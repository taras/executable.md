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

import { getExpansion, sourceDescription } from "@executablemd/core";
import { createDurableOperation } from "@executablemd/durable-streams";
import type { EffectDescription, Json as DurableJson } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { scoped } from "effection";
import { PullRequestReadError } from "../../composition/errors.ts";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import { PullRequestReadExecution } from "../../composition/pull-request-read-execution.ts";
import {
  PullRequestOperations,
  type PullRequestReadInvocation,
  type PullRequestUpsertInvocation,
} from "../../composition/pull-request-operations.ts";
import {
  parsePullRequestReadResult,
  pullRequestReadEnvelopeJson,
  pullRequestReadRequestJson,
  readRequest,
} from "../../composition/pull-request-read-records.ts";
import type {
  PullRequestReadKind,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import type { PullRequestResult } from "../../composition/pull-request-records.ts";
import { parseJsonValue } from "../../storage/members.ts";
import { getWorkflowRun } from "../../run.ts";
import { gitOperationFingerprint } from "./operations.ts";

/** The durable effect type one evidence read is retained under. */
export const PULL_REQUEST_READ = "pull_request_read";

/** Which element a refusal names, by the collection it was reading. */
const ELEMENT: Readonly<Record<PullRequestReadKind, string>> = Object.freeze({
  reviews: "<PullRequest.Reviews>",
  comments: "<PullRequest.Comments>",
  checks: "<PullRequest.Checks>",
});

function* describeRead(request: PullRequestReadRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  // The run is in the retained request, and deliberately not in this
  // fingerprint. A fork is a different run reaching the same position with the
  // same question, and a name that carried the run would make every inherited
  // read a different effect — which is to say, unforkable. What the name has to
  // separate is different *questions*, and the four members below are what a
  // question is made of.
  const configuration = gitOperationFingerprint([
    request.operation,
    request.url,
    request.provider,
    request.kind,
  ]);
  return {
    type: PULL_REQUEST_READ,
    name: `${request.expansionId}:${configuration}`,
    input: pullRequestReadRequestJson(request),
    configuration,
    ...sourceDescription(expansion.position),
  };
}

/**
 * Retain one admitted read, or restore what is already retained.
 *
 * Reached only through `PullRequestReadExecution`, after a transport has
 * matched the request, admitted it against the host ceiling and validated the
 * target — so the effect this creates always describes a question this run was
 * permitted to ask. Everything from here is durable: a transport or evidence
 * failure retains the failed read, and a completed one restores its snapshot
 * without opening a session or reaching the network.
 */
function retainDurableRead(
  request: PullRequestReadRequest,
  perform: () => Operation<PullRequestReadResult>,
): Operation<PullRequestReadResult> {
  const element = ELEMENT[request.kind];

  return scoped(function* () {
    const description = yield* describeRead(request);

    const stored = yield createDurableOperation<DurableJson>(
      description,
      function* (): Operation<DurableJson> {
        const answered = yield* perform();
        if (answered.kind !== request.kind) {
          throw new PullRequestReadError(
            "protocol",
            element,
            "the selected provider answered with a different collection than the one this " +
              "element asked for.",
          );
        }
        return pullRequestReadEnvelopeJson(answered);
      },
    );

    const result = parsePullRequestReadResult(
      parseJsonValue(
        stored,
        "$",
        (reason, path) =>
          new PullRequestReadError(
            "protocol",
            element,
            `what this run retained for it is not a value it can carry: ${reason} at ${path}.`,
          ),
      ),
    );
    if (result === undefined || result.kind !== request.kind) {
      throw new PullRequestReadError(
        "protocol",
        element,
        "what this run retained for it is not the evidence that read produces.",
      );
    }
    return result;
  });
}

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
        return yield* retainDurableRead(
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
