/**
 * What one REPL entry's `<PullRequest.Reviews>`, `.Comments` and `.Checks`
 * retain, and whose read is whose.
 *
 * A read needs no Repository, no checkout and no working directory, so every
 * row here installs the entry capability over a canned transport and nothing
 * else — no managed root, no bare remote, no `git`. That is itself part of the
 * contract: these identities are declared and installed for an entry that
 * holds no checkout at all.
 *
 * What the rows are about is the boundary between what the adapter decides and
 * what this entry retains. The adapter matches the request, holds it to the
 * configured ceiling and validates the target on *every* execution, including
 * the one that reopens an entry whose read is already saved; retention begins
 * after all three and holds exactly the normalized answer produced inside the
 * seam. So the rows that matter most are the ones where those two disagree: a
 * target the ceiling has since stopped authorizing, a transformation applied
 * after delegation, and two reads running at once.
 *
 * These rows carry V7, the read half of V4, and the read half of V8.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import { collect } from "@executablemd/core";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../src/deno/composition/github.ts";
// From the subpath that publishes them rather than from the source modules:
// these are public, and reaching one by relative path would bypass the export
// map the partition test holds every consumer to.
import { PullRequestAPI } from "@executablemd/git/api";
import type { PullRequestReadResult } from "@executablemd/git/api";
import { PullRequestOperations } from "../src/composition/pull-request-operations.ts";
import { parsePullRequestReadRequest } from "../src/composition/pull-request-read-records.ts";
import { replRepositoryInstallation } from "../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { PULL_REQUEST_READ } from "../src/deno/composition/pull-request-operations.ts";

const OWNER = '["executablemd.repl.issue-owner",1,"execution-pr-reads","1"]';
const OTHER_OWNER = '["executablemd.repl.issue-owner",1,"execution-pr-reads","2"]';

const ENDPOINT = "https://api.github.test";
const SUBJECT_REPO = "https://github.com/octo/project";
const SUBJECT_URL = `${SUBJECT_REPO}/pull/7`;
const OTHER_URL = `${SUBJECT_REPO}/pull/9`;
const HEAD = "a".repeat(40);

const PULL = "/repos/octo/project/pulls/7";
const REVIEWS = "/repos/octo/project/pulls/7/reviews";
const OTHER_PULL = "/repos/octo/project/pulls/9";
const OTHER_REVIEWS = "/repos/octo/project/pulls/9/reviews";

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
 * from page 1, and a row can assert that a replay asked for nothing at all.
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

/** The pull request itself, carrying what an answer is authenticated against. */
function pullRequestPayload(number = 7): string {
  return JSON.stringify({
    number,
    head: { sha: HEAD },
    base: { repo: { full_name: "octo/project" } },
  });
}

function review(id: number, pull = 7): unknown {
  return {
    id,
    user: { login: "reviewer" },
    state: "APPROVED",
    body: `review ${id}`,
    submitted_at: "2026-08-24T00:00:00Z",
    commit_id: HEAD,
    html_url: `https://github.test/pr/${pull}#r${id}`,
    pull_request_url: `${ENDPOINT}/repos/octo/project/pulls/${pull}`,
  };
}

/** One pull request with two reviews, plus a second one for the paired rows. */
function reviewing(): Server {
  return server({
    [PULL]: { body: pullRequestPayload() },
    [REVIEWS]: { body: JSON.stringify([review(1), review(2)]) },
    [OTHER_PULL]: { body: pullRequestPayload(9) },
    [OTHER_REVIEWS]: { body: JSON.stringify([review(3, 9)]) },
  });
}

interface Fixture {
  readonly root: string;
}

/** This scenario's own directory. No checkout, and no managed root. */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-pr-reads-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* provide({ root });
  });
}

function hostFiles(): FilesHandler {
  return hostFilesHandler();
}

interface Run {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  readonly refusal: string | undefined;
}

interface RunOptions {
  readonly owner?: string;
  /** What this deployment authorizes reading, when a row narrows it. */
  readonly allowed?: readonly string[];
  readonly between?: () => Operation<void>;
}

/**
 * Run one document with the entry capability installed over this transport.
 *
 * Deliberately without `root`: no managed checkout is configured, which is what
 * proves these identities need none.
 */
function run(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  host: Server,
  options: RunOptions = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return fixture.root;
        },
      },
      { at: "min" },
    );
    const files = hostFiles();
    yield* API.Files.around(
      {
        checkFilePath: ([input]) => files.checkFilePath(input),
        readTextFile: ([input]) => files.readTextFile(input),
        globFiles: ([input]) => files.globFiles(input),
        temporaryDirectory: () => files.temporaryDirectory(),
        writeTextFile: ([input]) => files.writeTextFile(input),
        deleteFile: ([input]) => files.deleteFile(input),
        ensureDirectory: ([input]) => files.ensureDirectory(input),
      },
      { at: "min" },
    );
    yield* useCompositionComponents();
    if (options.between !== undefined) {
      yield* options.between();
    }
    const installation = yield* replRepositoryInstallation(options.owner ?? OWNER, {
      pullRequests: {
        access: gitHubSource(host.access),
        configuration: {
          allowed: options.allowed === undefined ? [SUBJECT_REPO] : [...options.allowed],
        },
      },
    });
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream, includes: [fixture.root] }, [
            { admissions: [(retained) => admitReplRepositoryHistory(retained)] },
            installation,
          ]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, events: yield* stream.readAll(), refusal };
  });
}

