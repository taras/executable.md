/**
 * The durable envelope the two Issue operations run inside.
 *
 * Each derives what it needs, wraps exactly one `IssueApi` call as this run's
 * next durable effect, validates what came back, and retains it. That is all
 * either does — and the shortness is the design. Reconciliation is knowledge
 * about what a particular service can prove, so it belongs to the middleware
 * that holds the credential rather than to a state machine here.
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
 * An effect owner and an authored site. For a workflow run both are derived
 * here, from the host-established `getWorkflowRun()` and the engine's own
 * `getExpansion()`; a host that is not a workflow run states them itself,
 * through {@link readOwnedIssue} and {@link upsertOwnedIssue}. Either way they
 * come from something the host established. Neither the document, the tracker,
 * middleware nor a provider supplies either member, because a party that could
 * name the identity could name someone else's issue.
 */

import type { Operation } from "effection";
import {
  createDurableOperation,
  type EffectDescription,
  type Json,
  type Workflow,
} from "@executablemd/durable-streams";
import { getExpansion, sourceDescription } from "@executablemd/core";
import { getWorkflowRun } from "@executablemd/workflow";
import { retainedIssueIdentitiesHere } from "../identities.ts";
import { claimRetainedIssueIdentity, exhaustRetainedIssueIdentities } from "./identities.ts";
import { ISSUE_EFFECT } from "./effect-type.ts";
import { IssueApi } from "./api.ts";
import { IssueOperations } from "./operations.ts";
import type { IssueReadInvocation, IssueUpsertInvocation } from "./operations.ts";
import type { IssueDetails, IssueInput, IssueReference } from "./api.ts";
import { IssueProtocolError } from "./errors.ts";
import {
  issueDetailsJson,
  issueIdempotencyKey,
  issueRecordJson,
  issueRequestFingerprint,
  issueRequestJson,
  parseIssueDetails,
  parseIssueRecord,
  type IssueReadRequest,
  type IssueRequest,
  type IssueUpsertRequest,
} from "./records.ts";

export { ISSUE_EFFECT } from "./effect-type.ts";

/** What one read asks the envelope for. */
export interface IssueReadEffectRequest {
  /** The canonical issue URL. */
  readonly url: string;
  /** The explicit discriminator, or `undefined` when the document named none. */
  readonly provider: string | undefined;
}

/** What one upsert asks the envelope for. */
export interface IssueUpsertEffectRequest {
  /** The canonical container URL. */
  readonly target: string;
  /** The explicit discriminator, or `undefined` when the tracker named none. */
  readonly provider: string | undefined;
  readonly issue: IssueInput;
}

/**
 * Read one issue, as this run's next durable effect.
 *
 * Live, this calls `IssueApi.read()` once and retains the fields it answered
 * with. Replayed, it hands back that snapshot without resolving a provider,
 * reaching one, or appending anything.
 */
export function* readIssue(request: IssueReadEffectRequest): Operation<IssueDetails> {
  const identity = yield* effectIdentity();
  return yield* readOwnedIssue({ owner: identity.runId, site: identity.expansionId, request });
}

/**
 * The identity a host that is not a workflow run states for itself.
 *
 * `owner` travels in the legacy `runId` member, which is what keeps the
 * retained record shapes and the upsert idempotency keys byte-compatible, and
 * `site` is the canonical occurrence of the element asking, as that host
 * authenticated it. Both are opaque here: this module never interprets either,
 * and the caller is the only thing that can establish them.
 */
export interface OwnedIssueEffect<Request> {
  readonly owner: string;
  readonly site: string;
  readonly request: Request;
}

/**
 * Read one issue under an identity its own host authenticated.
 *
 * The same durable effect, named the same way; what differs is only who said
 * the identity. A read reconciles nothing and borrows nothing, so there is
 * nothing else for this surface to leave out.
 */
