/**
 * What a separate process makes of one run's executor lock.
 *
 * Prints `acquired` or `already-running` and exits. It is a whole process on
 * purpose: the lock is the operating system's, and a stand-in inside the test
 * process would only prove that one registry agrees with itself.
 */

import { main } from "effection";
import { WorkflowLifecycle } from "../../mod.ts";
import { useWorkflowLifecycle } from "../../deno.ts";

await main(function* () {
  const [root, runId] = Deno.args;
  if (root === undefined || runId === undefined) {
    throw new Error("usage: executor-holder.ts <root> <run-id>");
  }

  yield* useWorkflowLifecycle({ root });
  const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
  if (!acquired.ok) {
    throw acquired.error;
  }
  console.log(acquired.value.kind);
});
