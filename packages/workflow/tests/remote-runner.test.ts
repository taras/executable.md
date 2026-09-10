/**
 * Tier WRH14 — the runner's four methods, and the handoff between two of them.
 *
 * A begin transition hands back a storage handle. An attachment needs the
 * Workspace runtime for the *same* run, over the same connection — and two
 * clients on two owners can hold handles whose run id, root and anchor are
 * identical, so nothing a handle says about itself can establish that. What
 * establishes it is where the handle came from.
 *
 * So this file is about which handles attach and which do not. An attachment
 * that succeeds here has opened the run from the exact link its own acquisition
 * produced, taken the provenance of that handle's own journal, and installed
 * the coordinator for it — every one of which has to line up, or the attachment
 * raises instead. What a real owner does with the commit such an attachment
 * produces is proved against one in `tests/cloudflare/remote-workspace.vitest.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, type Operation, scoped } from "effection";
import { WorkflowLifecycle } from "../src/lifecycle/api.ts";
import type { ExecutorLock } from "../src/lifecycle/api.ts";
import type { WorkflowExecutionTransitions } from "../src/lifecycle/execution.ts";
import type { WorkflowRunDatabase } from "../src/storage/api.ts";
import { useRemoteWorkflowRunner } from "../src/deno/remote-runner.ts";
import type { RemoteRunnerOwner, RemoteWorkflowRunner } from "../src/deno/remote-runner.ts";
import type { RemoteReadPlane } from "../src/remote/read.ts";
import { WorkflowRequestError } from "../src/storage/errors.ts";
import { installedHost, RUN_ID, type Script } from "./support/remote-lifecycle-host.ts";

/** One scripted owner, and every run its acquisitions were opened for. */
function ownerOf(script: Script = {}): { owner: RemoteRunnerOwner; acquisitions: string[] } {
  const acquisitions: string[] = [];
  const host = installedHost({ ...script, opened: acquisitions });
  return {
    acquisitions,
    owner: {
      runId: RUN_ID,
      admit: (runId: string) => host.admit(runId),
      // deno-lint-ignore require-yield
      *reads(runId: string) {
        return Ok(readPlane(runId));
      },
      delivery: {
        // deno-lint-ignore require-yield
        *wait(): Operation<never> {
          throw new Error("PLANTED-DELIVERY-WAIT-REACHED");
        },
        // deno-lint-ignore require-yield
        *retain(): Operation<never> {
          throw new Error("PLANTED-DELIVERY-RETAIN-REACHED");
        },
      },
    },
  };
}

/**
 * One read plane, which answers nothing and takes nothing.
 *
 * What the tests below need of it is that installing it and asking it a
 * question require no acquisition; what it would answer is the read plane's own
 * contract and is proved where that is under test.
 */
function unanswered(): never {
  throw new WorkflowRequestError("this scripted plane answers no read");
}

function readPlane(runId: string): RemoteReadPlane {
  return {
    runId,
    // deno-lint-ignore require-yield
    *inspect() {
      return unanswered();
    },
    // deno-lint-ignore require-yield
    *history() {
      return unanswered();
    },
    // deno-lint-ignore require-yield
    *forkSource() {
      return unanswered();
    },
  };
}

/** One runner over one scripted owner. */
function assembled(owner: RemoteRunnerOwner, scratch: string): Operation<RemoteWorkflowRunner> {
  return useRemoteWorkflowRunner({ owner, scratchRoot: `/tmp/xmd-remote-runner-${scratch}` });
}

/** Take this run's acquisition, or say why it could not be taken. */
function* acquired(): Operation<ExecutorLock> {
  const taken = yield* WorkflowLifecycle.operations.acquireExecutor(RUN_ID);
  if (!taken.ok) {
    throw taken.error;
  }
  if (taken.value.kind !== "acquired") {
    throw new Error("expected the executor acquisition to be taken");
  }
  return taken.value.lock;
}

