/**
 * Tier AP — ACPX provider tests (specs/acp-client-spec.md §ACPX provider).
 *
 * Drives the provider through its dependencies with a scriptable fake runtime:
 * no agent process ever starts.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { Agent, Config } from "@executablemd/core";
import type {
  AgentLaunchRequest,
  AgentPromptEvent,
  AgentProviderAuthority,
  PromptOptions,
  Session,
} from "@executablemd/core";
import {
  createAcpxProvider,
  createPartitionedAcpxProvider,
  useAcpxProvider,
} from "../src/provider.ts";
import { TOOL_PERMISSION_REFUSED } from "../src/permission-bridge.ts";
import type {
  AcpxSessionContext,
  AcpxSessionIdentity,
  AcpxSessionPlacement,
  AcpxSessionPolicy,
} from "../src/provider.ts";
import { useSerialQueues } from "../src/serial-queue.ts";
import type { AcpxProvider } from "../src/provider.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import {
  createFakeRuntime,
  makeRecord,
  makeRegistry,
  makeStore,
  useFlatWorld,
  useGitWorld,
} from "./helpers.ts";
import type { AcpPermissionRequest, AcpRuntimeTurnResult } from "../src/acpx-runtime.ts";
import type { FakeRuntimeHarness } from "./helpers.ts";

const CWD = "/work";

function* installProvider(harness: FakeRuntimeHarness): Operation<void> {
  yield* useFlatWorld(CWD);
  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: makeStore(),
    agentRegistry: makeRegistry({ scribe: "scribe-cmd", other: "other-cmd" }),
  });
  yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());
}

function* collectPrompt(
  content: string,
  options?: PromptOptions,
): Operation<{ events: AgentPromptEvent[]; close: string }> {
  return yield* scoped(function* () {
    const stream = yield* Agent.operations.prompt(content, options);
    const subscription = yield* stream;
    const events: AgentPromptEvent[] = [];
    let next = yield* subscription.next();
    while (!next.done) {
      events.push(next.value);
      next = yield* subscription.next();
    }
    return { events, close: next.value };
  });
}

describe("Tier AP — ACPX provider", () => {
  it("AP1: a successful turn emits started, output deltas, terminal, and the close value", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* installProvider(harness);
      const { events, close } = yield* collectPrompt("describe this repo");

      expect(events[0]).toMatchObject({ type: "started", agent: "scribe" });
      const started = events[0]!;
      if (started.type === "started") {
        expect(started.session.sessionKey).toBe(deriveSessionKey("scribe-cmd", CWD));
        expect(started.session.cwd).toBe(CWD);
      }
      const deltas = events.filter((event) => event.type === "text_delta");
      expect(deltas.map((event) => (event.type === "text_delta" ? event.text : ""))).toEqual([
        "hello ",
        "world",
      ]);
      expect(events.at(-1)).toMatchObject({ type: "terminal", status: "completed" });
      expect(close).toBe("hello world");

      expect(harness.ensureCalls[0]).toMatchObject({
        sessionKey: deriveSessionKey("scribe-cmd", CWD),
        agent: "scribe",
        mode: "persistent",
        cwd: CWD,
      });
      expect(harness.turns[0]!.input.text).toBe("describe this repo");
    });
  });

  it("AP2: a non-end_turn stop reason fails the turn but keeps partial text", function* () {
    const harness = createFakeRuntime();
    harness.script({
      events: [{ type: "text_delta", text: "partial", stream: "output" }],
      result: { status: "completed", stopReason: "max_tokens" },
    });
    yield* scoped(function* () {
      yield* installProvider(harness);
      const { events, close } = yield* collectPrompt("long request");
      expect(events.at(-1)).toMatchObject({
        type: "terminal",
        status: "failed",
        stopReason: "max_tokens",
      });
      expect(close).toBe("partial");
    });
  });

  /**
   * The provider bounds a prompt by what its caller asked for and by nothing
   * else. `Config.timeout` is the deadline for the whole run (§Config), so
   * inheriting it here would have bounded every prompt by it.
   */
  it("AP3: an explicit prompt timeout is forwarded, and nothing else supplies one", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* Config.around({ timeout: () => 4_321, timeoutExec: () => 4_321 }, { at: "min" });
      yield* installProvider(harness);
      yield* collectPrompt("first", { timeout: 250 });
      yield* collectPrompt("second");
      expect(harness.turns[0]!.input.timeoutMs).toBe(250);
      expect(harness.turns[1]!.input.timeoutMs).toBe(undefined);
      expect(harness.createdOptions[0]!.timeoutMs).toBe(undefined);
    });
  });

  it("AP4: same-session prompts serialize; different sessions run concurrently", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* installProvider(harness);
      const first = yield* spawn(() => collectPrompt("one"));
      yield* sleep(10);
      expect(harness.turns.length).toBe(1);

      const second = yield* spawn(() => collectPrompt("two"));
      const elsewhere = yield* spawn(() => collectPrompt("three", { session: "separate" }));
      yield* sleep(10);
      // Same default session: "two" waits for the lock. Different
      // session: "three" starts immediately.
      expect(harness.turns.length).toBe(2);
      expect(harness.turns[1]!.input.text).toBe("three");

      harness.turns[0]!.finish([{ type: "text_delta", text: "done", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      const firstResult = yield* first;
      expect(firstResult.close).toBe("done");
      yield* second;
      yield* elsewhere;
      expect(harness.turns.length).toBe(3);
    });
  });

  it("AP12: permission routing registers the record's persisted session id, not stale handle state", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    const store = makeStore();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: store,
        agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
      });
      yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());

      // Simulate a prior turn's reconnect: the persisted record now
      // carries a replaced ACP session id that the handle predates.
      const sessionKey = deriveSessionKey("scribe-cmd", CWD);
      const record = makeRecord("scribe-cmd", CWD);
      record.acpxRecordId = `record:${sessionKey}`;
      record.acpSessionId = "replaced-id";
      store.records.set(record.acpxRecordId, record);

      const turn = yield* spawn(() => collectPrompt("during"));
      yield* sleep(20);
      const options = harness.createdOptions.find((created) => created.onPermissionRequest);
      expect(options).toBeDefined();
      const request: AcpPermissionRequest = {
        sessionId: "replaced-id",
        inferredKind: undefined,
        raw: {
          sessionId: "replaced-id",
          toolCall: { toolCallId: "call-1" },
          options: [{ optionId: "opt-reject", name: "Reject", kind: "reject_once" }],
        },
      };
      const signal = new AbortController().signal;
      const routed = yield* until(options!.onPermissionRequest!(request, { signal }));
      // Routed to the active prompt scope: the base policy denies.
      expect(routed).toEqual({ outcome: "reject_once" });

      const stale = yield* until(
        options!.onPermissionRequest!(
          {
            ...request,
            sessionId: `backend:${sessionKey}`,
            raw: { ...request.raw, sessionId: `backend:${sessionKey}` },
          },
          { signal },
        ),
      );
      // The handle's pre-replacement id no longer routes.
      expect(stale).toEqual({ outcome: "cancel" });

      harness.turns[0]!.finish([{ type: "text_delta", text: "ok", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* turn;
    });
  });

  it("AP13: a routed request reaches the scoped prompt policy; agentSessionId refreshes from the record", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    const store = makeStore();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: store,
        agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
      });
      yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());

      // The persisted record carries the authoritative ids after a
      // prior reconnect replaced both.
      const sessionKey = deriveSessionKey("scribe-cmd", CWD);
      const record = makeRecord("scribe-cmd", CWD);
      record.acpxRecordId = `record:${sessionKey}`;
      record.acpSessionId = "sid-2";
      record.agentSessionId = "agent-2";
      store.records.set(record.acpxRecordId, record);
      // A session that already exists, under the placement key a prompt
      // resolves to. Without it this prompt would be constructing the session
      // rather than reconnecting to one, and there would be no earlier
      // conversation whose ids a reconnect could have replaced.
      const placed = makeRecord("scribe-cmd", CWD);
      placed.acpxRecordId = sessionKey;
      placed.acpSessionId = "sid-2";
      placed.agentSessionId = "agent-2";
      store.records.set(sessionKey, placed);

      const started = withResolvers<Session>();
      const promptTask = yield* spawn(() =>
        scoped(function* () {
          // A scoped prompt policy (as <ApproveAll> installs).
          yield* Agent.around(
            {
              *requestPermission([request]) {
                return { outcome: "selected", optionId: request.options[0]!.optionId };
              },
            },
            { at: "min" },
          );
          const stream = yield* Agent.operations.prompt("go");
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            if (next.value.type === "started") {
              started.resolve(next.value.session);
            }
            next = yield* subscription.next();
          }
        }),
      );

      const session = yield* started.operation;
      // Point 4: the public Session metadata refreshed from the record.
      expect(session.agentSessionId).toBe("agent-2");

      const options = harness.createdOptions.find((created) => created.onPermissionRequest);
      const request: AcpPermissionRequest = {
        sessionId: "sid-2",
        inferredKind: undefined,
        raw: {
          sessionId: "sid-2",
          toolCall: { toolCallId: "call-1" },
          options: [{ optionId: "opt-allow", name: "Allow", kind: "allow_once" }],
        },
      };
      const routed = yield* until(
        options!.onPermissionRequest!(request, { signal: new AbortController().signal }),
      );
      // The scoped policy — not ACPX's mode resolver — decided.
      expect(routed).toEqual({ outcome: "allow_once" });

      harness.turns[0]!.finish([{ type: "text_delta", text: "ok", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* promptTask;
    });
  });

  it("AP17: a reconnect that changes the record's session id (A→B) still routes to the scope", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    const store = makeStore();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: store,
        agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
      });
      yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());

      const sessionKey = deriveSessionKey("scribe-cmd", CWD);
      const record = makeRecord("scribe-cmd", CWD);
      record.acpxRecordId = `record:${sessionKey}`;
      record.acpSessionId = "id-A";
      record.agentSessionId = "agent-A";
      store.records.set(record.acpxRecordId, record);

      const prompt = yield* spawn(() =>
        scoped(function* () {
          yield* Agent.around(
            {
              *requestPermission([request]) {
                return { outcome: "selected", optionId: request.options[0]!.optionId };
              },
            },
            { at: "min" },
          );
          const stream = yield* Agent.operations.prompt("go");
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
        }),
      );
      yield* sleep(20);

      // ACPX reconnected mid-turn and checkpointed the record with a new
      // ACP session id (and agent session id).
      record.acpSessionId = "id-B";
      record.agentSessionId = "agent-B";

      const options = harness.createdOptions.find((created) => created.onPermissionRequest);
      const request = (sessionId: string): AcpPermissionRequest => ({
        sessionId,
        inferredKind: undefined,
        raw: {
          sessionId,
          toolCall: { toolCallId: "call-1" },
          options: [{ optionId: "opt-allow", name: "Allow", kind: "allow_once" }],
        },
      });
      const abort = new AbortController().signal;

      // The new id B refreshes the registration and reaches the scoped
      // policy.
      const routedB = yield* until(
        options!.onPermissionRequest!(request("id-B"), { signal: abort }),
      );
      expect(routedB).toEqual({ outcome: "allow_once" });

      // The stale id A no longer routes.
      const staleA = yield* until(
        options!.onPermissionRequest!(request("id-A"), { signal: abort }),
      );
      expect(staleA).toEqual({ outcome: "cancel" });

      harness.turns[0]!.finish([{ type: "text_delta", text: "ok", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* prompt;
    });
  });

  it("AP14: prompts from different cwds that resolve to the same session serialize", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    const store = makeStore();
    const cwdRef = { value: "/repo" };
    yield* scoped(function* () {
      yield* useGitWorld(cwdRef, "/repo");
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: store,
        agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
      });
      yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());

      // Pre-seed the repo-root session so the walk from a subdir reuses it.
      const rootKey = deriveSessionKey("scribe-cmd", "/repo");
      const rootRecord = makeRecord("scribe-cmd", "/repo");
      rootRecord.acpxRecordId = `record:${rootKey}`;
      store.records.set(rootKey, rootRecord);

      // Prompt A from the repo root.
      const a = yield* spawn(() => collectPrompt("from-root"));
      yield* sleep(10);
      expect(harness.turns.length).toBe(1);

      // Prompt B from a subdir — resolves (nearest existing) to the same
      // root session key, so it SERIALIZES behind A.
      cwdRef.value = "/repo/sub";
      const b = yield* spawn(() => collectPrompt("from-subdir"));
      yield* sleep(10);
      expect(harness.turns.length).toBe(1);
      expect(harness.ensureCalls.every((call) => call.sessionKey === rootKey)).toBe(true);

      harness.turns[0]!.finish([{ type: "text_delta", text: "one", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* a;
      yield* sleep(10);
      expect(harness.turns.length).toBe(2);
      harness.turns[1]!.finish([{ type: "text_delta", text: "two", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* b;
    });
  });

  it("AP15: A2 waits for A1 without holding the global route slot, so B1 starts", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const routeQueue = yield* useSerialQueues();
      // A single global route queue models test-agent's route slot; if
      // it were held while a prompt waited on the session queue, B1
      // could not enter its own routed section.
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: makeStore(),
        agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
        withSessionRoute: (_context, op) => routeQueue.withSlot("route", op),
      });
      yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());

      const a1 = yield* spawn(() => collectPrompt("a1"));
      yield* sleep(10);
      expect(harness.turns.length).toBe(1);

      // A2 — same default session — queues on the session slot.
      const a2 = yield* spawn(() => collectPrompt("a2"));
      // B1 — different session — must start immediately, proving A2 is
      // NOT holding the global route slot while it waits.
      const b1 = yield* spawn(() => collectPrompt("b1", { session: "other" }));
      yield* sleep(10);
      expect(harness.turns.length).toBe(2);
      expect(harness.turns[1]!.input.text).toBe("b1");

      harness.turns[0]!.finish([{ type: "text_delta", text: "x", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* a1;
      yield* sleep(10);
      // A2 now admitted.
      expect(harness.turns.some((turn) => turn.input.text === "a2")).toBe(true);
      for (const turn of harness.turns) {
        if (!turn.cancelled) {
          turn.finish([], { status: "completed", stopReason: "end_turn" });
        }
      }
      yield* a2;
      yield* b1;
    });
  });

  it("AP16: an explicit session() waits on the same session queue as an active turn", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* installProvider(harness);
      const order: string[] = [];

      const turn = yield* spawn(() => collectPrompt("turn"));
      yield* sleep(10);
      expect(harness.turns.length).toBe(1);

      const sessionCall = yield* spawn(function* () {
        yield* Agent.operations.session();
        order.push("session-resolved");
      });
      yield* sleep(10);
      // session() is blocked behind the active turn's session slot.
      expect(order).toEqual([]);

      harness.turns[0]!.finish([{ type: "text_delta", text: "done", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* turn;
      yield* sessionCall;
      // …and returns once the turn releases the slot (not held for the
      // surrounding scope).
      expect(order).toEqual(["session-resolved"]);
    });
  });

  it("AP11: a prompt halted while queued never blocks the session queue", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* installProvider(harness);
      const first = yield* spawn(() => collectPrompt("one"));
      yield* sleep(10);
      expect(harness.turns.length).toBe(1);

      // Queued behind "one", then halted before ever being granted.
      const abandoned = yield* spawn(() => collectPrompt("two"));
      yield* sleep(10);
      yield* abandoned.halt();

      harness.turns[0]!.finish([{ type: "text_delta", text: "done", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      yield* first;

      // The old withResolvers chain deadlocked here: the halted
      // request's link never resolved.
      const third = yield* collectPrompt("three");
      expect(third.close).toBe("hello world");
      expect(harness.turns.length).toBe(2);
    });
  });

  it("AP5: halting a prompt mid-turn cancels its ACPX turn", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* installProvider(harness);
      const task = yield* spawn(() => collectPrompt("interrupted"));
      yield* sleep(10);
      expect(harness.turns.length).toBe(1);
      yield* task.halt();
      expect(harness.turns[0]!.cancelled).toBe(true);
    });
  });

  it("AP6: a completed turn is never cancelled afterward", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* installProvider(harness);
      yield* collectPrompt("finishes normally");
      expect(harness.turns[0]!.cancelled).toBe(false);
    });
  });

  it("AP7: teardown closes each distinct handle; close failures throw from the provider scope", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* installProvider(harness);
      yield* collectPrompt("hello");
    });
    expect(harness.closeCalls.length).toBe(1);

    const failing = createFakeRuntime();
    failing.closeFailure = new Error("close exploded");
    let thrown: unknown;
    try {
      yield* scoped(function* () {
        yield* installProvider(failing);
        yield* collectPrompt("one");
        yield* collectPrompt("two", { session: "second" });
      });
    } catch (error) {
      thrown = error;
    }
    expect(failing.closeCalls.length).toBe(2);
    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.message).toBe("agent provider teardown failed");
      expect(thrown.errors.length).toBe(2);
    }
  });

  it("AP8: availability uses doctor(); failures throw and successes are cached", function* () {
    const harness = createFakeRuntime();
    harness.doctorReports.push({
      ok: false,
      code: "ACP_BACKEND_UNAVAILABLE",
      message: "scribe not installed",
      details: ["agent=scribe"],
    });
    yield* scoped(function* () {
      yield* installProvider(harness);
      let thrown: unknown;
      try {
        yield* Agent.operations.agent("scribe");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      if (thrown instanceof Error) {
        expect(thrown.message).toContain("ACP_BACKEND_UNAVAILABLE");
        expect(thrown.message).toContain("scribe not installed");
      }

      // The failed probe is not cached; the next probe succeeds and is.
      expect(yield* Agent.operations.agent("scribe")).toBe("scribe");
      expect(yield* Agent.operations.agent("scribe")).toBe("scribe");
      expect(harness.doctorCalls).toBe(2);
    });
  });

  it("AP10: sibling provider states are fully independent", function* () {
    const first = createFakeRuntime();
    const second = createFakeRuntime();
    yield* useFlatWorld(CWD);

    function* installState(harness: FakeRuntimeHarness): Operation<AcpxProvider> {
      const state = yield* useAcpxProvider(
        { defaultAgent: "scribe", permissionMode: "deny-all" },
        {
          createRuntime: harness.create,
          sessionStore: makeStore(),
          agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
        },
      );
      yield* Agent.around(
        {
          *agent([name], _next) {
            return yield* state.agent(name);
          },
          *session([option], _next) {
            return yield* state.session(option);
          },
          *prompt([content, options], _next) {
            return state.promptStream(content, options);
          },
        },
        { at: "min" },
      );
      return state;
    }

    yield* scoped(function* () {
      yield* installState(first);
      const { close } = yield* collectPrompt("first state");
      expect(close).toBe("hello world");
    });
    expect(first.closeCalls.length).toBe(1);
    expect(second.createdOptions.length).toBe(0);

    yield* scoped(function* () {
      yield* installState(second);
      yield* collectPrompt("second state");
    });
    // The sibling state probed and closed on its own: nothing was shared
    // with the first state's caches or teardown.
    expect(second.doctorCalls).toBe(1);
    expect(second.closeCalls.length).toBe(1);
    expect(first.closeCalls.length).toBe(1);
  });

  it("AP9: unknown, stale, or agent-mismatched sessions are rejected", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* installProvider(harness);
      const stale: Session = { sessionKey: "xmd:v1:nope:0000000000000000:default", cwd: CWD };
      let unknownError: unknown;
      try {
        yield* collectPrompt("hi", { session: stale });
      } catch (error) {
        unknownError = error;
      }
      expect(unknownError).toBeInstanceOf(Error);
      if (unknownError instanceof Error) {
        expect(unknownError.message).toContain("unknown or stale agent session");
      }

      const session = yield* Agent.operations.session();
      let mismatchError: unknown;
      try {
        yield* collectPrompt("hi", { agent: "other", session });
      } catch (error) {
        mismatchError = error;
      }
      expect(mismatchError).toBeInstanceOf(Error);
      if (mismatchError instanceof Error) {
        expect(mismatchError.message).toContain("does not match session");
      }
    });
  });
});

