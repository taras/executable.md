/**
 * Tier RU — the vendored runtime's per-turn usage
 * (packages/acp/vendor/acpx/PROVENANCE.md §Selected Prompt usage).
 *
 * These speak real ACP to a real child, through the real vendored runtime. The
 * fake agent answers each prompt with the usage and `_meta.quota` its script
 * names, so what is proven is that the counters an agent put on a response, and
 * the identities the runtime itself generated for that turn, reach the turn's
 * terminal result on every way it ends — and that they are the same identities
 * the runtime saved.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createAcpRuntime } from "../src/acpx-runtime.ts";
import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeTurnResult,
  AcpSessionRecord,
  AcpSessionStore,
} from "../src/acpx-runtime.ts";

/**
 * A fake ACP agent. `XMD_RU_SCRIPT` is a JSON array, one entry per prompt in
 * order: `{ usage?, meta?, delayMs?, accept? }`. `accept: false` withholds the
 * first-turn acceptance update a materializing session waits for.
 */
const AGENT_SOURCE = `#!/usr/bin/env node
const script = JSON.parse(process.env.XMD_RU_SCRIPT ?? "[]");
let prompts = 0;

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\\n");
    if (line.trim().length > 0) {
      handle(JSON.parse(line));
    }
  }
});

function handle(request) {
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    send({
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
      },
    });
    return;
  }
  if (request.method === "session/new") {
    send({ id: request.id, result: { sessionId: "ru-" + process.pid } });
    return;
  }
  if (request.method === "session/prompt") {
    const step = script[prompts++] ?? {};
    const sessionId = request.params.sessionId;
    if (step.accept !== false) {
      send({
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "session_info_update",
            _meta: { "executablemd.session-materialization/v1": { state: "accepted" } },
          },
        },
      });
    }
    send({
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      },
    });
    const result = { stopReason: "end_turn" };
    if (step.usage !== undefined) {
      result.usage = step.usage;
    }
    if (step.meta !== undefined) {
      result._meta = step.meta;
    }
    setTimeout(() => send({ id: request.id, result }), step.delayMs ?? 0);
    return;
  }
  send({ id: request.id, error: { code: -32601, message: "not implemented: " + request.method } });
}
`;

interface World {
  dir: string;
  agent: string;
  records: Map<string, AcpSessionRecord>;
  store: AcpSessionStore;
  /** Refuse any save of a record that already holds request usage. */
  failUsageSaves: boolean;
}

