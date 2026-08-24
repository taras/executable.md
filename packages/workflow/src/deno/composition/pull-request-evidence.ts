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

import type { Operation } from "effection";
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
  ReviewEvidence,
} from "../../composition/pull-request-read-records.ts";

/** What one read produced, or that it could not be completed. */
export type EvidenceReading =
  | {
      readonly state: "read";
      readonly headSha: string | null;
      readonly evidence: PullRequestEvidence[];
    }
  | { readonly state: "unavailable" };

const UNAVAILABLE: EvidenceReading = Object.freeze({ state: "unavailable" });

/** The identifier a provider returned, as the decimal string a record holds. */
function identifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return typeof value === "string" && value !== "" ? value : undefined;
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
function* collect(
  access: GitHubAccess,
  first: string,
  read: (payload: unknown) => PullRequestEvidence | undefined,
  /**
   * The member holding the page's items, for an endpoint that wraps them.
   *
   * `check-runs` answers `{ total_count, check_runs: [...] }` while every other
   * collection here answers the array itself. The walk is the same either way;
   * where the items are is not.
   */
  envelope?: string,
): Operation<PullRequestEvidence[] | undefined> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return undefined;
  }
  const gathered: PullRequestEvidence[] = [];
  let url = first;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    let response;
    try {
      response = yield* access.send({ method: "GET", url, headers: sent });
    } catch {
      return undefined;
    }
    if (response.status !== 200) {
      return undefined;
    }
    const payload = readJson(response.body);
    const listed = envelope === undefined ? payload : member(payload, envelope);
    if (!Array.isArray(listed)) {
      return undefined;
    }
    for (const candidate of listed) {
      const item = read(candidate);
      if (item === undefined) {
        return undefined;
      }
      gathered.push(item);
    }
    const walk = nextPage(response.link, access.endpoint);
    if (walk.kind === "complete") {
      return gathered;
    }
    if (walk.kind === "unfollowable") {
      return undefined;
    }
    url = walk.url;
  }
  return undefined;
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

