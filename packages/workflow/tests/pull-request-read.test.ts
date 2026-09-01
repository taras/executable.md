/**
 * Tier PRR — the evidence a network-denied reviewer is given.
 *
 * The claim these cases defend is a negative one: this surface never answers
 * "there is nothing there" on the strength of something it could not read. So
 * every refusal case asserts that the read *fails* rather than binding a
 * shorter list, and the one case that binds `[]` proves the provider said so.
 *
 * The adapter runs against a transport this suite supplies. Nothing here
 * contacts a network host, and no case reads a developer's real credential.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, race, resource, scoped, suspend, until, withResolvers } from "effection";
import { exists } from "@effectionx/fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Operation } from "effection";
import type { PullRequestReadResult } from "../src/composition/pull-request-read-records.ts";
import { PullRequestAPI } from "../src/composition/pull-request-api.ts";
import {
  parseGitHubPullRequestUrl,
  recognizesGitHubPullRequestUrl,
} from "../src/deno/composition/pull-request-reads.ts";
import { PullRequestReadError } from "../src/composition/errors.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../mod.ts";
import { dropRootClose } from "./support/replay.ts";
import { raised, runWorkflowDocument } from "./support/composition.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import { PULL_REQUEST_READ } from "../src/deno/composition/pull-request-operations.ts";
import { collect, execute, inlineSource, isJsonObject } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { readPullRequestEvidence } from "../src/deno/composition/pull-request-evidence.ts";
import type { EvidenceReading } from "../src/deno/composition/pull-request-evidence.ts";
import type { GitHubSource } from "../src/deno/composition/github.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
  GitHubRepositoryName,
} from "../src/deno/composition/github.ts";

const ENDPOINT = "https://api.github.test";

/** A body that makes the transport raise rather than answer. */
const THROWS = "\u0000transport-failure";
const NAME: GitHubRepositoryName = { owner: "octo", repository: "project" };
const HEAD = "a".repeat(40);

/** One canned answer, and the `Link` header that decides what follows it. */
interface Answer {
  readonly status?: number;
  readonly body: string;
  readonly link?: string;
}

interface Server {
  readonly access: GitHubAccess;
  readonly requests: GitHubHttpRequest[];
}

/**
 * A transport that answers by path, and records what it was asked.
 *
 * Keyed by pathname plus search so a paged case can answer page 2 differently
 * from page 1, and a case can assert that a replay asked for nothing at all.
 */
function server(answers: Record<string, Answer>, token: string | null = "t"): Server {
  const requests: GitHubHttpRequest[] = [];
  return {
    requests,
    access: {
      endpoint: ENDPOINT,
      // deno-lint-ignore require-yield
      *token(): Operation<string | undefined> {
        return token ?? undefined;
      },
      // deno-lint-ignore require-yield
      *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
        requests.push(request);
        const url = new URL(request.url);
        const answer = answers[`${url.pathname}${url.search}`] ?? answers[url.pathname];
        if (answer === undefined) {
          throw new Error(`no canned answer for ${url.pathname}${url.search}`);
        }
        if (answer.body === THROWS) {
          throw new Error("the transport could not reach the host");
        }
        return {
          status: answer.status ?? 200,
          body: answer.body,
          ...(answer.link === undefined ? {} : { link: answer.link }),
        };
      },
    },
  };
}

/**
 * A run whose only pull-request adapter is this suite's transport.
 *
 * A read needs no Repository, no checkout and no working directory, so these
 * cases install the GitHub middleware over a canned server and nothing else.
 * The ceiling is the repository the fixtures name.
 */
/**
 * Middleware installed *outside* the run's own adapter.
 *
 * Position is the whole of provider order here: a handler installed through the
 * harness callback lands inside the attachment, and therefore behind the GitHub
 * adapter — it is the *next* provider. One installed around the whole run is in
 * front of it, and sees a request first.
 */
function ahead<T>(handler: () => Operation<void>, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* handler();
    return yield* body();
  });
}

function reading(host: Server, allowed: readonly string[] = [SUBJECT_REPO]) {
  return {
    composition: {},
    gitHubPullRequests: { allowed, access: gitHubSource(host.access) },
  };
}

/** The pull request every case here names, and the ceiling that admits it. */
const SUBJECT_REPO = "https://github.com/octo/project";
const SUBJECT_URL = `${SUBJECT_REPO}/pull/7`;

const REVIEWS = "/repos/octo/project/pulls/7/reviews";
const CONVERSATION = "/repos/octo/project/issues/7/comments";
const INLINE = "/repos/octo/project/pulls/7/comments";
const PULL = "/repos/octo/project/pulls/7";
const RUNS = `/repos/octo/project/commits/${HEAD}/check-runs`;
const STATUS = `/repos/octo/project/commits/${HEAD}/status`;

