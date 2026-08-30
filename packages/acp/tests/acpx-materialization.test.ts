/**
 * Tier TM — deferred first-turn materialization in the vendored ACPX
 * (packages/acp/vendor/acpx/PROVENANCE.md).
 *
 * A session placed for a first turn is occupancy: it names where a
 * conversation will live and asserts none. It becomes a conversation when the
 * backend accepts a turn, and only the adapter can say when that happened — so
 * the runtime waits for one exact signal and infers nothing from anything else.
 *
 * These speak real ACP to a real child. The agent command resolves to a fake
 * agent that answers JSON-RPC over stdio and emits whatever session updates the
 * case asks for, so what is proven is that the bytes an agent sent — or did not
 * send — decided what the store holds.
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
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeMaterialization,
  AcpSessionRecord,
  AcpSessionStore,
} from "../src/acpx-runtime.ts";

/** The one versioned key an adapter reports backend acceptance on. */
const SESSION_MATERIALIZATION_META = "executablemd.session-materialization/v1";

/**
 * A fake ACP agent, as a Node script.
 *
 * `XMD_TM_SCRIPT` is a JSON array of what it does when a prompt arrives, in
 * order: `accept` sends the acceptance marker, `chatter` sends an ordinary
 * `session_info_update` carrying a title and an unrelated `_meta` namespace,
 * `text` sends an agent message chunk, and `fail` answers the prompt with a
 * JSON-RPC error instead of a stop reason. Anything not listed simply never
 * happens, which is how a case asks for an adapter that never signals.
 *
 * Every `session/new` answers with a fresh identity, so a run that resumed a
 * previous arrangement instead of creating one is visible as the old id.
 */
const AGENT_SOURCE = `#!/usr/bin/env node
const script = JSON.parse(process.env.XMD_TM_SCRIPT || '["accept","text"]');
let created = 0;
let sessionId = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function update(update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
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
    reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? 1,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
    });
    return;
  }
  if (request.method === "session/new") {
    created += 1;
    sessionId = "tm-" + process.pid + "-" + created;
    reply(request.id, { sessionId, _meta: { agentSessionId: "agent-" + sessionId } });
    return;
  }
  if (request.method === "session/prompt") {
    for (const step of script) {
      if (step === "accept") {
        update({
          sessionUpdate: "session_info_update",
          _meta: { "${SESSION_MATERIALIZATION_META}": { state: "accepted" } },
        });
      } else if (step === "chatter") {
        update({
          sessionUpdate: "session_info_update",
          title: "a title nobody asked about",
          _meta: { somebodyElse: { state: "accepted" } },
        });
      } else if (step === "text") {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "the answer" },
        });
      } else if (step === "fail") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: "the backend refused this turn" },
        });
        return;
      }
    }
    reply(request.id, { stopReason: "end_turn" });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: "the fake agent does not implement " + request.method },
  });
}
`;

interface World {
  dir: string;
  agent: string;
  registry: AcpAgentRegistry;
  store: AcpSessionStore;
  /** Every record this store was asked to save, in the order it was asked. */
  saves: AcpSessionRecord[];
}

