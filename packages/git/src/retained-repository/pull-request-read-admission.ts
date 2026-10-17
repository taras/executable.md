/**
 * Whether one entry's retained evidence reads may be continued at all.
 *
 * Three questions. **Integrity**: every retained read's description parses as
 * the closed normalized request. **Ownership**: every one of them names this
 * entry's owner. **Result**: a settled one holds the envelope its own
 * collection produces, with every check it carries about the head it recorded.
 *
 * Ownership is asked explicitly, and that is the whole reason this boundary
 * exists. The read name deliberately omits the owner — a fork is a different
 * run reaching the same position with the same question, and a name carrying
 * the run would make every inherited read unforkable — so the name alone cannot
 * tell this entry's read from another's. A record whose `runId` is somebody
 * else's is refused however correct its name is, and that is asked of a failed
 * read's description too: a failure retains no result to check, but its
 * description still says who asked.
 *
 * Nothing here contacts a URL, opens a session or hands a result out.
 * Replaying a completed read is the durable engine's own positional matching,
 * and this runs before any of it. Whether the ceiling still authorizes a saved
 * read is a different question, asked by the adapter on every execution.
 *
 * ## Why the name check is not here
 *
 * The read's name is a synchronous native digest, and that digest belongs to
 * the runtime-named half of this package rather than to this graph — the same
 * split the saved publication request keeps when it leaves its origin's
 * fingerprint to the provider that reads it back. So the caller computes the
 * name and this module answers everything a name cannot: what the record is,
 * whose it is, and whether its value is the evidence it claims.
 */

import { StaleInputError } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import {
  parsePullRequestReadRequest,
  parsePullRequestReadResult,
} from "../composition/pull-request-read-records.ts";
import type {
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../composition/pull-request-read-records.ts";

/** Why one entry's retained evidence-read history cannot be continued. */
export type ReplPullRequestReadRefusal =
  /** A retained read whose description this host cannot read. */
  | "malformed-record"
  /** A retained read naming a history that is not this entry's. */
  | "foreign-owner"
  /** A retained read journaled under a name its own question does not produce. */
  | "request-fingerprint"
  /** A settled read holding a value that is not the evidence a read produces. */
  | "malformed-result";

/**
 * A retained evidence-read history this entry cannot continue from.
 *
 * Fatal by construction: it extends `StaleInputError`, so it ends the attempt
 * rather than becoming a value a document can print away and carry on past.
 */
export class ReplPullRequestReadHistoryError extends StaleInputError {
  override name = "ReplPullRequestReadHistoryError";

  readonly reason: ReplPullRequestReadRefusal;

  constructor(reason: ReplPullRequestReadRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/**
 * The question one retained read asked, held to this entry, or the refusal.
 *
 * Asked of every retained read, settled or failed, because a description says
 * who asked whether or not there is a result beside it.
 */
export function admitReplPullRequestReadRequest(
  owner: string,
  input: Json | undefined,
): PullRequestReadRequest {
  const request = parsePullRequestReadRequest(input);
  if (request === undefined) {
    throw readRefusal(
      "malformed-record",
      "a retained evidence read in this entry's history is not one this host can read, so what " +
        "it says was read is unknown.",
    );
  }
  if (request.runId !== owner) {
    throw readRefusal(
      "foreign-owner",
      "a retained evidence read in this entry's history was written under another owner, so the " +
        "collection it describes was not read by this entry and its record is not one this " +
        "entry can present again.",
    );
  }
  return request;
}

/** The refusal a read journaled under the wrong name gets. */
export function replPullRequestReadNameRefusal(): ReplPullRequestReadHistoryError {
  return readRefusal(
    "request-fingerprint",
    "a retained evidence read is journaled under a name that is not the name its own question " +
      "produces, so the record and the read it claims to be do not match.",
  );
}

/**
 * The collection one settled read retained, or the refusal that it retained
 * something else.
 *
 * The envelope has to be the one this question asked for, and a checks envelope
 * has to be internally consistent: every item about the head it recorded. That
 * is asked even of an empty collection, because an empty checks result still
 * says which head was read and that head is the whole of what it claims.
 */
export function admitReplPullRequestReadResult(
  request: PullRequestReadRequest,
  value: Json | undefined,
): PullRequestReadResult {
  const envelope = value === undefined ? undefined : parsePullRequestReadResult(value);
  if (envelope === undefined || envelope.kind !== request.kind) {
    throw readRefusal(
      "malformed-result",
      "a retained evidence read holds a value that is not the collection its own question asked " +
        "for, so what it says was read is unknown.",
    );
  }
  if (envelope.kind === "checks" && !sameHead(envelope.headSha, envelope.items)) {
    throw readRefusal(
      "malformed-result",
      "a retained checks read holds an item for a different head than the one it recorded, so " +
        "what it says about that commit is unknown.",
    );
  }
  return envelope;
}

/** Whether every check in this collection is about the head that was read. */
function sameHead(headSha: string, items: readonly { readonly headSha: string }[]): boolean {
  return items.every((item) => item.headSha === headSha);
}

function readRefusal(
  reason: ReplPullRequestReadRefusal,
  sentence: string,
): ReplPullRequestReadHistoryError {
  return new ReplPullRequestReadHistoryError(reason, sentence);
}