/** What a partition owner holds: the public handle, and nothing more. */
interface Partition {
  handle: AcpxProvider;
  /** Deliberately answers with no partition, for the absence case. */
  absent(): AcpxProvider | undefined;
}

function* usePartition(harness: FakeRuntimeHarness): Operation<Partition> {
  const handle = yield* useAcpxProvider(
    { defaultAgent: "scribe", permissionMode: "deny-all" },
    {
      createRuntime: harness.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ scribe: "scribe-cmd", other: "other-cmd" }),
    },
  );
  return { handle, absent: () => undefined };
}

/** A stand-in for what core delivers to an installed factory. */
interface AuthorityLog extends AgentProviderAuthority {
  performed: number;
  refused: number;
  /**
   * Every provider turn this provider named, in the order it named them.
   *
   * Recorded as it arrived, unparsed. What the provider decided to associate is
   * exactly what a suite here is asking about, so reading it back through a
   * parser of this suite's own would be asking a different question.
   */
  checkpoints: unknown[];
}

function stubAuthority(): AuthorityLog {
  const log: AuthorityLog = {
    performed: 0,
    refused: 0,
    checkpoints: [],
    checkpoint: (_terminal, token) => {
      log.checkpoints.push(token);
    },
    // These suites route launches, never a `<Session>` placement. Throwing
    // rather than answering means a placement that did reach here fails
    // loudly instead of being handed an identity nobody derived.
    sessionIdentity: () => {
      throw new Error("this stub authority routes no session placement");
    },
    // deno-lint-ignore require-yield
    *perform() {
      log.performed += 1;
    },
    // deno-lint-ignore require-yield
    *refuse() {
      log.refused += 1;
    },
  };
  return log;
}

