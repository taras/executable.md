/**
 * What one `<Issue>` retains: the request it made, and the URL it got back.
 *
 * The durable envelope is deliberately thin. Reconciliation — observing,
 * adopting, creating, updating, recovering — belongs to the provider that knows
 * what its service can prove, so none of it appears here. What the journal
 * holds is what a document asked for, where it asked for it, and the one value
 * a document may read back.
 *
 * ## Identity is the position, not the text
 *
 * The idempotency key is derived from the canonical target and this run's own
 * effect identity — the run and the expansion. Title is not identity: two runs
 * of one workflow are two issues to file, and a document that edits its own
 * title between attempts is still asking about the issue its position already
 * created.
 *
 * The complete request fingerprint is what the durable operation is *named*
 * by, and it covers every member: the canonical target, the discriminator, the
 * title, the description, the normalized tags and the assignee. A changed
 * request therefore diverges at the durable position rather than consuming the
 * result retained for a different question.
 *
 * ## Tags are a set
 *
 * Deduplicated and sorted by code point, because tag order is not issue
 * identity and a document that reordered its list would otherwise ask a
 * different question. Sorting by code point rather than by the default
 * comparison is deliberate: the default compares UTF-16 code units, which
 * orders supplementary characters before ones in the private-use area, and a
 * durable identity should not depend on which encoding a comparison walked.
 *
 * ## Absence has one spelling
 *
 * An absent assignee is `null` from the moment the component reads its props,
 * in the request, and in the retained record. `undefined` is not a JSON value,
 * and a member that is sometimes missing is a second shape rather than a value.
 */

import { until, type Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "../storage/record.ts";
import type { IssueDetails, IssueInput, IssueOperation, IssueReference } from "./api.ts";

/** Where one Issue effect sits: the run it belongs to, and its expansion. */
export interface IssueEffectIdentity {
  readonly runId: string;
  readonly expansionId: string;
}

/**
 * What one read asks for.
 *
 * The URL is the identity, so there is no tracker here and no key: reading the
 * same issue twice at two positions is two observations of one object, and each
 * retains what it saw.
 */
export interface IssueReadRequest {
  readonly operation: "read";
  readonly identity: IssueEffectIdentity;
  /** The canonical issue URL. */
  readonly url: string;
  /** The explicit discriminator, or `null` when the document named none. */
  readonly provider: string | null;
}

/** What one upsert asks for. */
export interface IssueUpsertRequest {
  readonly operation: "upsert";
  readonly identity: IssueEffectIdentity;
  /** The canonical container URL. */
  readonly target: string;
  /** The explicit discriminator, or `null` when the tracker named none. */
  readonly provider: string | null;
  readonly issue: IssueInput;
}

/**
 * The complete durable request one `<Issue>` makes.
 *
 * Discriminated, because the two are different questions and a name that could
 * be either would let a read consume an upsert's retained result.
 */
export type IssueRequest = IssueReadRequest | IssueUpsertRequest;

/** What one settled read retains, and what a document binds. */
export type IssueReadRecord = IssueDetails;

/** What one settled upsert retains, and what a document binds. */
export type IssueRecord = IssueReference;

const READ_MEMBERS = ["operation", "identity", "url", "provider"] as const;
const UPSERT_MEMBERS = ["operation", "identity", "target", "provider", "issue"] as const;
const DETAILS_MEMBERS = ["url", "title", "description", "tags", "assignee"] as const;
const IDENTITY_MEMBERS = ["runId", "expansionId"] as const;
const ISSUE_MEMBERS = ["title", "description", "tags", "assignee"] as const;
const RESULT_MEMBERS = ["url"] as const;

function members(value: unknown, expected: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    if (Object.keys(value).length !== expected.length) {
      return undefined;
    }
    if (!expected.every((member) => Object.hasOwn(value, member))) {
      return undefined;
    }
    const read: Record<string, unknown> = Object.create(null);
    for (const member of expected) {
      read[member] = Reflect.get(value, member);
    }
    return read;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A string that is allowed to be empty.
 *
 * For a value a service holds rather than one this boundary was given. An issue
 * with no body is an ordinary issue, and refusing to report one would make a
 * read fail on a state the tracker considers perfectly normal.
 */
function anyText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One string's code points, so ordering does not depend on the encoding. */
function codePoints(value: string): number[] {
  const points: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0);
    points.push(point === undefined ? 0 : point);
  }
  return points;
}

