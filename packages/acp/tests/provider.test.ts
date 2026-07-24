/**
 * Tier AP — ACPX provider tests (specs/acp-client-spec.md §ACPX provider).
 *
 * Drives the provider through its seams with a scriptable fake runtime:
 * no agent process ever starts.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { Agent, Config } from "@executablemd/core";
import type { AgentPromptEvent, PromptOptions, Session } from "@executablemd/core";
import { createAcpxProvider, useAcpxProviderState } from "../src/provider.ts";
import type { AcpxProviderState } from "../src/provider.ts";
import { deriveSessionKey } from "../src/session-key.ts";
import { createFakeRuntime, makeRegistry, makeStore, useFlatWorld } from "./helpers.ts";
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
