/**
 * Tier TW — worker lifecycle tests (specs/test-agent-spec.md acceptance
 * §2): a real `xmd test-agent` subprocess driven over ACP stdio against
 * an in-test controller — initialize, session/new, matched prompts and
 * rendered text, mismatch diagnostics, and restart-between-turns with
 * session/load rehydration.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { createSignal, each, ensure, scoped, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { useTestAgentController } from "../src/controller.ts";
import { createLineSplitter } from "../src/protocol.ts";

const CLI = path.resolve("packages/cli/src/cli.ts");
const BEHAVIOR = [
  "<WhenPrompt",
  '  as="review"',
  '  template="Review {?subject} at revision {?revision}"',
  "/>",
  "",
  "The review of **{review.subject}** at `{review.revision}` passed.",
  "",
  '<WhenPrompt template="Summarize {review.subject}" />',
  "",
  "The review of **{review.subject}** passed.",
  "",
].join("\n");

interface RpcReply {
  result?: Record<string, unknown>;
  error?: { message: string };
}

interface AcpClientHandle {
  request(method: string, params: Record<string, unknown>): Operation<RpcReply>;
  notifications: Array<Record<string, unknown>>;
}

function* useWorker(route: string): Operation<AcpClientHandle> {
  const proc = yield* exec(`deno run --allow-all ${CLI} test-agent --connect ${route}`, {
    env: { ...process.env, NO_COLOR: "1" },
  });
  const lines = createSignal<Record<string, unknown>, undefined>();
  const splitter = createLineSplitter();
  const notifications: Array<Record<string, unknown>> = [];
  const pending = new Map<number, (reply: RpcReply) => void>();

  yield* spawn(function* () {
    for (const chunk of yield* each(proc.stdout)) {
      for (const line of splitter.feed(new TextDecoder().decode(chunk))) {
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null) {
            lines.send(parsed);
          }
        } catch {
          // non-JSON stdout noise is ignored
        }
      }
      yield* each.next();
    }
  });
  yield* spawn(function* () {
    for (const chunk of yield* each(proc.stderr)) {
      void chunk;
      yield* each.next();
    }
  });
  yield* spawn(function* () {
    for (const message of yield* each(lines)) {
      const id = message.id;
      if (typeof id === "number" && pending.has(id)) {
        const resolve = pending.get(id)!;
        pending.delete(id);
        const reply: RpcReply = {};
        if (typeof message.result === "object" && message.result !== null) {
          reply.result = message.result as Record<string, unknown>;
        }
        if (typeof message.error === "object" && message.error !== null) {
          reply.error = message.error as { message: string };
        }
        resolve(reply);
      } else if (typeof message.method === "string") {
        notifications.push(message);
      }
      yield* each.next();
    }
  });
  yield* ensure(() => {
    lines.close(undefined);
  });

  let nextId = 1;
  return {
    notifications,
    *request(method, params) {
      const id = nextId++;
      const reply = withResolvers<RpcReply>();
      pending.set(id, reply.resolve);
      proc.stdin.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return yield* reply.operation;
    },
  };
}

function chunkText(notifications: Array<Record<string, unknown>>): string {
  let text = "";
  for (const message of notifications) {
    if (message.method !== "session/update") {
      continue;
    }
    const params = message.params;
    if (typeof params !== "object" || params === null) {
      continue;
    }
    const update = (params as Record<string, unknown>).update;
    if (typeof update !== "object" || update === null) {
      continue;
    }
    const record = update as Record<string, unknown>;
    if (record.sessionUpdate === "agent_message_chunk") {
      const content = record.content;
      if (typeof content === "object" && content !== null) {
        const value = (content as Record<string, unknown>).text;
        if (typeof value === "string") {
          text += value;
        }
      }
    }
  }
  return text;
}

describe("Tier TW — worker lifecycle", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("TW1: initialize, session/new, matched turns, mismatch, restart + session/load", function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xmd-tw-"));
    try {
      fs.writeFileSync(path.join(dir, "review.md"), BEHAVIOR);
      yield* scoped(function* () {
        const controller = yield* useTestAgentController();
        const instance = controller.registerInstance({
          doc: { path: "review.md", source: BEHAVIOR },
          scenarioDir: dir,
        });

        let sessionId = "";
        yield* scoped(function* () {
          const worker = yield* useWorker(instance.route);
          const init = yield* worker.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: {},
          });
          expect(init.result).toMatchObject({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          });

          const created = yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
          expect(typeof created.result?.sessionId).toBe("string");
          if (typeof created.result?.sessionId === "string") {
            sessionId = created.result.sessionId;
          }

          const first = yield* worker.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Review packages/core at revision abc123" }],
          });
          expect(first.result).toMatchObject({ stopReason: "end_turn" });
          expect(chunkText(worker.notifications)).toContain(
            "The review of **packages/core** at `abc123` passed.",
          );

          const mismatch = yield* worker.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Do something else entirely" }],
          });
          expect(mismatch.error?.message).toContain("Summarize {review.subject}");
          expect(mismatch.error?.message).toContain("Do something else entirely");
          expect(controller.instance(instance.id)?.failure?.kind).toBe("mismatch");
        });
        // The first worker is gone (killed between completed turns); its
        // stage-1 transition was acknowledged, so a fresh worker
        // rehydrates with the capture intact and stage 2 active.
        expect(controller.instance(instance.id)?.journal.length).toBeGreaterThan(0);

        yield* scoped(function* () {
          const worker = yield* useWorker(instance.route);
          yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
          const loaded = yield* worker.request("session/load", {
            sessionId,
            cwd: "/",
            mcpServers: [],
          });
          expect(loaded.error).toBe(undefined);

          const second = yield* worker.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Summarize packages/core" }],
          });
          if (second.error) {
            throw new Error(`second turn failed: ${second.error.message}`);
          }
          expect(second.result).toMatchObject({ stopReason: "end_turn" });
          expect(chunkText(worker.notifications)).toContain(
            "The review of **packages/core** passed.",
          );

          const exhaustedReply = yield* worker.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Anything more?" }],
          });
          expect(exhaustedReply.error?.message).toContain("scenario exhausted");
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("TW2: probe workers initialize and never start a behavior document", function* () {
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const worker = yield* useWorker(controller.probeRoute);
      const init = yield* worker.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(init.result).toMatchObject({ protocolVersion: 1 });
    });
  });
});
