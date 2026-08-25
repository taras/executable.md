/**
 * Reading a pull request's existing evidence from GitHub, completely or not at
 * all.
 *
 * Everything provider-specific about the three read components is here: which
 * endpoints answer them, how a page walk ends, and how one payload becomes one
 * normalized record. None of it is reachable from a document — a live
 * invocation opens one access session, holds it in the provider closure, and
 * disposes it with the invocation.
 *
 * ## Complete, or unavailable
 *
 * Every refusal is the same refusal: *unavailable*. A transport failure, a
 * non-200, a body that is not the array it should be, an item this adapter
 * cannot read, a next relation off the endpoint's own origin, and a walk still
 * going at the page limit all leave the collection unknown. Answering with what
 * had been collected would report "no further objections" on the strength of a
 * page nobody read, and an empty array already means something else: the
 * provider completed the collection and it holds nothing.
 *
 * ## The subject is checked, never accepted
 *
 * `checks` reads the pull request first to learn its head, and every check and
 * status is then read at that exact SHA and carries it. A payload naming
 * another repository, another number or another head is a protocol failure
 * rather than data — a well-formed answer about the wrong subject is still
 * well-formed, so shape validation cannot catch it and the request's own
 * identity is what the answer is held to.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import {
  authorizedHeaders,
  member,
  nextPage,
  nonEmpty,
  PAGE_LIMIT,
  PAGE_SIZE,
  readJson,
} from "./github.ts";
import type { GitHubAccess, GitHubRepositoryName } from "./github.ts";
import {
  CHECK_RUN_CONCLUSIONS,
  CHECK_RUN_STATUSES,
  COMMIT_STATUS_STATES,
  REVIEW_STATES,
} from "../../composition/pull-request-read-records.ts";
import type {
  CheckEvidence,
  CommentEvidence,
  PullRequestEvidence,
  PullRequestReadKind,
  PullRequestReadResult,
  ReviewEvidence,
} from "../../composition/pull-request-read-records.ts";

/** What one read produced, or that it could not be completed. */
export type EvidenceReading =
  | { readonly state: "read"; readonly result: PullRequestReadResult }
  | { readonly state: "unavailable" }
  | { readonly state: "protocol-invalid" };

/**
 * Something was read, and it was not what it claimed to be.
 *
 * Told apart from unavailable because they mean opposite things about the host:
 * unavailable is a host that did not answer, and this is a host that answered
 * about the wrong subject or with an item outside the contract. One is worth
 * asking again; the other is a provider a run should stop believing.
 */
/**
 * Why a collection could not be answered, carried as the failure itself.
 *
 * The two states are the whole payload: this never reaches a document, and the
 * component turns it into the refusal a reader sees.
 */
export class EvidenceUnreadable extends Error {
  override name = "EvidenceUnreadable";

  readonly state: "unavailable" | "protocol-invalid";

  constructor(state: "unavailable" | "protocol-invalid") {
    super(state);
    this.state = state;
  }
}

function unavailable<T>(): Result<T> {
  return Err(new EvidenceUnreadable("unavailable"));
}

function invalid<T>(): Result<T> {
  return Err(new EvidenceUnreadable("protocol-invalid"));
}

/** The refusal a failed collection carries, read back rather than asserted. */
function refusal(error: Error): EvidenceReading {
  return { state: error instanceof EvidenceUnreadable ? error.state : "unavailable" };
}

type Collected<T> = Result<T[]>;

/** The identifier a provider returned, as the decimal string a record holds. */
function identifier(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  return typeof value === "string" && /^[0-9]+$/.test(value) ? value : undefined;
}

