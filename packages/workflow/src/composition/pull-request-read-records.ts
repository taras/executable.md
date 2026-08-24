/**
 * What a pull-request evidence read binds, and how it is read back
 * (specs/workflow-workspace-spec.md §7.7).
 *
 * A network-denied reviewer judges what its prompt renders, so these records
 * are what "every existing review, comment and check result" means in a value.
 * Each is closed and provider-neutral: no raw provider response, live handle,
 * credential, endpoint or pagination transport state crosses this boundary, and
 * every body and provider message is retained byte-for-byte because a reviewer
 * reading a summary of an objection has not read the objection.
 *
 * `id` is a decimal string. Provider identifiers already exceed what a JSON
 * number holds exactly, and a value that silently loses its last digits is
 * worse than one that never claimed to be arithmetic.
 *
 * Timestamps are the provider's own RFC 3339 strings, unparsed. What a reader
 * needs is what the host said, and reformatting is a second contract to get
 * wrong.
 */

import { isJsonObject } from "@executablemd/core";
import type { Json, JsonObject } from "@executablemd/core";
import type { RepositoryRecord } from "./records.ts";
import {
  filteredRepositoryIdentity,
  gitPushRepositoryIdentityJson,
  parseGitPushRepositoryIdentity,
} from "./git-push-records.ts";
import type { GitPushRepositoryIdentity } from "./git-push-records.ts";

/** Which collection one read covers. */
export type PullRequestReadKind = "reviews" | "comments" | "checks";

export const PULL_REQUEST_READ_KINDS: readonly PullRequestReadKind[] = [
  "reviews",
  "comments",
  "checks",
];

/** One submitted review, with its body unchanged. */
export interface ReviewEvidence {
  readonly id: string;
  readonly author: string | null;
  readonly state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending";
  readonly body: string;
  /**
   * Null for a review that was never submitted.
   *
   * A `pending` review has no submission time and GitHub documents its commit
   * as nullable. Refusing one would lose every other review with it.
   */
  readonly submittedAt: string | null;
  readonly commitSha: string | null;
  readonly url: string;
}

/** One comment on the pull request's conversation. */
export interface ConversationCommentEvidence {
  readonly kind: "conversation";
  readonly id: string;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}

/** One comment on a line of the diff. */
export interface ReviewCommentEvidence {
  readonly kind: "review";
  readonly id: string;
  /** Null for a comment that belongs to no review. */
  readonly reviewId: string | null;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly path: string;
  readonly diffHunk: string;
  readonly commitSha: string;
  readonly originalCommitSha: string;
  readonly line: number | null;
  readonly side: "left" | "right" | null;
  readonly startLine: number | null;
  readonly startSide: "left" | "right" | null;
  readonly inReplyToId: string | null;
}

export type CommentEvidence = ConversationCommentEvidence | ReviewCommentEvidence;

/** One check run associated with the observed head. */
export type CheckRunStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "waiting"
  | "requested"
  | "pending";

export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export type CommitStatusState = "error" | "failure" | "pending" | "success";

export interface CheckRunEvidence {
  readonly kind: "check-run";
  readonly id: string;
  readonly headSha: string;
  readonly name: string;
  readonly status: CheckRunStatus;
  readonly conclusion: CheckRunConclusion | null;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly text: string | null;
}

/** One commit status associated with the observed head. */
export interface CommitStatusEvidence {
  readonly kind: "commit-status";
  readonly id: string;
  readonly headSha: string;
  readonly name: string;
  readonly state: CommitStatusState;
  readonly description: string | null;
  readonly url: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CheckEvidence = CheckRunEvidence | CommitStatusEvidence;

export type PullRequestEvidence = ReviewEvidence | CommentEvidence | CheckEvidence;

/**
 * The vocabularies the two check kinds speak, kept apart.
 *
 * A commit status has one `state` where a check run has a status/conclusion
 * pair, and `error` is a state no check run has. Mapping it onto `failure`
 * would tell a reviewer a check failed when the provider said it never ran, so
 * `kind` says which vocabulary an item came from and both sets stay whole.
 */
export const CHECK_RUN_STATUSES: readonly CheckRunStatus[] = [
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
];

export const CHECK_RUN_CONCLUSIONS: readonly CheckRunConclusion[] = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
];

export const COMMIT_STATUS_STATES: readonly CommitStatusState[] = [
  "error",
  "failure",
  "pending",
  "success",
];

export const REVIEW_STATES: readonly ReviewEvidence["state"][] = [
  "approved",
  "changes-requested",
  "commented",
  "dismissed",
  "pending",
];

/**
 * One read, as the component asks for it.
 *
 * Live provider-private attachment data. The whole Repository record and the
 * working directory are here because the provider needs them to select a
 * checkout and resolve a locator, and neither belongs in the journal: a
 * checkout path is this machine's, and the locator the fingerprint already
 * names is the one thing a retained record must not repeat.
 */
