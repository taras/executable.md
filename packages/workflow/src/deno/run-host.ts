/**
 * Everything one Deno host installs to run and manage workflow runs.
 *
 * Storage and lifecycle write to the same databases, so the host owns one
 * connection registry and hands the same one to each. Installing them
 * separately still works — each allocates its own — but a host doing both would
 * then have two authoritative writers for one file, which is the invariant the
 * registry exists to hold.
 */

import type { Operation } from "effection";
import type { WorkflowExecutionTransitions } from "../lifecycle/execution.ts";
import { useWorkflowRunConnections } from "./connections.ts";
import { installWorkflowLifecycle } from "./lifecycle.ts";
import { installWorkflowRunStorage, type WorkflowRunStorageOptions } from "./provider.ts";
import { SavepointObservation } from "./savepoints.ts";

/** What one host installs. */
export type WorkflowRunHostOptions = WorkflowRunStorageOptions;

export function* useWorkflowRunHost(
  options: WorkflowRunHostOptions,
): Operation<WorkflowExecutionTransitions> {
  const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
  yield* installWorkflowRunStorage({ root: options.root }, {}, connections);
  return yield* installWorkflowLifecycle({ root: options.root }, connections);
}