/** Every retained evidence read this history holds. */
function reads(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === PULL_REQUEST_READ,
  );
}

/** The normalized question one retained read recorded. */
function question(event: DurableEvent) {
  return event.type === "yield"
    ? parsePullRequestReadRequest(event.description["input"])
    : undefined;
}

/** How many times this transport was asked for a reviews collection. */
function reviewCalls(host: Server): number {
  return host.requests.filter((request) => new URL(request.url).pathname.endsWith("/reviews"))
    .length;
}

/** A journal that refuses every append of one durable type. */
function refusing(inner: InMemoryStream, type: string): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === type) {
        throw new Error("the journal backend refused this append");
      }
      yield* inner.append(event);
    },
  };
}

/** A journal holding one unfinished history's events. */
function replaying(prefix: readonly DurableEvent[]): InMemoryStream {
  return new InMemoryStream(
    [...prefix].filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
}

describe("one entry's evidence reads", () => {
  it("V7a: reads a collection with no checkout, and retains the question it asked", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const first = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      stream,
      host,
    );

    expect(first.refusal).toBeUndefined();
    expect(first.output).toContain("reviewer");
    const retained = reads(first.events);
    expect(retained.length).toBe(1);
    const asked = question(retained[0]!);
    expect(asked?.url).toBe(SUBJECT_URL);
    expect(asked?.kind).toBe("reviews");
    // The owner is in the run, and the authenticated invocation in the
    // expansion. The name omits the owner, so this is where it is said.
    expect(asked?.runId).toBe(OWNER);
    expect(asked?.expansionId).not.toBe("");
  });

  it("V4a: a completed read restores without a session or a request", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const first = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      stream,
      host,
    );
    expect(first.refusal).toBeUndefined();
    expect(reviewCalls(host)).toBe(1);

    const again = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      replaying(first.events),
      host,
    );
    expect(again.refusal).toBeUndefined();
    expect(again.output).toContain("reviewer");
    // Nothing was asked of the host a second time, and no second record exists.
    expect(reviewCalls(host)).toBe(1);
    expect(reads(again.events).length).toBe(1);
  });

  it("V4b: removing the repository from the allowed list refuses a saved read", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const first = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
    );
    expect(first.refusal).toBeUndefined();
    expect(reads(first.events).length).toBe(1);

    // The ceiling is asked on every execution, including this one. The saved
    // record is history and is not erased; it is simply not reachable.
    const narrowed = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      replaying(first.events),
      host,
      { allowed: [] },
    );
    expect(narrowed.refusal).toBeDefined();
    expect(reads(narrowed.events).length).toBe(1);
    expect(reviewCalls(host)).toBe(1);
  });

  it("V7b: a denied target leaves no record and asks nothing", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const denied = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
      { allowed: ["https://github.com/octo/other"] },
    );

    expect(denied.refusal).toBeDefined();
    // A question this host was never permitted to ask is not a read that
    // failed: there is no record of it and no session was opened.
    expect(reads(denied.events).length).toBe(0);
    expect(host.requests).toEqual([]);
  });

  it("V7c: two concurrent reads keep their own question under reversed completion", function* () {
    const fixture = yield* useFixture();
    // The second pull request answers first, so the two reads complete in the
    // opposite order from the one they started in.
    const order: string[] = [];
    const inner = reviewing();
    const host: Server = {
      requests: inner.requests,
      access: {
        endpoint: inner.access.endpoint,
        token: () => inner.access.token(),
        *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
          const path = new URL(request.url).pathname;
          if (path === REVIEWS) {
            // Let the other read's walk finish first.
            yield* until(new Promise<void>((resolve) => setTimeout(resolve, 40)));
          }
          order.push(path);
          return yield* inner.access.send(request);
        },
      },
    };
    const stream = new InMemoryStream();
    const both = yield* run(
      fixture,
      [
        "<All>",
        `  <Spawn><PullRequest.Reviews url="${SUBJECT_URL}" as="first" /></Spawn>`,
        `  <Spawn><PullRequest.Reviews url="${OTHER_URL}" as="second" /></Spawn>`,
        "</All>",
        "<Json value={{ first, second }} />",
      ].join("\n"),
      stream,
      host,
      { allowed: [SUBJECT_REPO] },
    );

    expect(both.refusal).toBeUndefined();
    const retained = reads(both.events);
    expect(retained.length).toBe(2);
    const asked = retained.map((event) => question(event));
    // Each read kept its own URL and its own invocation, whichever finished
    // first: one bridge per read, so neither could answer the other.
    expect(new Set(asked.map((one) => one?.url))).toEqual(new Set([SUBJECT_URL, OTHER_URL]));
    expect(new Set(asked.map((one) => one?.expansionId)).size).toBe(2);
    for (const one of asked) {
      expect(one?.runId).toBe(OWNER);
      expect(one?.kind).toBe("reviews");
    }
    expect(order.indexOf(OTHER_REVIEWS)).toBeLessThan(order.indexOf(REVIEWS));
  });

  it("V7d: a URL transformation before admission is the question that is recorded", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const redirected = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
      {
        *between(): Operation<void> {
          yield* PullRequestOperations.around({
            *read([invocation], next): Operation<PullRequestReadResult> {
              return yield* next({ ...invocation, url: OTHER_URL });
            },
          });
        },
      },
    );

    expect(redirected.refusal).toBeUndefined();
    // The transformation changed which read was admitted, so the record says
    // the other pull request.
    expect(question(reads(redirected.events)[0]!)?.url).toBe(OTHER_URL);
  });

  it("V4c: a transformation after delegation is live, over the saved snapshot", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const document =
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n` + "<Json value={reviews} />";

    const first = yield* run(fixture, document, stream, host, {
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *read([invocation], next): Operation<PullRequestReadResult> {
            const answered = yield* next(invocation);
            return answered.kind === "reviews"
              ? { kind: "reviews", items: answered.items.slice(0, 1) }
              : answered;
          },
        });
      },
    });
    expect(first.refusal).toBeUndefined();
    // One of the two, because the handler kept one.
    expect(first.output).toContain("review 1");
    expect(first.output).not.toContain("review 2");

    // Reopening with a handler that keeps the other one: the saved provider
    // snapshot is fixed, and the composition over it is not.
    const again = yield* run(fixture, document, replaying(first.events), host, {
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *read([invocation], next): Operation<PullRequestReadResult> {
            const answered = yield* next(invocation);
            return answered.kind === "reviews"
              ? { kind: "reviews", items: answered.items.slice(1) }
              : answered;
          },
        });
      },
    });
    expect(again.refusal).toBeUndefined();
    expect(again.output).toContain("review 2");
    expect(again.output).not.toContain("review 1");
    // And nothing was asked of the host again.
    expect(reviewCalls(host)).toBe(1);
  });

  it("V4d: a synthetic read reruns and retains nothing", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const synthetic = {
      *between(): Operation<void> {
        yield* PullRequestAPI.around({
          // deno-lint-ignore require-yield
          *read(): Operation<PullRequestReadResult> {
            return { kind: "reviews", items: [] };
          },
        });
      },
    };
    const first = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
      synthetic,
    );

    expect(first.refusal).toBeUndefined();
    // A handler that never reached the seam retained nothing, and asked
    // nothing.
    expect(reads(first.events).length).toBe(0);
    expect(host.requests).toEqual([]);

    // So reopening runs it again rather than restoring it.
    const again = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      replaying(first.events),
      host,
      synthetic,
    );
    expect(again.refusal).toBeUndefined();
    expect(reads(again.events).length).toBe(0);
  });

  it("V7e: a read whose walk cannot finish binds no array", function* () {
    const fixture = yield* useFixture();
    // The collection is paged and page two is unavailable, so the walk never
    // completes. None of what it did answer is evidence that there is nothing
    // there.
    const host = server({
      [PULL]: { body: pullRequestPayload() },
      [REVIEWS]: {
        body: JSON.stringify([review(1)]),
        link: `<${ENDPOINT}${REVIEWS}?page=2>; rel="next"`,
      },
      [`${REVIEWS}?page=2`]: { status: 500, body: "{}" },
    });
    const stream = new InMemoryStream();
    const incomplete = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      stream,
      host,
    );

    expect(incomplete.refusal).toBeDefined();
    expect(incomplete.output).not.toContain("reviewer");
    // The failed read is this read's own outcome, and it holds no partial
    // array.
    const retained = reads(incomplete.events);
    expect(retained.length).toBe(1);
    expect(retained[0]?.type === "yield" && retained[0].result.status).toBe("err");
  });

  it("V8a: a refused read append binds no array", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const inner = new InMemoryStream();
    const attempt = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      refusing(inner, PULL_REQUEST_READ),
      host,
    );

    expect(attempt.refusal).toBeDefined();
    expect(attempt.output).not.toContain("reviewer");
    expect(reads(yield* inner.readAll()).length).toBe(0);
    // The read may have happened; what did not happen is a binding, and an
    // unacknowledged read can safely run again.
    expect(reviewCalls(host)).toBe(1);
  });

  it("V6a: a read saved under another owner is refused before replay", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const first = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
    );
    expect(first.refusal).toBeUndefined();

    // The same history offered to another entry. The read's name omits the
    // owner, so what refuses this is the owner in the record itself.
    const borrowed = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      replaying(first.events),
      host,
      { owner: OTHER_OWNER },
    );
    expect(borrowed.refusal).toBeDefined();
  });
});