function login(value: unknown): string | null {
  const name = nonEmpty(member(value, "login"));
  return name === undefined ? null : name;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function lowered(value: unknown): string | undefined {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function reviewSide(value: unknown): "left" | "right" | null {
  const word = lowered(value);
  return word === "left" || word === "right" ? word : null;
}

/**
 * One page walk over an endpoint that answers with an array.
 *
 * The shape the pull-request candidate walk already uses: collect, follow the
 * `Link` relation while it stays on the endpoint's own origin, and answer
 * `undefined` rather than a short list when it cannot be finished.
 */
function* collect<T>(
  access: GitHubAccess,
  first: string,
  read: (payload: unknown) => T | undefined,
  /**
   * The member holding the page's items, for an endpoint that wraps them.
   *
   * `check-runs` answers `{ total_count, check_runs: [...] }` while every other
   * collection here answers the array itself. The walk is the same either way;
   * where the items are is not.
   */
  envelope?: string,
): Operation<Collected<T>> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return unavailable();
  }
  const gathered: T[] = [];
  let url = first;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    let response;
    try {
      response = yield* access.send({ method: "GET", url, headers: sent });
    } catch {
      return unavailable();
    }
    if (response.status !== 200) {
      return unavailable();
    }
    const payload = readJson(response.body);
    const listed = envelope === undefined ? payload : member(payload, envelope);
    if (!Array.isArray(listed)) {
      return invalid();
    }
    for (const candidate of listed) {
      const item = read(candidate);
      if (item === undefined) {
        return invalid();
      }
      gathered.push(item);
    }
    const walk = nextPage(response.link, access.endpoint);
    if (walk.kind === "complete") {
      return Ok(gathered);
    }
    if (walk.kind === "unfollowable") {
      return unavailable();
    }
    url = walk.url;
  }
  return unavailable();
}

function collectionUrl(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  path: string,
  query = "",
): string {
  const prefix = `${access.endpoint}/repos/${name.owner}/${name.repository}`;
  return `${prefix}${path}?per_page=${PAGE_SIZE}${query}`;
}

function readReview(subject: Subject, payload: unknown): ReviewEvidence | undefined {
  // The review says which pull request it belongs to, and it has to be this
  // one: the endpoint, the owner, the repository, the collection and the
  // number, compared whole.
  if (!belongsTo(member(payload, "pull_request_url"), subject.pulls)) {
    return undefined;
  }
  const id = identifier(member(payload, "id"));
  const url = nonEmpty(member(payload, "html_url"));
  const body = member(payload, "body");
  const state = REVIEW_STATES.find(
    (candidate) => candidate === lowered(member(payload, "state"))?.replace("_", "-"),
  );
  if (id === undefined || url === undefined || typeof body !== "string") {
    return undefined;
  }
  if (state === undefined) {
    return undefined;
  }
  return {
    id,
    author: login(member(payload, "user")),
    state,
    body,
    submittedAt: optionalText(member(payload, "submitted_at")),
    commitSha: optionalText(member(payload, "commit_id")),
    url,
  };
}

function readConversationComment(subject: Subject, payload: unknown): CommentEvidence | undefined {
  if (!belongsTo(member(payload, "issue_url"), subject.issues)) {
    return undefined;
  }
  const id = identifier(member(payload, "id"));
  const url = nonEmpty(member(payload, "html_url"));
  const body = member(payload, "body");
  const createdAt = nonEmpty(member(payload, "created_at"));
  const updatedAt = nonEmpty(member(payload, "updated_at"));
  if (id === undefined || url === undefined || typeof body !== "string") {
    return undefined;
  }
  if (createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    kind: "conversation",
    id,
    author: login(member(payload, "user")),
    body,
    createdAt,
    updatedAt,
    url,
  };
}

