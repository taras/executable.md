/**
 * What one REPL entry's `<PullRequest>` asked for, on the wire.
 *
 * An entry that opens or updates a pull request writes this down *before* the
 * Git host is contacted, and the external outcome is reconciled afterwards
 * under the shared Git-host contract. Those are two records at two positions:
 * this one says what was asked, and the Git-host record beside it says what the
 * host did about it. Reopen the entry and the saved request is what the next
 * attempt reconciles — the exact title, body, head and destination it
 * originally named, however far the checkout has moved since.
 *
 * It is a request publication and nothing else. A record here is not evidence
 * that anything was opened: an entry interrupted between this append and the
 * host leaves exactly this record and no outcome, which is the window the
 * reconciliation exists to close. It is also not publication evidence — what
 * authorizes an upsert is this entry's own matching acknowledged Push, proven
 * before this record is written.
 *
 * ## Three readings of one request
 *
 * `requested` is what the invocation observed: the place it authenticated and
 * the content the document wrote, normalized. `received` is the same pair as it
 * stood when the live dispatch reached this provider, so an intentional
 * middleware transformation is visible rather than hidden — when nothing
 * transformed them the two readings are equal and both are still written.
 * `resolved` is the answer: the covering checkout, its common directory, the
 * admitted credential-free origin and the complete pull-request inputs,
 * including the head commit this attempt resolved.
 *
 * Only `requested` names the record. A replay matches the question, not the
 * answer, so `received` and `resolved` are read back and held to each other
 * rather than re-resolved: resolving them again would ask today's checkout what
 * a saved request meant, and the head it answered with then is the head the
 * host was asked about.
 *
 * ## What is deliberately absent
 *
 * No credential, endpoint, Git output, object source, selection token or
 * publication flag. The body is verbatim and may be empty, because an entry
 * that publishes a reflowed body publishes something nobody wrote. Host paths
 * are kept as the bytes they arrived as, for the reason the Push request keeps
 * them: an entry's paths are places on somebody's disk.
 */

import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, text } from "../composition/parse.ts";
import { admitLocator } from "../composition/locator.ts";
import {
  parsePullRequestInputs,
  pullRequestInputsJson,
  type PullRequestInputs,
} from "../composition/pull-request-records.ts";
import {
  parseRepositoryIdentity,
  repositoryIdentityJson,
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../composition/selection.ts";
import { digest, REPL_REPOSITORY_VERSION } from "./records.ts";

export const REPL_REPOSITORY_PULL_REQUEST_REQUEST = "repl_repository_pull_request_request";

const PULL_REQUEST_REQUEST_PREFIX = "executablemd.repl.pull-request-request";

/**
 * Where one pull request was asked for, as one reading of it.
 *
 * The same four facts the Push request carries, and for the same reason: the
 * upsert belongs to the Repository the invocation authenticated, to the
 * checkout that selection named, to the repository that checkout shares, and to
 * the directory the element was written in.
 */
export interface ReplPullRequestPlace {
  /** All six members of the authenticated Repository identity. */
  readonly repository: RepositoryIdentity;
  /** The checkout root the authenticated selection named. */
  readonly selectionCheckout: string;
  /** That selection's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The working directory exactly as it was received, uncanonicalized. */
  readonly workingDirectory: string;
}

/**
 * What the document asked for, normalized.
 *
 * `number` is a positive integer when the document named one and `null` when it
 * asked for a pull request to exist — absence is `null` from here on, because a
 * member that is sometimes missing is a second shape. `base` is the destination
 * branch the invocation settled on, which is the Repository's pinned primary
 * branch unless the document wrote one.
 */
export interface ReplPullRequestContent {
  readonly number: number | null;
  readonly title: string;
  /** Verbatim, and may be empty. */
  readonly body: string;
  readonly draft: boolean;
  readonly base: string;
}

/** One reading of a pull-request request: where, and what. */
export interface ReplPullRequestAsked {
  readonly place: ReplPullRequestPlace;
  readonly pullRequest: ReplPullRequestContent;
}

/** What routing answered, and the complete request it produced. */
export interface ReplPullRequestResolution {
  /** The checkout actually covering the received working directory. */
  readonly checkoutRoot: string;
  /** That checkout's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The admitted credential-free locator this pull request belongs to. */
  readonly origin: string;
  /** The complete inputs the Git-host effect acts on, head commit included. */
  readonly inputs: PullRequestInputs;
}

/** One entry pull-request request, as a continuation reads it back. */
export interface ReplPullRequestRequestRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  /** The entry whose retained work this is. */
  readonly owner: string;
  /** The invocation inside that entry, as canonical core minted it. */
  readonly site: string;
  readonly requested: ReplPullRequestAsked;
  readonly received: ReplPullRequestAsked;
  readonly resolved: ReplPullRequestResolution;
}

/** What names one request: the owner, the site and the question it asked. */
export interface ReplPullRequestRequestName {
  readonly owner: string;
  readonly site: string;
  readonly requested: ReplPullRequestAsked;
}

const RECORD_MEMBERS = ["version", "owner", "site", "requested", "received", "resolved"] as const;

const ASKED_MEMBERS = ["place", "pullRequest"] as const;

const PLACE_MEMBERS = [
  "repository",
  "selectionCheckout",
  "commonDirectory",
  "workingDirectory",
] as const;

const CONTENT_MEMBERS = ["number", "title", "body", "draft", "base"] as const;

const RESOLUTION_MEMBERS = ["checkoutRoot", "commonDirectory", "origin", "inputs"] as const;