/** Two strings ordered by code point. */
export function byCodePoint(left: string, right: string): number {
  const first = codePoints(left);
  const second = codePoints(right);
  const shared = Math.min(first.length, second.length);
  for (let index = 0; index < shared; index += 1) {
    const one = first[index] ?? 0;
    const two = second[index] ?? 0;
    if (one !== two) {
      return one < two ? -1 : 1;
    }
  }
  if (first.length === second.length) {
    return 0;
  }
  return first.length < second.length ? -1 : 1;
}

/**
 * The tags this value describes as a set, or `undefined` when it is not one.
 *
 * Every member is a non-empty string, duplicates are removed and the result is
 * ordered by code point. A value that is not an array of strings names no tag
 * set, and reading one as empty would file an issue the document did not ask
 * for.
 */
export function normalizedTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const unique = new Set<string>();
  for (const entry of value) {
    const tag = text(entry);
    if (tag === undefined) {
      return undefined;
    }
    unique.add(tag);
  }
  return Object.freeze([...unique].sort(byCodePoint));
}

export function issueInputJson(issue: IssueInput): Json {
  return {
    title: issue.title,
    description: issue.description,
    tags: [...issue.tags],
    assignee: issue.assignee,
  };
}

export function issueRequestJson(request: IssueRequest): Json {
  const identity = {
    runId: request.identity.runId,
    expansionId: request.identity.expansionId,
  };
  return request.operation === "read"
    ? { operation: request.operation, identity, url: request.url, provider: request.provider }
    : {
        operation: request.operation,
        identity,
        target: request.target,
        provider: request.provider,
        issue: issueInputJson(request.issue),
      };
}

export function issueDetailsJson(details: IssueDetails): Json {
  return {
    url: details.url,
    title: details.title,
    description: details.description,
    tags: [...details.tags],
    assignee: details.assignee,
  };
}