function readReviewComment(subject: Subject, payload: unknown): CommentEvidence | undefined {
  if (!belongsTo(member(payload, "pull_request_url"), subject.pulls)) {
    return undefined;
  }
  const id = identifier(member(payload, "id"));
  const url = nonEmpty(member(payload, "html_url"));
  const body = member(payload, "body");
  const createdAt = nonEmpty(member(payload, "created_at"));
  const updatedAt = nonEmpty(member(payload, "updated_at"));
  const path = nonEmpty(member(payload, "path"));
  const commitSha = nonEmpty(member(payload, "commit_id"));
  const originalCommitSha = nonEmpty(member(payload, "original_commit_id"));
  const declaredReview = member(payload, "pull_request_review_id");
  const reviewId =
    declaredReview === null || declaredReview === undefined ? null : identifier(declaredReview);
  const diffHunk = member(payload, "diff_hunk");
  if (id === undefined || url === undefined || typeof body !== "string") {
    return undefined;
  }
  if (createdAt === undefined || updatedAt === undefined || path === undefined) {
    return undefined;
  }
  if (commitSha === undefined || originalCommitSha === undefined || reviewId === undefined) {
    return undefined;
  }
  if (typeof diffHunk !== "string") {
    return undefined;
  }
  const replyTo = member(payload, "in_reply_to_id");
  return {
    kind: "review",
    id,
    reviewId,
    author: login(member(payload, "user")),
    body,
    createdAt,
    updatedAt,
    url,
    path,
    diffHunk,
    commitSha,
    originalCommitSha,
    line: optionalCount(member(payload, "line")),
    side: reviewSide(member(payload, "side")),
    startLine: optionalCount(member(payload, "start_line")),
    startSide: reviewSide(member(payload, "start_side")),
    inReplyToId: replyTo === undefined || replyTo === null ? null : (identifier(replyTo) ?? null),
  };
}

function readCheckRun(headSha: string, payload: unknown): CheckEvidence | undefined {
  const id = identifier(member(payload, "id"));
  const name = nonEmpty(member(payload, "name"));
  const declaredStatus = lowered(member(payload, "status"));
  const status = CHECK_RUN_STATUSES.find((known) => known === declaredStatus);
  if (id === undefined || name === undefined || status === undefined) {
    return undefined;
  }
  const declaredConclusion = lowered(member(payload, "conclusion"));
  const conclusion =
    declaredConclusion === undefined
      ? null
      : CHECK_RUN_CONCLUSIONS.find((known) => known === declaredConclusion);
  if (conclusion === undefined) {
    return undefined;
  }
  // The run's own head, required and checked: a check that does not say which
  // commit it describes cannot be evidence about this one, and one that names
  // another commit is evidence about something else.
  if (nonEmpty(member(payload, "head_sha")) !== headSha) {
    return undefined;
  }
  const output = member(payload, "output");
  return {
    kind: "check-run",
    id,
    headSha,
    name,
    status,
    conclusion,
    url: optionalText(member(payload, "html_url")),
    startedAt: optionalText(member(payload, "started_at")),
    completedAt: optionalText(member(payload, "completed_at")),
    title: optionalText(member(output, "title")),
    summary: optionalText(member(output, "summary")),
    text: optionalText(member(output, "text")),
  };
}

function readCommitStatus(headSha: string, payload: unknown): CheckEvidence | undefined {
  const id = identifier(member(payload, "id"));
  const name = nonEmpty(member(payload, "context"));
  const state = COMMIT_STATUS_STATES.find((known) => known === lowered(member(payload, "state")));
  const createdAt = nonEmpty(member(payload, "created_at"));
  const updatedAt = nonEmpty(member(payload, "updated_at"));
  if (id === undefined || name === undefined || state === undefined) {
    return undefined;
  }
  if (createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    kind: "commit-status",
    id,
    headSha,
    name,
    state,
    description: optionalText(member(payload, "description")),
    url: optionalText(member(payload, "target_url")),
    createdAt,
    updatedAt,
  };
}

/**
 * The complete API subject one read is about.
 *
 * Built from the request rather than from anything an answer says, and compared
 * whole. Matching the trailing number alone would accept a review from
 * `someone/else` for `octo/project` — the numbers collide constantly, and a
 * well-formed payload about the wrong repository is still well formed.
 */
interface Subject {
  readonly pulls: string;
  readonly issues: string;
}

function subjectFor(access: GitHubAccess, name: GitHubRepositoryName, number: number): Subject {
  const repository = `${access.endpoint}/repos/${name.owner}/${name.repository}`;
  return {
    pulls: `${repository}/pulls/${number}`,
    issues: `${repository}/issues/${number}`,
  };
}

/** Whether a subject URL is the exact one this read is about. */
function belongsTo(value: unknown, expected: string): boolean {
  return nonEmpty(value) === expected;
}

/** The head this numbered pull request is at, checked against the request. */
type Observed = Result<string>;