/** The URL a review and an inline comment name their pull request by. */
const SUBJECT = `${ENDPOINT}/repos/octo/project/pulls/7`;
const ISSUE_SUBJECT = `${ENDPOINT}/repos/octo/project/issues/7`;

function review(
  id: number,
  state: string,
  body: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id,
    user: { login: "reviewer" },
    state,
    body,
    submitted_at: "2026-08-24T00:00:00Z",
    commit_id: HEAD,
    html_url: `https://github.test/pr/7#r${id}`,
    pull_request_url: SUBJECT,
    ...overrides,
  };
}

/** The pull request itself, carrying everything an answer is authenticated by. */
function pullRequestPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    number: 7,
    head: { sha: HEAD },
    base: { repo: { full_name: "octo/project" } },
    ...overrides,
  };
}

function read(
  server: Server,
  kind: "reviews" | "comments" | "checks",
  name: GitHubRepositoryName = NAME,
): Operation<EvidenceReading> {
  return readPullRequestEvidence(server.access, name, 7, kind);
}

/**
 * Every byte of this run's storage, main database and sidecars alike.
 *
 * A refusal must leave the run untouched, so this compares bytes rather than
 * the rows a query would select — a write a query does not look at is exactly
 * what a refusal must not make.
 */
function* storageDigest(path: string): Operation<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = `${path}${suffix}`;
    digests[suffix === "" ? "db" : suffix] = (yield* exists(file))
      ? createHash("sha256")
          .update(yield* until(readFile(file)))
          .digest("hex")
      : "absent";
  }
  return digests;
}

/** Every retained evidence read this run holds. */
function* reads(database: WorkflowRunDatabase): Operation<DurableEvent[]> {
  const events: DurableEvent[] = yield* database.journal.readAll();
  return events.filter(
    (event) => event.type === "yield" && event.description.type === PULL_REQUEST_READ,
  );
}

/** The discriminator, for the two collections that carry one. */
function kinds(reading: EvidenceReading): string[] {
  return items(reading).map((item) => String(item.kind ?? "review-evidence"));
}

/**
 * The items a completed read holds, whatever collection it read.
 *
 * `JsonObject` rather than the union: every case here asks whether a member is
 * present and what it holds, which is a question about the record the provider
 * produced rather than about which arm of the union it is.
 */
function items(reading: EvidenceReading): readonly Record<string, unknown>[] {
  return reading.state === "read" ? reading.result.items.map((item) => ({ ...item })) : [];
}

/** The head a completed checks read names. */
function headOf(reading: EvidenceReading): string | undefined {
  return reading.state === "read" && reading.result.kind === "checks"
    ? reading.result.headSha
    : undefined;
}

