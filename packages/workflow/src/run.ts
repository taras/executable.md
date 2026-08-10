/**
 * Associating one document execution with a workflow run.
 *
 * `useWorkflow({ base })` installs ordinary middleware and nothing else. It
 * creates no workflow run: a run comes into being when a document execution
 * reaches its first durable operation, which resolves the base once, records
 * one immutable value, and only then lets the root document be imported.
 *
 * Two middlewares are needed because a journal can be in three states.
 *
 * - **Live** — no record yet. `Execution.document` allocates the run id,
 *   resolves `${base}^{commit}` through `Git.revParse()`, and records the value
 *   before `next()` imports the root.
 * - **Truncated** — the record is there but the root never closed. Both
 *   middlewares run: the guard restores the value, and the durable operation
 *   still runs so the journal cursor advances past its own entry.
 * - **Completed** — the root `Close` is recorded, and `durableRun` returns the
 *   stored result without ever invoking the workflow, so `Execution.document`
 *   is never reached. The guard's check phase runs before that shortcut, which
 *   is the only place a completed journal can restore its run — or refuse a
 *   different base before the recorded result is handed back.
 *
 * All of it is operation-scoped. The value is installed in the scope that owns
 * the document execution, so every descendant of the expansion reads it, the
 * output emitted after the durable run still sees it, and ordinary teardown
 * takes it away. Nothing lives at module scope.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import { createDurableOperation } from "@executablemd/durable-streams";
import { ReplayGuard } from "@executablemd/durable-streams";
import type { EffectDescription, Json, Workflow, Yield } from "@executablemd/durable-streams";
import { Execution } from "@executablemd/core";
import { revParse } from "./git.ts";
import {
  baseMismatch,
  describeWorkflowRun,
  malformedRecord,
  readWorkflowRun,
  WORKFLOW_RUN,
} from "./journal.ts";
import type { WorkflowRun } from "./journal.ts";

export type { WorkflowRun } from "./journal.ts";

/**
 * The workflow run of the document execution running now.
 *
 * A stable, namespaced name and a plain value: another loaded copy of this
 * package reads the same binding through its own descriptor. By the same
 * property a descendant may bind this name for its own descendants, so durable
 * enforcement never depends on it.
 */
const CurrentWorkflowRun: Context<WorkflowRun | undefined> = createContext<WorkflowRun | undefined>(
  "executablemd.workflow.run",
  undefined,
);

/** The frozen run of the current document execution; throws outside one. */
export function* getWorkflowRun(): Operation<WorkflowRun> {
  const run = yield* CurrentWorkflowRun.get();
  if (run === undefined) {
    throw new Error(
      "getWorkflowRun() is available only inside a document execution associated with a " +
        "workflow run. Install useWorkflow({ base }) in the scope that owns the execution.",
    );
  }
  return run;
}

/** Append the run to the journal, and answer with what the journal holds. */
function* record(description: EffectDescription, base: string): Workflow<unknown> {
  return yield createDurableOperation(description, function* (): Operation<Json> {
    // Reached only when nothing is recorded yet: a replay hands the stored
    // value back without running this at all, so neither the identifier nor Git
    // is reached a second time.
    const pinnedCommit = yield* revParse(`${base}^{commit}`);
    // Web Crypto rather than `node:crypto`: a run id is allocated in shared
    // code, which names no host.
    return { runId: crypto.randomUUID(), base, pinnedCommit };
  });
}

function same(left: WorkflowRun, right: WorkflowRun): boolean {
  return (
    left.runId === right.runId &&
    left.base === right.base &&
    left.pinnedCommit === right.pinnedCommit
  );
}

/**
 * Read the record this run is held to, refusing anything that is not it.
 *
 * The description carries the base for a reader; divergence detection compares
 * only type and name, so the base this run supplied is checked against the
 * stored *value* rather than against the entry's identity.
 */
function held(description: EffectDescription, stored: unknown, base: string): WorkflowRun {
  const run = readWorkflowRun(stored);
  if (run === undefined) {
    throw malformedRecord(description);
  }
  if (run.base !== base) {
    throw baseMismatch(description, run.base, base);
  }
  return run;
}

function* establish(base: string): Operation<void> {
  const description = describeWorkflowRun(base);
  const run = held(description, yield* record(description, base), base);
  const restored = yield* CurrentWorkflowRun.get();
  // A truncated replay already restored this value in the check phase; keeping
  // that object is what makes every read in one execution the same one.
  if (restored !== undefined && same(restored, run)) {
    return;
  }
  yield* CurrentWorkflowRun.set(run);
}

function* restore(event: Yield, base: string): Operation<void> {
  if (event.description.type !== WORKFLOW_RUN || event.result.status !== "ok") {
    return;
  }
  yield* CurrentWorkflowRun.set(held(describeWorkflowRun(base), event.result.value, base));
}

/**
 * Associate the document execution this scope owns with a workflow run.
 *
 * Installing this creates nothing. Executing a document under it does.
 */
export function* useWorkflow(options: { base: string }): Operation<void> {
  const { base } = options;

  yield* ReplayGuard.around({
    *check([event], next) {
      // Runs before `durableRun` can short-circuit on a recorded root Close, so
      // a completed journal restores its run here — and refuses a different
      // base here, before the recorded result is returned.
      yield* restore(event, base);
      return yield* next(event);
    },
  });

  yield* Execution.around({
    *document([props], next) {
      yield* establish(base);
      return yield* next(props);
    },
  });
}