function* observeHead(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  number: number,
): Operation<Observed> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return unavailable();
  }
  const url = `${access.endpoint}/repos/${name.owner}/${name.repository}/pulls/${number}`;
  let response;
  try {
    response = yield* access.send({ method: "GET", url, headers: sent });
  } catch {
    return unavailable();
  }
  if (response.status !== 200) {
    return unavailable();
  }
  const payload = readJson(response.body);
  // Every field this answer is authenticated by is required. An answer that
  // omits the number, the repository or the head is not one this read can hold
  // to its request, and accepting it would be trusting the URL alone.
  if (member(payload, "number") !== number) {
    return invalid();
  }
  const full = nonEmpty(member(member(member(payload, "base"), "repo"), "full_name"));
  const asked = `${name.owner}/${name.repository}`.toLowerCase();
  if (full === undefined || full.toLowerCase() !== asked) {
    return invalid();
  }
  const headSha = nonEmpty(member(member(payload, "head"), "sha"));
  return headSha === undefined ? invalid() : Ok(headSha);
}

/** The combined status for one ref, which is a single object rather than a page. */
function* readCombinedStatus(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  headSha: string,
): Operation<Collected<CheckEvidence>> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return unavailable();
  }
  const url =
    `${access.endpoint}/repos/${name.owner}/${name.repository}/commits/${headSha}/status` +
    `?per_page=${PAGE_SIZE}`;
  let response;
  try {
    response = yield* access.send({ method: "GET", url, headers: sent });
  } catch {
    return unavailable();
  }
  if (response.status !== 200) {
    return unavailable();
  }
  const payload = readJson(response.body);
  // The combined status has to say which commit it is about, and say this one.
  if (nonEmpty(member(payload, "sha")) !== headSha) {
    return invalid();
  }
  const listed = member(payload, "statuses");
  if (!Array.isArray(listed)) {
    return invalid();
  }
  const gathered: CheckEvidence[] = [];
  for (const candidate of listed) {
    const item = readCommitStatus(headSha, candidate);
    if (item === undefined) {
      return invalid();
    }
    gathered.push(item);
  }
  return Ok(gathered);
}

/** Read one collection, completely, or say it could not be read. */
export function* readPullRequestEvidence(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  number: number,
  kind: PullRequestReadKind,
): Operation<EvidenceReading> {
  const subject = subjectFor(access, name, number);
  if (kind === "reviews") {
    const reviews = yield* collect(
      access,
      collectionUrl(access, name, `/pulls/${number}/reviews`),
      (payload) => readReview(subject, payload),
    );
    return reviews.ok
      ? { state: "read", result: { kind: "reviews", items: reviews.value } }
      : refusal(reviews.error);
  }

  if (kind === "comments") {
    // Conversation first, then inline: two collections with no common clock, so
    // the order is stated rather than interleaved by timestamp.
    const conversation = yield* collect(
      access,
      collectionUrl(access, name, `/issues/${number}/comments`),
      (payload) => readConversationComment(subject, payload),
    );
    if (!conversation.ok) {
      return refusal(conversation.error);
    }
    const inline = yield* collect(
      access,
      collectionUrl(access, name, `/pulls/${number}/comments`),
      (payload) => readReviewComment(subject, payload),
    );
    if (!inline.ok) {
      return refusal(inline.error);
    }
    return {
      state: "read",
      result: { kind: "comments", items: [...conversation.value, ...inline.value] },
    };
  }

  const observed = yield* observeHead(access, name, number);
  if (!observed.ok) {
    return refusal(observed.error);
  }
  const headSha = observed.value;
  // `filter=latest` is the default and is written anyway: what a reviewer wants
  // is what the pull request's own page associates with this head — the latest
  // run per name — rather than every historical attempt at it.
  const runs = yield* collect(
    access,
    collectionUrl(access, name, `/commits/${headSha}/check-runs`, "&filter=latest"),
    (payload) => readCheckRun(headSha, payload),
    "check_runs",
  );
  if (!runs.ok) {
    return refusal(runs.error);
  }
  const statuses = yield* readCombinedStatus(access, name, headSha);
  if (!statuses.ok) {
    return refusal(statuses.error);
  }
  return {
    state: "read",
    result: { kind: "checks", headSha, items: [...runs.value, ...statuses.value] },
  };
}