/** The issue details this value describes, or `undefined`. */
export function parseIssueDetails(value: unknown): IssueDetails | undefined {
  const read = members(value, DETAILS_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const url = text(read["url"]);
  const title = text(read["title"]);
  // Empty is a description an issue can genuinely have. A URL and a title are
  // still required: an issue without either is not one this side can report.
  const description = anyText(read["description"]);
  const assignee = read["assignee"] === null ? null : text(read["assignee"]);
  const tags = Array.isArray(read["tags"]) ? normalizedTags(read["tags"]) : undefined;
  if (
    url === undefined ||
    title === undefined ||
    description === undefined ||
    assignee === undefined ||
    tags === undefined
  ) {
    return undefined;
  }
  const written = read["tags"];
  if (!Array.isArray(written) || written.length !== tags.length) {
    return undefined;
  }
  for (const [index, tag] of tags.entries()) {
    if (written[index] !== tag) {
      return undefined;
    }
  }
  return Object.freeze({ url, title, description, tags, assignee });
}

/** The issue this value describes, or `undefined`. */
export function parseIssueInput(value: unknown): IssueInput | undefined {
  const read = members(value, ISSUE_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const title = text(read["title"]);
  const description = text(read["description"]);
  const assignee = read["assignee"] === null ? null : text(read["assignee"]);
  const tags = Array.isArray(read["tags"]) ? normalizedTags(read["tags"]) : undefined;
  if (
    title === undefined ||
    description === undefined ||
    assignee === undefined ||
    tags === undefined
  ) {
    return undefined;
  }
  // Read back as a set. A retained value whose tags are out of order or
  // repeated is not one this boundary wrote, and reading it as though it were
  // would let two spellings of one request answer for each other.
  const written = read["tags"];
  if (!Array.isArray(written) || written.length !== tags.length) {
    return undefined;
  }
  for (const [index, tag] of tags.entries()) {
    if (written[index] !== tag) {
      return undefined;
    }
  }
  return Object.freeze({ title, description, tags, assignee });
}

export function parseIssueEffectIdentity(value: unknown): IssueEffectIdentity | undefined {
  const read = members(value, IDENTITY_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const runId = text(read["runId"]);
  const expansionId = text(read["expansionId"]);
  if (runId === undefined || expansionId === undefined) {
    return undefined;
  }
  return Object.freeze({ runId, expansionId });
}

/** The durable request this value describes, or `undefined`. */
export function parseIssueRequest(value: unknown): IssueRequest | undefined {
  const operation = readOperation(value);
  if (operation === "read") {
    const read = members(value, READ_MEMBERS);
    if (read === undefined) {
      return undefined;
    }
    const identity = parseIssueEffectIdentity(read["identity"]);
    const url = text(read["url"]);
    const provider = read["provider"] === null ? null : text(read["provider"]);
    if (identity === undefined || url === undefined || provider === undefined) {
      return undefined;
    }
    return Object.freeze({ operation, identity, url, provider });
  }
  if (operation !== "upsert") {
    return undefined;
  }
  const read = members(value, UPSERT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const identity = parseIssueEffectIdentity(read["identity"]);
  const target = text(read["target"]);
  const provider = read["provider"] === null ? null : text(read["provider"]);
  const issue = parseIssueInput(read["issue"]);
  if (
    identity === undefined ||
    target === undefined ||
    provider === undefined ||
    issue === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ operation, identity, target, provider, issue });
}

/**
 * The word this value uses for its operation, read on its own.
 *
 * It selects which members the value must carry exactly, so it has to be read
 * before that membership is decided — and reading it is as much the value's to
 * refuse as anything else about it.
 */
function readOperation(value: unknown): unknown {
  try {
    return typeof value === "object" && value !== null
      ? Reflect.get(value, "operation")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The result this value describes, or `undefined`.
 *
 * Exactly one member. A provider that answered with more than a URL answered
 * with something this boundary will not retain, because everything else it
 * could add is the thing the boundary exists to keep on its own side.
 */
export function parseIssueRecord(value: unknown): IssueRecord | undefined {
  const read = members(value, RESULT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const url = text(read["url"]);
  return url === undefined ? undefined : Object.freeze({ url });
}

export function issueRecordJson(record: IssueRecord): Json {
  return { url: record.url };
}

/**
 * What makes a second attempt the same attempt.
 *
 * The operation, the canonical target and this run's own effect identity, and
 * nothing a document wrote. A provider carries it wherever its service can hold a mark,
 * so an attempt interrupted after the service accepted it is recognized by the
 * next one rather than repeated.
 */
export function issueIdempotencyKey(
  identity: IssueEffectIdentity,
  operation: IssueOperation,
  target: string,
): string {
  return canonicalJson({
    operation,
    canonicalTargetUrl: target,
    runId: identity.runId,
    expansionId: identity.expansionId,
  });
}

/**
 * The stable name one complete request is journaled under.
 *
 * A digest of the canonical encoding, so the durable operation's own identity
 * moves when the target, the discriminator or any authored field moves.
 * Without it a changed request would arrive at a matching type and name and
 * consume the result retained at the same journal position.
 */
export function* issueRequestFingerprint(request: IssueRequest): Operation<string> {
  const encoded = new TextEncoder().encode(canonicalJson(issueRequestJson(request)));
  const digest = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether two requests ask for the same thing in the same place. */
export function sameIssueRequest(left: IssueRequest, right: IssueRequest): boolean {
  return canonicalJson(issueRequestJson(left)) === canonicalJson(issueRequestJson(right));
}