/** A routed request's shape, for a dispatch that never reaches core. */
function fakeRequest(): AgentLaunchRequest {
  const request = {
    instructions: "You are the implementor.",
    agent: "scribe",
    cwd: CWD,
    additionalDirectories: [],
    permissionMode: "deny-all",
    with: () => request,
  };
  return request as AgentLaunchRequest;
}

/**
 * Install one partition-selecting factory, counting what it selected.
 *
 * The default selector answers with a partition this scope owns, which is the
 * ordinary case; a test that is about the selector supplies its own.
 */
function* installPartitioned(
  harness: FakeRuntimeHarness,
  options: { select?: () => AcpxProvider | undefined } = {},
): Operation<{ authority: AuthorityLog; selections: () => number }> {
  yield* useFlatWorld(CWD);
  const owned = options.select ? undefined : yield* usePartition(harness);
  let selections = 0;
  const factory = createPartitionedAcpxProvider(function* () {
    selections += 1;
    return options.select ? options.select() : owned!.handle;
  });
  const authority = stubAuthority();
  yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, authority);
  return { authority, selections: () => selections };
}

/**
 * Tier PT — one installed factory over isolated provider partitions
 * (issue-518-test-agent-provider-partition-architect-amendment.md).
 *
 * Authority has to be installed where the content it serves is projected, and
 * isolation has to be per `<Test>`. Both hold because installation and state
 * are different things: one factory is installed, and it selects which complete
 * provider state to act on for each dispatch.
 *
 * What that buys has to be paid for structurally, not by convention. A handle
 * is a way to reach work, never permission — so these ask what happens when the
 * selector answers with something this module never created, with a partition
 * its owner has already dismantled, or with nothing at all.
 */
