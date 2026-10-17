/**
 * What one REPL entry's `<PullRequest>` asked the Git host for, on the wire.
 *
 * An entry that opens or updates a pull request writes this down *before* the
 * service is contacted, and the external outcome is reconciled afterwards under
 * the shared Git-host contract. Those are two records, exactly as they are for
 * publication: this one says what was asked, and the Git-host record beside it
 * says what the host did about it. Reopen the entry and the saved request is
 * what the next attempt reconciles — the branch, the head and the body it
 * originally named, however far the checkout has moved since.
 *
 * A record here is not evidence that any pull request exists. An entry
 * interrupted between this append and the service leaves exactly this record
 * and no outcome, which is the window the reconciliation exists to close.
 *
 * ## Three readings of one question
 *
 * The shape follows the saved Push request beside it, for the same reasons.
 * `requested` is what the invocation observed: the pull request the document
 * authored, and the place that authored it. `received` is the same pair as they
 * stood when the live dispatch reached this provider, so an intentional
 * middleware transformation is visible rather than hidden. `resolved` is the
 * answer: the covering checkout, its common directory, the admitted
 * credential-free origin and the complete pull-request inputs, which pin the
 * head branch, the head commit and the base branch this attempt settled on.
 *
 * Only `requested` names the record. A replay matches the question, not the
 * answer, so `received` and `resolved` are read back and held to each other
 * rather than re-resolved: resolving them again would ask today's checkout what
 * a saved request meant, and the head it names has usually moved.
 *
 * ## Two naming algorithms, deliberately
 *
 * This request is named by the SHA-256 of canonical JSON, which is what every
 * retained entry record is named by. The evidence reads beside it keep the
 * *existing* `pull_request_read` name — a length-prefixed UTF-16 fingerprint
 * truncated to sixteen characters — because that name is already in journals
 * Workflow reads. They are not interchangeable and neither replaces the other.
 *
 * ## What is deliberately absent
 *
 * No opaque selection identifier, no credential, no endpoint, no provider
 * handle, no checkout inventory and no pull-request number this attempt has not
 * been given. Host paths are kept as the bytes they arrived as, for the same
 * reason the Push request keeps them: an entry's paths are places on somebody's
 * disk, and rewriting one would make a saved request name a different directory
 * than the one that was asked for.
 */

import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, text } from "../composition/parse.ts";
import { admitLocator } from "../composition/locator.ts";
import type { PullRequestInput } from "../composition/pull-request-api.ts";
import {
  parsePullRequestInputs,
  pullRequestInputsJson,
  pullRequestNumber,
  type PullRequestInputs,
} from "../composition/pull-request-records.ts";
import { sameRepositoryIdentity } from "../composition/selection.ts";
import { parseReplPushPlace, replPushPlaceJson, type ReplPushPlace } from "./push-records.ts";
import { digest, REPL_REPOSITORY_VERSION } from "./records.ts";

/** The durable type one entry pull-request request is published under. */
export const REPL_REPOSITORY_PULL_REQUEST_REQUEST = "repl_repository_pull_request_request";

/** The prefix the request's own name is built from. */
const PULL_REQUEST_REQUEST_PREFIX = "executablemd.repl.pull-request-request";

/** One reading of what was asked, and of where it was asked. */
export interface ReplPullRequestAsk {
  /** The pull request the document authored, before any resolution. */
  readonly pullRequest: PullRequestInput;
  /** The place that authored it, as the Push request records a place. */
  readonly place: ReplPushPlace;
}

/** What routing answered, and the complete request it produced. */
export interface ReplPullRequestResolution {
  /** The checkout actually covering the received working directory. */
  readonly checkoutRoot: string;
  /** That checkout's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The admitted credential-free locator this pull request belongs to. */
  readonly origin: string;
  /** The complete inputs the Git-host effect acts on. */
  readonly inputs: PullRequestInputs;
}

