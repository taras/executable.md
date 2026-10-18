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
import { ensure, race, resource, scoped, sleep, spawn, until, withResolvers } from "effection";
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
import { collect, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
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
import {
  parsePullRequestReadRequest,
  parsePullRequestReadResult,
} from "../src/composition/pull-request-read-records.ts";
import type { CheckEvidence } from "../src/composition/pull-request-read-records.ts";

import { PullRequestReadExecution } from "../src/composition/pull-request-read-execution.ts";
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
  /** Registrations this row installs beside the inherited ones. */
  readonly shadowing?: readonly ComponentRegistration[];
  /** Whether this row installs the entry capability at all. */
  readonly entry?: boolean;
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
            ...(options.entry === false ? [] : [installation]),
            ...(options.shadowing === undefined
              ? []
              : [
                  {
                    *install(): Operation<void> {
                      yield* registerComponents([...(options.shadowing ?? [])]);
                    },
                  },
                ]),
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

/** The retained reads that hold a collection, as opposed to a failure. */
function settled(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield" && event.result.status === "ok");
}

/** The collection one settled read retained, read back rather than asserted. */
function collectionOf(event: DurableEvent): PullRequestReadResult | undefined {
  if (event.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  const value = event.result.value;
  return value === undefined ? undefined : parsePullRequestReadResult(value);
}

/** One check run, about whichever commit the row says it is about. */
function check(headSha: string): CheckEvidence {
  return {
    kind: "check-run",
    id: "1",
    headSha,
    name: "build",
    status: "completed",
    conclusion: "success",
    url: null,
    startedAt: null,
    completedAt: null,
    title: null,
    summary: null,
    text: null,
  };
}

/**
 * An adapter whose read opens something its own cleanup cannot close.
 *
 * It admits the read, answers through the seam — or fails there — and then its
 * teardown throws. That is the one way an attempt ends in a state its outcome
 * cannot be read from, and it is deliberately the same shape for both.
 */
function answering(answer: () => void): Operation<void> {
  return PullRequestAPI.around({
    *read([url, options]): Operation<PullRequestReadResult> {
      return yield* PullRequestReadExecution.operations.perform(
        { url, kind: options.kind, provider: options.provider },
        function* (): Operation<PullRequestReadResult> {
          yield* resource<null>(function* (provide) {
            yield* ensure(function* (): Operation<void> {
              throw new Error("the read's own cleanup failed");
            });
            yield* provide(null);
          });
          answer();
          return { kind: "reviews", items: [] };
        },
      );
    },
  });
}

/** Wait for this signal, and fail the row rather than hang if it never comes. */
function* within(signal: Operation<void>, sentence: string): Operation<void> {
  yield* race([
    signal,
    (function* (): Operation<never> {
      yield* sleep(30_000);
      throw new Error(sentence);
    })(),
  ]);
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

  it("V7f: a paged collection is retained whole, and restores whole", function* () {
    const fixture = yield* useFixture();
    // Two pages, so the answer is only complete once the walk has finished
    // both. Nothing partial may be retained as the collection.
    const host = server({
      [PULL]: { body: pullRequestPayload() },
      [REVIEWS]: {
        body: JSON.stringify([review(1)]),
        link: `<${ENDPOINT}${REVIEWS}?page=2>; rel="next"`,
      },
      [`${REVIEWS}?page=2`]: { body: JSON.stringify([review(2)]) },
    });
    const document = `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`;
    const stream = new InMemoryStream();
    const walked = yield* run(fixture, document, stream, host);

    expect(walked.refusal).toBeUndefined();
    expect(walked.output).toContain("review 1");
    expect(walked.output).toContain("review 2");
    const retained = reads(walked.events);
    expect(retained.length).toBe(1);
    expect(collectionOf(retained[0]!)?.items.length).toBe(2);
    expect(reviewCalls(host)).toBe(2);

    // And the whole collection comes back without walking a page.
    const again = yield* run(fixture, document, replaying(walked.events), host);
    expect(again.refusal).toBeUndefined();
    expect(again.output).toContain("review 1");
    expect(again.output).toContain("review 2");
    expect(reviewCalls(host)).toBe(2);
  });

  it("V7g: an answer about another subject is refused before any success", function* () {
    const fixture = yield* useFixture();
    // The collection answers with a review belonging to pull request 9 while
    // the read asked about 7. The adapter checks the subject it was handed
    // rather than accepting it, so this never reaches retention as an answer.
    const host = server({
      [PULL]: { body: pullRequestPayload() },
      [REVIEWS]: { body: JSON.stringify([review(1, 9)]) },
    });
    const stream = new InMemoryStream();
    const wrong = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      stream,
      host,
    );

    expect(wrong.refusal).toBeDefined();
    expect(wrong.output).not.toContain("review 1");
    const retained = reads(wrong.events);
    expect(settled(retained)).toEqual([]);
    expect(retained.length).toBe(1);
    expect(retained[0]?.type === "yield" && retained[0].result.status).toBe("err");
  });

  it("V7h: a checks answer about another commit is refused before any success", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    // An adapter that admitted the read and then answered with an envelope for
    // one head holding a check about another. The entry owns what happens
    // after the seam, so this is its refusal to make: an envelope that is two
    // answers at once says nothing certain about either commit.
    const inconsistent = yield* run(
      fixture,
      `<PullRequest.Checks url="${SUBJECT_URL}" as="checks" />\n<Json value={checks} />`,
      stream,
      host,
      {
        *between(): Operation<void> {
          yield* PullRequestAPI.around({
            *read([url, options]): Operation<PullRequestReadResult> {
              return yield* PullRequestReadExecution.operations.perform(
                { url, kind: options.kind, provider: options.provider },
                // deno-lint-ignore require-yield
                function* (): Operation<PullRequestReadResult> {
                  return { kind: "checks", headSha: HEAD, items: [check("b".repeat(40))] };
                },
              );
            },
          });
        },
      },
    );

    expect(inconsistent.refusal).toBeDefined();
    expect(inconsistent.output).not.toContain("build");
    const retained = reads(inconsistent.events);
    // Refused before success: the position holds this read's own failure and
    // no collection at all.
    expect(settled(retained)).toEqual([]);
    expect(retained.length).toBe(1);
  });

  it("V7i: a duplicate admitted handoff and a stale one each run no second read", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    // A middleware above the entry's own policy that offers the same admitted
    // read twice. The first handoff is this read's; the second would retain a
    // second answer under one identity.
    const duplicated = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
      {
        *between(): Operation<void> {
          yield* PullRequestReadExecution.around({
            *perform([admitted, transport], next): Operation<PullRequestReadResult> {
              yield* next(admitted, transport);
              return yield* next(admitted, transport);
            },
          });
        },
      },
    );

    expect(duplicated.refusal).toBeDefined();
    expect(reads(duplicated.events).length).toBe(1);
    // The second handoff asked the host nothing: it was refused before a
    // session or a record existed.
    expect(reviewCalls(host)).toBe(1);

    // And one offered while the read that owns it is already unwinding reaches
    // the same refusal, from the other guard.
    const late = reviewing();
    const stale = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      new InMemoryStream(),
      late,
      {
        *between(): Operation<void> {
          yield* PullRequestReadExecution.around({
            *perform([admitted, transport], next): Operation<PullRequestReadResult> {
              const answered = yield* next(admitted, transport);
              // Registered in the read's own scope, so it runs while the
              // bridge is still installed and the read that installed it has
              // finished.
              yield* ensure(function* (): Operation<void> {
                yield* next(admitted, transport);
              });
              return answered;
            },
          });
        },
      },
    );

    expect(stale.refusal).toBeDefined();
    expect(reviewCalls(late)).toBe(1);
  });

  it("V7j: the final answer is validated after outer middleware, before it binds", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    // The provider answers soundly and a handler above the entry rewrites what
    // it answered: same envelope head, an item about another commit. Each item
    // is well formed on its own, so the element's own return contract accepts
    // it — the question it cannot ask is whether the collection agrees with
    // the head it was read at, and that is this boundary's to ask.
    const rewritten = yield* run(
      fixture,
      `<PullRequest.Checks url="${SUBJECT_URL}" as="checks" />\n<Json value={checks} />`,
      stream,
      host,
      {
        *between(): Operation<void> {
          yield* PullRequestOperations.around({
            *read([invocation], next): Operation<PullRequestReadResult> {
              const answered = yield* next(invocation);
              return answered.kind === "checks"
                ? { kind: "checks", headSha: answered.headSha, items: [check("b".repeat(40))] }
                : answered;
            },
          });
          yield* PullRequestAPI.around({
            *read([url, options]): Operation<PullRequestReadResult> {
              return yield* PullRequestReadExecution.operations.perform(
                { url, kind: options.kind, provider: options.provider },
                // deno-lint-ignore require-yield
                function* (): Operation<PullRequestReadResult> {
                  return { kind: "checks", headSha: HEAD, items: [check(HEAD)] };
                },
              );
            },
          });
        },
      },
    );

    expect(rewritten.refusal).toBeDefined();
    expect(rewritten.output).not.toContain("build");
    // What the provider answered was retained, and it is sound; what the
    // handler made of it never became a binding.
    const retained = reads(rewritten.events);
    expect(retained.length).toBe(1);
    const collection = collectionOf(retained[0]!);
    expect(collection?.kind === "checks" && collection.headSha).toBe(HEAD);
    expect(collection?.items.length).toBe(1);
  });

  it("V8b: cancelling a blocked read publishes nothing and joins its cleanup", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const reached = withResolvers<void>();
    const held = withResolvers<void>();
    const session = { opened: false, released: false };
    const stream = new InMemoryStream();

    yield* scoped(function* (): Operation<void> {
      const task = yield* spawn(() =>
        run(fixture, `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`, stream, host, {
          *between(): Operation<void> {
            yield* PullRequestAPI.around({
              *read([url, options]): Operation<PullRequestReadResult> {
                return yield* PullRequestReadExecution.operations.perform(
                  { url, kind: options.kind, provider: options.provider },
                  function* (): Operation<PullRequestReadResult> {
                    yield* resource<null>(function* (provide) {
                      session.opened = true;
                      yield* ensure(() => {
                        session.released = true;
                      });
                      yield* provide(null);
                    });
                    reached.resolve();
                    yield* held.operation;
                    return { kind: "reviews", items: [] };
                  },
                );
              },
            });
          },
        }),
      );
      yield* within(reached.operation, "the read never opened its session");
      const halting = yield* spawn(() => task.halt());
      held.resolve();
      yield* halting;
    });

    // The session this read opened was released, and the halt waited for it.
    expect(session.opened).toBe(true);
    expect(session.released).toBe(true);
    const events = yield* stream.readAll();
    // An interrupted read invented no outcome, so it is repeatable.
    expect(reads(events).length).toBe(0);
    expect(events.filter((event) => event.type === "close")).toEqual([]);
  });

  it("V8c: cancelling a read still acquiring its session releases it", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const reached = withResolvers<void>();
    const held = withResolvers<void>();
    const session = { opened: false, released: false };
    const stream = new InMemoryStream();

    yield* scoped(function* (): Operation<void> {
      const task = yield* spawn(() =>
        run(fixture, `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`, stream, host, {
          *between(): Operation<void> {
            yield* PullRequestAPI.around({
              *read([url, options]): Operation<PullRequestReadResult> {
                return yield* PullRequestReadExecution.operations.perform(
                  { url, kind: options.kind, provider: options.provider },
                  function* (): Operation<PullRequestReadResult> {
                    // Still being acquired when the halt arrives: the delivery
                    // this scope is owed has not happened yet. Its release is
                    // registered before it blocks, because a registration made
                    // after a halt has begun is not one the scope will honour.
                    yield* resource<null>(function* (provide) {
                      yield* ensure(() => {
                        session.released = true;
                      });
                      reached.resolve();
                      yield* held.operation;
                      session.opened = true;
                      yield* provide(null);
                    });

                    return { kind: "reviews", items: [] };
                  },
                );
              },
            });
          },
        }),
      );
      yield* within(reached.operation, "the read never began acquiring its session");
      const halting = yield* spawn(() => task.halt());
      held.resolve();
      yield* halting;
    });

    // The acquisition finished after the halt began, and the halt did not
    // settle until what it delivered was released.
    expect(session.opened).toBe(true);
    expect(session.released).toBe(true);
    const events = yield* stream.readAll();
    expect(reads(events).length).toBe(0);
    expect(events.filter((event) => event.type === "close")).toEqual([]);
  });

  it("V8d: a cleanup that throws after a successful read publishes nothing", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const failing = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      stream,
      host,
      { between: () => answering(() => undefined) },
    );

    expect(failing.refusal).toBeDefined();
    expect(failing.output).not.toContain("reviewer");
    // The read answered, but the attempt that produced the answer did not
    // finish. Nothing is acknowledged for a position whose work is in an
    // unknown state.
    expect(reads(failing.events).length).toBe(0);
    expect(failing.events.filter((event) => event.type === "close")).toEqual([]);
  });

  it("V8e: a cleanup that throws after an expected failure publishes nothing", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const failing = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />\n<Json value={reviews} />`,
      stream,
      host,
      {
        between: () =>
          answering(() => {
            throw new Error("the collection could not be read");
          }),
      },
    );

    expect(failing.refusal).toBeDefined();
    // The read's own failure would have been retained had the attempt ended
    // cleanly. It did not, so this position holds nothing rather than a
    // failure whose cleanup is unaccounted for.
    expect(reads(failing.events).length).toBe(0);
    expect(failing.events.filter((event) => event.type === "close")).toEqual([]);
  });

  it("V6c: a failed read saved under another owner is refused before replay", function* () {
    const fixture = yield* useFixture();
    // A walk that cannot finish, so what the history holds at that position is
    // a failed read: no collection, and a description that still says who
    // asked.
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
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
    );
    expect(incomplete.refusal).toBeDefined();
    const retained = reads(incomplete.events);
    expect(retained.length).toBe(1);
    expect(retained[0]?.type === "yield" && retained[0].result.status).toBe("err");

    // Offered to another entry. A failure retains no result to hold to
    // anything, and its description is still held to this entry's owner.
    const borrowed = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      replaying(incomplete.events),
      host,
      { owner: OTHER_OWNER },
    );
    expect(borrowed.refusal).toBeDefined();
    expect(borrowed.refusal).toContain("written under another owner");
  });

  it("V6e: a saved read whose configuration is not its question's is refused", function* () {
    const fixture = yield* useFixture();
    const host = reviewing();
    const stream = new InMemoryStream();
    const document = `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`;
    const first = yield* run(fixture, document, stream, host);
    expect(first.refusal).toBeUndefined();

    // A description carries the configuration beside the name, and the engine's
    // own divergence policy reads it. One edited to say another question was
    // asked is a record that does not describe the read beside it, however
    // correct its name and its value are.
    const edited = first.events.map((event) =>
      event.type === "yield" && event.description.type === PULL_REQUEST_READ
        ? {
            ...event,
            description: { ...event.description, configuration: "another-question" },
          }
        : event,
    );
    const resumed = yield* run(fixture, document, replaying(edited), host);
    expect(resumed.refusal).toBeDefined();
    expect(resumed.refusal).toContain("configuration");
    // Refused before replay, so the read was never performed again either.
    expect(reviewCalls(host)).toBe(1);
  });

  it("V9b: the entry's components are ordinary registrations over a kept one", function* () {
    const fixture = yield* useFixture();

    // The first-party registration is kept: this entry's own component is an
    // ordinary registration in the scope the execution mints for it, shadowing
    // the inherited one rather than replacing or retiring it. So a host that
    // registers the same name in the *inherited* scope is refused by the
    // ordinary rule, with no special precedence anywhere.
    const collided = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      new InMemoryStream(),
      reviewing(),
      {
        shadowing: [
          {
            name: "PullRequest.Reviews",
            origin: "test",
            props: { type: "object", additionalProperties: true },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return "shadowed";
            },
          },
        ],
      },
    );
    expect(collided.refusal).toContain("Register the name once per scope");

    // And the kept registration has no identity authenticator of its own: with
    // the entry capability not installed at all, the same element reaches the
    // ordinary missing-provider refusal and retains nothing.
    const host = reviewing();
    const stream = new InMemoryStream();
    const kept = yield* run(
      fixture,
      `<PullRequest.Reviews url="${SUBJECT_URL}" as="reviews" />`,
      stream,
      host,
      { entry: false },
    );
    expect(kept.refusal).toBeDefined();
    expect(reads(yield* stream.readAll()).length).toBe(0);
    expect(host.requests).toEqual([]);
  });
});