/**
 * Tier SM — session placement and materialization
 * (specs/acp-client-spec.md §Session lifecycle).
 *
 * A fresh `<Session>` places a session: it validates and pins where a logical
 * session will live and constructs nothing. The first consuming operation
 * chooses how it is constructed, and an ACP-first construction is not a
 * conversation until the backend accepts its first turn.
 *
 * What these ask is what the provider does around that boundary — what it does
 * not do while a placement is pending, what order it does things in once a turn
 * is accepted, and what it refuses.
 */
describe("Tier SM — session placement and materialization", () => {
  it("SM1: a fresh Session constructs nothing at all", function* () {
    const harness = createFakeRuntime();
    const store = makeStore();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: store,
        agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
      });
      yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());

      const session = yield* Agent.operations.session();

      expect(session.sessionKey).toBe(deriveSessionKey("scribe-cmd", CWD));
      expect(session.cwd).toBe(CWD);
      // Placement, and nothing else: no session was ensured, no handle exists,
      // no record was written, no turn was started, and nothing is asserted
      // about a conversation. The availability probe beside it is agent
      // resolution — it opens a disposable runtime of its own and touches no
      // session.
      expect(harness.ensureCalls).toEqual([]);
      expect(harness.handleIds).toEqual([]);
      expect(harness.turns).toEqual([]);
      expect([...store.records.keys()]).toEqual([]);
      expect(session.agentSessionId).toBe(undefined);
    });
  });

  it("SM2: the same value comes back, and a copy of it is refused", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* installProvider(harness);
      const session = yield* Agent.operations.session();

      // The exact value, so a document that pinned it around a body is holding
      // the thing this provider will admit.
      expect(yield* Agent.operations.session()).toBe(session);

      // A structural copy carrying the same key was issued by nobody, and
      // provenance is the object rather than the string inside it.
      let refused: Error | undefined;
      try {
        yield* collectPrompt("go", { session: { ...session } });
      } catch (error) {
        refused = error as Error;
      }

      expect(refused?.message).toContain("must come from this provider's session()");
      expect(harness.ensureCalls).toEqual([]);
    });
  });

  it("SM3: the first prompt ensures and starts a turn through one handle", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* installProvider(harness);
      const session = yield* Agent.operations.session();

      yield* collectPrompt("go", { session });

      // One ensure, and the turn went through the handle that ensure answered
      // with — not a second one opened between them.
      expect(harness.handleIds).toHaveLength(1);
      expect(harness.turns).toHaveLength(1);
      expect(harness.turns[0]!.input.handle.runtimeSessionName).toBe(harness.handleIds[0]);
      // Deferred, so the record ACPX wrote is occupancy rather than an
      // assertion.
      expect(harness.ensureCalls[0]!.materialization).toBe("first-turn-acceptance");
      // And nothing closed in between.
      expect(harness.closeCalls).toEqual([]);
    });
  });

  it("SM4: acceptance promotes before the host mapping, and a turn is never remapped", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness);
      const session = yield* Agent.operations.session();

      // Placed, and nothing retained: a key is occupied and no conversation is
      // named, so the host has nothing to map yet.
      expect(log.places).toHaveLength(1);
      expect(log.established).toEqual([]);
      expect(harness.ensureCalls).toEqual([]);

      yield* collectPrompt("first", { session });

      expect(log.established).toHaveLength(1);
      expect(log.established[0]!.agentSessionId).toBe(`agent-session:${WORKFLOW_SESSION_KEY}`);

      // A second turn continues the conversation the first established: it
      // neither creates it again nor maps it again.
      yield* collectPrompt("second", { session });

      expect(harness.turns).toHaveLength(2);
      expect(log.established).toHaveLength(1);
      expect(log.places).toHaveLength(1);
    });
  });

  it("SM5: a first turn nobody accepted retains nothing, and stays pending", function* () {
    const harness = createFakeRuntime();
    harness.script({ accepted: false });
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness);
      const session = yield* Agent.operations.session();

      let raised: Error | undefined;
      try {
        yield* collectPrompt("first", { session });
      } catch (error) {
        raised = error as Error;
      }

      expect(raised).toBeInstanceOf(Error);
      // No mapping, no identity on the value the document holds, and the
      // provider's own record still says it is awaiting one.
      expect(log.established).toEqual([]);
      expect(session.agentSessionId).toBe(undefined);
      expect(log.store.records.get(WORKFLOW_SESSION_KEY)?.agentSessionId).toBe(undefined);
      expect(log.store.records.get(WORKFLOW_SESSION_KEY)?.sessionMaterialization?.state).toBe(
        "pending",
      );

      // The same pending value retries and establishes once.
      yield* collectPrompt("again", { session });

      expect(harness.ensureCalls).toHaveLength(2);
      expect(log.established).toHaveLength(1);
      expect(session.agentSessionId).toBe(`agent-session:${WORKFLOW_SESSION_KEY}`);
    });
  });

  it("SM6: acceptance followed by a failed turn leaves the session established", function* () {
    const harness = createFakeRuntime();
    harness.script({
      events: [{ type: "text_delta", text: "partial", stream: "output" }],
      result: { status: "failed", error: { message: "the model gave up" } },
    });
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness);
      const session = yield* Agent.operations.session();

      let raised: Error | undefined;
      let events: AgentPromptEvent[] = [];
      try {
        events = (yield* collectPrompt("first", { session })).events;
      } catch (error) {
        raised = error as Error;
      }

      // Acceptance is the boundary, not successful terminal text: the backend
      // took this turn, so the conversation exists whatever the turn then did.
      // How the failure reaches the reader is Tier AP's question; that it did
      // is this one's premise.
      const failed =
        raised !== undefined ||
        events.some((event) => event.type === "terminal" && event.status !== "completed");
      expect(failed).toBe(true);
      expect(log.established).toHaveLength(1);
      expect(log.store.records.get(WORKFLOW_SESSION_KEY)?.sessionMaterialization).toBe(undefined);

      // And the next prompt continues it rather than constructing a second one.
      yield* collectPrompt("second", { session });

      expect(log.established).toHaveLength(1);
      expect(harness.ensureCalls).toHaveLength(1);
      expect(harness.turns).toHaveLength(2);
    });
  });

  it("SM7: concurrent first prompts construct one session between them", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness);
      const session = yield* Agent.operations.session();

      const first = yield* spawn(() => collectPrompt("one", { session }));
      const second = yield* spawn(() => collectPrompt("two", { session }));
      yield* first;
      yield* second;

      // One backend creation, one retained identity, and two turns in the
      // conversation it established.
      expect(harness.ensureCalls.filter((call) => call.materialization !== undefined)).toHaveLength(
        1,
      );
      expect(log.established).toHaveLength(1);
      expect(harness.turns).toHaveLength(2);
    });
  });

  it("SM9: a mapping that failed after the promotion leaves one canonical assertion", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness, { refuseFirstRetention: true });
      const session = yield* Agent.operations.session();

      let raised: Error | undefined;
      try {
        yield* collectPrompt("first", { session });
      } catch (error) {
        raised = error as Error;
      }

      // The pre-commit window: the provider's own record was promoted and
      // asserts a conversation, and the host never recorded what it is.
      expect(raised?.message).toContain("could not retain this session");
      const asserted = log.store.records.get(WORKFLOW_SESSION_KEY)?.agentSessionId;
      expect(asserted).toBe(`agent-session:${WORKFLOW_SESSION_KEY}`);
      expect(log.store.records.get(WORKFLOW_SESSION_KEY)?.sessionMaterialization).toBe(undefined);

      // The next attachment meets that one assertion, commits it, and creates
      // nothing in its place.
      yield* collectPrompt("again", { session });

      expect(log.established.map((identity) => identity.agentSessionId)).toEqual([
        asserted,
        asserted,
      ]);
      expect(log.store.records.get(WORKFLOW_SESSION_KEY)?.agentSessionId).toBe(asserted);
      expect([...log.store.records.keys()]).toEqual([WORKFLOW_SESSION_KEY]);
    });
  });

  it("SM8: a value from a torn-down provider reaches no session state", function* () {
    const harness = createFakeRuntime();
    let escaped: Session | undefined;
    yield* scoped(function* () {
      yield* installProvider(harness);
      escaped = yield* Agent.operations.session();
    });

    yield* scoped(function* () {
      yield* installProvider(createFakeRuntime());
      let refused: Error | undefined;
      try {
        yield* collectPrompt("go", { session: escaped });
      } catch (error) {
        refused = error as Error;
      }
      expect(refused?.message).toContain("must come from this provider's session()");
    });
  });
});