/**
 * The stable name one pull-request request is published under.
 *
 * A digest of the version, the owner, the site and every member of the
 * question — the place that was authenticated and the content the document
 * wrote. Two equal questions at two positions produce one name, which is
 * allowed: telling them apart is the durable engine's own positional matching,
 * and nothing here searches history by name.
 *
 * The freshly resolved head takes no part in it, and neither does anything else
 * routing answered. A name derived from the answer would have to be recomputed
 * to find the record, which means resolving a saved request again against a
 * checkout that has since moved.
 */
export function replPullRequestRequestName(
  request: ReplPullRequestRequestName,
): Operation<string> {
  return digest([
    PULL_REQUEST_REQUEST_PREFIX,
    REPL_REPOSITORY_VERSION,
    request.owner,
    request.site,
    askedJson(request.requested),
  ]);
}

export function replPullRequestRequestJson(record: {
  readonly owner: string;
  readonly site: string;
  readonly requested: ReplPullRequestAsked;
  readonly received: ReplPullRequestAsked;
  readonly resolved: ReplPullRequestResolution;
}): Json {
  return {
    version: REPL_REPOSITORY_VERSION,
    owner: record.owner,
    site: record.site,
    requested: askedJson(record.requested),
    received: askedJson(record.received),
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
 * whose origin is not a locator this host would hand to Git, whose resolved
 * inputs belong to a Repository other than the one the live dispatch received,
 * and whose received content disagrees with the inputs that were resolved from
 * it. Each of those would make a saved request name work this entry cannot
 * account for.
 *
 * Whether the saved roots are places this entry holds is not asked here. That
 * is a question about parsed placements and about this entry's own registry,
 * and it is answered by the admission and the readback beside this codec — as
 * is whether the admitted origin is the one the Repository was fingerprinted
 * from, which needs a digest the runtime-named half of this package owns.
 */
export function parseReplPullRequestRequestRecord(
  value: unknown,
): ReplPullRequestRequestRecord | undefined {
  // Totally: enumeration and every property read are the value's own to
  // refuse, and a refusal of any of them is the same answer. A revoked proxy
  // and a throwing getter both mean this value describes no saved request.
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
  const requested = parseAsked(read["requested"]);
  const received = parseAsked(read["received"]);
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

function parseAsked(value: unknown): ReplPullRequestAsked | undefined {
  const read = members(value, ASKED_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const place = parsePlace(read["place"]);
  const pullRequest = parseContent(read["pullRequest"]);
  if (place === undefined || pullRequest === undefined) {
    return undefined;
  }
  return Object.freeze({ place, pullRequest });
}

function parsePlace(value: unknown): ReplPullRequestPlace | undefined {
  const read = members(value, PLACE_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const repository = parseRepositoryIdentity(read["repository"]);
  const selectionCheckout = text(read["selectionCheckout"]);
  const commonDirectory = text(read["commonDirectory"]);
  const workingDirectory = text(read["workingDirectory"]);
  if (
    repository === undefined ||
    selectionCheckout === undefined ||
    commonDirectory === undefined ||
    workingDirectory === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ repository, selectionCheckout, commonDirectory, workingDirectory });
}

/**
 * The content one reading asked for, or `undefined`.
 *
 * `body` crosses as itself, empty included, which is why it is read as a string
 * rather than as nonempty text. `number` is a positive integer or `null` and
 * nothing else: zero, a fraction and a negative all name no pull request.
 */
function parseContent(value: unknown): ReplPullRequestContent | undefined {
  const read = members(value, CONTENT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const number = requestedNumber(read["number"]);
  const title = text(read["title"]);
  const body = read["body"];
  const draft = read["draft"];
  const base = text(read["base"]);
  if (number === undefined || title === undefined || base === undefined) {
    return undefined;
  }
  if (typeof body !== "string" || typeof draft !== "boolean") {
    return undefined;
  }
  return Object.freeze({ number, title, body, draft, base });
}

/** A positive integer, or the `null` that asks for a pull request to exist. */
function requestedNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

/**
 * What routing resolved, held to the reading it resolved from.
 *
 * The origin is admitted through the same closed grammar a document's locator
 * passes, so a saved origin this host would not hand to Git is refused here.
 * The inputs are held to the received reading twice over: to its Repository,
 * because inputs naming another repository describe another entry's work, and
 * to its content, because a saved request whose title, body, draft, number or
 * destination disagrees with what was resolved from it would reconcile
 * something the document never asked for.
 */
function parseResolution(
  value: unknown,
  received: ReplPullRequestAsked,
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
  if (!sameRequestedContent(received.pullRequest, inputs)) {
    return undefined;
  }
  return Object.freeze({ checkoutRoot, commonDirectory, origin, inputs });
}

function sameRequestedContent(
  content: ReplPullRequestContent,
  inputs: PullRequestInputs,
): boolean {
  return (
    content.number === inputs.number &&
    content.title === inputs.title &&
    content.body === inputs.body &&
    content.draft === inputs.draft &&
    content.base === inputs.baseBranch
  );
}

function placeJson(place: ReplPullRequestPlace): Json {
  return {
    repository: repositoryIdentityJson(place.repository),
    selectionCheckout: place.selectionCheckout,
    commonDirectory: place.commonDirectory,
    workingDirectory: place.workingDirectory,
  };
}

function contentJson(content: ReplPullRequestContent): Json {
  return {
    number: content.number,
    title: content.title,
    body: content.body,
    draft: content.draft,
    base: content.base,
  };
}

function askedJson(asked: ReplPullRequestAsked): Json {
  return {
    place: placeJson(asked.place),
    pullRequest: contentJson(asked.pullRequest),
  };
}

export function sameReplPullRequestAsked(
  left: ReplPullRequestAsked,
  right: ReplPullRequestAsked,
): boolean {
  return canonicalJson(askedJson(left)) === canonicalJson(askedJson(right));
}