/** One entry pull-request request, as a continuation reads it back. */
export interface ReplPullRequestRequestRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  /** The entry whose retained work this is. */
  readonly owner: string;
  /** The invocation inside that entry, as canonical core minted it. */
  readonly site: string;
  readonly requested: ReplPullRequestAsk;
  readonly received: ReplPullRequestAsk;
  readonly resolved: ReplPullRequestResolution;
}

/** What names one request: the owner, the site and the question it asked. */
export interface ReplPullRequestRequestName {
  readonly owner: string;
  readonly site: string;
  readonly requested: ReplPullRequestAsk;
}

const RECORD_MEMBERS = ["version", "owner", "site", "requested", "received", "resolved"] as const;

const ASK_MEMBERS = ["pullRequest", "place"] as const;

const INPUT_MEMBERS = ["number", "title", "body", "draft", "base"] as const;

const RESOLUTION_MEMBERS = ["checkoutRoot", "commonDirectory", "origin", "inputs"] as const;

/**
 * The stable name one pull-request request is published under.
 *
 * A digest of the version, the owner, the site and every member of the
 * question. Two equal questions at two positions produce one name, which is
 * allowed: telling them apart is the durable engine's own positional matching,
 * and nothing here searches history by name.
 *
 * The answer takes no part in it. A name derived from the resolved head would
 * have to be recomputed to find the record, which means resolving a saved
 * request again against a checkout whose head has since moved.
 */
export function replPullRequestRequestName(request: ReplPullRequestRequestName): Operation<string> {
  return digest([
    PULL_REQUEST_REQUEST_PREFIX,
    REPL_REPOSITORY_VERSION,
    request.owner,
    request.site,
    askJson(request.requested),
  ]);
}

/** The payload one published pull-request request carries. */
export function replPullRequestRequestJson(record: {
  readonly owner: string;
  readonly site: string;
  readonly requested: ReplPullRequestAsk;
  readonly received: ReplPullRequestAsk;
  readonly resolved: ReplPullRequestResolution;
}): Json {
  return {
    version: REPL_REPOSITORY_VERSION,
    owner: record.owner,
    site: record.site,
    requested: askJson(record.requested),
    received: askJson(record.received),
    resolved: {
      checkoutRoot: record.resolved.checkoutRoot,
      commonDirectory: record.resolved.commonDirectory,
      origin: record.resolved.origin,
      inputs: pullRequestInputsJson(record.resolved.inputs),
    },
  };
}

/**
 * The pull-request request this saved value describes, or `undefined`.
 *
 * Total, and exact about every member. Beyond the shape it refuses a request
 * whose origin is not a locator this host would hand to Git, and one whose
 * resolved inputs belong to a Repository other than the one the live dispatch
 * received. It also holds the received question to the answer: a saved request
 * whose resolved title, body, draft, number or base is not the one that was
 * received describes work this entry did not ask for.
 *
 * Whether the saved roots are places this entry holds, and whether a
 * publication authorized this pull request, are not asked here. Those are
 * questions about parsed placements and about this entry's own publication
 * memory, and they are answered by the admission beside this codec.
 */
export function parseReplPullRequestRequestRecord(
  value: unknown,
): ReplPullRequestRequestRecord | undefined {
  // Totally, for the same reason the Push request codec is total: enumeration
  // and every property read are the value's own to refuse, and a refusal of any
  // of them is the same answer. Answering `undefined` is what keeps an
  // untrusted value from carrying its own text out through an exception.
  try {
    return readRequestRecord(value);
  } catch {
    return undefined;
  }
}

function readRequestRecord(value: unknown): ReplPullRequestRequestRecord | undefined {
  const read = members(value, RECORD_MEMBERS);
  if (read === undefined || read["version"] !== REPL_REPOSITORY_VERSION) {
    return undefined;
  }
  const owner = text(read["owner"]);
  const site = text(read["site"]);
  const requested = parseAsk(read["requested"]);
  const received = parseAsk(read["received"]);
  if (
    owner === undefined ||
    site === undefined ||
    requested === undefined ||
    received === undefined
  ) {
    return undefined;
  }
  const resolved = parseResolution(read["resolved"], received);
  if (resolved === undefined) {
    return undefined;
  }
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    owner,
    site,
    requested,
    received,
    resolved,
  });
}