describe("Tier PT — partitioned provider installation", () => {
  it("PT1: the selector runs afresh for every dispatch", function* () {
    // Never cached across calls: a partition selected once and reused would
    // make the second `<Test>` act on the first one's sessions.
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const { selections } = yield* installPartitioned(harness);

      // Counted as growth rather than as totals: `session()` resolves an agent
      // on its way, and that is a dispatch too. What matters is that no call
      // reuses a partition chosen by an earlier one.
      const grew: number[] = [];
      let seen = 0;
      const since = () => {
        const grown = selections() - seen;
        seen = selections();
        return grown;
      };

      yield* Agent.operations.agent("scribe");
      grew.push(since());
      yield* Agent.operations.session("one");
      grew.push(since());
      yield* collectPrompt("hello");
      grew.push(since());

      expect(grew.every((count) => count > 0)).toBe(true);
    });
  });

  it("PT2: constructing a prompt stream selects nothing", function* () {
    // Selection belongs inside subscription, with the rest of a turn's work. A
    // stream nobody subscribed to has chosen no state and started nothing.
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const { selections } = yield* installPartitioned(harness);

      const stream = yield* Agent.operations.prompt("held", {});
      expect(stream).toBeDefined();

      expect(selections()).toBe(0);
      expect(harness.ensureCalls).toEqual([]);
    });
  });

  it("PT3: no current partition refuses, and never falls back to another", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      // A second, perfectly usable partition exists. Absence must not quietly
      // become "some other test's state".
      const spare = yield* usePartition(harness);
      yield* installPartitioned(harness, { select: () => spare.absent() });

      let refused: Error | undefined;
      try {
        yield* Agent.operations.session("one");
      } catch (error) {
        refused = error instanceof Error ? error : new Error(String(error));
      }

      expect(refused?.message).toContain("no agent provider partition");
      expect(harness.ensureCalls).toEqual([]);
    });
  });

  it("PT4: no handle reflection can build authorizes anything", function* () {
    // Shape is not identity, and neither is reflection. Each of these is
    // everything a holder of a live handle can produce from it, and none of
    // them reaches the state behind it.
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const real = yield* usePartition(harness);
      const live = real.handle;

      const forgeries: Record<string, () => AcpxProvider> = {
        // Rebuilt from the operations it offers.
        structural: () => ({
          agent: (name) => live.agent(name),
          session: (option) => live.session(option),
          promptStream: (content, options) => live.promptStream(content, options),
        }),
        // Every own property descriptor, on the same prototype: the closest
        // copy reflection can make of the object itself.
        descriptors: () =>
          Object.create(
            Object.getPrototypeOf(live),
            Object.getOwnPropertyDescriptors(live),
          ) as AcpxProvider,
        // Built on the prototype alone, so every method is the real one.
        prototype: () => Object.create(Object.getPrototypeOf(live)) as AcpxProvider,
        // Delegating to a live handle for everything a reader can see.
        delegating: () => Object.create(live) as AcpxProvider,
      };

      for (const [shape, build] of Object.entries(forgeries)) {
        yield* scoped(function* () {
          yield* installPartitioned(harness, { select: () => build() });

          let refused: Error | undefined;
          try {
            yield* Agent.operations.session("one");
          } catch (error) {
            refused = error instanceof Error ? error : new Error(String(error));
          }

          expect([
            shape,
            refused?.message?.includes("not a live agent provider partition"),
          ]).toEqual([shape, true]);
        });
      }
      // Refused before provider work, every time.
      expect(harness.ensureCalls).toEqual([]);
    });
  });

  it("PT5: a partition its owner dismantled can no longer be selected", function* () {
    const harness = createFakeRuntime();
    const closed = yield* scoped(function* () {
      const partition = yield* usePartition(harness);
      return partition.handle;
    });

    yield* scoped(function* () {
      yield* installPartitioned(harness, { select: () => closed });

      let refused: Error | undefined;
      try {
        yield* Agent.operations.session("one");
      } catch (error) {
        refused = error instanceof Error ? error : new Error(String(error));
      }

      expect(refused?.message).toContain("not a live agent provider partition");
      expect(harness.ensureCalls).toEqual([]);
    });
  });

  it("PT6: reflection over a handle finds no state and no launch", function* () {
    // The embedder surface is the non-authoritative half. There is no launch on
    // it to call and no way to read one out of it, so holding a partition and
    // holding a request still adds up to nothing.
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const partition = yield* usePartition(harness);
      const handle = partition.handle;

      // Nothing of its own at all: the state lives in a private field, which
      // appears in no key list and no descriptor.
      expect(Reflect.ownKeys(handle)).toEqual([]);
      expect(Object.getOwnPropertySymbols(handle)).toEqual([]);
      expect(Object.values(Object.getOwnPropertyDescriptors(handle))).toEqual([]);

      // The callable surface, wherever it lives, is the three public operations.
      const surface: string[] = [];
      for (
        let target: object | null = Object.getPrototypeOf(handle);
        target && target !== Object.prototype;
        target = Object.getPrototypeOf(target)
      ) {
        for (const key of Reflect.ownKeys(target)) {
          if (key !== "constructor") {
            surface.push(String(key));
          }
        }
      }
      expect(surface.sort()).toEqual(["agent", "promptStream", "session"]);
      expect("launch" in handle).toBe(false);

      // The class is reachable through the instance, as every class is. What it
      // does not carry is a way in: no resolver, and a constructor that refuses
      // anyone holding a state of their own.
      const constructor = Object.getPrototypeOf(handle).constructor as new (
        ...args: unknown[]
      ) => unknown;
      expect(Reflect.ownKeys(constructor).sort()).toEqual(["length", "name", "prototype"]);
      let built: unknown;
      let refused: Error | undefined;
      try {
        built = new constructor(Symbol("admit"), { launch: () => {} });
      } catch (error) {
        refused = error instanceof Error ? error : new Error(String(error));
      }
      expect(built).toBe(undefined);
      expect(refused?.message).toContain("created by the provider that owns its state");
    });
  });

  it("PT7: a launch reaches the selected partition through the installed factory", function* () {
    // The other direction, and the one the whole shape exists for: the factory
    // core installed is what pairs a routed request with its authority, and the
    // work lands on whichever partition was selected for that dispatch.
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const { authority, selections } = yield* installPartitioned(harness);

      yield* Agent.operations.launch(fakeRequest());

      expect(selections()).toBe(1);
      expect(authority.performed).toBe(1);
    });
  });
});

