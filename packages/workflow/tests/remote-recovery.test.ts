/**
 * Tier WRH — what a remote run reports about the executor that came before it.
 *
 * What recovery *decides* — that a retained root `Close` restores the outcome
 * it recorded, and that its absence leaves `interrupted` — is the shared
 * policy's, proved on a real owner in
 * `tests/cloudflare/remote-lifecycle.vitest.ts`. This is what a caller learns:
 * that the execution recovery closed is reported beside the one that was begun,
 * and that a run which kept a terminal outcome says so rather than looking
 * freshly running.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, scoped } from "effection";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import type { ExecutorLock } from "../src/lifecycle/api.ts";
import type { WorkflowExecutionTransitions } from "../src/lifecycle/execution.ts";
import { useRemoteLifecycle } from "../src/remote/lifecycle.ts";
import { installedHost, RUN_ID, type Script } from "./support/remote-lifecycle-host.ts";

function* installed<T>(
  script: Script,
  body: (transitions: WorkflowExecutionTransitions) => Operation<T>,
): Operation<T> {
  return yield* scoped(function* () {
    const transitions = yield* useRemoteLifecycle(installedHost(script));
    return yield* body(transitions);
  });
}

function* acquired(): Operation<ExecutorLock> {
  const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
  if (!taken.ok) {
    throw taken.error;
  }
  if (taken.value.kind !== "acquired") {
    throw new Error("expected the executor lock to be acquired");
  }
  return taken.value.lock;
}

describe("what a remote run reports about its previous executor", () => {
  it("reports the execution recovery closed, beside the one it began", function* () {
    const outcome = yield* installed({ recovered: "execution-before" }, function* (transitions) {
      const lock = yield* acquired();
      return yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.recovered?.executionId).toBe("execution-before");
      // The one this acquisition began is its own, and a different execution.
      expect(outcome.value.execution.executionId).not.toBe("execution-before");
    }
  });

  it("says nothing about recovery when there was none", function* () {
    const outcome = yield* installed({}, function* (transitions) {
      const lock = yield* acquired();
      return yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
    });

    expect(outcome.ok).toBe(true);
    // Absent rather than null: a caller reads "nothing was recovered" from the
    // member not being there at all.
    expect(outcome.ok && "recovered" in outcome.value).toBe(false);
  });

  it("carries a replay as a replay rather than as a fresh run", function* () {
    const outcome = yield* installed({ replay: true }, function* (transitions) {
      const lock = yield* acquired();
      return yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.replay).toBe(true);
  });

  it("settles the execution it began after a recovery, and only that one", function* () {
    const asked: string[] = [];
    const outcome = yield* installed(
      { asked, recovered: "execution-before" },
      function* (transitions) {
        const lock = yield* acquired();
        const begun = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
        if (!begun.ok) {
          throw begun.error;
        }
        return {
          // The recovered execution belonged to an acquisition that is gone.
          stale: yield* transitions.settle(lock, {
            executionId: "execution-before",
            status: "completed",
          }),
          own: yield* transitions.settle(lock, {
            executionId: begun.value.execution.executionId,
            status: "completed",
          }),
          asked: [...asked],
        };
      },
    );

    expect(outcome.stale.ok).toBe(false);
    expect(outcome.own.ok).toBe(true);
    expect(outcome.asked.filter((command) => command === "settle")).toHaveLength(1);
  });
});
