/**
 * Tier AP — ACPX provider tests (specs/acp-client-spec.md §ACPX provider).
 *
 * Drives the provider through its seams with a scriptable fake runtime:
 * no agent process ever starts.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { Agent, Config } from "@executablemd/core";
import type { AgentPromptEvent, PromptOptions, Session } from "@executablemd/core";
import { createAcpxProvider, useAcpxProviderState } from "../src/provider.ts";
import { useSerialQueues } from "../src/serial-queue.ts";
import type { AcpxProviderState } from "../src/provider.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import {
  createFakeRuntime,
  makeRecord,
  makeRegistry,
  makeStore,
  useFlatWorld,
  useGitWorld,
} from "./helpers.ts";
import type { AcpPermissionRequest } from "acpx/runtime";
import type { FakeRuntimeHarness } from "./helpers.ts";

const CWD = "/work";

function* installProvider(harness: FakeRuntimeHarness): Operation<void> {
  yield* useFlatWorld(CWD);
  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: makeStore(),
    agentRegistry: makeRegistry({ codex: "codex-cmd", other: "other-cmd" }),
  });
  yield* factory({ defaultAgent: "codex", permissionMode: "deny-all" });
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

      expect(events[0]).toMatchObject({ type: "started", agent: "codex" });
      const started = events[0]!;
      if (started.type === "started") {
        expect(started.session.sessionKey).toBe(deriveSessionKey("codex-cmd", CWD));
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
        sessionKey: deriveSessionKey("codex-cmd", CWD),
        agent: "codex",
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

  it("AP3: explicit prompt timeout wins; otherwise the validated contextual timeout is forwarded", function* () {
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* Config.around({ timeout: () => 4_321 }, { at: "min" });
      yield* installProvider(harness);
      yield* collectPrompt("first", { timeout: 250 });
      yield* collectPrompt("second");
      expect(harness.turns[0]!.input.timeoutMs).toBe(250);
      expect(harness.turns[1]!.input.timeoutMs).toBe(4_321);
      expect(harness.createdOptions[0]!.timeoutMs).toBe(4_321);
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
        agentRegistry: makeRegistry({ codex: "codex-cmd" }),
      });
      yield* factory({ defaultAgent: "codex", permissionMode: "deny-all" });

      // Simulate a prior turn's reconnect: the persisted record now
      // carries a replaced ACP session id that the handle predates.
      const sessionKey = deriveSessionKey("codex-cmd", CWD);
      const record = makeRecord("codex-cmd", CWD);
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
      const routed = yield* until(
        Promise.resolve(options!.onPermissionRequest!(request, { signal })),
      );
      // Routed to the active prompt scope: the base policy denies.
      expect(routed).toEqual({ outcome: "reject_once" });

      const stale = yield* until(
        Promise.resolve(
          options!.onPermissionRequest!(
            {
              ...request,
              sessionId: `backend:${sessionKey}`,
              raw: { ...request.raw, sessionId: `backend:${sessionKey}` },
            },
            { signal },
          ),
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
        agentRegistry: makeRegistry({ codex: "codex-cmd" }),
      });
      yield* factory({ defaultAgent: "codex", permissionMode: "deny-all" });

      // The persisted record carries the authoritative ids after a
      // prior reconnect replaced both.
      const sessionKey = deriveSessionKey("codex-cmd", CWD);
      const record = makeRecord("codex-cmd", CWD);
      record.acpxRecordId = `record:${sessionKey}`;
      record.acpSessionId = "sid-2";
      record.agentSessionId = "agent-2";
      store.records.set(record.acpxRecordId, record);

      const started = withResolvers<Session>();
      const promptTask = yield* spawn(() =>
        scoped(function* () {
          // A scoped prompt policy (as <ApproveAll> installs).
          yield* Agent.around(
            {
              // deno-lint-ignore require-yield
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
        Promise.resolve(
          options!.onPermissionRequest!(request, { signal: new AbortController().signal }),
        ),
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
        agentRegistry: makeRegistry({ codex: "codex-cmd" }),
      });
      yield* factory({ defaultAgent: "codex", permissionMode: "deny-all" });

      const sessionKey = deriveSessionKey("codex-cmd", CWD);
      const record = makeRecord("codex-cmd", CWD);
      record.acpxRecordId = `record:${sessionKey}`;
      record.acpSessionId = "id-A";
      record.agentSessionId = "agent-A";
      store.records.set(record.acpxRecordId, record);

      const prompt = yield* spawn(() =>
        scoped(function* () {
          yield* Agent.around(
            {
              // deno-lint-ignore require-yield
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
        Promise.resolve(options!.onPermissionRequest!(request("id-B"), { signal: abort })),
      );
      expect(routedB).toEqual({ outcome: "allow_once" });

      // The stale id A no longer routes.
      const staleA = yield* until(
        Promise.resolve(options!.onPermissionRequest!(request("id-A"), { signal: abort })),
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
        agentRegistry: makeRegistry({ codex: "codex-cmd" }),
      });
      yield* factory({ defaultAgent: "codex", permissionMode: "deny-all" });

      // Pre-seed the repo-root session so the walk from a subdir reuses it.
      const rootKey = deriveSessionKey("codex-cmd", "/repo");
      const rootRecord = makeRecord("codex-cmd", "/repo");
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
        agentRegistry: makeRegistry({ codex: "codex-cmd" }),
        sessionRouting: (_context, op) => routeQueue.withSlot("route", op),
      });
      yield* factory({ defaultAgent: "codex", permissionMode: "deny-all" });

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
      message: "codex not installed",
      details: ["agent=codex"],
    });
    yield* scoped(function* () {
      yield* installProvider(harness);
      let thrown: unknown;
      try {
        yield* Agent.operations.agent("codex");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      if (thrown instanceof Error) {
        expect(thrown.message).toContain("ACP_BACKEND_UNAVAILABLE");
        expect(thrown.message).toContain("codex not installed");
      }

      // The failed probe is not cached; the next probe succeeds and is.
      expect(yield* Agent.operations.agent("codex")).toBe("codex");
      expect(yield* Agent.operations.agent("codex")).toBe("codex");
      expect(harness.doctorCalls).toBe(2);
    });
  });

  it("AP10: sibling provider states are fully independent", function* () {
    const first = createFakeRuntime();
    const second = createFakeRuntime();
    yield* useFlatWorld(CWD);

    function* installState(harness: FakeRuntimeHarness): Operation<AcpxProviderState> {
      const state = yield* useAcpxProviderState(
        { defaultAgent: "codex", permissionMode: "deny-all" },
        {
          createRuntime: harness.create,
          sessionStore: makeStore(),
          agentRegistry: makeRegistry({ codex: "codex-cmd" }),
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
          // deno-lint-ignore require-yield
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