/**
 * Tier WAP — the strict workflow Agent profile
 * (specs/acp-client-spec.md §Workflow Agent profile).
 *
 * The profile is the provider's own dependencies, so these drive it exactly as
 * the Deno workflow host composes it: a host-decided working directory, no MCP
 * servers, an empty requested tool set, and a permission path the public Agent
 * chain does not reach. The contextual cwd is a Workspace root throughout,
 * because "the Agent never sees it" is the claim.
 */

/** The logical Workspace root a workflow document's contextual cwd answers with. */
const WORKSPACE = "/workspace";

/** The runtime's own directory: provider-owned, and not a checkout. */
const HOST_DIR = "/runs/sessions/host";

/** One logical session's directory, as the host places it. */
const SESSION_DIR = "/runs/sessions/cwd/8f2a";

const WORKFLOW_SESSION_KEY = "xmd:workflow:v1:run:acpx:scribe-cmd:default";

const INSTRUCTIONS = "You have no native tool authority here.";

/** The ACP session id a seeded record routes a permission request under. */
const ACP_SESSION_ID = "acp-session-workflow";

interface StrictHarness {
  /** Every placement the profile was asked for, in order. */
  places: AcpxSessionContext[];
  /** Every identity the provider retained, in order. */
  established: AcpxSessionIdentity[];
  /** Public permission decisions the authored policy was asked for. */
  consulted: number;
  /** The ACPX store behind the provider, so a test can seed a record. */
  store: ReturnType<typeof makeStore>;
}

function* installStrictProvider(
  harness: FakeRuntimeHarness,
  options: {
    place?: () => Operation<AcpxSessionPlacement>;
    /** Fail the first retention, as a host interrupted before its commit does. */
    refuseFirstRetention?: boolean;
  } = {},
): Operation<StrictHarness> {
  const store = makeStore();
  const log: StrictHarness = { places: [], established: [], consulted: 0, store };
  yield* useFlatWorld(WORKSPACE);
  const sessions: AcpxSessionPolicy = {
    *place(context) {
      log.places.push(context);
      if (options.place) {
        return yield* options.place();
      }
      return { sessionKey: WORKFLOW_SESSION_KEY, cwd: SESSION_DIR, state: "pending" };
    },
    // deno-lint-ignore require-yield
    *established(_placement, identity) {
      log.established.push(identity);
      if (options.refuseFirstRetention && log.established.length === 1) {
        throw new Error("the run could not retain this session");
      }
    },
  };
  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: store,
    agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
    // deno-lint-ignore require-yield
    agentCwd: function* () {
      return HOST_DIR;
    },
    mcpServers: [],
    newSessionOptions: { allowedTools: [], systemPrompt: INSTRUCTIONS },
    permissions: "strict",
    sessions,
  });
  yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());
  // An authored approve-all scope, installed the way `<ApproveAll>` installs
  // one. Under this profile it must reach no decision at all.
  yield* Agent.around({
    // deno-lint-ignore require-yield
    *requestPermission([request]) {
      log.consulted += 1;
      const allow = request.options.find((option) => option.kind === "allow_once");
      return allow === undefined
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: allow.optionId };
    },
  });
  return log;
}

/**
 * Route a permission request to the turn on `sessionKey`.
 *
 * The bridge routes by the ACP session id the run's persisted record carries, so
 * a test that wants a request delivered seeds that record — exactly as ACPX
 * checkpoints one before running a prompt.
 */
function seedRoutedRecord(store: ReturnType<typeof makeStore>, sessionKey: string, cwd: string) {
  const record = makeRecord("scribe-cmd", cwd);
  record.acpxRecordId = `record:${sessionKey}`;
  record.acpSessionId = ACP_SESSION_ID;
  store.records.set(record.acpxRecordId, record);
}

