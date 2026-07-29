/**
 * Tier TW — worker lifecycle tests (specs/test-agent-spec.md acceptance
 * §2): a real `xmd test-agent` subprocess driven over ACP stdio against
 * an in-test controller — initialize, session/new, matched prompts and
 * rendered text, mismatch diagnostics, and restart-between-turns with
 * session/load rehydration.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createSignal, each, ensure, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation, WithResolvers } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import type { DurableEvent } from "@executablemd/durable-streams";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { useTestAgentController } from "../src/controller.ts";
import type { TestAgentControllerInternals } from "../src/controller.ts";
import { useLineServer } from "../src/net.ts";
import { cliCommand } from "@executablemd/test-support/launch";
import {
  createLineSplitter,
  encodeMessage,
  formatRoute,
  parseWorkerMessage,
} from "../src/protocol.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AcpClientHandle {
  request(method: string, params: Record<string, unknown>): Operation<RpcReply>;
  notify(method: string, params: Record<string, unknown>): void;
  notifications: Array<Record<string, unknown>>;
}

function* useWorker(route: string): Operation<AcpClientHandle> {
  const cli = cliCommand(["test-agent", "--connect", route]);
  const proc = yield* exec(cli.command, {
    arguments: cli.arguments,
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
        if (isRecord(message.result)) {
          reply.result = message.result;
        }
        if (isRecord(message.error)) {
          const errorMessage = message.error.message;
          reply.error = {
            message: typeof errorMessage === "string" ? errorMessage : String(errorMessage),
          };
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
    notify(method, params) {
      proc.stdin.send(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
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
    if (!isRecord(params)) {
      continue;
    }
    const update = params.update;
    if (!isRecord(update)) {
      continue;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content;
      if (isRecord(content)) {
        const value = content.text;
        if (typeof value === "string") {
          text += value;
        }
      }
    }
  }
  return text;
}

interface GateHandle {
  held: Operation<void>;
  release(): void;
}

type GateKind = "journal" | "recorded";

interface GatedController {
  route: string;
  journal: DurableEvent[];
  /** Hold the next ack of the given kind until the returned handle is released. */
  armGate(kind?: GateKind): GateHandle;
}

/**
 * A minimal scenario controller whose journal or diagnostic ack can be held
 * mid-flush. It speaks the wire protocol directly so a test can freeze a
 * worker inside a controller round-trip and drive cancellation
 * deterministically, without timing sleeps.
 */
function* useGatedController(doc: { path: string; source: string }): Operation<GatedController> {
  const journal: DurableEvent[] = [];
  let gate: { kind: GateKind; held: WithResolvers<void>; release: WithResolvers<void> } | undefined;
  function* holdIf(kind: GateKind): Operation<void> {
    if (gate?.kind === kind) {
      const current = gate;
      gate = undefined;
      current.held.resolve();
      yield* current.release.operation;
    }
  }
  const server = yield* useLineServer("127.0.0.1", function* (conn) {
    let attached = false;
    for (const line of yield* each(conn.lines)) {
      const parsed = parseWorkerMessage(line);
      if (!parsed.ok) {
        conn.send(encodeMessage({ t: "error", message: parsed.error.message }));
        conn.end();
        return;
      }
      const message = parsed.value;
      if (!attached) {
        attached = true;
        conn.send(encodeMessage({ t: "config", mode: "scenario", doc, journal: [...journal] }));
        yield* each.next();
        continue;
      }
      switch (message.t) {
        case "journal": {
          yield* holdIf("journal");
          journal.push(message.event);
          conn.send(encodeMessage({ t: "ack", seq: message.seq }));
          break;
        }
        case "turn-failure":
        case "fatal": {
          yield* holdIf("recorded");
          conn.send(encodeMessage({ t: "recorded" }));
          break;
        }
        case "read": {
          conn.send(encodeMessage({ t: "read", path: message.path, missing: true }));
          break;
        }
        case "stat": {
          conn.send(encodeMessage({ t: "stat", path: message.path, exists: false, isFile: false }));
          break;
        }
        case "attach": {
          conn.send(encodeMessage({ t: "error", message: "duplicate attach" }));
          conn.end();
          return;
        }
      }
      yield* each.next();
    }
  });
  return {
    route: formatRoute({ host: "127.0.0.1", port: server.port, token: "gate", instance: "gate" }),
    journal,
    armGate(kind = "journal") {
      const held = withResolvers<void>();
      const release = withResolvers<void>();
      gate = { kind, held, release };
      return { held: held.operation, release: release.resolve };
    },
  };
}

