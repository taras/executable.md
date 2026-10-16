/**
 * The retained Issue lifecycle a workflow run installs.
 *
 * The envelope itself is `owned.ts`, shared with the other profile that retains
 * Issue work. What belongs here is the half that is a workflow run's own: that
 * the run and the expansion are what name a durable effect, that an inherited
 * prefix may lend an upsert the identity it was created under, and that a live
 * attempt calls `IssueApi` directly.
 *
 * ## One effect type, two operations
 *
 * Both journal as `issue_effect`, and the request carries which one it is. That
 * discriminator is in the durable name and, for an upsert, in the idempotency
 * key — so a read can never arrive at an upsert's retained result, and two
 * reads of different issues at one position are two different questions.
 *
 * ## What each guarantees, and what it does not
 *
 * A read retains the snapshot it saw. Replay hands that snapshot back without
 * resolving a provider or reaching one; a later authored read at another
 * position is a separate observation and may see something else, which is what
 * reading a live object means.
 *
 * An upsert guarantees that the call happens at most once per position and that
 * a replay returns the retained URL. It does not guarantee that the *service*
 * was touched once: that is the provider's, and the idempotency key is what this
 * side hands over so the provider can make it true. An attempt interrupted
 * after the service accepted it leaves no journal entry, and the next attempt
 * presents the same key.
 *
 * ## Identity, and what may name it
 *
 * The run and the expansion, derived here from the host-established
 * `getWorkflowRun()` and the engine's own `getExpansion()`. Neither the
 * document, the tracker, middleware nor a provider supplies either member,
 * because a party that could name the identity could name someone else's issue.
 */

import type { Operation } from "effection";
import { getExpansion } from "@executablemd/core";
import { getWorkflowRun } from "@executablemd/workflow";
import { retainedIssueIdentitiesHere } from "../identities.ts";
import { claimRetainedIssueIdentity, exhaustRetainedIssueIdentities } from "./identities.ts";
import { IssueApi } from "./api.ts";
import { IssueOperations } from "./operations.ts";
import type { IssueReadInvocation, IssueUpsertInvocation } from "./operations.ts";
import type { IssueDetails, IssueReference } from "./api.ts";
import { IssueProtocolError } from "./errors.ts";
import { issueIdempotencyKey } from "./records.ts";
import { ownedUpsertRequest, readOwnedIssue, upsertOwnedIssue } from "./owned.ts";
import type { IssueReadEffectRequest, IssueUpsertEffectRequest } from "./owned.ts";

export type { IssueReadEffectRequest, IssueUpsertEffectRequest } from "./owned.ts";

/**
 * Read one issue, as this run's next durable effect.
 *
 * Live, this calls `IssueApi.read()` once and retains the fields it answered
 * with. Replayed, it hands back that snapshot without resolving a provider,
 * reaching one, or appending anything.
 */
export function* readIssue(request: IssueReadEffectRequest): Operation<IssueDetails> {
  const identity = yield* effectIdentity();
  return yield* readOwnedIssue(
    { owner: identity.runId, site: identity.expansionId, request },
    function* (): Operation<unknown> {
      return yield* IssueApi.operations.read(request.url, {
        ...(request.provider === undefined ? {} : { provider: request.provider }),
      });
    },
  );
}

/**
 * Create or bring up to date one issue, as this run's next durable effect.
 *
 * Live, this calls `IssueApi.upsert()` once and retains the URL it answered
 * with. Replayed, it hands back the retained URL without resolving a provider,
 * reaching one, or appending anything.
 */
export function* upsertIssue(request: IssueUpsertEffectRequest): Operation<IssueReference> {
  const identity = yield* effectIdentity();

  // A position this run already retains a record at is named by the identity
  // that record holds; everywhere else by this run's own. A fork inherits its
  // source's history, and an inherited issue has to keep the key it was created
  // under or the fork would file a second one.
  //
  // Only an upsert borrows. A read has no key and reconciles nothing, so
  // lending it an identity would buy nothing and cost the ordering the
  // inherited prefix is consumed in.
  const held = yield* retainedIssueIdentitiesHere();
  const borrowed = claimRetainedIssueIdentity(
    held,
    ownedUpsertRequest({ owner: identity.runId, site: identity.expansionId, request }),
  );
  const owner = borrowed ?? identity.runId;
  const key = issueIdempotencyKey(
    { runId: owner, expansionId: identity.expansionId },
    "upsert",
    request.target,
  );

  return yield* upsertOwnedIssue(
    { owner, site: identity.expansionId, request },
    function* (): Operation<unknown> {
      if (borrowed !== undefined) {
        // The request was named by a retained record, which cannot be a live
        // request: performing under a run this execution is not would repeat
        // work that already happened at a service this journal does not
        // enclose.
        exhaustRetainedIssueIdentities(held);
        throw new IssueProtocolError(
          "this request is named by retained history it never consumed, so creating an issue " +
            "here would repeat work that already happened outside this journal",
        );
      }
      return yield* IssueApi.operations.upsert(request.issue, {
        url: request.target,
        ...(request.provider === undefined ? {} : { provider: request.provider }),
        idempotencyKey: key,
      });
    },
  );
}

function* effectIdentity(): Operation<{ runId: string; expansionId: string }> {
  const run = yield* getWorkflowRun();
  const expansion = yield* getExpansion();
  return { runId: run.runId, expansionId: expansion.id };
}

/**
 * Install the retained Issue lifecycle for the current scope and below.
 *
 * What a workflow run adds to the transport underneath is exactly the envelope
 * above: one durable effect per operation, named by this run and this
 * expansion. `<Issue>` asks `IssueOperations`, this answers, and the installed
 * `IssueApi` middleware still owns which service is reached and what a
 * credential may see.
 */
export function useRetainedIssueOperations(): Operation<void> {
  return IssueOperations.around(
    {
      read: ([invocation]: [IssueReadInvocation]) => readIssue(invocation),
      upsert: ([invocation]: [IssueUpsertInvocation]) => upsertIssue(invocation),
    },
    { at: "min" },
  );
}
