/**
 * A workflow run's pull-request lifecycle.
 *
 * The four components ask `PullRequestOperations`; this is what a workflow host
 * installs behind it, and what it adds to the transport underneath is
 * durability. A read becomes one ordinary durable effect, so a completed one
 * restores its snapshot without opening a session. An upsert is passed straight
 * through to the middleware that reconciles it as a Git-host effect, because
 * that reconciliation is already durable and already holds this run's own Push
 * evidence.
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

/** Perform one read and retain it, or restore what is retained. */
function retainedRead(request: PullRequestReadRequest): Operation<PullRequestReadResult> {
  const element = ELEMENT[request.kind];

  return scoped(function* () {
    const description = yield* describeRead(request);

    const stored = yield createDurableOperation<DurableJson>(
      description,
      function* (): Operation<DurableJson> {
        const answered = yield* PullRequestAPI.operations.read(request.url, {
          kind: request.kind,
          ...(request.provider === null ? {} : { provider: request.provider }),
        });
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

/** Install the retained pull-request lifecycle for the current scope and below. */
export function useRetainedPullRequestOperations(): Operation<void> {
  return PullRequestOperations.around(
    {
      *read([invocation]: [PullRequestReadInvocation]): Operation<PullRequestReadResult> {
        const run = yield* getWorkflowRun();
        const expansion = yield* getExpansion();
        return yield* retainedRead(
          readRequest(
            invocation.url,
            invocation.kind,
            invocation.provider,
            run.runId,
            expansion.id,
          ),
        );
      },

      // Straight through. The Git-host reconciliation underneath is already a
      // durable effect keyed by this run, and wrapping it in a second envelope
      // would retain one answer under two identities.
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
