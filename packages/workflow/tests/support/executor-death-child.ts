/**
 * A workflow executor that begins a run and is then lost, running no cleanup.
 *
 * ```sh
 * deno run -A executor-death-child.ts <root> <run-id>
 * ```
 *
 * It takes the run's executor lock, begins the first document execution, says
 * it is ready and waits to be killed. What it leaves is the state the
 * architecture's staleness premise is about: a run durably `running`, one
 * execution with no end, and an advisory lock the kernel released because the
 * process holding it is gone.
 *
 * It is a whole process on purpose, and the reason is the same one
 * `workflow-recovery-child.ts` gives for its own: nothing a test can do to
 * itself leaves an execution unfinished any more. A thrown error, a cancelled
 * task and a closed scope all unwind, and unwinding now settles the execution
 * the acquisition began — that is what the executor hold's teardown is for. A
 * killed process runs no finalizer, which is exactly what makes it the only
 * honest way to produce a dead executor's leftovers.
 */

import process from "node:process";
import { main, suspend } from "effection";
import { WorkflowLifecycle } from "../../mod.ts";
import { useWorkflowRunHost } from "../../deno.ts";
import { creation } from "./storage.ts";
import { legacySourceReader } from "./legacy-source.ts";

/** Said on stdout, and nowhere else, once the execution is durably begun. */
const READY = "READY";

await main(function* () {
  // `process.argv` rather than `Deno.args`: this file is Deno-only to run, and
  // still has to typecheck under the Node project like every other source.
  const [root, runId] = process.argv.slice(2);
  if (root === undefined || runId === undefined) {
    throw new Error("usage: executor-death-child.ts <root> <run-id>");
  }

  // `creation()` is a version-1 fixture, and every executable v1 admission is
  // reader-gated, so this host supplies the reader exactly as a Git-capable
  // one does.
  const transitions = yield* useWorkflowRunHost({ root, legacySource: legacySourceReader() });
  const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
  if (!acquired.ok) {
    throw acquired.error;
  }
  if (acquired.value.kind !== "acquired") {
    throw new Error(`${runId} already has a live workflow executor`);
  }

  const begun = yield* transitions.begin(acquired.value.lock, {
    runId,
    action: "start",
    creation: creation(),
  });
  if (!begun.ok) {
    throw begun.error;
  }

  // Only after the transaction committed: a reader told this was ready before
  // the run existed would be told about a run that might never appear.
  console.log(READY);

  // Nothing settles it, and nothing here will. A timer the event loop can see
  // is what keeps a suspended Effection task's process alive until the signal
  // arrives.
  setInterval(() => {}, 1_000);
  yield* suspend();
});