/** One permission request an adapter makes, carrying material a refusal must not echo. */
function toolRequest(sessionId: string, marker: string): AcpPermissionRequest {
  return {
    sessionId,
    inferredKind: undefined,
    raw: {
      sessionId,
      toolCall: {
        toolCallId: "call-1",
        title: `read ${marker}`,
        rawInput: { command: `cat ${marker}`, path: marker },
      },
      options: [
        { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
        { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
      ],
    },
  };
}

describe("Tier WAP — strict workflow Agent profile", () => {
  it("WAP1: the runtime and every session are created with the host's own empty directory, no MCP and no tools", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness);
      yield* collectPrompt("summarize the retained work");

      const created = harness.createdOptions.find((options) => options.onPermissionRequest);
      expect(created?.cwd).toBe(HOST_DIR);
      expect(created?.mcpServers).toEqual([]);
      expect(created?.permissionMode).toBe("deny-all");
      expect(created?.nonInteractivePermissions).toBe("deny");

      expect(harness.ensureCalls).toHaveLength(1);
      expect(harness.ensureCalls[0]).toMatchObject({
        sessionKey: WORKFLOW_SESSION_KEY,
        agent: "scribe",
        mode: "persistent",
        cwd: SESSION_DIR,
      });
      // The empty array is the statement, so omission is not equivalent to it.
      expect(harness.ensureCalls[0]!.sessionOptions?.allowedTools).toEqual([]);
      expect(harness.ensureCalls[0]!.sessionOptions?.systemPrompt).toBe(INSTRUCTIONS);

      // The host placed the session; nothing walked the contextual directory.
      expect(log.places).toEqual([
        { agentName: "scribe", agentCommand: "scribe-cmd", session: undefined },
      ]);
      expect(log.established).toEqual([
        {
          agentSessionId: `agent-session:${WORKFLOW_SESSION_KEY}`,
          acpxRecordId: `record:${WORKFLOW_SESSION_KEY}`,
        },
      ]);

      // No Workspace or caller path reaches the provider at all.
      const inputs = JSON.stringify({
        created: harness.createdOptions.map((options) => options.cwd),
        ensured: harness.ensureCalls,
        turns: harness.turns.map((turn) => turn.input),
      });
      expect(inputs).not.toContain(WORKSPACE);
    });
  });

  it("WAP2: a native permission request is denied and fails the turn, whatever the document approved", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness);
      seedRoutedRecord(log.store, WORKFLOW_SESSION_KEY, SESSION_DIR);
      const prompt = yield* spawn(() => collectPrompt("inspect the repository"));
      yield* sleep(20);

      const created = harness.createdOptions.find((options) => options.onPermissionRequest);
      const decision = yield* until(
        created!.onPermissionRequest!(toolRequest(ACP_SESSION_ID, "SECRET_PATH"), {
          signal: new AbortController().signal,
        }),
      );
      // A rejection where ACP offered one, and never the allow the authored
      // policy would have selected.
      expect(decision).toEqual({ outcome: "reject_once" });
      // The public chain is not consulted: there is no authority to widen.
      expect(log.consulted).toBe(0);

      // The adapter carries on regardless and reports success.
      harness.turns[0]!.finish([{ type: "text_delta", text: "done", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      const { events } = yield* prompt;
      const terminal = events.at(-1);
      expect(terminal).toMatchObject({ type: "terminal", status: "failed" });
      const failure = terminal?.type === "terminal" ? terminal.error : undefined;
      expect(failure?.message).toBe(TOOL_PERMISSION_REFUSED);
      expect(failure?.name).toBe("AgentToolPermissionRefused");
    });
  });

  it("WAP3: a completed, failed or cancelled turn finishes its turn and its handle", function* () {
    const exits = [
      { name: "completed", result: { status: "completed", stopReason: "end_turn" } },
      { name: "failed", result: { status: "completed", stopReason: "max_tokens" } },
      { name: "cancelled", result: { status: "cancelled" } },
    ] as const;
    for (const exit of exits) {
      const harness = createFakeRuntime();
      harness.script({ result: exit.result });
      yield* scoped(function* () {
        yield* installStrictProvider(harness);
        yield* collectPrompt(`turn that ends ${exit.name}`);
        // The turn's own finalizers ran with the prompt's scope, before this.
        expect(harness.turns).toHaveLength(1);
      });
      // Provider teardown closed the handle it opened, on every exit.
      expect(harness.closeCalls.map((handle) => handle.sessionKey)).toEqual([WORKFLOW_SESSION_KEY]);
    }
  });

  it("WAP3: an interrupted turn is cancelled and its handle still closes", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    yield* scoped(function* () {
      yield* installStrictProvider(harness);
      const prompt = yield* spawn(() => collectPrompt("a turn nobody waits for"));
      yield* sleep(20);
      yield* prompt.halt();
      expect(harness.turns[0]!.cancelled).toBe(true);
    });
    expect(harness.closeCalls.map((handle) => handle.sessionKey)).toEqual([WORKFLOW_SESSION_KEY]);
  });

  it("WAP4: the ordinary provider keeps the caller's directory, omits MCP and session restrictions, and routes permissions publicly", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    const store = makeStore();
    let consulted = 0;
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const factory = createAcpxProvider({
        createRuntime: harness.create,
        sessionStore: store,
        agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
      });
      yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());
      yield* Agent.around({
        // deno-lint-ignore require-yield
        *requestPermission([request]) {
          consulted += 1;
          const allow = request.options.find((option) => option.kind === "allow_once");
          return allow === undefined
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: allow.optionId };
        },
      });
      const sessionKey = deriveSessionKey("scribe-cmd", CWD);
      seedRoutedRecord(store, sessionKey, CWD);
      const prompt = yield* spawn(() => collectPrompt("ordinary run"));
      yield* sleep(20);

      const created = harness.createdOptions.find((options) => options.onPermissionRequest);
      expect(created?.cwd).toBe(CWD);
      expect(created?.mcpServers).toBe(undefined);
      expect(harness.ensureCalls[0]!.cwd).toBe(CWD);
      expect(harness.ensureCalls[0]!.sessionOptions).toBe(undefined);

      const decision = yield* until(
        created!.onPermissionRequest!(toolRequest(ACP_SESSION_ID, "MARKER"), {
          signal: new AbortController().signal,
        }),
      );
      // The authored policy decided, which is what `xmd run` has always done.
      expect(consulted).toBe(1);
      expect(decision).toEqual({ outcome: "allow_once" });

      harness.turns[0]!.finish([{ type: "text_delta", text: "ok", stream: "output" }], {
        status: "completed",
        stopReason: "end_turn",
      });
      const { events } = yield* prompt;
      expect(events.at(-1)).toMatchObject({ type: "terminal", status: "completed" });
    });
  });

  it("WAP5: a retained session this host cannot continue refuses before ACPX is contacted", function* () {
    const harness = createFakeRuntime();
    const refusal = new Error("this run's Agent session was established under a different policy");
    yield* scoped(function* () {
      yield* installStrictProvider(harness, {
        // deno-lint-ignore require-yield
        *place() {
          throw refusal;
        },
      });
      // The refusal happens while the subscription is being established, so it
      // reaches the subscriber rather than arriving as a turn's outcome — which
      // is the point: there is no turn.
      let raised: Error | undefined;
      try {
        yield* collectPrompt("continue where we left off");
      } catch (error) {
        raised = error instanceof Error ? error : new Error(String(error));
      }
      expect(raised).toBe(refusal);
    });
    // Nothing was established and no turn started against a replacement.
    expect(harness.ensureCalls).toHaveLength(0);
    expect(harness.turns).toHaveLength(0);
  });

  it("WAP6: nothing the permission request carried appears in the failure", function* () {
    const harness = createFakeRuntime();
    harness.script({ manual: true });
    const marker = "/secrets/deploy-key";
    yield* scoped(function* () {
      const log = yield* installStrictProvider(harness);
      seedRoutedRecord(log.store, WORKFLOW_SESSION_KEY, SESSION_DIR);
      const prompt = yield* spawn(() => collectPrompt("look around"));
      yield* sleep(20);
      const created = harness.createdOptions.find((options) => options.onPermissionRequest);
      yield* until(
        created!.onPermissionRequest!(toolRequest(ACP_SESSION_ID, marker), {
          signal: new AbortController().signal,
        }),
      );
      harness.turns[0]!.finish([], { status: "completed", stopReason: "end_turn" });
      const { events } = yield* prompt;
      const terminal = events.at(-1);
      const failure = terminal?.type === "terminal" ? terminal.error : undefined;
      expect(failure?.message).toBe(TOOL_PERMISSION_REFUSED);
      expect(failure?.message).not.toContain(marker);
      expect(failure?.message).not.toContain("call-1");
      expect(failure?.stack ?? "").not.toContain(marker);
    });
  });
});