export function* readOwnedIssue(
  owned: OwnedIssueEffect<IssueReadEffectRequest>,
): Operation<IssueDetails> {
  const request = owned.request;
  const complete: IssueReadRequest = Object.freeze({
    operation: "read" as const,
    identity: { runId: owned.owner, expansionId: owned.site },
    url: request.url,
    provider: request.provider ?? null,
  });

  const retained: unknown = yield* attempt(
    yield* describe(complete),
    function* (): Operation<Json> {
      const answered = yield* IssueApi.operations.read(complete.url, {
        ...(complete.provider === null ? {} : { provider: complete.provider }),
      });
      // Validated before it is retained. A provider that answered with more
      // than the shared fields answered with something this boundary will not
      // carry, and reading it anyway is how a provider's own shape reaches a
      // document.
      const details = parseIssueDetails(answered);
      if (details === undefined) {
        throw new IssueProtocolError(
          "the issue provider answered a read with something that is not an issue's shared " +
            "fields, so nothing was retained",
        );
      }
      return issueDetailsJson(details);
    },
  );
  const details = parseIssueDetails(retained);
  if (details === undefined) {
    throw new IssueProtocolError(
      "the journal holds a value that does not describe an issue's shared fields",
    );
  }
  return details;
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
  const live: IssueUpsertRequest = Object.freeze({
    operation: "upsert" as const,
    identity,
    target: request.target,
    provider: request.provider ?? null,
    issue: request.issue,
  });

  // A position this run already retains a record at is named by the identity
  // that record holds; everywhere else by this run's own. A fork inherits its
  // source's history, and an inherited issue has to keep the key it was created
  // under or the fork would file a second one.
  //
  // Only an upsert borrows. A read has no key and reconciles nothing, so
  // lending it an identity would buy nothing and cost the ordering the
  // inherited prefix is consumed in.
  const held = yield* retainedIssueIdentitiesHere();
  const borrowed = claimRetainedIssueIdentity(held, live);
  const complete: IssueUpsertRequest =
    borrowed === undefined
      ? live
      : Object.freeze({ ...live, identity: { ...identity, runId: borrowed } });

  return yield* upserted(
    complete,
    () => {
      // The request was named by a retained record, which cannot be a live
      // request: performing under a run this execution is not would repeat work
      // that already happened at a service this journal does not enclose.
      exhaustRetainedIssueIdentities(held);
    },
    borrowed !== undefined,
  );
}

/**
 * Create or bring up to date one issue under an identity its own host
 * authenticated.
 *
 * No identity is borrowed: borrowing is a workflow fork keeping the key an
 * inherited issue was created under, and an owner that is not a workflow run
 * has no fork to inherit from. Everything else — the durable name, the
 * idempotency key the provider reconciles with, the validation — is the same.
 */
export function* upsertOwnedIssue(
  owned: OwnedIssueEffect<IssueUpsertEffectRequest>,
): Operation<IssueReference> {
  const request = owned.request;
  return yield* upserted(
    Object.freeze({
      operation: "upsert" as const,
      identity: { runId: owned.owner, expansionId: owned.site },
      target: request.target,
      provider: request.provider ?? null,
      issue: request.issue,
    }),
    () => {},
    false,
  );
}

/**
 * One upsert, once the identity is settled.
 *
 * `borrowedName` is the workflow fork's condition: a request this execution did
 * not name cannot be the one a live attempt performs under, and reaching the
 * live path with one retires the inherited identities rather than using them.
 */
function* upserted(
  complete: IssueUpsertRequest,
  exhaust: () => void,
  borrowedName: boolean,
): Operation<IssueReference> {
  const retained: unknown = yield* attempt(
    yield* describe(complete),
    function* (): Operation<Json> {
      if (borrowedName) {
        exhaust();
        throw new IssueProtocolError(
          "this request is named by retained history it never consumed, so creating an issue " +
            "here would repeat work that already happened outside this journal",
        );
      }
      const answered = yield* IssueApi.operations.upsert(complete.issue, {
        url: complete.target,
        ...(complete.provider === null ? {} : { provider: complete.provider }),
        idempotencyKey: issueIdempotencyKey(complete.identity, "upsert", complete.target),
      });
      const record = parseIssueRecord(answered);
      if (record === undefined) {
        throw new IssueProtocolError(
          "the issue provider answered an upsert with something that is not a URL, so nothing " +
            "was retained",
        );
      }
      return issueRecordJson(record);
    },
  );
  const record = parseIssueRecord(retained);
  if (record === undefined) {
    throw new IssueProtocolError(
      "the journal holds a value that does not describe an issue reference",
    );
  }
  return record;
}

function* effectIdentity(): Operation<{ runId: string; expansionId: string }> {
  const run = yield* getWorkflowRun();
  const expansion = yield* getExpansion();
  return { runId: run.runId, expansionId: expansion.id };
}

function* describe(request: IssueRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  return {
    type: ISSUE_EFFECT,
    name: yield* issueRequestFingerprint(request),
    // Carried in the description so a retained history describes what it asked
    // for. The identity table reads it back to recognize a record a fork
    // inherited, and it holds only what a document wrote.
    request: issueRequestJson(request),
    // Where the authored component asking for this effect was written —
    // diagnostic journal data, never part of the fingerprint, the request, or
    // the identity table.
    ...sourceDescription(expansion.position),
  };
}

function* attempt(
  description: EffectDescription,
  perform: () => Operation<Json>,
): Workflow<unknown> {
  return yield createDurableOperation<Json>(description, perform);
}

export { issueRequestJson };

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
