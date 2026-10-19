/**
 * The durable envelope an Issue operation runs inside, for whoever owns it.
 *
 * `effect.ts` used to be both halves of this: the envelope, and the decision
 * that a workflow run and an expansion are what name it. Two profiles now
 * retain Issue work — a workflow run, and a REPL entry — and they agree about
 * everything except where the name comes from and what the live attempt does.
 * So the agreement is here and the two decisions stay with their profiles.
 *
 * What one of these workers does is fixed: build the complete request, name the
 * durable operation after a digest of it, invoke the caller's live operation
 * exactly once inside that operation, validate what came back before it is
 * retained, and validate it again when it is read back.
 *
 * The transport call a live attempt ends in is fixed too, and is here:
 * {@link liveIssueRead} and {@link liveIssueUpsert}. What differs is only what
 * the profile wraps around it — a workflow run installs this envelope at the
 * `IssueOperations` seam and calls the transport directly beneath the public
 * chain, and a REPL entry owns the envelope above that chain and composes it
 * per live attempt. That is why the live operation is still a callback.
 *
 * ## Owner and site, rather than run and expansion
 *
 * The two members of the retained identity, named for what they are rather than
 * for the profile that first supplied them. `owner` is whoever this operation's
 * history belongs to and `site` is which invocation inside it this is; a
 * workflow run supplies its run id and the expansion, and a REPL entry supplies
 * its own private owner and the invocation identity canonical core minted. The
 * `runId`/`expansionId` field spellings in the record are a compatibility
 * encoding of exactly those two, so a history written under either profile is
 * read by both.
 *
 * Neither member comes from the document, the tracker, middleware or a
 * provider, for the reason it never did: a party that could name the identity
 * could name someone else's issue.
 */

import type { Operation } from "effection";
import {
  createDurableOperation,
  type EffectDescription,
  type Json,
} from "@executablemd/durable-streams";
import { getExpansion, sourceDescription } from "@executablemd/core";
import { ISSUE_EFFECT } from "./effect-type.ts";
import { IssueApi } from "./api.ts";
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

/** Whose retained history this operation belongs to, and which invocation it is. */
interface OwnedIssue {
  /** The history this operation is retained in: a workflow run, or one entry. */
  readonly owner: string;
  /** The invocation inside that history, as its own profile authenticated it. */
  readonly site: string;
}

export interface OwnedIssueRead extends OwnedIssue {
  readonly request: IssueReadEffectRequest;
}

export interface OwnedIssueUpsert extends OwnedIssue {
  readonly request: IssueUpsertEffectRequest;
}

/** The live transport call one read ends in, whichever profile retains it. */
export function liveIssueRead(request: IssueReadEffectRequest): Operation<IssueDetails> {
  return IssueApi.operations.read(request.url, {
    ...(request.provider === undefined ? {} : { provider: request.provider }),
  });
}

/** The live transport call one upsert ends in, under this attempt's own key. */
export function liveIssueUpsert(
  request: IssueUpsertEffectRequest,
  key: string,
): Operation<IssueReference> {
  return IssueApi.operations.upsert(request.issue, {
    url: request.target,
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    idempotencyKey: key,
  });
}

/**
 * What makes a second upsert attempt the same attempt.
 *
 * Derived from the complete request's own identity and target before any
 * middleware saw it: a handler that transformed the issue, the target or the
 * discriminator changes what is sent and changes nothing about which attempt
 * this is.
 */
export function ownedUpsertKey(owner: string, site: string, target: string): string {
  return issueIdempotencyKey({ runId: owner, expansionId: site }, "upsert", target);
}

/**
 * The complete read request this owner and site name.
 *
 * Built here rather than by each caller, because the encoding is what the
 * durable name, the identity table and the retained history all agree about.
 */
export function ownedReadRequest(input: OwnedIssueRead): IssueReadRequest {
  return Object.freeze({
    operation: "read" as const,
    identity: { runId: input.owner, expansionId: input.site },
    url: input.request.url,
    provider: input.request.provider ?? null,
  });
}

/** The complete upsert request this owner and site name, on the same terms. */
export function ownedUpsertRequest(input: OwnedIssueUpsert): IssueUpsertRequest {
  return Object.freeze({
    operation: "upsert" as const,
    identity: { runId: input.owner, expansionId: input.site },
    target: input.request.target,
    provider: input.request.provider ?? null,
    issue: input.request.issue,
  });
}

/**
 * Read one issue, as this owner's next durable effect at this site.
 *
 * Live, `perform` is invoked once and the fields it answered with are retained.
 * Replayed, the snapshot comes back without `perform` being invoked at all — so
 * no provider is resolved, no transport is reached and nothing is appended.
 */
export function readOwnedIssue(
  input: OwnedIssueRead,
  perform: () => Operation<unknown>,
): Operation<IssueDetails> {
  return reading(ownedReadRequest(input), perform);
}

function* reading(
  complete: IssueReadRequest,
  perform: () => Operation<unknown>,
): Operation<IssueDetails> {
  const retained: unknown = yield* attempt(
    yield* describe(complete),
    function* (): Operation<Json> {
      const answered = yield* perform();
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
 * Create or bring up to date one issue, as this owner's next durable effect at
 * this site.
 *
 * Live, `perform` is invoked once and the URL it answered with is retained.
 * Replayed, that URL comes back without `perform` being invoked.
 *
 * What makes a second attempt the same attempt is not decided here: the key is
 * derived from this request's own identity and target, and the caller carries it
 * to the transport. An attempt interrupted after the service accepted it leaves
 * no record, and the next attempt presents the same key.
 */
export function upsertOwnedIssue(
  input: OwnedIssueUpsert,
  perform: () => Operation<unknown>,
): Operation<IssueReference> {
  return upserting(ownedUpsertRequest(input), perform);
}

function* upserting(
  complete: IssueUpsertRequest,
  perform: () => Operation<unknown>,
): Operation<IssueReference> {
  const retained: unknown = yield* attempt(
    yield* describe(complete),
    function* (): Operation<Json> {
      const answered = yield* perform();
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

/**
 * Whatever comes back is journal data on a replay, so it is handed on as the
 * unknown it is and parsed by the caller above rather than trusted here.
 */
function* attempt(
  description: EffectDescription,
  perform: () => Operation<Json>,
): Operation<unknown> {
  return yield createDurableOperation<Json>(description, perform);
}
