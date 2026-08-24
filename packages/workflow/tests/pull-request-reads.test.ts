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
import type { Operation } from "effection";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import { dropRootClose } from "./support/replay.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { raised, runWorkflowDocument } from "./support/composition.ts";
import { fixture, published, REMOTE } from "./support/pull-requests.ts";
import type { BareRemote } from "./support/git-remotes.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import { readPullRequestEvidence } from "../src/deno/composition/pull-request-evidence.ts";
import type { EvidenceReading } from "../src/deno/composition/pull-request-evidence.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
  GitHubRepositoryName,
} from "../src/deno/composition/github.ts";

const ENDPOINT = "https://api.github.test";
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

function review(id: number, state: string, body: string): unknown {
  return {
    id,
    user: { login: "reviewer" },
    state,
    body,
    submitted_at: "2026-08-24T00:00:00Z",
    commit_id: HEAD,
    html_url: `https://github.test/pr/7#r${id}`,
  };
}

function read(server: Server, kind: "reviews" | "comments" | "checks"): Operation<EvidenceReading> {
  return readPullRequestEvidence(server.access, NAME, 7, kind);
}

/** The discriminator, for the two collections that carry one. */
function kinds(reading: EvidenceReading): string[] {
  return reading.state === "read"
    ? reading.evidence.map((item) => ("kind" in item ? item.kind : "review-evidence"))
    : [];
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
          },
        ]),
      },
      [PULL]: { body: JSON.stringify({ number: 7, head: { sha: HEAD } }) },
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
              details_url: "https://github.test/run/4",
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
    expect(reviews.state === "read" && reviews.evidence).toEqual([
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
    expect(
      comments.state === "read" &&
        comments.evidence.every((item) => "body" in item && item.body === body),
    ).toBe(true);

    const checks = yield* read(host, "checks");
    expect(checks.state === "read" && checks.headSha).toBe(HEAD);
    expect(kinds(checks)).toEqual(["check-run", "commit-status"]);
    // `error` is a commit-status word and stays one. Mapped onto `failure` it
    // would tell a reviewer a check ran and failed.
    const status = checks.state === "read" ? checks.evidence[1] : undefined;
    expect(status && "state" in status && status.state).toBe("error");
    expect(status && "description" in status && status.description).toBe(body);
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
    expect(reading.state === "read" && reading.evidence.map((item) => item.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(host.requests).toHaveLength(3);
  });

  it("PRR5: a completed empty collection binds [], and checks still name the head", function* () {
    const host = server({
      [REVIEWS]: { body: "[]" },
      [PULL]: { body: JSON.stringify({ number: 7, head: { sha: HEAD } }) },
      [RUNS]: { body: JSON.stringify({ total_count: 0, check_runs: [] }) },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });

    const reviews = yield* read(host, "reviews");
    expect(reviews.state).toBe("read");
    expect(reviews.state === "read" && reviews.evidence).toEqual([]);

    const checks = yield* read(host, "checks");
    expect(checks.state).toBe("read");
    expect(checks.state === "read" && checks.evidence).toEqual([]);
    // An empty array that still says which revision it is empty about.
    expect(checks.state === "read" && checks.headSha).toBe(HEAD);
  });

  it("PRR6: every unreadable answer is unavailable, and none of them truncates", function* () {
    const first = JSON.stringify([review(1, "COMMENTED", "one")]);
    const cases: Record<string, Answer> = {
      transport: { body: "" },
      "rate limit": { status: 403, body: "{}" },
      "auth failure": { status: 401, body: "{}" },
      "ambiguous 404": { status: 404, body: "{}" },
      "malformed json": { body: "{not json" },
      "not an array": { body: JSON.stringify({ reviews: [] }) },
    };
    for (const [name, answer] of Object.entries(cases)) {
      const host = server({ [REVIEWS]: answer });
      const reading = yield* read(host, "reviews");
      expect(`${name}: ${reading.state}`).toBe(`${name}: unavailable`);
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
      [PULL]: { body: JSON.stringify({ number: 8, head: { sha: HEAD } }) },
    });
    expect((yield* read(wrongNumber, "checks")).state).toBe("unavailable");

    // It answers for another repository.
    const wrongRepository = server({
      [PULL]: {
        body: JSON.stringify({
          number: 7,
          head: { sha: HEAD },
          base: { repo: { full_name: "someone/else" } },
        }),
      },
    });
    expect((yield* read(wrongRepository, "checks")).state).toBe("unavailable");

    // A check run naming a head other than the one this read is about.
    const wrongHead = server({
      [PULL]: { body: JSON.stringify({ number: 7, head: { sha: HEAD } }) },
      [RUNS]: {
        body: JSON.stringify({
          check_runs: [{ id: 1, head_sha: "b".repeat(40), name: "x", status: "completed" }],
        }),
      },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });
    expect((yield* read(wrongHead, "checks")).state).toBe("unavailable");

    // A combined status answering for another commit.
    const wrongStatusSha = server({
      [PULL]: { body: JSON.stringify({ number: 7, head: { sha: HEAD } }) },
      [RUNS]: { body: JSON.stringify({ check_runs: [] }) },
      [STATUS]: { body: JSON.stringify({ sha: "c".repeat(40), statuses: [] }) },
    });
    expect((yield* read(wrongStatusSha, "checks")).state).toBe("unavailable");
  });

  it("PRR8: a value outside a frozen enum, or a missing field, is refused", function* () {
    const unknownReviewState = server({
      [REVIEWS]: { body: JSON.stringify([review(1, "ESCALATED", "one")]) },
    });
    expect((yield* read(unknownReviewState, "reviews")).state).toBe("unavailable");

    const missingBody = server({
      [REVIEWS]: {
        body: JSON.stringify([
          { id: 1, user: { login: "r" }, state: "COMMENTED", html_url: "https://github.test/x" },
        ]),
      },
    });
    expect((yield* read(missingBody, "reviews")).state).toBe("unavailable");

    const unknownRunStatus = server({
      [PULL]: { body: JSON.stringify({ number: 7, head: { sha: HEAD } }) },
      [RUNS]: {
        body: JSON.stringify({ check_runs: [{ id: 1, name: "x", status: "napping" }] }),
      },
      [STATUS]: { body: JSON.stringify({ sha: HEAD, statuses: [] }) },
    });
    expect((yield* read(unknownRunStatus, "checks")).state).toBe("unavailable");

    const unknownStatusState = server({
      [PULL]: { body: JSON.stringify({ number: 7, head: { sha: HEAD } }) },
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
    expect((yield* read(unknownStatusState, "checks")).state).toBe("unavailable");
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
          },
          review(2, "APPROVED", "looks right"),
        ]),
      },
    });

    const reading = yield* read(host, "reviews");
    expect(reading.state).toBe("read");
    // Both survive: one pending review must not cost the reviewer every other
    // review in the collection.
    expect(reading.state === "read" && reading.evidence).toHaveLength(2);
    const pending = reading.state === "read" ? reading.evidence[0] : undefined;
    expect(pending && "state" in pending && pending.state).toBe("pending");
    expect(pending && "submittedAt" in pending && pending.submittedAt).toBe(null);
    expect(pending && "commitSha" in pending && pending.commitSha).toBe(null);
    // A deleted account is an absent author, not an unreadable item.
    expect(pending && "author" in pending && pending.author).toBe(null);
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
      [PULL]: { body: JSON.stringify({ number: 7, head: { sha: HEAD } }) },
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
});