/**
 * Set up a real controller + instance + initialized worker over a temp doc,
 * run the body, and tear it all down. Used by the causal-diagnostics tests.
 */
function* runScenario(
  source: string,
  body: (ctx: {
    controller: TestAgentControllerInternals;
    scenarioId: string;
    worker: AcpClientHandle;
  }) => Operation<void>,
): Operation<void> {
  const dir = path.join(os.tmpdir(), `xmd-causal-${randomUUID()}`);
  yield* ensureDir(dir);
  // The fixtures outlive the scenario scope nested below, and both end
  // before this helper returns to the test that called it.
  yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* writeTextFile(path.join(dir, "doc.md"), source);
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const scenario = yield* controller.useScenario({
        document: { path: "doc.md", source },
        rootDir: dir,
      });
      const worker = yield* useWorker(scenario.route);
      yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      yield* body({ controller, scenarioId: scenario.id, worker });
    });
  });
}

describe("Tier TW — worker lifecycle", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("TW1: initialize, session/new, matched turns, mismatch, restart + session/load", function* () {
    const dir = path.join(os.tmpdir(), `xmd-tw-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* writeTextFile(path.join(dir, "review.md"), BEHAVIOR);
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const scenario = yield* controller.useScenario({
        document: { path: "review.md", source: BEHAVIOR },
        rootDir: dir,
      });

      let sessionId = "";
      yield* scoped(function* () {
        const worker = yield* useWorker(scenario.route);
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
        expect(controller.getScenarioRecord(scenario.id)?.failure?.kind).toBe("mismatch");
      });
      // The first worker is gone (killed between completed turns); its
      // stage-1 transition was acknowledged, so a fresh worker
      // rehydrates with the capture intact and stage 2 active.
      expect(controller.getScenarioRecord(scenario.id)?.journal.length).toBeGreaterThan(0);

      yield* scoped(function* () {
        const worker = yield* useWorker(scenario.route);
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
  });

  it("TW3: cancellation is transactional — nothing commits and the stage re-matches", function* () {
    const behavior = [
      '<WhenPrompt template="go" />',
      "",
      "```js eval",
      "yield* sleep(400);",
      'return "";',
      "```",
      "",
      "slow reply",
      "",
      '<WhenPrompt template="next" />',
      "",
      "done",
      "",
    ].join("\n");
    const dir = path.join(os.tmpdir(), `xmd-tw3-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* writeTextFile(path.join(dir, "slow.md"), behavior);
    yield* scoped(function* () {
      const controller = yield* useTestAgentController();
      const scenario = yield* controller.useScenario({
        document: { path: "slow.md", source: behavior },
        rootDir: dir,
      });
      const worker = yield* useWorker(scenario.route);
      yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
      const sessionId = created.result?.sessionId;
      const baseline = controller.getScenarioRecord(scenario.id)!.journal.length;

      const pending = yield* spawn(() =>
        worker.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "go" }],
        }),
      );
      yield* sleep(120);
      worker.notify("session/cancel", { sessionId });
      const cancelled = yield* pending;
      expect(cancelled.result).toMatchObject({ stopReason: "cancelled" });
      // Nothing committed: the controller journal is exactly where it
      // was before the cancelled turn.
      expect(controller.getScenarioRecord(scenario.id)!.journal.length).toBe(baseline);

      // The rebuilt runtime re-enters stage 1 deterministically.
      const retried = yield* worker.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      expect(retried.result).toMatchObject({ stopReason: "end_turn" });
      expect(chunkText(worker.notifications)).toContain("slow reply");
      expect(controller.getScenarioRecord(scenario.id)!.journal.length).toBeGreaterThan(baseline);

      const second = yield* worker.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "next" }],
      });
      expect(second.result).toMatchObject({ stopReason: "end_turn" });
      expect(chunkText(worker.notifications)).toContain("done");
    });
  });

  it("TW4: losing the controller fails turns through ACP instead of hanging", function* () {
    const dir = path.join(os.tmpdir(), `xmd-tw4-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* writeTextFile(path.join(dir, "hi.md"), '<WhenPrompt template="hi" />\n\nhello\n');
    const started = withResolvers<string>();
    const stop = withResolvers<void>();
    yield* spawn(() =>
      scoped(function* () {
        const controller = yield* useTestAgentController();
        const scenario = yield* controller.useScenario({
          document: { path: "hi.md", source: '<WhenPrompt template="hi" />\n\nhello\n' },
          rootDir: dir,
        });
        started.resolve(scenario.route);
        yield* stop.operation;
      }),
    );
    const route = yield* started.operation;
    const worker = yield* useWorker(route);
    yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
    const sessionId = created.result?.sessionId;

    stop.resolve();
    yield* sleep(50);

    const reply = yield* worker.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(reply.result).toBe(undefined);
    expect(reply.error).toBeDefined();
  });

  it("TW2: probe workers initialize and never start a behavior document", function* () {
    const controller = yield* useTestAgentController();
    const worker = yield* useWorker(controller.probeRoute);
    const init = yield* worker.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(init.result).toMatchObject({ protocolVersion: 1 });
  });

  it("TW5: a cancel during journal commit is ignored — the turn finishes normally", function* () {
    const behavior = [
      '<WhenPrompt template="go" />',
      "",
      "first reply",
      "",
      '<WhenPrompt template="next" />',
      "",
      "second reply",
      "",
    ].join("\n");
    yield* scoped(function* () {
      const controller = yield* useGatedController({ path: "doc.md", source: behavior });
      const worker = yield* useWorker(controller.route);
      yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const created = yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
      const sessionId = created.result?.sessionId;

      // Freeze the worker inside its commit: hold the first journal ack, cancel
      // while it is held, then release. The commit has begun, so the cancel
      // must be ignored and the turn must finish with end_turn.
      const gate = controller.armGate("journal");
      const pending = yield* spawn(() =>
        worker.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "go" }],
        }),
      );
      yield* gate.held;
      worker.notify("session/cancel", { sessionId });
      // Input-order barrier: initialize follows the cancel on the same ACP
      // input stream, so receiving its response proves the worker already
      // dispatched the cancel. Only then release — no timing sleep.
      yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      gate.release();

      const reply = yield* pending;
      expect(reply.result).toMatchObject({ stopReason: "end_turn" });
      expect(chunkText(worker.notifications)).toContain("first reply");
      // The transition committed, so the journal advanced and the next stage
      // matches deterministically.
      expect(controller.journal.length).toBeGreaterThan(0);

      const second = yield* worker.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "next" }],
      });
      expect(second.result).toMatchObject({ stopReason: "end_turn" });
      expect(chunkText(worker.notifications)).toContain("second reply");
    });
  });

  it("TW6: a prompt mismatch is recorded on the controller before the ACP error", function* () {
    yield* runScenario(
      '<WhenPrompt template="hi" />\n\nhello\n',
      function* ({ controller, scenarioId, worker }) {
        yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
        const reply = yield* worker.request("session/prompt", {
          sessionId: "s",
          prompt: [{ type: "text", text: "bye" }],
        });
        expect(reply.error).toBeDefined();
        // No sleep: the worker awaited the controller's record ack before it
        // surfaced the error, so the diagnostic is already present.
        expect(controller.getScenarioRecord(scenarioId)?.failure).toMatchObject({
          kind: "mismatch",
        });
      },
    );
  });

  it("TW7: an exhausted scenario is recorded before the ACP error", function* () {
    yield* runScenario(
      '<WhenPrompt template="hi" />\n\nhello\n',
      function* ({ controller, scenarioId, worker }) {
        yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
        const matched = yield* worker.request("session/prompt", {
          sessionId: "s",
          prompt: [{ type: "text", text: "hi" }],
        });
        expect(matched.result).toMatchObject({ stopReason: "end_turn" });
        const reply = yield* worker.request("session/prompt", {
          sessionId: "s",
          prompt: [{ type: "text", text: "hi" }],
        });
        expect(reply.error).toBeDefined();
        expect(controller.getScenarioRecord(scenarioId)?.failure).toMatchObject({
          kind: "exhausted",
        });
      },
    );
  });

  it("TW8: a behavior-document failure during a turn is recorded before the ACP error", function* () {
    const behavior = [
      '<WhenPrompt template="go" />',
      "",
      "```js eval",
      'throw new Error("boom");',
      "```",
      "",
    ].join("\n");
    yield* runScenario(behavior, function* ({ controller, scenarioId, worker }) {
      yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
      const reply = yield* worker.request("session/prompt", {
        sessionId: "s",
        prompt: [{ type: "text", text: "go" }],
      });
      expect(reply.error).toBeDefined();
      expect(controller.getScenarioRecord(scenarioId)?.fatal).toBeDefined();
    });
  });

  it("TW9: an initialization failure is recorded before the session/new error", function* () {
    const behavior = [
      "```js eval",
      'throw new Error("init boom");',
      "```",
      "",
      '<WhenPrompt template="hi" />',
      "",
      "hello",
      "",
    ].join("\n");
    yield* runScenario(behavior, function* ({ controller, scenarioId, worker }) {
      const reply = yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
      expect(reply.error).toBeDefined();
      expect(controller.getScenarioRecord(scenarioId)?.fatal).toBeDefined();
    });
  });

  it("TW10: a pre-matcher configuration failure is recorded before the session/new error", function* () {
    const behavior = [
      "Rendered output before the first matcher.",
      "",
      '<WhenPrompt template="hi" />',
      "",
      "hello",
      "",
    ].join("\n");
    yield* runScenario(behavior, function* ({ controller, scenarioId, worker }) {
      const reply = yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
      expect(reply.error).toBeDefined();
      expect(controller.getScenarioRecord(scenarioId)?.failure).toMatchObject({ kind: "config" });
    });
  });

  it("TW11: a cancel while a diagnostic ack is held is ignored — the prompt still fails", function* () {
    const controller = yield* useGatedController({
      path: "doc.md",
      source: '<WhenPrompt template="hi" />\n\nhello\n',
    });
    const worker = yield* useWorker(controller.route);
    yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = yield* worker.request("session/new", { cwd: "/", mcpServers: [] });
    const sessionId = created.result?.sessionId;

    // Freeze the worker waiting for the mismatch diagnostic to be recorded,
    // cancel while it is held, and use the input-order barrier to prove the
    // cancel was dispatched before releasing the ack.
    const gate = controller.armGate("recorded");
    const pending = yield* spawn(() =>
      worker.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "bye" }],
      }),
    );
    yield* gate.held;
    worker.notify("session/cancel", { sessionId });
    yield* worker.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    gate.release();

    const reply = yield* pending;
    // The cancel is ignored: the turn fails with the mismatch error, not
    // cancelled.
    expect(reply.result).toBe(undefined);
    expect(reply.error).toBeDefined();

    // The recorded ack was consumed, not stranded: a matching prompt at the
    // same stage still succeeds through the shared response queue.
    const retry = yield* worker.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(retry.result).toMatchObject({ stopReason: "end_turn" });
    expect(chunkText(worker.notifications)).toContain("hello");
  });
});
