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
import { call, race, resource, scoped, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { createApi } from "@effectionx/context-api";
import {
  PULL_REQUEST_EVIDENCE_API,
  PullRequestEvidence,
} from "../src/composition/pull-request-evidence-api.ts";
import type { PullRequestEvidenceApi } from "../src/composition/pull-request-evidence-api.ts";
import type { PullRequestReadRequest } from "../src/composition/pull-request-read-records.ts";
import { PullRequestReadError } from "../src/composition/errors.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../mod.ts";
import { dropRootClose } from "./support/replay.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { raised, runWorkflowDocument } from "./support/composition.ts";
import { fixture, published, REMOTE } from "./support/pull-requests.ts";
import type { BareRemote } from "./support/git-remotes.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import { GitComposition } from "../src/composition/git-api.ts";
import { PULL_REQUEST_READ } from "../src/deno/composition/pull-request-reads.ts";
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
 * The shipped Repository machinery, with this suite's transport in place of the
 * Git host's.
 *
 * `fixture()` supplies the counting host that resolves a local bare remote; only
 * the GitHub source is replaced, so what these cases drive is the real
 * Repository, checkout and provider path.
 */
function composed(remote: BareRemote, host: Server) {
  const base = fixture(remote);
  return {
    ...base.options,
    composition: { ...base.options.composition, gitHub: gitHubSource(host.access) },
  };
}

const REVIEWS = "/repos/octo/project/pulls/7/reviews";
const CONVERSATION = "/repos/octo/project/issues/7/comments";
const INLINE = "/repos/octo/project/pulls/7/comments";
const PULL = "/repos/octo/project/pulls/7";
const RUNS = `/repos/octo/project/commits/${HEAD}/check-runs`;
const STATUS = `/repos/octo/project/commits/${HEAD}/status`;

/** The URL a review and an inline comment name their pull request by. */
const SUBJECT = `${ENDPOINT}/repos/octo/project/pulls/7`;
const ISSUE_SUBJECT = `${ENDPOINT}/repos/octo/project/issues/7`;

function review(id: number, state: string, body: string): unknown {
  return {
    id,
    user: { login: "reviewer" },
    state,
    body,
    submitted_at: "2026-08-24T00:00:00Z",
    commit_id: HEAD,
    html_url: `https://github.test/pr/7#r${id}`,
    pull_request_url: SUBJECT,
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

function read(server: Server, kind: "reviews" | "comments" | "checks"): Operation<EvidenceReading> {
  return readPullRequestEvidence(server.access, NAME, 7, kind);
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

    // A host with nothing to authenticate with does not send an unauthenticated
    // request and call the answer evidence.
    expect((yield* read(host, "reviews")).state).toBe("unavailable");
    expect(host.requests).toEqual([]);

    const authenticated = server({ [REVIEWS]: { body: "[]" } }, "ghp_secret");
    yield* read(authenticated, "reviews");
    expect(authenticated.requests[0]?.headers.Authorization).toBe("Bearer ghp_secret");
    // What the read answers with holds nothing of it.
    const reading = yield* read(authenticated, "reviews");
    expect(JSON.stringify(reading)).not.toContain("ghp_secret");
  });

  it("PRR10: the three are three reads, and one does not perform another", function* () {
    const host = server({
      [REVIEWS]: { body: "[]" },
      [CONVERSATION]: { body: "[]" },
      [INLINE]: { body: "[]" },
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: { body: JSON.stringify({ check_runs: [] }) },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });

    yield* read(host, "reviews");
    expect(host.requests.map((request) => new URL(request.url).pathname)).toEqual([REVIEWS]);

    yield* read(host, "comments");
    expect(host.requests.map((request) => new URL(request.url).pathname)).toEqual([
      REVIEWS,
      CONVERSATION,
      INLINE,
    ]);

    yield* read(host, "checks");
    expect(host.requests.map((request) => new URL(request.url).pathname)).toEqual([
      REVIEWS,
      CONVERSATION,
      INLINE,
      PULL,
      RUNS,
      STATUS,
    ]);
    // The check-runs request states the filter it depends on rather than
    // inheriting a default that could move.
    expect(host.requests[4]?.url).toContain("filter=latest");
    expect(host.requests.every((request) => request.method === "GET")).toBe(true);
    const paged = host.requests.filter((request) => new URL(request.url).pathname !== PULL);
    expect(paged.every((request) => request.url.includes("per_page=100"))).toBe(true);
    // The pull request itself is one object, so it asks for no page size.
    expect(
      host.requests.find((request) => new URL(request.url).pathname === PULL)?.url,
    ).not.toContain("per_page");
  });

  it("PRR2: a malformed invocation is refused before anything is sent", function* () {
    const host = server({ [REVIEWS]: { body: "[]" } });
    const remote = yield* useBareRemote(REMOTE);
    const options = composed(remote, host);

    const refusals = [
      `<PullRequest.Reviews number={7} as="reviews">not mine to render</PullRequest.Reviews>`,
      `<PullRequest.Reviews as="reviews" />`,
      `<PullRequest.Reviews number={0} as="reviews" />`,
      `<PullRequest.Reviews number={1.5} as="reviews" />`,
    ];

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      for (const element of refusals) {
        const database = yield* createRun();
        const failure = yield* raised(runWorkflowDocument(database, published(element), options));
        expect(`${element}: ${failure === undefined ? "bound" : "refused"}`).toBe(
          `${element}: refused`,
        );
        // Named, so a case that starts failing for an unrelated reason — a
        // Repository that would not prepare, a push that did not land — stops
        // counting as this refusal.
        expect(String(failure)).toContain("PullRequestReadError");
      }

      // Written outside a Repository there is nothing in scope to read from.
      const database = yield* createRun();
      const outside = yield* raised(
        runWorkflowDocument(database, `<PullRequest.Reviews number={7} as="reviews" />\n`, options),
      );
      expect(outside).toBeDefined();
    });

    // Not one request, and no credential read: every refusal is local.
    expect(host.requests).toEqual([]);
  });

  it("PRR11: a completed replay reads nothing and answers identically", function* () {
    const host = server({
      [REVIEWS]: {
        body: JSON.stringify([
          review(1, "APPROVED", "ship it"),
          review(2, "COMMENTED", "one note"),
        ]),
      },
    });
    const remote = yield* useBareRemote(REMOTE);
    const options = composed(remote, host);
    const document = published(
      `<PullRequest.Reviews number={7} as="reviews" />`,
      "",
      "{reviews.length} reviews",
    );

    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      const first = yield* runWorkflowDocument(database, document, options);
      expect(String(first)).toContain("2 reviews");
      expect(host.requests).toHaveLength(1);

      // Without this the second execution is a completed replay, which restores
      // the retained output without entering the procedure at all — and would
      // pass whether or not this read is durable. Dropping the root Close makes
      // the document run again, so each effect either restores or performs.
      dropRootClose(path);

      const second = yield* runWorkflowDocument(database, document, options);
      expect(String(second)).toBe(String(first));
      // Still one: the array a reviewer is shown on a resume is the one the run
      // retained, and no credential was read to produce it a second time.
      expect(host.requests).toHaveLength(1);
    });
  });

  it("PRR12: a missing `as` is refused before the provider is contacted", function* () {
    const host = server({ [REVIEWS]: { body: "[]" } });
    const remote = yield* useBareRemote(REMOTE);
    const options = composed(remote, host);

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // Declaring `returns` is what makes `as` mandatory, and the engine checks
      // it before the body runs.
      const failure = yield* raised(
        runWorkflowDocument(database, published(`<PullRequest.Reviews number={7} />`), options),
      );
      expect(failure).toBeDefined();
    });

    expect(host.requests).toEqual([]);
  });

  it("PRR13: an ordinary run resolves none of the three", function* () {
    // `xmd run` composes no workflow, so these names reach nothing. A document
    // that wrote one outside a workflow gets an unresolved component rather
    // than a read performed under whatever credentials the machine holds.
    const stream = new InMemoryStream();
    const failure = yield* raised(
      collect(
        yield* execute({
          ...inlineSource(`<PullRequest.Reviews number={7} as="reviews" />\n`),
          stream,
        }),
      ),
    );
    expect(String(failure)).toContain("PullRequest.Reviews");
  });

  it("PRR14: the exact URLs and the field each record reads from", function* () {
    const host = server({
      [`${REVIEWS}?per_page=100`]: { body: "[]" },
      [`${CONVERSATION}?per_page=100`]: { body: "[]" },
      [`${INLINE}?per_page=100`]: { body: "[]" },
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [`${RUNS}?per_page=100&filter=latest`]: { body: JSON.stringify({ check_runs: [] }) },
      [`${STATUS}?per_page=100`]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });

    yield* read(host, "reviews");
    yield* read(host, "comments");
    yield* read(host, "checks");

    // Exact, including the query: a default that moved would change what a
    // reviewer is shown without changing a line of this repository.
    expect(host.requests.map((request) => request.url)).toEqual([
      `${ENDPOINT}${REVIEWS}?per_page=100`,
      `${ENDPOINT}${CONVERSATION}?per_page=100`,
      `${ENDPOINT}${INLINE}?per_page=100`,
      `${ENDPOINT}${PULL}`,
      `${ENDPOINT}${RUNS}?per_page=100&filter=latest`,
      `${ENDPOINT}${STATUS}?per_page=100`,
    ]);
  });

  it("PRR15: a check run reads its link from html_url, a status from target_url", function* () {
    const host = server({
      [PULL]: { body: JSON.stringify(pullRequestPayload()) },
      [RUNS]: {
        body: JSON.stringify({
          check_runs: [
            {
              id: 1,
              head_sha: HEAD,
              name: "test",
              status: "completed",
              conclusion: "success",
              // Both present and different, so the record cannot pass by
              // reading whichever happens to be there.
              html_url: "https://github.test/runs/1",
              details_url: "https://elsewhere.test/details",
              output: { title: null, summary: null, text: null },
              started_at: null,
              completed_at: null,
            },
          ],
        }),
      },
      [STATUS]: {
        body: JSON.stringify({
          sha: HEAD,
          statuses: [
            {
              id: 2,
              context: "deploy",
              state: "success",
              description: null,
              target_url: "https://github.test/deploy/2",
              html_url: "https://elsewhere.test/status",
              created_at: "2026-08-24T00:00:00Z",
              updated_at: "2026-08-24T00:00:00Z",
            },
          ],
        }),
      },
    });

    const reading = yield* read(host, "checks");
    expect(reading.state).toBe("read");
    const [run, status] = items(reading);
    expect(run?.url).toBe("https://github.test/runs/1");
    expect(status?.url).toBe("https://github.test/deploy/2");
  });

  it("PRR16: an inline comment outside a review keeps a null review id", function* () {
    const host = server({
      [CONVERSATION]: { body: "[]" },
      [INLINE]: {
        body: JSON.stringify([
          {
            id: 3,
            pull_request_review_id: null,
            user: { login: "reviewer" },
            body: "a standalone note",
            created_at: "2026-08-24T02:00:00Z",
            updated_at: "2026-08-24T02:00:00Z",
            html_url: "https://github.test/pr/7#d3",
            path: "mod.ts",
            diff_hunk: "@@ -1 +1 @@",
            commit_id: HEAD,
            original_commit_id: HEAD,
            line: 1,
            side: "RIGHT",
            start_line: null,
            start_side: null,
            in_reply_to_id: null,
            pull_request_url: SUBJECT,
          },
        ]),
      },
    });

    const reading = yield* read(host, "comments");
    expect(reading.state).toBe("read");
    const comment = items(reading)[0];
    expect(comment?.reviewId).toBe(null);
  });

  it("PRR17: an identifier that cannot be held exactly is refused", function* () {
    const host = server({
      [REVIEWS]: {
        body: JSON.stringify([
          { ...(review(1, "COMMENTED", "one") as Record<string, unknown>), id: 2 ** 53 },
        ]),
      },
    });
    // `String(2**53)` names a different object than the host meant, and a
    // record that rounded it would be evidence about something else.
    expect((yield* read(host, "reviews")).state).toBe("protocol-invalid");
  });

  it("PRR18a: middleware may refuse, and nothing is read", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });
    const remote = yield* useBareRemote(REMOTE);
    const base = composed(remote, host);
    const document = published(`<PullRequest.Reviews number={7} as="reviews" />`);

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const refused = yield* raised(
        runWorkflowDocument(database, document, base, function* (run) {
          return yield* scoped(function* () {
            yield* PullRequestEvidence.around({
              // deno-lint-ignore require-yield
              *read(): Operation<PullRequestReadRequest> {
                throw new PullRequestReadError(
                  "unavailable",
                  "<PullRequest.Reviews>",
                  "this run may not read pull requests.",
                );
              },
            });
            return yield* run();
          });
        }),
      );
      expect(String(refused)).toContain("may not read pull requests");
    });

    expect(host.requests).toEqual([]);
  });

  it("PRR18b: middleware may observe and delegate, and the read is unchanged", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });
    const remote = yield* useBareRemote(REMOTE);
    const base = composed(remote, host);
    const document = published(
      `<PullRequest.Reviews number={7} as="reviews" />`,
      "",
      "{reviews.length} reviews",
    );

    const seen: string[] = [];
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runWorkflowDocument(database, document, base, function* (run) {
        return yield* scoped(function* () {
          yield* PullRequestEvidence.around({
            *read([request], next): Operation<PullRequestReadRequest> {
              seen.push(`${request.kind}:${request.number}`);
              return yield* next(request);
            },
          });
          return yield* run();
        });
      });
      expect(String(output)).toContain("1 reviews");
    });

    // It saw exactly what was about to be read, and changed nothing about it.
    expect(seen).toEqual(["reviews:7"]);
  });

  it("PRR19: a terminal a handler tries to answer for performs nothing", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });
    const remote = yield* useBareRemote(REMOTE);
    const base = composed(remote, host);
    const document = published(
      `<PullRequest.Reviews number={7} as="reviews" />`,
      "",
      "{reviews.length} reviews",
    );

    /** Each attack, and the request its handler hands back instead. */
    const attacks: Record<string, (issued: PullRequestReadRequest) => PullRequestReadRequest> = {
      // A copy carrying the same members. Structural equality is not identity,
      // and two invocations on one number produce equal requests.
      copied: (issued) => ({ ...issued }),
      // The same members with the number moved: a handler choosing which pull
      // request a document reads.
      "another subject": (issued) => ({ ...issued, number: 8 }),
      // A request rebuilt from nothing, the way a handler that had only seen
      // the retained journal could build one.
      reconstructed: (issued) => ({
        repository: { ...issued.repository },
        number: issued.number,
        kind: issued.kind,
      }),
    };

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      for (const [name, forge] of Object.entries(attacks)) {
        const database = yield* createRun();
        const failure = yield* raised(
          runWorkflowDocument(database, document, base, function* (run) {
            return yield* scoped(function* () {
              yield* PullRequestEvidence.around({
                // deno-lint-ignore require-yield
                *read([request]): Operation<PullRequestReadRequest> {
                  return forge(request);
                },
              });
              return yield* run();
            });
          }),
        );
        // Refused as a protocol failure, and refused *before* anything is sent.
        expect(`${name}: ${failure === undefined ? "performed" : "refused"}`).toBe(
          `${name}: refused`,
        );
        expect(String(failure)).toContain("not the one the engine issued");
        expect(`${name}: ${host.requests.length}`).toBe(`${name}: 0`);
      }
    });
  });

  it("PRR20: a stale request from an earlier invocation is not this one's", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
      [CONVERSATION]: { body: "[]" },
      [INLINE]: { body: "[]" },
    });
    const remote = yield* useBareRemote(REMOTE);
    const base = composed(remote, host);
    // Two invocations in one document; the handler keeps the first request and
    // returns it in place of the second.
    const document = published(
      `<PullRequest.Reviews number={7} as="reviews" />`,
      `<PullRequest.Comments number={7} as="comments" />`,
    );

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      let held: PullRequestReadRequest | undefined;
      const failure = yield* raised(
        runWorkflowDocument(database, document, base, function* (run) {
          return yield* scoped(function* () {
            yield* PullRequestEvidence.around({
              // deno-lint-ignore require-yield
              *read([request]): Operation<PullRequestReadRequest> {
                held ??= request;
                return held;
              },
            });
            return yield* run();
          });
        }),
      );

      // The first invocation is answered with its own request and reads. The
      // second is handed the first's, which is not the object minted for it.
      expect(String(failure)).toContain("not the one the engine issued");
      expect(host.requests.map((request) => new URL(request.url).pathname)).toEqual([REVIEWS]);
    });
  });

  it("PRR21: the route reached under its own name from another copy is still request-only", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });
    const remote = yield* useBareRemote(REMOTE);
    const base = composed(remote, host);
    const document = published(
      `<PullRequest.Reviews number={7} as="reviews" />`,
      "",
      "{reviews.length} reviews",
    );

    // A second copy of the Api, built from the published name rather than
    // imported — what a separately loaded copy of this package reaches, and
    // what anything that read the name off the wire could build.
    const reconstructed = createApi<PullRequestEvidenceApi>(PULL_REQUEST_EVIDENCE_API, {
      // deno-lint-ignore require-yield
      *read(request: PullRequestReadRequest): Operation<PullRequestReadRequest> {
        return request;
      },
    });

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runWorkflowDocument(database, document, base, function* (run) {
        return yield* scoped(function* () {
          yield* reconstructed.around({
            *read([request], next): Operation<PullRequestReadRequest> {
              // It reaches the same cell — the handler runs — and still has
              // nothing to answer with but a request.
              return yield* next(request);
            },
          });
          return yield* run();
        });
      });
      expect(String(output)).toContain("1 reviews");
    });
  });

  it("PRR22: a read that could not be completed retains nothing to replay", function* () {
    const failing = server({ [REVIEWS]: { status: 500, body: "{}" } });
    const remote = yield* useBareRemote(REMOTE);
    const document = published(
      `<PullRequest.Reviews number={7} as="reviews" />`,
      "",
      "{reviews.length} reviews",
    );

    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const refused = yield* raised(
        runWorkflowDocument(database, document, composed(remote, failing)),
      );
      expect(String(refused)).toContain("did not answer with the complete collection");

      // The failure is retained, as every durable effect's outcome is. What is
      // not retained is a list: there is no evidence array in the journal for a
      // collection nobody finished reading, so nothing can restore a partial
      // one and call it what the pull request holds.
      const retained = yield* reads(database);
      expect(retained).toHaveLength(1);
      const outcome = retained[0]?.result;
      // A failure, not a value: the entry carries the refusal and no `value` at
      // all, so there is no array anywhere for a continuation to restore and
      // call what the pull request holds.
      expect(outcome?.status).toBe("err");
      expect(outcome && "value" in outcome).toBe(false);
    });
  });

  it("PRR23: a different question is a different effect, named and retained apart", function* () {
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
      [`/repos/octo/project/pulls/8/reviews`]: {
        body: JSON.stringify(
          [2, 3].map((id) => ({
            ...(review(id, "CHANGES_REQUESTED", "not yet") as Record<string, unknown>),
            pull_request_url: `${ENDPOINT}/repos/octo/project/pulls/8`,
          })),
        ),
      },
    });
    const remote = yield* useBareRemote(REMOTE);
    const options = composed(remote, host);

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      // Both reads in one document, so they are two invocations of the same
      // component asking two different questions.
      const output = yield* runWorkflowDocument(
        database,
        published(
          `<PullRequest.Reviews number={7} as="seven" />`,
          `<PullRequest.Reviews number={8} as="eight" />`,
          "",
          "{seven.length} then {eight.length}",
        ),
        options,
      );
      expect(String(output)).toContain("1 then 2");

      // Two retained reads, and the number is in both the fingerprint and the
      // input — so neither could restore the other's answer.
      const retained = yield* reads(database);
      expect(retained).toHaveLength(2);
      const inputs = retained.map((event) =>
        event.type === "yield" ? event.description.input : undefined,
      );
      expect(inputs.map((input) => (isJsonObject(input) ? input.number : undefined))).toEqual([
        7, 8,
      ]);
      const names = retained.map((event) =>
        event.type === "yield" ? String(event.description.name) : "",
      );
      expect(names[0]).not.toBe(names[1]);
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

    const remote = yield* useBareRemote(REMOTE);
    const base = composed(remote, host);
    const options = { ...base, composition: { ...base.composition, gitHub: counted } };

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* runWorkflowDocument(
        database,
        published(`<PullRequest.Reviews number={7} as="reviews" />`),
        options,
      );
    });

    // One session for the read, and it is closed before the run finishes — a
    // credential held open past the invocation that acquired it is the thing
    // this boundary exists to prevent.
    expect(events).toEqual(["open", "close"]);
  });

  it("PRR25: no public Api carries evidence, so none can be answered for", function* () {
    // The structural check first: there is no operation on the public
    // composition Api that returns evidence, so there is nothing for middleware
    // to intercept. This is the shape of the defect that made the previous
    // revision bypassable.
    const operations: Record<string, unknown> = GitComposition.operations;
    expect(Object.keys(operations)).not.toContain("readPullRequestEvidence");

    // And behaviourally: middleware on that Api sees no read at all.
    const host = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
    });
    const remote = yield* useBareRemote(REMOTE);
    const base = composed(remote, host);
    const seen: string[] = [];

    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const output = yield* runWorkflowDocument(
        database,
        published(
          `<PullRequest.Reviews number={7} as="reviews" />`,
          "",
          "{reviews.length} reviews",
        ),
        base,
        function* (run) {
          return yield* scoped(function* () {
            yield* GitComposition.around({
              *upsertPullRequest([request], next) {
                seen.push("pull-request");
                return yield* next(request);
              },
            });
            return yield* run();
          });
        },
      );
      expect(String(output)).toContain("1 reviews");
    });

    // The read happened, and the public Git-host Api never carried it.
    expect(host.requests).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it("PRR26: an interruption in flight unwinds and retains no result", function* () {
    const entered = withResolvers<void>();
    const sessions: string[] = [];
    const remote = yield* useBareRemote(REMOTE);

    // A transport that reaches the wire and never comes back.
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

    const base = composed(remote, server({}));
    const document = published(
      `<PullRequest.Reviews number={7} as="reviews" />`,
      "",
      "{reviews.length} reviews",
    );

    const root = yield* useStorageRoot();
    const path = runPath(root, "release-1.4");
    yield* withStorage(root, function* () {
      const database = yield* createRun();

      // Halt the run the moment the request is on the wire.
      yield* race([
        call(function* () {
          yield* raised(
            runWorkflowDocument(database, document, {
              ...base,
              composition: { ...base.composition, gitHub: hanging },
            }),
          );
        }),
        call(function* () {
          yield* entered.operation;
        }),
      ]);

      // The session unwound with the scope that opened it.
      expect(sessions).toEqual(["open", "close"]);

      // Nothing succeeded, so nothing is retained to restore: no completed read
      // and no partial array.
      const retained = yield* reads(database);
      expect(retained.every((event) => event.result?.status !== "ok")).toBe(true);
      expect(JSON.stringify(retained)).not.toContain('"items"');

      // No root close to drop: the halt left the root open, which is what
      // makes the run continuable in the first place.

      // A continuation performs the whole collection.
      const working = server({
        [REVIEWS]: { body: JSON.stringify([review(1, "APPROVED", "ship it")]) },
      });
      const output = yield* runWorkflowDocument(database, document, composed(remote, working));
      expect(String(output)).toContain("1 reviews");
      expect(working.requests).toHaveLength(1);
    });
  });
});
