/**
 * A workflow run's pull-request lifecycle.
 *
 * The four components ask `PullRequestOperations`; this is what a workflow host
 * installs behind it. Both members pass straight through to the transport, and
 * what makes each durable lives underneath.
 *
 * A read becomes one durable effect, but not from here: retaining around the
 * whole transport would wrap the adapter's own decisions — whether it matches
 * the request, whether the host ceiling authorizes the target, whether the URL
 * names something it can read — and a target the host never authorized would
 * leave a failed read in the history, a record of a question this run was never
 * permitted to ask.
 *
 * So the durability is installed one layer down, as policy on
 * `PullRequestReadExecution`. That surface is profile-neutral and performs
 * afresh by default; an adapter reaches it only after it has admitted a read,
 * and this middleware is what makes an admitted one durable under a workflow
 * run. The adapter itself stays free of WorkflowRun and expansion context,
 * which is what lets an ordinary run install the same adapter and keep
 * nothing.
 *
 * An upsert passes through for a different reason: the Git-host reconciliation
 * beneath it is already durable and already holds this run's own Push evidence,
 * so a second envelope would retain one answer under two identities.
 *
 * ## What one read retains
 *
 * Its input is the whole normalized request — operation, canonical URL,
 * provider discriminator, collection, run and expansion — so a reader of the
 * history knows what was asked, and a document edited to read a different URL
 * or collection at that position is a different effect rather than one
 * replaying the first answer.
 *
 * It is not a reconciled Git-host effect. There is no natural key, no pre-state
 * and nothing to adopt: repeating a read is safe in the way repeating a write
 * is not.
 */

import { getExpansion } from "@executablemd/core";
import type { Operation } from "effection";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import { PullRequestReadExecution } from "../../composition/pull-request-read-execution.ts";
import {
  PullRequestOperations,
  type PullRequestReadInvocation,
  type PullRequestUpsertInvocation,
} from "../../composition/pull-request-operations.ts";
import { readRequest } from "../../composition/pull-request-read-records.ts";
import { retainPullRequestRead } from "../../composition/pull-request-read-retention.ts";

import type { PullRequestReadResult } from "../../composition/pull-request-read-records.ts";
import type { PullRequestResult } from "../../composition/pull-request-records.ts";
import { getWorkflowRun } from "@executablemd/workflow";

/**
 * Make an admitted read durable, for this scope and below.
 *
 * Installed by the workflow host beside the transport. The run and expansion it
 * needs come from context it has and the adapter does not, which is the whole
 * reason the boundary exists.
 */
export function useRetainedPullRequestReads(): Operation<void> {
  return PullRequestReadExecution.around(
    {
      *perform([admitted, transport]): Operation<PullRequestReadResult> {
        const run = yield* getWorkflowRun();
        const expansion = yield* getExpansion();
        return yield* retainPullRequestRead(
          readRequest(admitted.url, admitted.kind, admitted.provider, run.runId, expansion.id),
          transport,
        );
      },
    },
    { at: "min" },
  );
}

/** Install the retained pull-request lifecycle for the current scope and below. */
export function useRetainedPullRequestOperations(): Operation<void> {
  return PullRequestOperations.around(
    {
      // Straight through, so the adapter beneath decides when a read is
      // admitted and retains it from there. Wrapping it here would put the
      // ceiling and URL refusals inside the effect.
      *read([invocation]: [PullRequestReadInvocation]): Operation<PullRequestReadResult> {
        return yield* PullRequestAPI.operations.read(invocation.url, {
          kind: invocation.kind,
          ...(invocation.provider === null ? {} : { provider: invocation.provider }),
        });
      },

      // Straight through for its own reason: the Git-host reconciliation
      // underneath is already a durable effect keyed by this run, and wrapping
      // it in a second envelope would retain one answer under two identities.
      *upsert([invocation]: [PullRequestUpsertInvocation]): Operation<PullRequestResult> {
        return yield* PullRequestAPI.operations.upsert(invocation.pullRequest, {
          repository: invocation.repository,
          workingDirectory: invocation.workingDirectory,
        });
      },
    },
    { at: "min" },
  );
}