/**
 * Tier APC — which provider turn a completed Prompt was.
 *
 * The adapter puts that on the ACP response's own `_meta`, ACPX carries it out
 * unchanged, and this provider decides which of its keys mean something. What
 * these prove is that decision: the two adapter namespaces are recognized and
 * everything else in `_meta` is discarded, and a turn that did not succeed
 * names nothing however the adapter labelled it.
 *
 * The authority records what it was told, unparsed. It stands in for what core
 * delivers to an installed factory, which is the only way this provider can
 * state a checkpoint at all.
 */
describe("Tier APR — preparing an agent before it is probed", () => {
  it("APR1: prepareAgent runs before the availability probe, and only when an agent is resolved", function* () {
    const harness = createFakeRuntime();
    const order: string[] = [];
    yield* useFlatWorld(CWD);
    const factory = createAcpxProvider({
      createRuntime: (options) => {
        order.push(options.probeAgent === undefined ? "runtime" : "probe");
        return harness.create(options);
      },
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
      *prepareAgent(agentName: string) {
        order.push(`prepare:${agentName}`);
      },
    });
    yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, stubAuthority());

    // Nothing yet: installing a provider resolves no agent.
    expect(order).toEqual([]);

    yield* Agent.operations.agent("scribe");

    // Preparation first. The probe spawns the agent's command, so a host that
    // has to put that command on disk must have done so by now — otherwise the
    // probe reports the agent unavailable for a reason that names the wrong
    // cause, and no amount of later preparation is reached.
    expect(order[0]).toBe("prepare:scribe");
    expect(order).toContain("probe");
    expect(order.indexOf("prepare:scribe")).toBeLessThan(order.indexOf("probe"));
  });
});

describe("Tier APC — Prompt checkpoint metadata", () => {
  function* run(
    result: AcpRuntimeTurnResult,
  ): Operation<{ checkpoints: unknown[]; events: AgentPromptEvent[] }> {
    const harness = createFakeRuntime();
    harness.script({ result });
    const authority = stubAuthority();
    yield* useFlatWorld(CWD);
    const factory = createAcpxProvider({
      createRuntime: harness.create,
      sessionStore: makeStore(),
      agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
    });
    yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, authority);
    const { events } = yield* collectPrompt("hello");
    return { checkpoints: authority.checkpoints, events };
  }

  function completed(meta: Record<string, unknown>): AcpRuntimeTurnResult {
    return { status: "completed", stopReason: "end_turn", _meta: meta };
  }

  it("APC1: the Codex namespace names an App Server turn", function* () {
    const { checkpoints } = yield* run(completed({ codex: { turnId: "turn-9" } }));

    expect(checkpoints).toEqual([
      { provider: "codex", kind: "app-server-turn-id", value: "turn-9" },
    ]);
  });

  it("APC2: the Claude namespace names an assistant message", function* () {
    const { checkpoints } = yield* run(
      completed({ claudeCode: { assistantMessageUuid: "msg-7" } }),
    );

    expect(checkpoints).toEqual([
      { provider: "claude", kind: "assistant-message-uuid", value: "msg-7" },
    ]);
  });

  it("APC3: metadata beside a recognized namespace is discarded", function* () {
    const { checkpoints } = yield* run(
      completed({
        codex: { turnId: "turn-9", usage: { input: 12 } },
        quota: { remaining: 4 },
        claudeCodeExtra: { assistantMessageUuid: "not-this" },
      }),
    );

    // Exactly the one thing this build recognizes, and nothing beside it. An
    // adapter's `_meta` is its own space, and reading an unfamiliar key as a
    // turn identity is how a run comes to continue from a point nobody named.
    expect(checkpoints).toEqual([
      { provider: "codex", kind: "app-server-turn-id", value: "turn-9" },
    ]);
  });

  it("APC4: metadata this build recognizes nothing in names no turn", function* () {
    const { checkpoints } = yield* run(
      completed({ quota: { remaining: 4 }, codex: { turn: "turn-9" } }),
    );

    expect(checkpoints).toEqual([]);
  });

  it("APC5: a value that is not a non-empty string names no turn", function* () {
    for (const turnId of ["", 7, null, { value: "turn-9" }, ["turn-9"]]) {
      const { checkpoints } = yield* run(completed({ codex: { turnId } }));
      expect({ turnId, checkpoints }).toEqual({ turnId, checkpoints: [] });
    }
  });

  it("APC6: two adapters claiming one turn name none of them", function* () {
    const { checkpoints } = yield* run(
      completed({
        codex: { turnId: "turn-9" },
        claudeCode: { assistantMessageUuid: "msg-7" },
      }),
    );

    // Two answers to which conversation this was, and no rule for choosing.
    // Naming neither leaves the Prompt unassociated, which is recoverable;
    // naming the wrong one is not.
    expect(checkpoints).toEqual([]);
  });

  it("APC7: a cancelled turn names no turn", function* () {
    const { checkpoints } = yield* run({ status: "cancelled", stopReason: "cancelled" });

    expect(checkpoints).toEqual([]);
  });

  it("APC8: a failed turn names no turn", function* () {
    const { checkpoints } = yield* run({ status: "failed", error: { message: "no" } });

    expect(checkpoints).toEqual([]);
  });

  it("APC9: a stop reason this host treats as failure names no turn", function* () {
    const { checkpoints, events } = yield* run({
      status: "completed",
      stopReason: "max_tokens",
      _meta: { codex: { turnId: "turn-9" } },
    });

    // ACP calls it completed; this host calls it a failed Prompt. A checkpoint
    // is a point a later run continues from, and there is no such point in a
    // turn the document is about to be told failed.
    expect(events.at(-1)).toMatchObject({ type: "terminal", status: "failed" });
    expect(checkpoints).toEqual([]);
  });
});