export interface PullRequestReadRequest {
  /** The whole Repository record the component observed, to be compared. */
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
  readonly number: number;
  readonly kind: PullRequestReadKind;
}

/**
 * The same read, filtered to what durable JSON may carry.
 *
 * The Repository identity Push retains, without its Workspace checkout path,
 * plus the two things that say which collection of which pull request this is.
 * This is what the effect's input holds and what its fingerprint is taken over,
 * so a document edited to read another number in the same place is a different
 * effect rather than one replaying the first's answer.
 */
export interface PullRequestReadInputs {
  readonly repository: GitPushRepositoryIdentity;
  readonly number: number;
  readonly kind: PullRequestReadKind;
}

/** The durable inputs one live request reduces to. */
export function readInputs(request: PullRequestReadRequest): PullRequestReadInputs {
  return Object.freeze({
    repository: filteredRepositoryIdentity(request.repository),
    number: request.number,
    kind: request.kind,
  });
}

export function pullRequestReadInputsJson(inputs: PullRequestReadInputs): JsonObject {
  return {
    repository: gitPushRepositoryIdentityJson(inputs.repository),
    number: inputs.number,
    kind: inputs.kind,
  };
}

/** The retained inputs, read back rather than asserted. */
export function parsePullRequestReadInputs(value: Json): PullRequestReadInputs | undefined {
  if (!isJsonObject(value) || !exactMembers(value, ["repository", "number", "kind"])) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(value.repository);
  const kind = PULL_REQUEST_READ_KINDS.find((known) => known === value.kind);
  const number = value.number;
  if (repository === undefined || kind === undefined) {
    return undefined;
  }
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    return undefined;
  }
  return { repository, number, kind };
}

/**
 * Exactly these members, and no others.
 *
 * A record that carries one more member than its contract declares is a
 * provider detail that reached a binding, so the check is equality rather than
 * presence — a closed record that only refused what was *missing* would let
 * anything extra through.
 */
function exactMembers(value: JsonObject, names: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === names.length && names.every((name) => present.includes(name));
}

/** What one completed read holds. */
export interface PullRequestReadResult {
  readonly kind: PullRequestReadKind;
  /**
   * The head the checks describe, retained beside the array.
   *
   * Null for the two collections that do not depend on a revision. An empty
   * checks array still says which head was read, which "no checks" alone
   * cannot.
   */
  readonly headSha: string | null;
  readonly evidence: readonly PullRequestEvidence[];
}

/** The evidence a document binds: the array, and nothing else. */
export function pullRequestReadResultJson(result: PullRequestReadResult): Json {
  return result.evidence.map((item) => evidenceJson(item));
}

function evidenceJson(item: PullRequestEvidence): JsonObject {
  const record: Record<string, Json> = {};
  for (const [name, value] of Object.entries(item)) {
    record[name] = value;
  }
  return record;
}

/** The retained result, read back rather than asserted. */
export function parsePullRequestReadResult(value: Json): PullRequestReadResult | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const kind = PULL_REQUEST_READ_KINDS.find((known) => known === value.kind);
  if (kind === undefined) {
    return undefined;
  }
  const headSha = value.headSha;
  if (headSha !== null && typeof headSha !== "string") {
    return undefined;
  }
  const evidence = value.evidence;
  if (!Array.isArray(evidence)) {
    return undefined;
  }
  if (!exactMembers(value, ["kind", "headSha", "evidence"])) {
    return undefined;
  }
  const items: PullRequestEvidence[] = [];
  for (const entry of evidence) {
    const item = parseEvidence(kind, entry);
    if (item === undefined) {
      return undefined;
    }
    items.push(item);
  }
  return { kind, headSha, evidence: items };
}

function parseEvidence(kind: PullRequestReadKind, value: Json): PullRequestEvidence | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  if (kind === "reviews") {
    return parseReview(value);
  }
  if (kind === "comments") {
    return parseComment(value);
  }
  return parseCheck(value);
}

function text(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableText(value: Json | undefined): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function nullableCount(value: Json | undefined): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : undefined;
}

function side(value: Json | undefined): "left" | "right" | null | undefined {
  if (value === null) {
    return null;
  }
  return value === "left" || value === "right" ? value : undefined;
}

const REVIEW_MEMBERS = ["id", "author", "state", "body", "submittedAt", "commitSha", "url"];

const CONVERSATION_MEMBERS = ["kind", "id", "author", "body", "createdAt", "updatedAt", "url"];

const REVIEW_COMMENT_MEMBERS = [
  "kind",
  "id",
  "reviewId",
  "author",
  "body",
  "createdAt",
  "updatedAt",
  "url",
  "path",
  "diffHunk",
  "commitSha",
  "originalCommitSha",
  "line",
  "side",
  "startLine",
  "startSide",
  "inReplyToId",
];