/** Begin one execution, and hand back the handle it produced. */
function* opened(
  transitions: WorkflowExecutionTransitions,
  lock: ExecutorLock,
): Operation<WorkflowRunDatabase> {
  const begun = yield* transitions.begin(lock, { runId: RUN_ID, action: "resume" });
  if (!begun.ok) {
    throw begun.error;
  }
  return begun.value.database;
}

/** What an attachment runs. Reaching it at all is the claim. */
// deno-lint-ignore require-yield
function* attached(): Operation<string> {
  return "attached";
}

/** Attach one handle through one runner, and report what came back. */
function* attaching(runner: RemoteWorkflowRunner, handle: WorkflowRunDatabase): Operation<string> {
  try {
    return yield* scoped(() => runner.attach(handle, attached()));
  } catch (error) {
    return error instanceof Error ? error.message : "other";
  }
}

function planted(): never {
  throw new Error("PLANTED-FOREIGN-HANDLE-READ");
}

/** A handle nothing opened: shaped like one, and one nothing may read. */
function foreignHandle(): WorkflowRunDatabase {
  return {
    get record() {
      return planted();
    },
    get retrieval() {
      return planted();
    },
    get journal() {
      return planted();
    },
    readJournalEntries: planted,
    transact: planted,
    replaceRetrievalMetadata: planted,
    readDocumentExecutions: planted,
  };
}

describe("a runner for a run whose storage is somewhere else", () => {
  it("attaches the handle its own lifecycle opened, and no other", function* () {
    const outcome = yield* scoped(function* () {
      const first = ownerOf();
      const second = ownerOf();
      const one = yield* assembled(first.owner, "one");
      const transitions = yield* one.useRunHost();
      const database = yield* opened(transitions, yield* acquired());
      // A second runner over a second owner, with an acquisition and a handle
      // of its own. Its scripted owner answers with the same record, root and
      // anchor, so the two handles agree about everything except where they
      // came from.
      return yield* scoped(function* () {
        const other = yield* assembled(second.owner, "two");
        const theirs = yield* other.useRunHost();
        const another = yield* opened(theirs, yield* acquired());
        return {
          own: yield* attaching(one, database),
          theirs: yield* attaching(other, another),
          crossed: yield* attaching(other, database),
          back: yield* attaching(one, another),
          foreign: yield* attaching(one, foreignHandle()),
          acquisitions: [...first.acquisitions, ...second.acquisitions],
        };
      });
    });
    // Attaching succeeded, which means the run was opened from the exact link
    // this runner's acquisition produced, the provenance of that handle's own
    // journal was taken, and the coordinator was installed for it.
    expect(outcome.own).toBe("attached");
    expect(outcome.theirs).toBe("attached");
    // Neither runner can attach the other's handle, in either direction.
    expect(outcome.crossed).toContain("not opened by this remote host");
    expect(outcome.back).toContain("not opened by this remote host");
    expect(outcome.foreign).toContain("not opened by this remote host");
    // One acquisition per runner, and neither of them for the other's run.
    expect(outcome.acquisitions).toEqual([RUN_ID, RUN_ID]);
  });

  it("reads and delivers without taking an acquisition", function* () {
    const outcome = yield* scoped(function* () {
      const scripted = ownerOf();
      const built = yield* assembled(scripted.owner, "planes");
      yield* built.useLifecycle();
      yield* built.useDelivery();
      const inspected = yield* trapped(WorkflowLifecycle.operations.inspect(RUN_ID));
      return {
        inspected,
        // Nothing was acquired to install either plane or to answer with them.
        acquisitions: scripted.acquisitions,
      };
    });
    // The scripted plane answers no read, which is the plane refusing rather
    // than an acquisition that was never taken.
    expect(outcome.inspected).toContain("answers no read");
    expect(outcome.acquisitions).toEqual([]);
  });
});

/** Run one operation and report what it refused with, if it refused. */
function* trapped(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
    return "answered";
  } catch (error) {
    return error instanceof Error ? error.message : "other";
  }
}
