/**
 * The remote lifecycle provider, with this runner's own local facilities.
 *
 * The provider is host-neutral: it knows how to take an acquisition, hold a
 * lock, move a run's lifecycle and assemble a fork, and it knows none of what
 * those need underneath. This is where a Deno runner supplies them — reaching
 * an owner, reading a source without acquiring it, and building a fork
 * candidate on its own disk — so nothing host-specific reaches the shared
 * modules and the staging facility is a real implementation rather than a seam
 * waiting for one.
 *
 * Internal on purpose. Assembling this into a configured host is a later
 * slice's; what exists here is the wiring the lifecycle needs to work at all.
 */

import { randomUUID } from "node:crypto";
import type { Operation, Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { WorkflowExecutionTransitions, WorkflowForkRequest } from "../lifecycle/execution.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import type { RemoteExecutorConnection } from "../remote/lifecycle-link.ts";
import type { RemoteForkSource, RemoteReadPlane } from "../remote/read.ts";
import { useRemoteLifecycle } from "../remote/lifecycle.ts";
import { useWorkflowRunConnections, type WorkflowRunConnections } from "./connections.ts";
import { stageRemoteFork } from "./remote-staging.ts";
import { authorizedRoot } from "./provider.ts";

/** What a Deno runner supplies the remote lifecycle beyond its own disk. */
export interface RemoteWorkflowLifecycleOptions {
  /** Where fork candidates are assembled. Nothing else is kept here. */
  readonly root: string;
  /** Admit one executor connection for this run, owned by the calling scope. */
  admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">>;
  /** The no-acquisition read plane for one run. */
  source(runId: string): Operation<Result<RemoteReadPlane>>;
}

/**
 * Install the remote executor lifecycle for a Deno runner.
 *
 * The connections it stages through belong to this scope, so a candidate's
 * database handles and files go when the scope that asked for them ends.
 */
export function* installRemoteWorkflowLifecycle(
  options: RemoteWorkflowLifecycleOptions,
  connections?: WorkflowRunConnections,
): Operation<WorkflowExecutionTransitions> {
  const root = authorizedRoot(options.root);
  const held = connections ?? (yield* useWorkflowRunConnections());
  return yield* useRemoteLifecycle({
    admit: options.admit,
    source: options.source,
    *stage(
      request: WorkflowForkRequest,
      source: RemoteForkSource,
      head: { readonly runRecord: DurableEvent; readonly rootImport: DurableEvent },
    ): Operation<Result<WorkflowRunDatabase>> {
      return yield* stageRemoteFork(held, root, request, source, head);
    },
    ids: {
      // Opaque and minted here, never taken from a caller: an identity a
      // document could choose is one two runs could share.
      execution: () => randomUUID(),
      command: () => randomUUID(),
    },
  });
}
