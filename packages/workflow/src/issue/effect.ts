/**
 * The durable envelope one `<Issue>` runs inside.
 *
 * It derives the idempotency key, wraps exactly one `IssueApi.upsert()` call as
 * this run's next durable effect, validates what came back, and retains the
 * URL. That is all it does — and the shortness is the design. Reconciliation is
 * knowledge about what a particular service can prove, so it belongs to the
 * middleware that holds the credential rather than to a state machine here that
 * would have to be told.
 *
 * ## What the envelope guarantees, and what it does not
 *
 * It guarantees that the call happens at most once per position, that a replay
 * returns the retained URL without invoking `IssueApi` at all, and that a
 * changed request diverges instead of consuming another request's result.
 *
 * It does not guarantee that the *service* was touched once. That is the
 * provider's, and the idempotency key is what this side hands over so the
 * provider can make it true: an attempt interrupted after the service accepted
 * it leaves no journal entry, and the next attempt presents the same key.
 *
 * ## Identity, and what may name it
 *
 * The run and the expansion, derived here from the host-established
 * `getWorkflowRun()` and the engine's own `getExpansion()`. Neither the
 * document, the tracker, middleware nor a provider supplies either member,
 * because a party that could name the identity could name someone else's issue.
 */

import type { Operation } from "effection";
import {
  createDurableOperation,
  type EffectDescription,
  type Json,
  type Workflow,
} from "@executablemd/durable-streams";
import { getExpansion } from "@executablemd/core";
import { getWorkflowRun, retainedIssueIdentitiesHere } from "../run.ts";
import { claimRetainedIssueIdentity, exhaustRetainedIssueIdentities } from "./identities.ts";
import { ISSUE_EFFECT } from "./effect-type.ts";
import { IssueApi } from "./api.ts";
import type { IssueInput, IssueResult } from "./api.ts";
import { IssueProtocolError } from "./errors.ts";
import {
  issueIdempotencyKey,
  issueRecordJson,
  issueRequestFingerprint,
  issueRequestJson,
  parseIssueRecord,
  type IssueRequest,
} from "./records.ts";

export { ISSUE_EFFECT } from "./effect-type.ts";

/** What one `<Issue>` asks the envelope for. */
export interface IssueEffectRequest {
  /** The canonical container URL. */
  readonly target: string;
  /** The explicit discriminator, or `undefined` when the tracker named none. */
  readonly provider: string | undefined;
  readonly issue: IssueInput;
}

/**
 * Create or bring up to date one issue, as this run's next durable effect.
 *
 * Live, this calls `IssueApi.upsert()` once and retains the URL it answered
 * with. Replayed, it hands back the retained URL without resolving a provider,
 * reaching one, or appending anything.
 */
export function* upsertIssue(request: IssueEffectRequest): Operation<IssueResult> {
  const run = yield* getWorkflowRun();
  const expansion = yield* getExpansion();

  // A position this run already retains a record at is named by the identity
  // that record holds; everywhere else by this run's own. A fork inherits its
  // source's history, and an inherited issue has to keep the key it was created
  // under or the fork would file a second one.
  const live: IssueRequest = Object.freeze({
    identity: { runId: run.runId, expansionId: expansion.id },
    target: request.target,
    provider: request.provider ?? null,
    issue: request.issue,
  });
  const held = yield* retainedIssueIdentitiesHere();
  const borrowed = claimRetainedIssueIdentity(held, live);
  const complete: IssueRequest =
    borrowed === undefined
      ? live
      : Object.freeze({ ...live, identity: { runId: borrowed, expansionId: expansion.id } });

  const description: EffectDescription = {
    type: ISSUE_EFFECT,
    name: yield* issueRequestFingerprint(complete),
    // Carried in the description so a retained history describes what it asked
    // for. The identity table reads it back to recognize a record a fork
    // inherited, and it holds only what a document wrote.
    request: issueRequestJson(complete),
  };

  const retained: unknown = yield* attempt(
    description,
    complete,
    held !== undefined && borrowed !== undefined,
  );
  const record = parseIssueRecord(retained);
  if (record === undefined) {
    throw new IssueProtocolError(
      "the journal holds a value that does not describe an issue result",
    );
  }
  return record;
}

function* attempt(
  description: EffectDescription,
  request: IssueRequest,
  borrowed: boolean,
): Workflow<unknown> {
  return yield createDurableOperation<Json>(description, function* (): Operation<Json> {
    if (borrowed) {
      // The request was named by a retained record, which cannot be a live
      // request: performing under a run this execution is not would repeat
      // work that already happened at a service this journal does not enclose.
      throw new IssueProtocolError(
        "this request is named by retained history it never consumed, so creating an issue " +
          "here would repeat work that already happened outside this journal",
      );
    }
    const answered = yield* IssueApi.operations.upsert(request.issue, {
      url: request.target,
      ...(request.provider === null ? {} : { provider: request.provider }),
      idempotencyKey: issueIdempotencyKey(request.identity, request.target),
    });
    // Validated before it is retained. A provider that answered with more than
    // a URL answered with something this boundary will not carry, and reading
    // it anyway is how a provider's own identity reaches a document.
    const record = parseIssueRecord(answered);
    if (record === undefined) {
      throw new IssueProtocolError(
        "the issue provider answered with something that is not a URL, so nothing was retained",
      );
    }
    return issueRecordJson(record);
  });
}

/** The durable request one retained record answers, for a reader. */
export { issueRequestJson };

/** Take the rest of an inherited prefix out of use once a call has run live. */
export { exhaustRetainedIssueIdentities };