function readReview(payload: unknown): ReviewEvidence | undefined {
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

function readConversationComment(payload: unknown): CommentEvidence | undefined {
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

function readReviewComment(payload: unknown): CommentEvidence | undefined {
  const id = identifier(member(payload, "id"));
  const url = nonEmpty(member(payload, "html_url"));
  const body = member(payload, "body");
  const createdAt = nonEmpty(member(payload, "created_at"));
  const updatedAt = nonEmpty(member(payload, "updated_at"));
  const path = nonEmpty(member(payload, "path"));
  const commitSha = nonEmpty(member(payload, "commit_id"));
  const originalCommitSha = nonEmpty(member(payload, "original_commit_id"));
  const reviewId = identifier(member(payload, "pull_request_review_id"));
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
  const status = lowered(member(payload, "status"));
  if (id === undefined || name === undefined || status === undefined) {
    return undefined;
  }
  if (!CHECK_RUN_STATUSES.includes(status)) {
    return undefined;
  }
  const conclusion = lowered(member(payload, "conclusion"));
  if (conclusion !== undefined && !CHECK_RUN_CONCLUSIONS.includes(conclusion)) {
    return undefined;
  }
  // The run's own head, checked against the one this read is about: a check
  // describing another commit is not evidence about this revision.
  const declared = nonEmpty(member(payload, "head_sha"));
  if (declared !== undefined && declared !== headSha) {
    return undefined;
  }
  const output = member(payload, "output");
  return {
    kind: "check-run",
    id,
    headSha,
    name,
    status,
    conclusion: conclusion ?? null,
    url: optionalText(member(payload, "details_url")),
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
  const state = lowered(member(payload, "state"));
  const createdAt = nonEmpty(member(payload, "created_at"));
  const updatedAt = nonEmpty(member(payload, "updated_at"));
  if (id === undefined || name === undefined || state === undefined) {
    return undefined;
  }
  if (!COMMIT_STATUS_STATES.includes(state)) {
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

/** The head this numbered pull request is at, checked against the request. */
function* observeHead(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  number: number,
): Operation<string | undefined> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return undefined;
  }
  const url = `${access.endpoint}/repos/${name.owner}/${name.repository}/pulls/${number}`;
  let response;
  try {
    response = yield* access.send({ method: "GET", url, headers: sent });
  } catch {
    return undefined;
  }
  if (response.status !== 200) {
    return undefined;
  }
  const payload = readJson(response.body);
  const answered = member(payload, "number");
  if (answered !== number) {
    return undefined;
  }
  const full = nonEmpty(member(member(member(payload, "base"), "repo"), "full_name"));
  const asked = `${name.owner}/${name.repository}`.toLowerCase();
  if (full !== undefined && full.toLowerCase() !== asked) {
    return undefined;
  }
  return nonEmpty(member(member(payload, "head"), "sha"));
}

/** The combined status for one ref, which is a single object rather than a page. */
function* readCombinedStatus(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  headSha: string,
): Operation<PullRequestEvidence[] | undefined> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return undefined;
  }
  const url =
    `${access.endpoint}/repos/${name.owner}/${name.repository}/commits/${headSha}/status` +
    `?per_page=${PAGE_SIZE}`;
  let response;
  try {
    response = yield* access.send({ method: "GET", url, headers: sent });
  } catch {
    return undefined;
  }
  if (response.status !== 200) {
    return undefined;
  }
  const payload = readJson(response.body);
  const declared = nonEmpty(member(payload, "sha"));
  if (declared !== undefined && declared !== headSha) {
    return undefined;
  }
  const listed = member(payload, "statuses");
  if (!Array.isArray(listed)) {
    return undefined;
  }
  const gathered: PullRequestEvidence[] = [];
  for (const candidate of listed) {
    const item = readCommitStatus(headSha, candidate);
    if (item === undefined) {
      return undefined;
    }
    gathered.push(item);
  }
  return gathered;
}

/** Read one collection, completely, or say it could not be read. */
export function* readPullRequestEvidence(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  number: number,
  kind: PullRequestReadKind,
): Operation<EvidenceReading> {
  if (kind === "reviews") {
    const reviews = yield* collect(
      access,
      collectionUrl(access, name, `/pulls/${number}/reviews`),
      readReview,
    );
    return reviews === undefined
      ? UNAVAILABLE
      : { state: "read", headSha: null, evidence: reviews };
  }

  if (kind === "comments") {
    // Conversation first, then inline: two collections with no common clock, so
    // the order is stated rather than interleaved by timestamp.
    const conversation = yield* collect(
      access,
      collectionUrl(access, name, `/issues/${number}/comments`),
      readConversationComment,
    );
    if (conversation === undefined) {
      return UNAVAILABLE;
    }
    const inline = yield* collect(
      access,
      collectionUrl(access, name, `/pulls/${number}/comments`),
      readReviewComment,
    );
    if (inline === undefined) {
      return UNAVAILABLE;
    }
    return { state: "read", headSha: null, evidence: [...conversation, ...inline] };
  }

  const headSha = yield* observeHead(access, name, number);
  if (headSha === undefined) {
    return UNAVAILABLE;
  }
  // `filter=latest` is the default and is written anyway: what a reviewer wants
  // is what the pull request's own page associates with this head — the latest
  // run per name — rather than every historical attempt at it.
  const runs = yield* collect(
    access,
    collectionUrl(access, name, `/commits/${headSha}/check-runs`, "&filter=latest"),
    (payload) => readCheckRun(headSha, payload),
    "check_runs",
  );
  if (runs === undefined) {
    return UNAVAILABLE;
  }
  const statuses = yield* readCombinedStatus(access, name, headSha);
  if (statuses === undefined) {
    return UNAVAILABLE;
  }
  return { state: "read", headSha, evidence: [...runs, ...statuses] };
}