describe("Tier PRR — pull-request evidence", () => {
  it("PRR3: every body and every check survives normalization byte for byte", function* () {
    const body = "  Two  spaces, a\ttab, and a trailing newline.\n";
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "CHANGES_REQUESTED", body)]) },
      [CONVERSATION]: {
        body: JSON.stringify([
          {
            id: 2,
            user: { login: "watcher" },
            body,
            created_at: "2026-08-24T01:00:00Z",
            updated_at: "2026-08-24T01:00:00Z",
            html_url: "https://github.test/pr/7#c2",
            issue_url: ISSUE_SUBJECT,
          },
        ]),
      },
      [INLINE]: {
        body: JSON.stringify([
          {
            id: 3,
            pull_request_review_id: 1,
            user: { login: "reviewer" },
            body,
            created_at: "2026-08-24T02:00:00Z",
            updated_at: "2026-08-24T02:00:00Z",
            html_url: "https://github.test/pr/7#d3",
            path: "packages/core/mod.ts",
            diff_hunk: "@@ -1 +1 @@\n-old\n+new",
            commit_id: HEAD,
            original_commit_id: HEAD,
            line: 12,
            side: "RIGHT",
            start_line: null,
            start_side: null,
            in_reply_to_id: null,
            pull_request_url: SUBJECT,
          },
        ]),
      },
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: {
        body: JSON.stringify({
          total_count: 1,
          check_runs: [
            {
              id: 4,
              head_sha: HEAD,
              name: "test-deno",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.test/run/4",
              started_at: "2026-08-24T03:00:00Z",
              completed_at: "2026-08-24T03:10:00Z",
              output: { title: "1 failed", summary: body, text: null },
            },
          ],
        }),
      },
      [STATUS]: {
        body: JSON.stringify({
          sha: HEAD,
          statuses: [
            {
              id: 5,
              context: "deploy",
              state: "error",
              description: body,
              target_url: null,
              created_at: "2026-08-24T04:00:00Z",
              updated_at: "2026-08-24T04:00:00Z",
            },
          ],
        }),
      },
    });

    const reviews = yield* read(host, "reviews");
    expect(reviews.state).toBe("read");
    expect(items(reviews)).toEqual([
      {
        id: "1",
        author: "reviewer",
        state: "changes-requested",
        body,
        submittedAt: "2026-08-24T00:00:00Z",
        commitSha: HEAD,
        url: "https://github.test/pr/7#r1",
      },
    ]);

    const comments = yield* read(host, "comments");
    expect(kinds(comments)).toEqual(["conversation", "review"]);
    expect(comments.state === "read" && items(comments).every((item) => item.body === body)).toBe(
      true,
    );

    const checks = yield* read(host, "checks");
    expect(headOf(checks)).toBe(HEAD);
    expect(kinds(checks)).toEqual(["check-run", "commit-status"]);
    // `error` is a commit-status word and stays one. Mapped onto `failure` it
    // would tell a reviewer a check ran and failed.
    const status = items(checks)[1];
    expect(status?.state).toBe("error");
    expect(status?.description).toBe(body);
  });

  it("PRR3b: every published URL is the one a person opens, or null", function* () {
    // Three URL families, none of which a payload could be confused for
    // another: what a person opens, what the API answers on, and where a
    // build lives. If a reader ever published the wrong one, a reviewer
    // following the link would land on JSON or on a CI page rather than on
    // the objection they were shown.
    const HUMAN = "https://github.test";
    const CI = "https://ci.test";

    const host = server({
      [REVIEWS]: {
        body: JSON.stringify([
          review(10, "APPROVED", "approved", { html_url: `${HUMAN}/pr/7#r10` }),
        ]),
      },
      [CONVERSATION]: {
        body: JSON.stringify([
          {
            id: 11,
            user: { login: "watcher" },
            body: "on the thread",
            created_at: "2026-08-24T01:00:00Z",
            updated_at: "2026-08-24T01:00:00Z",
            html_url: `${HUMAN}/pr/7#c11`,
            issue_url: ISSUE_SUBJECT,
          },
        ]),
      },
      [INLINE]: {
        body: JSON.stringify([
          {
            id: 12,
            // A comment left outside a review — GitHub says so with an
            // explicit null, and it is an ordinary comment, not a malformed
            // one. Rejecting it would drop the whole collection.
            pull_request_review_id: null,
            user: { login: "reviewer" },
            body: "on the diff",
            created_at: "2026-08-24T02:00:00Z",
            updated_at: "2026-08-24T02:00:00Z",
            html_url: `${HUMAN}/pr/7#d12`,
            path: "packages/core/mod.ts",
            diff_hunk: "@@ -1 +1 @@\n-old\n+new",
            commit_id: HEAD,
            original_commit_id: HEAD,
            in_reply_to_id: null,
            pull_request_url: SUBJECT,
          },
        ]),
      },
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: {
        body: JSON.stringify({
          check_runs: [
            {
              id: 13,
              head_sha: HEAD,
              name: "with-page",
              status: "completed",
              conclusion: "success",
              html_url: `${HUMAN}/run/13`,
              details_url: `${CI}/build/13`,
            },
            {
              id: 14,
              head_sha: HEAD,
              name: "without-page",
              status: "completed",
              conclusion: "success",
              // No `html_url`. `details_url` is a different field naming a
              // different place, and it is not a substitute for the missing one.
              details_url: `${CI}/build/14`,
            },
          ],
        }),
      },
      [STATUS]: {
        body: JSON.stringify({
          sha: HEAD,
          statuses: [
            {
              id: 15,
              context: "with-target",
              state: "success",
              target_url: `${CI}/status/15`,
              created_at: "2026-08-24T04:00:00Z",
              updated_at: "2026-08-24T04:00:00Z",
            },
            {
              id: 16,
              context: "without-target",
              state: "success",
              target_url: null,
              created_at: "2026-08-24T05:00:00Z",
              updated_at: "2026-08-24T05:00:00Z",
            },
          ],
        }),
      },
    });

    // A review is opened where a person reads it, not where the API answered
    // about it — `pull_request_url` names this same review's subject.
    const reviews = items(yield* read(host, "reviews"));
    expect(reviews[0]?.url).toBe(`${HUMAN}/pr/7#r10`);
    expect(reviews[0]?.url).not.toBe(SUBJECT);

    const comments = yield* read(host, "comments");
    expect(kinds(comments)).toEqual(["conversation", "review"]);
    const [conversation, inline] = items(comments);
    expect(conversation?.url).toBe(`${HUMAN}/pr/7#c11`);
    expect(conversation?.url).not.toBe(ISSUE_SUBJECT);
    expect(inline?.url).toBe(`${HUMAN}/pr/7#d12`);
    expect(inline?.url).not.toBe(SUBJECT);
    // The comment survived its null review, and says so rather than guessing.
    expect(inline?.reviewId).toBe(null);

    const checks = yield* read(host, "checks");
    expect(kinds(checks)).toEqual(["check-run", "check-run", "commit-status", "commit-status"]);
    const [withPage, withoutPage, withTarget, withoutTarget] = items(checks);
    expect(withPage?.url).toBe(`${HUMAN}/run/13`);
    expect(withPage?.url).not.toBe(`${CI}/build/13`);
    // Absent stays absent. Falling back to `details_url` would send a reviewer
    // to a build page while telling them it was the check's own.
    expect(withoutPage?.url).toBe(null);
    expect(withTarget?.url).toBe(`${CI}/status/15`);
    expect(withoutTarget?.url).toBe(null);
  });

  it("PRR4: a three-page collection returns every item once, in order", function* () {
    const page = (n: number) => `${ENDPOINT}${REVIEWS}?per_page=100&page=${n}`;
    const host = server({
      [`${REVIEWS}?per_page=100`]: {
        body: JSON.stringify([review(1, "COMMENTED", "one")]),
        link: `<${page(2)}>; rel="next"`,
      },
      [`${REVIEWS}?per_page=100&page=2`]: {
        body: JSON.stringify([review(2, "COMMENTED", "two")]),
        link: `<${page(3)}>; rel="next"`,
      },
      [`${REVIEWS}?per_page=100&page=3`]: {
        body: JSON.stringify([review(3, "COMMENTED", "three")]),
      },
    });

    const reading = yield* read(host, "reviews");
    expect(items(reading).map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(host.requests).toHaveLength(3);
  });

  it("PRR5: a completed empty collection binds [], and checks still name the head", function* () {
    const host = server({
      [REVIEWS]: { body: "[]" },
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: { body: JSON.stringify({ total_count: 0, check_runs: [] }) },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });

    const reviews = yield* read(host, "reviews");
    expect(reviews.state).toBe("read");
    expect(items(reviews)).toEqual([]);

    const checks = yield* read(host, "checks");
    expect(checks.state).toBe("read");
    expect(items(checks)).toEqual([]);
    // An empty array that still says which revision it is empty about.
    expect(headOf(checks)).toBe(HEAD);
  });

  it("PRR6: every unreadable answer is unavailable, and none of them truncates", function* () {
    const first = JSON.stringify([review(1, "COMMENTED", "one")]);
    // Two meanings, told apart: nothing could be read, versus something was
    // read and was not what it claimed to be.
    const expected: Record<string, string> = {
      "not an array": "protocol-invalid",
      "malformed json": "protocol-invalid",
    };
    const cases: Record<string, Answer> = {
      transport: { body: THROWS },
      "rate limit": { status: 403, body: "{}" },
      "auth failure": { status: 401, body: "{}" },
      "ambiguous 404": { status: 404, body: "{}" },
      "malformed json": { body: "{not json" },
      "not an array": { body: JSON.stringify({ reviews: [] }) },
    };
    for (const [name, answer] of Object.entries(cases)) {
      const host = server({ [REVIEWS]: answer });
      const reading = yield* read(host, "reviews");
      expect(`${name}: ${reading.state}`).toBe(`${name}: ${expected[name] ?? "unavailable"}`);
    }

    // A next relation off the endpoint's own origin is where the credential
    // would have gone; one that cannot be parsed is a page nobody read; one
    // still present at the limit is more pages than this adapter will follow.
    const offOrigin = server({
      [`${REVIEWS}?per_page=100`]: {
        body: first,
        link: `<https://elsewhere.test/next>; rel="next"`,
      },
    });
    expect((yield* read(offOrigin, "reviews")).state).toBe("unavailable");

    const unparseable = server({
      [`${REVIEWS}?per_page=100`]: { body: first, link: `<not a url>; rel="next"` },
    });
    expect((yield* read(unparseable, "reviews")).state).toBe("unavailable");

    const endless = server({
      [`${REVIEWS}?per_page=100`]: {
        body: first,
        link: `<${ENDPOINT}${REVIEWS}?per_page=100>; rel="next"`,
      },
    });
    expect((yield* read(endless, "reviews")).state).toBe("unavailable");
  });

  it("PRR7: an answer about another subject is refused, not published", function* () {
    // The number collides; the repository does not. Matching the trailing
    // number alone would render someone else's objection as this change's.
    const foreign = server({
      [REVIEWS]: {
        body: JSON.stringify([
          review(1, "CHANGES_REQUESTED", "this is about another project", {
            pull_request_url: `${ENDPOINT}/repos/someone/else/pulls/7`,
          }),
        ]),
      },
    });
    expect((yield* read(foreign, "reviews")).state).toBe("protocol-invalid");

    // The same collision on the conversation collection.
    const foreignComment = server({
      [CONVERSATION]: {
        body: JSON.stringify([
          {
            id: 2,
            user: { login: "watcher" },
            body: "another project's thread",
            created_at: "2026-08-24T01:00:00Z",
            updated_at: "2026-08-24T01:00:00Z",
            html_url: "https://github.test/pr/7#c2",
            issue_url: `${ENDPOINT}/repos/someone/else/issues/7`,
          },
        ]),
      },
      [INLINE]: { body: "[]" },
    });
    expect((yield* read(foreignComment, "comments")).state).toBe("protocol-invalid");

    // The pull request answers with a different number.
    const wrongNumber = server({
      [PULL]: { body: JSON.stringify(pullRequestPayload({ number: 8 })) },
    });
    expect((yield* read(wrongNumber, "checks")).state).toBe("protocol-invalid");

    // It answers for another repository.
    const wrongRepository = server({
      [PULL]: {
        body: JSON.stringify(pullRequestPayload({ base: { repo: { full_name: "someone/else" } } })),
      },
    });
    expect((yield* read(wrongRepository, "checks")).state).toBe("protocol-invalid");

    // The border of that rejection. GitHub accepts a repository path in any
    // casing and answers with the canonical spelling, so the canonical answer
    // to a request that named `OCTO/PROJECT` is this read's own subject — the
    // same name, not a foreign one — and refusing it would refuse an
    // authorized URL the host had already answered.
    const cased = server({
      "/repos/OCTO/PROJECT/pulls/7/reviews": {
        body: JSON.stringify([review(3, "APPROVED", "ship it")]),
      },
    });
    const canonical = yield* read(cased, "reviews", { owner: "OCTO", repository: "PROJECT" });
    expect(canonical.state).toBe("read");
    expect(items(canonical)).toHaveLength(1);

    // A check run naming a head other than the one this read is about.
    const wrongHead = server({
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: {
        body: JSON.stringify({
          check_runs: [{ id: 1, head_sha: "b".repeat(40), name: "x", status: "completed" }],
        }),
      },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });
    expect((yield* read(wrongHead, "checks")).state).toBe("protocol-invalid");

    // A combined status answering for another commit.
    const wrongStatusSha = server({
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: { body: JSON.stringify({ check_runs: [] }) },
      [STATUS]: { body: JSON.stringify({ sha: "c".repeat(40), statuses: [] }) },
    });
    expect((yield* read(wrongStatusSha, "checks")).state).toBe("protocol-invalid");
  });

  it("PRR8: a value outside a frozen enum, or a missing field, is refused", function* () {
    const unknownReviewState = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "ESCALATED", "one")]) },
    });
    expect((yield* read(unknownReviewState, "reviews")).state).toBe("protocol-invalid");

    const missingBody = server({
      [REVIEWS]: {
        body: JSON.stringify([
          { id: 1, user: { login: "r" }, state: "COMMENTED", html_url: "https://github.test/x" },
        ]),
      },
    });
    expect((yield* read(missingBody, "reviews")).state).toBe("protocol-invalid");

    const unknownRunStatus = server({
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: {
        body: JSON.stringify({
          check_runs: [{ id: 1, head_sha: HEAD, name: "x", status: "napping" }],
        }),
      },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });
    expect((yield* read(unknownRunStatus, "checks")).state).toBe("protocol-invalid");

    const unknownStatusState = server({
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: { body: JSON.stringify({ check_runs: [] }) },
      [STATUS]: {
        body: JSON.stringify({
          sha: HEAD,
          statuses: [
            {
              id: 1,
              context: "x",
              state: "wobbly",
              created_at: "2026-08-24T00:00:00Z",
              updated_at: "2026-08-24T00:00:00Z",
            },
          ],
        }),
      },
    });
    expect((yield* read(unknownStatusState, "checks")).state).toBe("protocol-invalid");
  });

  it("PRR9: a pending review with no submission is retained, not refused", function* () {
    const host = server({
      [REVIEWS]: {
        body: JSON.stringify([
          {
            id: 1,
            user: null,
            state: "PENDING",
            body: "",
            submitted_at: null,
            commit_id: null,
            html_url: "https://github.test/pr/7#r1",
            pull_request_url: SUBJECT,
          },
          review(2, "APPROVED", "looks right"),
        ]),
      },
    });

    const reading = yield* read(host, "reviews");
    expect(reading.state).toBe("read");
    // Both survive: one pending review must not cost the reviewer every other
    // review in the collection.
    expect(items(reading)).toHaveLength(2);
    const pending = items(reading)[0];
    expect(pending?.state).toBe("pending");
    expect(pending?.submittedAt).toBe(null);
    expect(pending?.commitSha).toBe(null);
    // A deleted account is an absent author, not an unreadable item.
    expect(pending?.author).toBe(null);
  });

  it("PRR1: no credential is no read, and the credential never reaches a record", function* () {
    const host = server({ [REVIEWS]: { body: "[]" } }, null);

    expect((yield* read(host, "reviews")).state).toBe("unavailable");
    expect(host.requests).toEqual([]);

    const authenticated = server({ [REVIEWS]: { body: "[]" } }, "ghp_secret");
    yield* read(authenticated, "reviews");
    expect(authenticated.requests[0]?.headers.Authorization).toBe("Bearer ghp_secret");
    const reading = yield* read(authenticated, "reviews");
    expect(JSON.stringify(reading)).not.toContain("ghp_secret");
  });

  it("PRR2: a malformed invocation is refused before any provider is asked", function* () {
    const host = server({ [REVIEWS]: { body: "[]" } });
    const options = reading(host);

    const refusals: readonly string[] = [
      `<PullRequest.Reviews as="reviews" />`,
      `<PullRequest.Reviews url="" as="reviews" />`,
      `<PullRequest.Reviews url="not a url" as="reviews" />`,
      `<PullRequest.Reviews url="${SUBJECT_URL}?token=hunter2" as="reviews" />`,
      `<PullRequest.Reviews url="https://user:pw@github.com/octo/project/pull/7" as="reviews" />`,
      `<PullRequest.Reviews url="${SUBJECT_URL}" provider="Not A Name" as="reviews" />`,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews">paired</PullRequest.Reviews>`,
    ];

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      for (const element of refusals) {
        const database = yield* createRun();
        const failure = yield* raised(runWorkflowDocument(database, `${element}\n`, options));
        expect(`${element}: ${failure === undefined ? "bound" : "refused"}`).toBe(
          `${element}: refused`,
        );
      }
    });

    // Not one request, and no credential read: every refusal is local.
    expect(host.requests).toEqual([]);
  });

  it("PRR12: a missing `as` is refused before the provider is contacted", function* () {
    const host = server({ [REVIEWS]: { body: "[]" } });
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          `<PullRequest.Reviews url="${SUBJECT_URL}" />\n`,
          reading(host),
        ),
      );
      expect(failure).toBeDefined();
    });
    expect(host.requests).toEqual([]);
  });

  it("PRR13: an ordinary run resolves none of the three", function* () {
    const stream = new InMemoryStream();
    const failure = yield* raised(
      collect(
        yield* execute({
          ...inlineSource(`<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n`),
          stream,
        }),
      ),
    );
    expect(String(failure)).toContain("PullRequest.Reviews");
  });

  it("PRR19: a canonical URL selects GitHub, and names the repository and number", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runWorkflowDocument(
        database,
        `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n\n{reviews.length} reviews\n`,
        reading(host),
      );
      expect(String(output)).toContain("1 reviews");
    });

    // No discriminator was written; the URL selected the adapter, and the
    // owner, repository and number it sent came out of that URL.
    expect(host.requests.map((request) => new URL(request.url).pathname)).toEqual([REVIEWS]);
  });

  it("PRR20: an explicit provider selects GitHub for a self-hosted URL shape", function* () {
    const selfHosted = "https://git.example.test/octo/project/pull/7";

    // Implicit selection is public GitHub only. The same path shape on another
    // host is not claimed, because claiming it is how a document that named one
    // service quietly reaches a different one.
    expect(recognizesGitHubPullRequestUrl(SUBJECT_URL)).toBe(true);
    expect(recognizesGitHubPullRequestUrl(selfHosted)).toBe(false);
    // The shape is still one this adapter speaks, which is what makes the URL
    // addressable once a document names the provider.
    expect(parseGitHubPullRequestUrl(selfHosted)).toEqual({
      owner: "octo",
      repository: "project",
      number: 7,
    });

    const host = server({ "/repos/octo/project/pulls/7/reviews": { body: "[]" } });
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(
        database,
        `<PullRequest.Reviews url="${selfHosted}" provider="github" as="reviews" />\n`,
        reading(host, [selfHosted]),
      );
    });

    // Named, the same URL is this adapter's.
    expect(host.requests).toHaveLength(1);
  });

  it("PRR20b: a malformed provider name is refused before the API is invoked", function* () {
    const host = server({ [REVIEWS]: { body: "[]" } });
    let asked = 0;

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        ahead(
          function* () {
            yield* PullRequestAPI.around({
              *read([url, options], next): Operation<PullRequestReadResult> {
                asked += 1;
                return yield* next(url, options);
              },
            });
          },
          () =>
            runWorkflowDocument(
              database,
              `<PullRequest.Reviews url="${SUBJECT_URL}" provider="Not A Name" as="reviews" />\n`,
              reading(host),
            ),
        ),
      );
      expect(String(failure)).toContain("not a provider name");
    });

    // The component refused it, so nothing was asked of the surface at all.
    expect(asked).toBe(0);
    expect(host.requests).toEqual([]);
  });

  it("PRR21: a provider that does not match delegates the exact arguments", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });
    const seen: string[] = [];

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* ahead(
        // A provider for somewhere else, in front of the adapter. It sees the
        // request, recognizes nothing, and passes both arguments along
        // untouched.
        function* () {
          yield* PullRequestAPI.around({
            *read([url, options], next): Operation<PullRequestReadResult> {
              seen.push(`${url}|${options.kind}|${options.provider ?? "-"}`);
              return yield* next(url, options);
            },
          });
        },
        () =>
          runWorkflowDocument(
            database,
            `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n\n{reviews.length} reviews\n`,
            reading(host),
          ),
      );
      expect(String(output)).toContain("1 reviews");
    });

    // Exactly what the component asked for, and the next matching provider
    // owned the answer.
    expect(seen).toEqual([`${SUBJECT_URL}|reviews|-`]);
    expect(host.requests).toHaveLength(1);
  });

  it("PRR25: once a provider matches, its refusal is final", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });
    let fallbacks = 0;

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n`,
          // Configured, so the adapter matches this URL by recognizing it —
          // and then refuses, because this is not one of the places allowed.
          // An empty list would make it delegate instead, which is a different
          // fact about a different situation.
          reading(host, ["https://github.com/octo/other"]),
          function* (run) {
            return yield* scoped(function* () {
              // Installed outside the adapter, so it would be the next one
              // asked if a refusal were a reason to keep looking.
              yield* PullRequestAPI.around({
                // deno-lint-ignore require-yield
                *read(): Operation<PullRequestReadResult> {
                  fallbacks += 1;
                  return { kind: "reviews", items: [] };
                },
              });
              return yield* run();
            });
          },
        ),
      );
      expect(String(failure)).toContain("has not authorized");
    });

    // The refusal ended the request. Nothing fell back to a second answer.
    expect(fallbacks).toBe(0);
    expect(host.requests).toEqual([]);
  });

  it("PRR28: a URL that is not allowed is refused before any session or request", function* () {
    const sessions: string[] = [];
    const host = server({ [REVIEWS]: { body: "[]" } });
    const counted: GitHubSource = {
      endpoint: host.access.endpoint,
      open(): Operation<GitHubAccess> {
        return resource(function* (provide) {
          sessions.push("open");
          try {
            yield* provide(host.access);
          } finally {
            sessions.push("close");
          }
        });
      },
    };

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const failure = yield* raised(
        runWorkflowDocument(
          database,
          `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n`,
          {
            composition: {},
            // Authorizes a different repository entirely.
            gitHubPullRequests: { allowed: ["https://github.com/octo/other"], access: counted },
          },
        ),
      );
      expect(String(failure)).toContain("has not authorized");
    });

    // No access session was opened, so no credential was read and nothing was
    // sent. The ceiling is asked before any of that exists.
    expect(sessions).toEqual([]);
    expect(host.requests).toEqual([]);
  });

  it("PRR18a: middleware may refuse, and nothing is read", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const refused = yield* raised(
        ahead(
          function* () {
            yield* PullRequestAPI.around({
              // deno-lint-ignore require-yield
              *read(): Operation<PullRequestReadResult> {
                throw new PullRequestReadError(
                  "unavailable",
                  "<PullRequest.Reviews>",
                  "this run may not read pull requests.",
                );
              },
            });
          },
          () =>
            runWorkflowDocument(
              database,
              `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n`,
              reading(host),
            ),
        ),
      );
      expect(String(refused)).toContain("may not read pull requests");
    });

    expect(host.requests).toEqual([]);
  });

  it("PRR10: the three are three independent durable reads", function* () {
    const host = server({
      [REVIEWS]: { body: "[]" },
      [CONVERSATION]: { body: "[]" },
      [INLINE]: { body: "[]" },
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: { body: JSON.stringify({ check_runs: [] }) },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(
        database,
        [
          `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
          `<PullRequest.Comments url="${SUBJECT_URL}" as="comments" />`,
          `<PullRequest.Checks url="${SUBJECT_URL}" as="checks" />`,
          "",
        ].join("\n"),
        reading(host),
      );

      // Three effects, one per collection: completing one manufactures neither
      // of the others.
      const retained = yield* reads(database);
      expect(retained).toHaveLength(3);
      const kinds = retained.map((event) =>
        event.type === "yield" && isJsonObject(event.description.input)
          ? event.description.input.kind
          : undefined,
      );
      expect(kinds).toEqual(["reviews", "comments", "checks"]);
    });
  });

  it("PRR23: the URL, the discriminator and the collection all name the effect", function* () {
    const other = "https://github.com/octo/project/pull/8";
    const host = server({
      [REVIEWS]: { body: "[]" },
      [CONVERSATION]: { body: "[]" },
      [INLINE]: { body: "[]" },
      "/repos/octo/project/pulls/8/reviews": { body: "[]" },
    });

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(
        database,
        [
          `<PullRequest.Reviews url="${SUBJECT_URL}" as="a" />`,
          `<PullRequest.Reviews url="${other}" as="b" />`,
          `<PullRequest.Comments url="${SUBJECT_URL}" as="c" />`,
          `<PullRequest.Reviews url="${SUBJECT_URL}" provider="github" as="d" />`,
          "",
        ].join("\n"),
        reading(host, [SUBJECT_REPO]),
      );

      const retained = yield* reads(database);
      expect(retained).toHaveLength(4);
      const inputs = retained.map((event) =>
        event.type === "yield" && isJsonObject(event.description.input)
          ? event.description.input
          : {},
      );
      // Every member the request is made of appears in it.
      expect(inputs.map((input) => input.url)).toEqual([
        SUBJECT_URL,
        other,
        SUBJECT_URL,
        SUBJECT_URL,
      ]);
      expect(inputs.map((input) => input.kind)).toEqual([
        "reviews",
        "reviews",
        "comments",
        "reviews",
      ]);
      expect(inputs.map((input) => input.provider)).toEqual([null, null, null, "github"]);

      // And each is a different effect: four reads, four names.
      const names = retained.map((event) =>
        event.type === "yield" ? String(event.description.name) : "",
      );
      expect(new Set(names).size).toBe(4);
    });
  });

  it("PRR11: a completed replay performs no provider or credential work", function* () {
    const sessions: string[] = [];
    const host = server({
      [REVIEWS]: {
        body: JSON.stringify([review(1, "APPROVED", "ship it"), review(2, "COMMENTED", "note")]),
      },
    });
    const counted: GitHubSource = {
      endpoint: host.access.endpoint,
      open(): Operation<GitHubAccess> {
        return resource(function* (provide) {
          sessions.push("open");
          yield* provide(host.access);
        });
      },
    };
    const options = {
      composition: {},
      gitHubPullRequests: { allowed: [SUBJECT_REPO], access: counted },
    };
    const document = `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n\n{reviews.length} reviews\n`;

    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const first = yield* runWorkflowDocument(database, document, options);
      expect(String(first)).toContain("2 reviews");
      expect(host.requests).toHaveLength(1);
      expect(sessions).toEqual(["open"]);

      dropRootClose(path);

      const second = yield* runWorkflowDocument(database, document, options);
      expect(String(second)).toBe(String(first));
      // No second request, and no second session: a completed read restores.
      expect(host.requests).toHaveLength(1);
      expect(sessions).toEqual(["open"]);
    });
  });

  it("PRR22: a read that could not be completed retains no array", function* () {
    const failing = server({ [REVIEWS]: { status: 500, body: "{}" } });
    const document = `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n`;

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const refused = yield* raised(runWorkflowDocument(database, document, reading(failing)));
      expect(String(refused)).toContain("did not answer with the complete collection");

      const retained = yield* reads(database);
      expect(retained).toHaveLength(1);
      const outcome = retained[0]?.result;
      expect(outcome?.status).toBe("err");
      expect(outcome && "value" in outcome).toBe(false);
    });
  });

  it("PRR24: the access session is opened once per read and disposed with it", function* () {
    const host = server({ [REVIEWS]: { body: "[]" } });
    const events: string[] = [];
    const counted: GitHubSource = {
      endpoint: host.access.endpoint,
      open(): Operation<GitHubAccess> {
        return resource(function* (provide) {
          events.push("open");
          try {
            yield* provide(host.access);
          } finally {
            events.push("close");
          }
        });
      },
    };

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(
        database,
        `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n`,
        { composition: {}, gitHubPullRequests: { allowed: [SUBJECT_REPO], access: counted } },
      );
    });

    expect(events).toEqual(["open", "close"]);
  });

  it("PRR26: an interruption in flight unwinds and retains no result", function* () {
    const entered = withResolvers<void>();
    const sessions: string[] = [];
    const hanging: GitHubSource = {
      endpoint: ENDPOINT,
      open(): Operation<GitHubAccess> {
        return resource(function* (provide) {
          sessions.push("open");
          try {
            yield* provide({
              endpoint: ENDPOINT,
              // deno-lint-ignore require-yield
              *token(): Operation<string | undefined> {
                return "t";
              },
              *send(): Operation<GitHubHttpResponse> {
                entered.resolve();
                yield* suspend();
                throw new Error("unreachable");
              },
            });
          } finally {
            sessions.push("close");
          }
        });
      },
    };
    const document = `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n\n{reviews.length} reviews\n`;

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      yield* race([
        call(function* () {
          yield* raised(
            runWorkflowDocument(database, document, {
              composition: {},
              gitHubPullRequests: { allowed: [SUBJECT_REPO], access: hanging },
            }),
          );
        }),
        call(function* () {
          yield* entered.operation;
        }),
      ]);

      expect(sessions).toEqual(["open", "close"]);

      const retained = yield* reads(database);
      expect(retained.every((event) => event.result?.status !== "ok")).toBe(true);
      expect(JSON.stringify(retained)).not.toContain('"items"');

      const working = server({
        [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
      });
      const output = yield* runWorkflowDocument(database, document, reading(working));
      expect(String(output)).toContain("1 reviews");
      expect(working.requests).toHaveLength(1);
    });
  });
});