const CHECK_RUN_MEMBERS = [
  "kind",
  "id",
  "headSha",
  "name",
  "status",
  "conclusion",
  "url",
  "startedAt",
  "completedAt",
  "title",
  "summary",
  "text",
];

const COMMIT_STATUS_MEMBERS = [
  "kind",
  "id",
  "headSha",
  "name",
  "state",
  "description",
  "url",
  "createdAt",
  "updatedAt",
];

function parseReview(value: JsonObject): ReviewEvidence | undefined {
  if (!exactMembers(value, REVIEW_MEMBERS)) {
    return undefined;
  }
  const id = text(value.id);
  const state = value.state;
  const body = text(value.body);
  const url = text(value.url);
  const author = nullableText(value.author);
  const submittedAt = nullableText(value.submittedAt);
  const commitSha = nullableText(value.commitSha);
  if (id === undefined || body === undefined || url === undefined) {
    return undefined;
  }
  if (author === undefined || submittedAt === undefined || commitSha === undefined) {
    return undefined;
  }
  const known = REVIEW_STATES.find((candidate) => candidate === state);
  if (known === undefined) {
    return undefined;
  }
  return { id, author, state: known, body, submittedAt, commitSha, url };
}

function parseComment(value: JsonObject): CommentEvidence | undefined {
  const id = text(value.id);
  const body = text(value.body);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  const url = text(value.url);
  const author = nullableText(value.author);
  if (id === undefined || body === undefined || url === undefined) {
    return undefined;
  }
  if (createdAt === undefined || updatedAt === undefined || author === undefined) {
    return undefined;
  }
  if (value.kind === "conversation") {
    if (!exactMembers(value, CONVERSATION_MEMBERS)) {
      return undefined;
    }
    return { kind: "conversation", id, author, body, createdAt, updatedAt, url };
  }
  if (value.kind !== "review" || !exactMembers(value, REVIEW_COMMENT_MEMBERS)) {
    return undefined;
  }
  const reviewId = nullableText(value.reviewId);
  const path = text(value.path);
  const diffHunk = text(value.diffHunk);
  const commitSha = text(value.commitSha);
  const originalCommitSha = text(value.originalCommitSha);
  const line = nullableCount(value.line);
  const startLine = nullableCount(value.startLine);
  const commentSide = side(value.side);
  const startSide = side(value.startSide);
  const inReplyToId = nullableText(value.inReplyToId);
  if (reviewId === undefined || path === undefined || diffHunk === undefined) {
    return undefined;
  }
  if (commitSha === undefined || originalCommitSha === undefined) {
    return undefined;
  }
  if (line === undefined || startLine === undefined || inReplyToId === undefined) {
    return undefined;
  }
  if (commentSide === undefined || startSide === undefined) {
    return undefined;
  }
  return {
    kind: "review",
    id,
    reviewId,
    author,
    body,
    createdAt,
    updatedAt,
    url,
    path,
    diffHunk,
    commitSha,
    originalCommitSha,
    line,
    side: commentSide,
    startLine,
    startSide,
    inReplyToId,
  };
}

function parseCheck(value: JsonObject): CheckEvidence | undefined {
  const id = text(value.id);
  const headSha = text(value.headSha);
  const name = text(value.name);
  const url = nullableText(value.url);
  if (id === undefined || headSha === undefined || name === undefined || url === undefined) {
    return undefined;
  }
  if (value.kind === "check-run") {
    if (!exactMembers(value, CHECK_RUN_MEMBERS)) {
      return undefined;
    }
    const status = CHECK_RUN_STATUSES.find((known) => known === value.status);
    const declared = nullableText(value.conclusion);
    const conclusion =
      declared === null ? null : CHECK_RUN_CONCLUSIONS.find((known) => known === declared);
    const startedAt = nullableText(value.startedAt);
    const completedAt = nullableText(value.completedAt);
    const title = nullableText(value.title);
    const summary = nullableText(value.summary);
    const body = nullableText(value.text);
    if (status === undefined || declared === undefined || conclusion === undefined) {
      return undefined;
    }
    if (startedAt === undefined || completedAt === undefined) {
      return undefined;
    }
    if (title === undefined || summary === undefined || body === undefined) {
      return undefined;
    }
    return {
      kind: "check-run",
      id,
      headSha,
      name,
      status,
      conclusion,
      url,
      startedAt,
      completedAt,
      title,
      summary,
      text: body,
    };
  }
  if (value.kind !== "commit-status" || !exactMembers(value, COMMIT_STATUS_MEMBERS)) {
    return undefined;
  }
  const state = COMMIT_STATUS_STATES.find((known) => known === value.state);
  const description = nullableText(value.description);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  if (state === undefined) {
    return undefined;
  }
  if (description === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    kind: "commit-status",
    id,
    headSha,
    name,
    state,
    description,
    url,
    createdAt,
    updatedAt,
  };
}
