/**
 * Tier WRH — what the remote executor lifecycle authorizes, and what it refuses.
 *
 * The owner-side facts — admission contention, pristine initialization, the
 * acquisition/execution association surviving hibernation, and one transaction
 * per transition — are proved against a real Durable Object in
 * `tests/cloudflare/remote-lifecycle.vitest.ts`. These are the other half: that
 * the lock is an object rather than a description, that its lifetime is its
 * connection's, that one acquisition begins one execution, and that a caller
 * never sees a private refusal.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, type Result, scoped, spawn, withResolvers } from "effection";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import type { ExecutorLock } from "../src/lifecycle/api.ts";
import type {
  WorkflowBeginRequest,
  WorkflowExecutionTransitions,
} from "../src/lifecycle/execution.ts";
import { useRemoteLifecycle } from "../src/remote/lifecycle.ts";
import { WorkflowRequestError } from "../src/storage/errors.ts";
import { installedHost, RUN_ID, type Script } from "./support/remote-lifecycle-host.ts";

function* acquired(runId = RUN_ID): Operation<ExecutorLock> {
  const taken = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
  if (!taken.ok) {
    throw taken.error;
  }
  if (taken.value.kind !== "acquired") {
    throw new Error("expected the executor lock to be acquired");
  }
  return taken.value.lock;
}

function* installed<T>(
  script: Script,
  body: (transitions: WorkflowExecutionTransitions) => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const transitions = yield* useRemoteLifecycle(installedHost(script));
    return yield* body(transitions);
  });
}

describe("a remote run's executor lifecycle", () => {
  it("hands back a lock nothing else can be mistaken for", function* () {
    const outcomes = yield* installed({}, function* (transitions) {
      const lock = yield* acquired();
      const request: WorkflowBeginRequest = { runId: RUN_ID, action: "resume" };
      return {
        // The same run, the same shape, a different object.
        copied: yield* transitions.begin({ runId: lock.runId }, request),
        frozen: yield* transitions.begin(Object.freeze({ runId: RUN_ID }), request),
        // Another provider's lock: this one was never issued here at all.
        foreign: yield* transitions.begin(Object.freeze({ runId: RUN_ID }), request),
        held: yield* transitions.begin(lock, request),
      };
    });

    for (const [name, outcome] of Object.entries(outcomes)) {
      if (name === "held") {
        expect([name, outcome.ok]).toEqual([name, true]);
        continue;
      }
      expect([name, outcome.ok]).toEqual([name, false]);
      expect(outcome.ok === false && outcome.error).toEqual(expect.any(WorkflowRequestError));
    }
  });

  it("refuses a lock whose acquisition has ended, and takes nothing while it does", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked }, function* (transitions) {
      // The lock outlives the scope that acquired it; its authority does not.
      const escaped = yield* scoped(function* () {
        return yield* acquired();
      });
      const after = asked.length;
      const refused = yield* transitions.begin(escaped, { runId: RUN_ID, action: "resume" });
      return { refused, before: after, sent: asked.length };
    });

    expect(outcome.refused.ok).toBe(false);
    // Nothing was asked of the owner: a released lock is refused before a
    // command is composed, let alone sent.
    expect(outcome.sent).toBe(outcome.before);
  });

  it("reports a live executor rather than failing, and advances nothing", function* () {
    const asked: string[] = [];
    const taken = yield* installed({ asked, admit: "already-running" }, function* () {
      return yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
    });

    expect(taken.ok).toBe(true);
    expect(taken.ok && taken.value.kind).toBe("already-running");
    expect(asked).toEqual([]);
  });

  it("begins one execution per acquisition, and settles only that one", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked }, function* (transitions) {
      const lock = yield* acquired();
      const begun = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
      if (!begun.ok) {
        throw begun.error;
      }
      const again = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
      const foreign = yield* transitions.settle(lock, {
        executionId: "execution-elsewhere",
        status: "completed",
      });
      const settled = yield* transitions.settle(lock, {
        executionId: begun.value.execution.executionId,
        status: "completed",
      });
      return { again, foreign, settled, asked: [...asked] };
    });

    expect(outcome.again.ok).toBe(false);
    expect(outcome.foreign.ok).toBe(false);
    expect(outcome.settled.ok).toBe(true);
    // The second begin and the foreign settlement never reached the owner.
    expect(outcome.asked.filter((command) => command === "begin")).toHaveLength(1);
    expect(outcome.asked.filter((command) => command === "settle")).toHaveLength(1);
  });

  it("refuses a begin addressed to another run before the transport", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked }, function* (transitions) {
      const lock = yield* acquired();
      return yield* transitions.begin(lock, { runId: "another-run", action: "resume" });
    });

    expect(outcome.ok).toBe(false);
    expect(asked).toEqual([]);
  });

  it("carries a refusal about the run as its own condition", function* () {
    const conditions: readonly ("cancelled" | "resume-failed")[] = ["cancelled", "resume-failed"];
    for (const refusal of conditions) {
      const outcome = yield* installed({ begin: refusal }, function* (transitions) {
        const lock = yield* acquired();
        return yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
      });
      expect([refusal, outcome.ok]).toEqual([refusal, false]);
      if (!outcome.ok) {
        // The condition, and nothing about how it was spelled underneath.
        expect(String(outcome.error)).not.toContain("command:");
        expect(String(outcome.error)).toContain(RUN_ID);
      }
    }
  });

  it("takes its own acquisition to cancel, and gives it back", function* () {
    const opened: string[] = [];
    const closed: string[] = [];
    const outcome = yield* installed({ opened, closed }, function* () {
      return yield* WorkflowLifecycle.operations.cancel(RUN_ID);
    });

    expect(outcome.ok).toBe(true);
    expect(opened).toEqual([RUN_ID]);
    // The acquisition cancellation took for itself is not still held.
    expect(closed).toEqual([RUN_ID]);
  });

  it("refuses to cancel a run a live executor holds", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked, admit: "already-running" }, function* () {
      return yield* WorkflowLifecycle.operations.cancel(RUN_ID);
    });

    expect(outcome.ok).toBe(false);
    // Nothing was asked of the owner, and the no-acquisition plane was not
    // consulted to decide who holds the run.
    expect(asked).toEqual([]);
  });

  it("composes with the reads already installed rather than replacing them", function* () {
    const outcome = yield* scoped(function* () {
      let asked = false;
      yield* WorkflowLifecycle.around({
        // deno-lint-ignore require-yield
        *inspect(): Operation<Result<never>> {
          asked = true;
          throw new WorkflowRequestError("the installed read answered");
        },
      });
      yield* useRemoteLifecycle(installedHost({}));
      const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
      try {
        yield* WorkflowLifecycle.operations.inspect(RUN_ID);
      } catch {
        // The installed read answered by raising; what matters is that it was
        // the one that answered.
      }
      return { taken, asked };
    });

    expect(outcome.taken.ok).toBe(true);
    // The lifecycle provider added its two operations over the read provider's,
    // rather than installing an object that answers only its own.
    expect(outcome.asked).toBe(true);
  });

  it("answers from the nearest provider, over one installed further out", function* () {
    const answered: string[] = [];
    const outcome = yield* scoped(function* () {
      // A provider in an enclosing scope, installed the way every provider in
      // this repository installs. Nothing should reach it.
      yield* WorkflowLifecycle.around(
        {
          // deno-lint-ignore require-yield
          *acquireExecutor(): Operation<Result<never>> {
            answered.push("outer-acquire");
            throw new WorkflowRequestError("the outer provider answered acquireExecutor");
          },
          // deno-lint-ignore require-yield
          *cancel(): Operation<Result<never>> {
            answered.push("outer-cancel");
            throw new WorkflowRequestError("the outer provider answered cancel");
          },
          // deno-lint-ignore require-yield
          *inspect(): Operation<Result<never>> {
            answered.push("outer-inspect");
            throw new WorkflowRequestError("the outer provider answered inspect");
          },
        },
        { at: "min" },
      );
      return yield* scoped(function* () {
        // The read provider, then the lifecycle provider, both nearer the work.
        yield* WorkflowLifecycle.around(
          {
            // deno-lint-ignore require-yield
            *inspect(): Operation<Result<never>> {
              answered.push("inner-inspect");
              throw new WorkflowRequestError("the inner read provider answered inspect");
            },
          },
          { at: "min" },
        );
        yield* useRemoteLifecycle(installedHost({}));
        const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
        const cancelled = yield* WorkflowLifecycle.operations.cancel(RUN_ID);
        try {
          yield* WorkflowLifecycle.operations.inspect(RUN_ID);
        } catch {
          // The read provider answers by raising; which one raised is what is
          // being observed.
        }
        return { taken, cancelled };
      });
    });

    expect(outcome.taken.ok).toBe(true);
    expect(outcome.cancelled.ok).toBe(true);
    // The nearest provider answered its own operations, the read provider
    // installed beside it still answered its own, and the outer one answered
    // nothing at all.
    expect(answered).toEqual(["inner-inspect"]);
  });

  it("asks the same question after a lost answer, and gets one decision", function* () {
    const commands: string[] = [];
    const loseAnswer = new Set<string>();
    const committed = new Map<string, never>();
    const script: Script = { commands, loseAnswer, committed: committed as never };
    const outcome = yield* scoped(function* () {
      const transitions = yield* useRemoteLifecycle(installedHost(script));
      const first = yield* scoped(function* () {
        const lock = yield* acquired();
        // The owner will commit and the answer will be lost.
        loseAnswer.add("command-1:begin");
        return yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
      });
      // The connection is gone with its answer. A replacement acquisition asks
      // the same question.
      const second = yield* scoped(function* () {
        const lock = yield* acquired();
        return yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
      });
      return { first, second };
    });

    expect(outcome.first.ok).toBe(false);
    expect(outcome.second.ok).toBe(true);
    // The same command identity both times, so the owner answered with the
    // decision it had already made rather than making a second one.
    expect(commands).toEqual(["command-1:begin", "command-1:begin"]);
    if (outcome.second.ok) {
      // And the execution the caller is handed is the one that was begun.
      expect(outcome.second.value.execution.executionId).toBe("execution-1");
    }
  });

  it("refuses a second call while the first is still waiting for its answer", function* () {
    const asked: string[] = [];
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const script: Script = {
      asked,
      gate: {
        *wait(): Operation<void> {
          entered.resolve();
          yield* release.operation;
        },
      },
    };
    const outcome = yield* installed(script, function* (transitions) {
      const lock = yield* acquired();
      const request: WorkflowBeginRequest = { runId: RUN_ID, action: "resume" };
      const first = yield* spawn(() => transitions.begin(lock, request));
      // The first call has sent and is waiting for its answer. The second is a
      // different call, however equal its arguments look.
      yield* entered.operation;
      const second = yield* transitions.begin(lock, request);
      release.resolve();
      return { first: yield* first, second };
    });

    expect(outcome.first.ok).toBe(true);
    expect(outcome.second.ok).toBe(false);
    // One owner mutation, not two.
    expect(asked.filter((command) => command === "begin")).toHaveLength(1);
  });

  it("gives a corrected request a new identity after a definitive answer", function* () {
    const commands: string[] = [];
    const outcome = yield* installed({ commands, begin: "cancelled" }, function* (transitions) {
      const lock = yield* acquired();
      const refused = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
      return { refused, commands: [...commands] };
    });
    // The owner answered, so that question is finished. What it is not is a
    // claim on the next one's identity.
    expect(outcome.refused.ok).toBe(false);
    expect(outcome.commands).toEqual(["command-1:begin"]);

    const second = yield* installed({ commands: [] }, function* (transitions) {
      const lock = yield* acquired();
      return yield* transitions.begin(lock, { runId: RUN_ID, action: "start" });
    });
    expect(second.ok).toBe(true);
  });

  it("asks the same cancellation again when its answer was lost", function* () {
    const commands: string[] = [];
    const outcome = yield* installed(
      { commands, loseAnswer: new Set(["command-1:cancel"]) },
      function* () {
        const first = yield* WorkflowLifecycle.operations.cancel(RUN_ID);
        // The connection that asked is gone; the question is not.
        const second = yield* WorkflowLifecycle.operations.cancel(RUN_ID);
        return { first, second, commands: [...commands] };
      },
    );

    expect(outcome.first.ok).toBe(false);
    expect(outcome.second.ok).toBe(true);
    // One identity, asked twice, so the owner answers with what it decided.
    expect(outcome.commands).toEqual(["command-1:cancel", "command-1:cancel"]);
  });

  it("gives a later cancellation a fresh identity once one was answered", function* () {
    const commands: string[] = [];
    const outcome = yield* installed({ commands }, function* () {
      const first = yield* WorkflowLifecycle.operations.cancel(RUN_ID);
      const second = yield* WorkflowLifecycle.operations.cancel(RUN_ID);
      return { first, second, commands: [...commands] };
    });

    expect(outcome.first.ok).toBe(true);
    expect(outcome.second.ok).toBe(true);
    // Answered, so the claim was retired and the next call is its own.
    expect(outcome.commands).toEqual(["command-1:cancel", "command-2:cancel"]);
  });

  it("frees the acquisition when a call is cancelled before it sends", function* () {
    const asked: string[] = [];
    const outcome = yield* installed({ asked }, function* (transitions) {
      const lock = yield* acquired();
      // Cancelled while it is still deciding it may not proceed: nothing was
      // sent, so the acquisition is free to try again.
      const refused = yield* transitions.begin(lock, {
        runId: RUN_ID,
        action: "resume",
        creation: {
          definition: {
            version: 1,
            kind: "git",
            objectFormat: "sha1",
            objectId: "0".repeat(40),
            rootDocumentPath: "README.md",
          },
          base: "main",
          props: {},
        },
      });
      const after = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
      return { refused, after, asked: [...asked] };
    });

    expect(outcome.refused.ok).toBe(false);
    // The guard lifted, so the corrected call went through.
    expect(outcome.after.ok).toBe(true);
    expect(outcome.asked).toEqual(["begin"]);
  });

  it("retires an acquisition cancelled after its command went out", function* () {
    const asked: string[] = [];
    const retired: string[] = [];
    const entered = withResolvers<void>();
    const script: Script = {
      asked,
      retired,
      gate: {
        *wait(): Operation<void> {
          entered.resolve();
          // Never resolved: this call is cancelled while it waits.
          yield* withResolvers<void>().operation;
        },
      },
    };
    const outcome = yield* installed(script, function* (transitions) {
      const lock = yield* acquired();
      const sent = yield* spawn(() => transitions.begin(lock, { runId: RUN_ID, action: "resume" }));
      yield* entered.operation;
      // The call is interrupted with its answer outstanding.
      yield* sent.halt();
      // The lock cannot start anything else: whether the owner committed is
      // unknown, and a fresh mutation must not race that.
      return yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
    });

    expect(outcome.ok).toBe(false);
    expect(asked.filter((command) => command === "begin")).toHaveLength(1);
    // The connection went with the lock, before its scope ended. A socket
    // still holding the run for a lock nobody may use would leave the run
    // unreachable by anybody.
    expect(retired).toEqual([RUN_ID]);
  });
});