function* useWorld(): Operation<World> {
  const dir = path.join(os.tmpdir(), `xmd-tm-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));

  const agent = path.join(dir, "fake-agent");
  yield* writeTextFile(agent, AGENT_SOURCE);
  yield* until(chmod(agent, 0o755));

  const records = new Map<string, AcpSessionRecord>();
  const saves: AcpSessionRecord[] = [];
  return {
    dir,
    agent,
    saves,
    registry: { resolve: () => agent, list: () => ["fake"] },
    store: {
      load: (id) => Promise.resolve(records.get(id)),
      save: (record) => {
        records.set(record.acpxRecordId, record);
        saves.push(structuredClone(record));
        return Promise.resolve();
      },
    },
  };
}

function runtimeFor(world: World, script: string[]): AcpRuntime {
  return createAcpRuntime({
    cwd: world.dir,
    sessionStore: world.store,
    agentRegistry: world.registry,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    agentProcessEnv: { XMD_TM_SCRIPT: JSON.stringify(script) },
  });
}

function* place(
  world: World,
  runtime: AcpRuntime,
  sessionKey: string,
): Operation<AcpRuntimeHandle> {
  return yield* until(
    runtime.ensureSession({
      sessionKey,
      agent: "fake",
      mode: "persistent",
      cwd: world.dir,
      materialization: "first-turn-acceptance",
    }),
  );
}

interface TurnOutcome {
  events: AcpRuntimeEvent[];
  materialized: AcpRuntimeMaterialization | undefined;
  refusal: string | undefined;
  status: string;
}

/** One turn, driven to the end, reporting what it produced and what it settled. */
function* takeTurn(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  text: string,
): Operation<TurnOutcome> {
  const turn = runtime.startTurn({
    handle,
    text,
    mode: "prompt",
    requestId: randomUUID(),
    timeoutMs: 20_000,
  });
  const settled = yield* until(
    turn.materialized.then(
      (value: AcpRuntimeMaterialization) => ({ value, refusal: undefined }),
      (error: unknown) => ({
        value: undefined,
        refusal: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
  const events: AcpRuntimeEvent[] = [];
  const iterator = turn.events[Symbol.asyncIterator]();
  let next = yield* until(iterator.next());
  while (!next.done) {
    events.push(next.value);
    next = yield* until(iterator.next());
  }
  const result = yield* until(turn.result);
  return {
    events,
    materialized: settled.value,
    refusal: settled.refusal,
    status: result.status,
  };
}

/** Whether the record under this key is still occupancy rather than a conversation. */
function pending(world: World, sessionKey: string): Operation<boolean> {
  return (function* () {
    const record = yield* until(world.store.load(sessionKey));
    return record?.sessionMaterialization?.state === "pending";
  })();
}

function* assertedIdentity(world: World, sessionKey: string): Operation<string | undefined> {
  const record = yield* until(world.store.load(sessionKey));
  return record?.agentSessionId;
}

describe(
  "Tier TM — deferred first-turn materialization",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("TM1: a placed session asserts nothing before a turn is accepted", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, []);

      const handle = yield* place(world, runtime, "tm-placed");

      // Occupancy: the key is taken and no conversation is named, on the
      // handle a caller could publish and in the record a host would read.
      expect(handle.agentSessionId).toBe(undefined);
      expect(yield* pending(world, "tm-placed")).toBe(true);
      expect(yield* assertedIdentity(world, "tm-placed")).toBe(undefined);
      yield* until(runtime.close({ handle, reason: "test" }));
    });

    it("TM2: acceptance promotes the record, and the save precedes the answer", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, ["accept", "text"]);
      const handle = yield* place(world, runtime, "tm-accepted");

      const outcome = yield* takeTurn(runtime, handle, "hello");

      expect(outcome.refusal).toBe(undefined);
      expect(outcome.materialized?.agentSessionId).toBe(
        yield* assertedIdentity(world, "tm-accepted"),
      );
      expect(outcome.materialized?.agentSessionId).toMatch(/^agent-tm-/);
      expect(yield* pending(world, "tm-accepted")).toBe(false);
      // The identity the caller was answered with was already durable: a save
      // asserting it appears in the store's own log, and every save after the
      // promotion asserts it too.
      const promoted = world.saves.findIndex(
        (record) => record.agentSessionId === outcome.materialized?.agentSessionId,
      );
      expect(promoted).toBeGreaterThan(-1);
      expect(
        world.saves.slice(promoted).every((record) => record.sessionMaterialization === undefined),
      ).toBe(true);
      yield* until(runtime.close({ handle, reason: "test" }));
    });

    it("TM3: the marker is consumed, never published as an event", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, ["accept", "chatter", "text"]);
      const handle = yield* place(world, runtime, "tm-quiet");

      const outcome = yield* takeTurn(runtime, handle, "hello");

      // Two `session_info_update`s were sent and one travels: the ordinary one.
      // So this is a claim about the marker rather than about session updates
      // being dropped.
      const infoUpdates = outcome.events.filter(
        (event) => (event as { tag?: string }).tag === "session_info_update",
      );
      expect(infoUpdates).toHaveLength(1);
      expect(JSON.stringify(outcome.events)).not.toContain(SESSION_MATERIALIZATION_META);
      // And it is not conversation either. The ordinary update's title reached
      // the record, and the marker left nothing behind at all.
      const record = yield* until(world.store.load("tm-quiet"));
      expect(record?.title).toBe("a title nobody asked about");
      expect(JSON.stringify(record)).not.toContain(SESSION_MATERIALIZATION_META);
      yield* until(runtime.close({ handle, reason: "test" }));
    });

    it("TM4: updates, text and a terminal result promote nothing", function* () {
      const world = yield* useWorld();
      // Everything an adapter does around a turn, and no acceptance: a
      // completed turn that produced an answer still says nothing about
      // whether the backend took it.
      const runtime = runtimeFor(world, ["chatter", "text"]);
      const handle = yield* place(world, runtime, "tm-silent");

      const outcome = yield* takeTurn(runtime, handle, "hello");

      expect(outcome.status).toBe("completed");
      expect(outcome.materialized).toBe(undefined);
      expect(outcome.refusal).toContain("materialization");
      expect(yield* pending(world, "tm-silent")).toBe(true);
      expect(yield* assertedIdentity(world, "tm-silent")).toBe(undefined);
      yield* until(runtime.close({ handle, reason: "test" }));
    });

    it("TM5: a turn that failed before acceptance leaves the record occupancy", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, ["chatter", "fail"]);
      const handle = yield* place(world, runtime, "tm-failed");

      const outcome = yield* takeTurn(runtime, handle, "hello");

      expect(outcome.status).toBe("failed");
      expect(outcome.materialized).toBe(undefined);
      expect(yield* pending(world, "tm-failed")).toBe(true);
      expect(yield* assertedIdentity(world, "tm-failed")).toBe(undefined);
      yield* until(runtime.close({ handle, reason: "test" }));
    });

    it("TM6: the next ensure creates fresh backend state, never the unaccepted one", function* () {
      const world = yield* useWorld();
      const first = runtimeFor(world, ["chatter"]);
      const placed = yield* place(world, first, "tm-retry");
      yield* takeTurn(first, placed, "hello");
      const abandoned = (yield* until(world.store.load("tm-retry")))?.acpSessionId;
      yield* until(first.close({ handle: placed, reason: "test" }));

      const retry = runtimeFor(world, ["accept", "text"]);
      const again = yield* place(world, retry, "tm-retry");
      const outcome = yield* takeTurn(retry, again, "again");

      // A record still marked pending is never reused: this session was
      // created, not resumed, so its ACP session is a different one.
      expect((yield* until(world.store.load("tm-retry")))?.acpSessionId).not.toBe(abandoned);
      expect(outcome.refusal).toBe(undefined);
      expect(yield* pending(world, "tm-retry")).toBe(false);
      expect(yield* assertedIdentity(world, "tm-retry")).toBe(outcome.materialized?.agentSessionId);
      yield* until(retry.close({ handle: again, reason: "test" }));
    });

    it("TM7: a session that already asserts one is satisfied at once", function* () {
      const world = yield* useWorld();
      const runtime = runtimeFor(world, ["accept", "text"]);
      const handle = yield* place(world, runtime, "tm-second");
      yield* takeTurn(runtime, handle, "hello");
      const asserted = yield* assertedIdentity(world, "tm-second");

      // The second turn never signals. It does not have to: this says the
      // session no longer awaits its first accepted turn, not that this turn
      // was accepted.
      const quiet = runtimeFor(world, ["text"]);
      const again = yield* until(
        quiet.ensureSession({
          sessionKey: "tm-second",
          agent: "fake",
          mode: "persistent",
          cwd: world.dir,
        }),
      );
      const outcome = yield* takeTurn(quiet, again, "more");

      expect(outcome.refusal).toBe(undefined);
      expect(outcome.materialized?.agentSessionId).toBe(asserted);
      yield* until(runtime.close({ handle, reason: "test" }));
      yield* until(quiet.close({ handle: again, reason: "test" }));
    });
  },
);
