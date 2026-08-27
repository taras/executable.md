/**
 * Tier EA — what the embedded adapters actually put on a prompt response.
 *
 * This is the protocol evidence for #622, and it runs the production artifacts:
 * each adapter is materialized out of the bytes this build carries, installed
 * the way a run installs it, spawned as a real process, and spoken to over real
 * ACP. Nothing here mocks the adapter, the transport, or the response.
 *
 * What each case compares is the identity the *provider surface* emitted with
 * the value that came back on `_meta` — the same string, not merely a present
 * one. The provider behind each adapter is a fake, because the assertion is
 * about the adapter's reporting and a real Codex or Claude would make it depend
 * on an account, a network and a model's mood.
 *
 * The interleaved cases are the load-bearing ones. Two sessions run at once and
 * each identity is derived from its own session, so an adapter reporting
 * anything session-global hands at least one of them the other's answer.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, ensure, resource, spawn as effectionSpawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { rm } from "@effectionx/fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createEmbeddedAdapters } from "../src/adapter-snapshots.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FAKE_CODEX = join(FIXTURES, "fake-codex-app-server.cjs");
const FAKE_CLAUDE = join(FIXTURES, "fake-claude-cli.cjs");

/** One ACP conversation with a spawned adapter. */
interface Adapter {
  request(method: string, params: unknown): Operation<Record<string, unknown>>;
}

/**
 * Materialize one embedded adapter and speak ACP to it.
 *
 * The command comes from the materializer, so what is spawned is exactly what a
 * workflow run spawns — not a path this test assembled.
 */
function useAdapter(provider: string, environment: Record<string, string>): Operation<Adapter> {
  return resource(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-ea-")));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const adapters = createEmbeddedAdapters(join(root, "adapters"));
    yield* adapters.materialize(provider);
    const entry = adapters.executablePath(provider);

    const child: ChildProcess = spawn(process.execPath, [entry], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: root,
    });
    yield* ensure(() => {
      child.kill();
    });

    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    let next = 1;
    let buffer = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line.trim().length === 0) {
          continue;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const id = message["id"];
        if (typeof id === "number" && pending.has(id)) {
          pending.get(id)?.(message);
          pending.delete(id);
          continue;
        }
        // The adapter asks its client for things too. Answering permissively
        // keeps the turn moving; none of it is what these cases assert on.
        if (typeof id === "number" && typeof message["method"] === "string") {
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
        }
      }
    });

    yield* provide({
      *request(method: string, params: unknown): Operation<Record<string, unknown>> {
        const id = next++;
        const answered = withResolvers<Record<string, unknown>>();
        pending.set(id, answered.resolve);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        const message = yield* answered.operation;
        if (message["error"] !== undefined) {
          throw new Error(`${method}: ${JSON.stringify(message["error"])}`);
        }
        const result = message["result"];
        if (typeof result !== "object" || result === null) {
          throw new Error(`${method} answered with no result`);
        }
        return result as Record<string, unknown>;
      },
    });
  });
}

function* initialize(adapter: Adapter): Operation<void> {
  yield* adapter.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
}

function* openSession(adapter: Adapter): Operation<string> {
  const session = yield* adapter.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const sessionId = session["sessionId"];
  if (typeof sessionId !== "string") {
    throw new Error("session/new answered with no session id");
  }
  return sessionId;
}

function* prompt(adapter: Adapter, sessionId: string): Operation<Record<string, unknown>> {
  return yield* adapter.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
}

/** What one prompt response says under `_meta`, for one namespace. */
function metaOf(response: Record<string, unknown>, namespace: string): unknown {
  const meta = response["_meta"];
  if (typeof meta !== "object" || meta === null) {
    return undefined;
  }
  return (meta as Record<string, unknown>)[namespace];
}

const CODEX_ENV = { CODEX_PATH: FAKE_CODEX };
const CLAUDE_ENV = { CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE };

describe("Tier EA — the embedded adapters' prompt-response metadata", () => {
  it("EA1: Codex reports the exact App Server turn that completed the prompt", function* () {
    const adapter = yield* useAdapter("codex", CODEX_ENV);
    yield* initialize(adapter);
    const sessionId = yield* openSession(adapter);

    const response = yield* prompt(adapter, sessionId);

    expect(response["stopReason"]).toBe("end_turn");
    // The App Server names each turn `turn:<threadId>:<n>`, and the ACP session
    // id is that thread. So this is the identity the provider surface emitted,
    // compared with the identity the adapter reported — the same string.
    expect(metaOf(response, "codex")).toEqual({ turnId: `turn:${sessionId}:1` });
    // Beside what the adapter already reported, never in place of it.
    expect(metaOf(response, "quota")).toBeDefined();
  });

  it("EA2: interleaved Codex sessions each carry their own turn", function* () {
    const adapter = yield* useAdapter("codex", CODEX_ENV);
    yield* initialize(adapter);
    const first = yield* openSession(adapter);
    const second = yield* openSession(adapter);

    // Both in flight against one adapter process. The fake holds each turn open
    // long enough that they overlap.
    const alpha = yield* effectionSpawn(() => prompt(adapter, first));
    const beta = yield* effectionSpawn(() => prompt(adapter, second));
    const [one, two] = yield* all([alpha, beta]);

    expect(metaOf(one, "codex")).toEqual({ turnId: `turn:${first}:1` });
    expect(metaOf(two, "codex")).toEqual({ turnId: `turn:${second}:1` });
    expect(first).not.toBe(second);
  });

  it("EA3: Claude reports the exact assistant message the turn ended on", function* () {
    const adapter = yield* useAdapter("claude", CLAUDE_ENV);
    yield* initialize(adapter);
    const sessionId = yield* openSession(adapter);

    const response = yield* prompt(adapter, sessionId);

    expect(response["stopReason"]).toBe("end_turn");
    // The CLI derives its assistant message uuid from the session it was
    // launched for, so this is that message's own identity rather than a value
    // the adapter could have produced on its own.
    expect(metaOf(response, "claudeCode")).toEqual({
      assistantMessageUuid: `uuid:${sessionId}`,
    });
  });

  it("EA4: interleaved Claude sessions each carry their own assistant message", function* () {
    const adapter = yield* useAdapter("claude", CLAUDE_ENV);
    yield* initialize(adapter);
    const first = yield* openSession(adapter);
    const second = yield* openSession(adapter);

    const alpha = yield* effectionSpawn(() => prompt(adapter, first));
    const beta = yield* effectionSpawn(() => prompt(adapter, second));
    const [one, two] = yield* all([alpha, beta]);

    expect(metaOf(one, "claudeCode")).toEqual({ assistantMessageUuid: `uuid:${first}` });
    expect(metaOf(two, "claudeCode")).toEqual({ assistantMessageUuid: `uuid:${second}` });
    expect(first).not.toBe(second);
  });

  it("EA5: a second Codex turn on one session names the second turn", function* () {
    const adapter = yield* useAdapter("codex", CODEX_ENV);
    yield* initialize(adapter);
    const sessionId = yield* openSession(adapter);

    const first = yield* prompt(adapter, sessionId);
    const second = yield* prompt(adapter, sessionId);

    // Where the conversation reached, not where it started. A checkpoint that
    // reported the session's first turn forever would resume every later run
    // before work it had already done.
    expect(metaOf(first, "codex")).toEqual({ turnId: `turn:${sessionId}:1` });
    expect(metaOf(second, "codex")).toEqual({ turnId: `turn:${sessionId}:2` });
  });
});
