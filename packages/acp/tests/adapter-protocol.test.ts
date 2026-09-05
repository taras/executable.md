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
  /**
   * Every `session/update` notification the adapter sent, in arrival order.
   *
   * One ordered stdio stream carries both these and the responses, so a marker
   * already in here when a prompt answers arrived before that answer.
   */
  readonly updates: Array<Record<string, unknown>>;
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
    const updates: Array<Record<string, unknown>> = [];
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
        if (message["method"] === "session/update" && id === undefined) {
          const params = message["params"];
          if (typeof params === "object" && params !== null) {
            updates.push(params as Record<string, unknown>);
          }
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
      updates,
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

/** The one versioned key an adapter reports backend acceptance on. */
const SESSION_MATERIALIZATION_META = "executablemd.session-materialization/v1";

/** The sessions this adapter reported acceptance for, in arrival order. */
function acceptances(adapter: Adapter): string[] {
  return adapter.updates.flatMap((notification) => {
    const update = notification["update"];
    if (typeof update !== "object" || update === null) {
      return [];
    }
    const fields = update as Record<string, unknown>;
    if (fields["sessionUpdate"] !== "session_info_update") {
      return [];
    }
    const meta = fields["_meta"];
    if (typeof meta !== "object" || meta === null) {
      return [];
    }
    const signal = (meta as Record<string, unknown>)[SESSION_MATERIALIZATION_META];
    if (typeof signal !== "object" || signal === null) {
      return [];
    }
    if ((signal as Record<string, unknown>)["state"] !== "accepted") {
      return [];
    }
    const sessionId = notification["sessionId"];
    return typeof sessionId === "string" ? [sessionId] : [];
  });
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

  it("EA6: Codex reports its backend's acceptance, on its own session, before answering", function* () {
    const adapter = yield* useAdapter("codex", CODEX_ENV);
    yield* initialize(adapter);
    const first = yield* openSession(adapter);
    const second = yield* openSession(adapter);

    // Nothing yet: opening a session is not a backend accepting a turn, which
    // is the whole distinction this marker exists to carry.
    expect(acceptances(adapter)).toEqual([]);

    const alpha = yield* effectionSpawn(() => prompt(adapter, first));
    const beta = yield* effectionSpawn(() => prompt(adapter, second));
    yield* all([alpha, beta]);

    // One per accepted turn, each naming the session its turn started on, and
    // both already sent by the time their prompts answered.
    expect(acceptances(adapter).slice().sort()).toEqual([first, second].sort());
    expect(first).not.toBe(second);
  });

  it("EA7: Claude reports its SDK's acceptance, on its own session, before answering", function* () {
    const adapter = yield* useAdapter("claude", CLAUDE_ENV);
    yield* initialize(adapter);
    const first = yield* openSession(adapter);
    const second = yield* openSession(adapter);

    expect(acceptances(adapter)).toEqual([]);

    const alpha = yield* effectionSpawn(() => prompt(adapter, first));
    const beta = yield* effectionSpawn(() => prompt(adapter, second));
    yield* all([alpha, beta]);

    expect(acceptances(adapter).slice().sort()).toEqual([first, second].sort());
    expect(first).not.toBe(second);
  });

  it("EA8: Codex reports acceptance for a turn a command started", function* () {
    // `/review` reaches the App Server by its own request rather than through
    // `turn/start`, and the turn it answers with is a turn the backend
    // accepted. A client that waits for acceptance before it retains anything
    // must not be left waiting because the turn was asked for by a command.
    const adapter = yield* useAdapter("codex", CODEX_ENV);
    yield* initialize(adapter);
    const sessionId = yield* openSession(adapter);

    yield* adapter.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/review" }],
    });

    expect(acceptances(adapter)).toEqual([sessionId]);
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

  it("EA9: interleaved Codex sessions each report the thread they opened", function* () {
    const adapter = yield* useAdapter("codex", CODEX_ENV);
    yield* initialize(adapter);

    const alpha = yield* effectionSpawn(() =>
      adapter.request("session/new", { cwd: process.cwd(), mcpServers: [] }),
    );
    const beta = yield* effectionSpawn(() =>
      adapter.request("session/new", { cwd: process.cwd(), mcpServers: [] }),
    );
    const [one, two] = yield* all([alpha, beta]);

    // The App Server named each thread, so this is the identity that surface
    // emitted compared with what the adapter reported on `_meta`. A top-level
    // session id cannot stand in: a client reading that cannot tell an identity
    // the provider allocated from one it invented itself.
    expect(metaOf(one, "agentSessionId")).toBe(one["sessionId"]);
    expect(metaOf(two, "agentSessionId")).toBe(two["sessionId"]);
    // Two at once, so an adapter reporting anything session-global — the last
    // thread it opened, say — hands at least one of them the other's answer.
    expect(metaOf(one, "agentSessionId")).not.toBe(metaOf(two, "agentSessionId"));
  });

  it("EA10: reopening a Codex session reports the thread the App Server reopened", function* () {
    const adapter = yield* useAdapter("codex", CODEX_ENV);
    yield* initialize(adapter);
    // A thread opened first, so the reopened answers below are distinguishable
    // from the most recent thread this adapter process created.
    const opened = yield* openSession(adapter);

    const resumed = yield* adapter.request("session/resume", {
      sessionId: "thread-resumed",
      cwd: process.cwd(),
      mcpServers: [],
    });
    const loaded = yield* adapter.request("session/load", {
      sessionId: "thread-loaded",
      cwd: process.cwd(),
      mcpServers: [],
    });

    // Continuing a conversation needs its identity as much as starting one
    // does, and reopening is the route a run takes on every turn after the
    // first.
    expect(metaOf(resumed, "agentSessionId")).toBe("thread-resumed");
    expect(metaOf(loaded, "agentSessionId")).toBe("thread-loaded");
    expect(metaOf(resumed, "agentSessionId")).not.toBe(opened);
    expect(metaOf(loaded, "agentSessionId")).not.toBe(opened);
  });

  it("EA11: the Claude adapter reports no native session identity", function* () {
    const adapter = yield* useAdapter("claude", CLAUDE_ENV);
    yield* initialize(adapter);

    const session = yield* adapter.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });

    // Claude is handed the identity it uses rather than allocating one, so
    // there is nothing for its adapter to report back. This is the absence the
    // client-allocated route depends on: were a value to appear here, a client
    // choosing a route by whether the provider named the session would start
    // taking the wrong one.
    expect(typeof session["sessionId"]).toBe("string");
    expect(metaOf(session, "agentSessionId")).toBeUndefined();
  });
});