/** One reading of what was asked and where, or `undefined`. */
function parseAsk(value: unknown): ReplPullRequestAsk | undefined {
  const read = members(value, ASK_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const pullRequest = parseAuthoredInput(read["pullRequest"]);
  const place = parseReplPushPlace(read["place"]);
  if (pullRequest === undefined || place === undefined) {
    return undefined;
  }
  return Object.freeze({ pullRequest, place });
}

/**
 * The pull request a document authored, or `undefined`.
 *
 * The five members the public input carries and no others. The number is
 * `null` when the document asked for a pull request to exist, and a positive
 * integer when it named one; the body may be empty and may not be absent,
 * because an empty `<PullRequest />` renders `""` and a missing member is a
 * second shape rather than a value.
 */
function parseAuthoredInput(value: unknown): PullRequestInput | undefined {
  const read = members(value, INPUT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const number = read["number"] === null ? null : pullRequestNumber(read["number"]);
  const title = text(read["title"]);
  const body = read["body"];
  const draft = read["draft"];
  const base = text(read["base"]);
  if (
    number === undefined ||
    title === undefined ||
    typeof body !== "string" ||
    typeof draft !== "boolean" ||
    base === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ number, title, body, draft, base });
}

/**
 * What routing resolved, held to the reading it resolved from.
 *
 * The origin is admitted through the same closed grammar a document's locator
 * passes, so a saved origin this host would not hand to Git is refused here.
 * Whether an admitted one is the origin the Repository identity was
 * fingerprinted from is the other half of that question, and the digest it
 * needs belongs to the runtime-named half of this package: the provider asks it
 * of every record it reads back, before the record may be reconciled.
 *
 * The resolved inputs are also held to the question they answer. A resolved
 * title, body, draft, number or base that is not the received one would let a
 * saved request reconcile a pull request the document never authored, so the
 * mutable fields have to agree. The head branch, head commit and base branch
 * are the answer and have no counterpart to agree with.
 */
function parseResolution(
  value: unknown,
  received: ReplPullRequestAsk,
): ReplPullRequestResolution | undefined {
  const read = members(value, RESOLUTION_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const checkoutRoot = text(read["checkoutRoot"]);
  const commonDirectory = text(read["commonDirectory"]);
  const origin = text(read["origin"]);
  const inputs = parsePullRequestInputs(read["inputs"]);
  if (
    checkoutRoot === undefined ||
    commonDirectory === undefined ||
    origin === undefined ||
    inputs === undefined
  ) {
    return undefined;
  }
  if (admitLocator(origin) !== origin) {
    return undefined;
  }
  if (!sameRepositoryIdentity(inputs.repository, received.place.repository)) {
    return undefined;
  }
  if (!resolvedAnswersAsk(inputs, received.pullRequest)) {
    return undefined;
  }
  return Object.freeze({ checkoutRoot, commonDirectory, origin, inputs });
}

/** Whether the resolved inputs carry the question that was received. */
function resolvedAnswersAsk(inputs: PullRequestInputs, asked: PullRequestInput): boolean {
  return (
    inputs.number === asked.number &&
    inputs.title === asked.title &&
    inputs.body === asked.body &&
    inputs.draft === asked.draft &&
    inputs.baseBranch === asked.base
  );
}

function askJson(ask: ReplPullRequestAsk): Json {
  return {
    pullRequest: {
      number: ask.pullRequest.number,
      title: ask.pullRequest.title,
      body: ask.pullRequest.body,
      draft: ask.pullRequest.draft,
      base: ask.pullRequest.base,
    },
    place: replPushPlaceJson(ask.place),
  };
}

/** Whether two readings of one pull request's question describe the same question. */
export function sameReplPullRequestAsk(
  left: ReplPullRequestAsk,
  right: ReplPullRequestAsk,
): boolean {
  return canonicalJson(askJson(left)) === canonicalJson(askJson(right));
}