function* useWorld(): Operation<World> {
  const dir = path.join(os.tmpdir(), `xmd-ru-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  const agent = path.join(dir, "fake-agent");
  yield* writeTextFile(agent, AGENT_SOURCE);
  yield* until(chmod(agent, 0o755));
  const records = new Map<string, AcpSessionRecord>();
  const world: World = {
    dir,
    agent,
    records,
    failUsageSaves: false,
    store: {
      load: (id) => Promise.resolve(structuredClone(records.get(id))),
      save: (record) => {
        const usage = Reflect.get(record, "request_token_usage");
        if (world.failUsageSaves && usage && Object.keys(usage).length > 0) {
          return Promise.reject(new Error("injected finalization save failure"));
        }
        records.set(record.acpxRecordId, structuredClone(record));
        return Promise.resolve();
      },
    },
  };
  return world;
}

function runtimeFor(world: World, script: unknown[]): AcpRuntime {
  return createAcpRuntime({
    cwd: world.dir,
    sessionStore: world.store,
    agentRegistry: { resolve: () => world.agent, list: () => ["fake"] },
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    agentProcessEnv: { XMD_RU_SCRIPT: JSON.stringify(script) },
  });
}

function* ensureHandle(
  world: World,
  runtime: AcpRuntime,
  sessionKey: string,
  materialization?: "first-turn-acceptance",
): Operation<AcpRuntimeHandle> {
  return yield* until(
    runtime.ensureSession({
      sessionKey,
      agent: "fake",
      mode: "persistent",
      cwd: world.dir,
      ...(materialization === undefined ? {} : { materialization }),
    }),
  );
}

function* turnOf(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  text: string,
  timeoutMs = 20_000,
): Operation<{ requestId: string; result: AcpRuntimeTurnResult; materialized: boolean }> {
  const requestId = randomUUID();
  const turn = runtime.startTurn({ handle, text, mode: "prompt", requestId, timeoutMs });
  const materialized = turn.materialized.then(
    () => true,
    () => false,
  );
  const result = yield* until(turn.result);
  return { requestId, result, materialized: yield* until(materialized) };
}

const EQUAL = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };
const QUOTA = {
  token_count: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 0, outputTokens: 3 },
  model_usage: [{ model: "fixture-model", token_count: { totalTokens: 12, outputTokens: 4 } }],
};

describe(
  "Tier RU — vendored runtime usage",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("RU1: two turns with equal counters keep their own generated message and saved entry", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, [
        { usage: EQUAL, meta: { quota: QUOTA } },
        { usage: EQUAL, meta: { quota: QUOTA } },
      ]);
      const handle = yield* ensureHandle(world, runtime, "ru-two");
      const first = yield* turnOf(runtime, handle, "alpha");
      const second = yield* turnOf(runtime, handle, "beta");
      yield* until(runtime.close({ handle, reason: "test" }));

      expect(first.result.status).toBe("completed");
      expect(second.result.status).toBe("completed");
      const one = first.result.usage;
      const two = second.result.usage;
      expect(one?.response).toEqual(EQUAL);
      expect(two?.response).toEqual(EQUAL);
      expect(one?.quota).toEqual({
        tokenCount: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 0, outputTokens: 3 },
        modelUsage: [{ model: "fixture-model", tokenCount: { totalTokens: 12, outputTokens: 4 } }],
      });
      // Equal counts are not the association: each turn names the user message
      // the runtime generated for it, under the same owning record.
      expect(typeof one?.promptMessageId).toBe("string");
      expect(typeof two?.promptMessageId).toBe("string");
      expect(one?.promptMessageId).not.toBe(two?.promptMessageId);
      expect(one?.acpxRecordId).toBe(handle.acpxRecordId);
      expect(two?.acpxRecordId).toBe(handle.acpxRecordId);
      expect(typeof one?.sessionId).toBe("string");

      // And each is exactly the entry the runtime saved for that request.
      const saved = world.records.get(handle.acpxRecordId ?? "");
      const perRequest = Reflect.get(saved ?? {}, "request_token_usage") ?? {};
      expect(Object.keys(perRequest).sort()).toEqual(
        [one?.promptMessageId, two?.promptMessageId].sort(),
      );
      const messages = (Reflect.get(saved ?? {}, "messages") ?? []) as Record<string, unknown>[];
      const userIds = messages.flatMap((message) => {
        const user = Reflect.get(message, "User");
        return typeof user === "object" && user !== null ? [Reflect.get(user, "id")] : [];
      });
      expect(userIds).toEqual([one?.promptMessageId, two?.promptMessageId]);
    });

    it("RU2: an absent response usage stays absent, and a source null stays null", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, [
        {},
        { usage: null, meta: { quota: { token_count: null } } },
      ]);
      const handle = yield* ensureHandle(world, runtime, "ru-absent");
      const absent = yield* turnOf(runtime, handle, "alpha");
      const nulled = yield* turnOf(runtime, handle, "beta");
      yield* until(runtime.close({ handle, reason: "test" }));
      expect(absent.result.usage !== undefined && "response" in absent.result.usage).toBe(false);
      expect(typeof absent.result.usage?.promptMessageId).toBe("string");
      expect(nulled.result.usage?.response).toBe(null);
      expect(nulled.result.usage?.quota).toEqual({ tokenCount: null });
    });

    it("RU3: a response recovered during timeout drain keeps its own usage", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, [{ usage: EQUAL, delayMs: 400 }]);
      const handle = yield* ensureHandle(world, runtime, "ru-drain");
      const drained = yield* turnOf(runtime, handle, "alpha", 100);
      yield* until(runtime.close({ handle, reason: "test" }));
      expect(drained.result.status).toBe("completed");
      expect(drained.result.usage?.response).toEqual(EQUAL);
    });

    it("RU4: a failed finalization keeps the readings already observed", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, [{ usage: EQUAL, meta: { quota: QUOTA } }]);
      const handle = yield* ensureHandle(world, runtime, "ru-finalize");
      world.failUsageSaves = true;
      const failed = yield* turnOf(runtime, handle, "alpha");
      world.failUsageSaves = false;
      yield* until(runtime.close({ handle, reason: "test" }).catch(() => undefined));
      expect(failed.result.status).toBe("failed");
      expect(failed.result.usage?.response).toEqual(EQUAL);
      expect(failed.result.usage?.quota?.tokenCount?.totalTokens).toBe(10);
      expect(typeof failed.result.usage?.promptMessageId).toBe("string");
    });

    it("RU5: a turn no backend accepted still carries the readings its result reported", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, [{ usage: EQUAL, accept: false }]);
      const handle = yield* ensureHandle(world, runtime, "ru-unaccepted", "first-turn-acceptance");
      const unaccepted = yield* turnOf(runtime, handle, "alpha");
      yield* until(runtime.close({ handle, reason: "test" }).catch(() => undefined));
      expect(unaccepted.materialized).toBe(false);
      expect(unaccepted.result.usage?.response).toEqual(EQUAL);
    });
  },
);
