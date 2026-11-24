/**
 * What `<PullRequest.Checks watch>` waits for in one REPL entry, and what it
 * binds, retains and restores (specs/workflow-workspace-spec.md §7.7.1).
 *
 * Every row runs a document through canonical execution with the production
 * entry capability installed, against a GitHub model behind a real loopback
 * listener the shipped transport reaches over HTTP. Time is the one thing a row
 * controls directly: the watch reads its clock through `PullRequestWatchClock`,
 * and the clock here only moves when the row advances it, so every poll, retry
 * and deadline lands exactly where the row says.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  each,
  ensure,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  useScope,
  withResolvers,
} from "effection";
import type { Operation, Task } from "effection";
import { fromReadable } from "@effectionx/node";
import { once } from "@effectionx/node/events";
import { rm, writeTextFile } from "@effectionx/fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, realpath } from "node:fs/promises";
import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { collect, DocumentOutput, Elicitation } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { PullRequestWatchClock } from "@executablemd/git/api";
import { useCompositionComponents } from "@executablemd/git";
import {
  PULL_REQUEST_CHECKS_WATCH_DEADLINE,
  PULL_REQUEST_CHECKS_WATCH_HEAD,
  PULL_REQUEST_CHECKS_WATCH_RESULT,
  PULL_REQUEST_READ,
} from "@executablemd/git/deno";
import { replRepositoryInstallation } from "../src/repl/repositories/deno/provider.ts";
import { admitReplRepositoryHistory } from "../src/repl/repositories/admission.ts";
import { gitHubStore, respond } from "../../git/tests/support/github.ts";
import type { GitHubStore } from "../../git/tests/support/github.ts";

const REPL_GITHUB_BASE = "XMD_REPL_GITHUB_BASE_URL";
const OWNER = '["executablemd.repl.issue-owner",1,"execution-checks-watch","1"]';
const TOKEN = "github-credential-for-this-test";
const URL_1 = "https://github.com/owner/repository/pull/1";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const START = Date.UTC(2026, 10, 23, 12);
// The cadence the workflow workspace spec states, held here rather than read
// from the implementation so a changed interval fails this suite.
const CHECK_WATCH_POLL_MS = 10_000;
const CHECK_WATCH_RETRY_MS = 5_000;

/** One request the modeled GitHub receives. */
interface GitHubHttpRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** What the modeled CI reports for whichever head is asked about. */
interface Ci {
  runs: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
  /** A status every check route answers with instead of its collection. */
  refuses?: number;
  /** Answer check runs with a first page whose next page fails. */
  partial?: boolean;
  /** A status the pull request itself answers with instead of its record. */
  pullRefuses?: number;
  /** Called before a request is answered; a row holds or rewrites state here. */
  before?: (request: GitHubHttpRequest) => Operation<void>;
}

interface Fixture {
  readonly root: string;
  readonly store: GitHubStore;
  readonly ci: Ci;
  readonly endpoint: string;
  readonly clock: TestClock;
  /** Requests currently being answered, so a row can see one in flight. */
  readonly inFlight: { count: number; closed: number };
}

/** A clock that moves only when a row moves it. */
interface TestClock {
  now: number;
  readonly waiters: { at: number; wake: () => void }[];
  /** Resolves once some waiter matches. */
  waitFor(match: (at: number) => boolean): Operation<number>;
  /** Move to `at`, waking every waiter at or before it. */
  advanceTo(at: number): void;
  /** Add a waiter, answering how to remove it. */
  register(at: number, wake: () => void): () => void;
}

function testClock(start: number): TestClock {
  let changed = withResolvers<void>();
  const clock: TestClock = {
    now: start,
    waiters: [],
    *waitFor(match) {
      for (;;) {
        const found = clock.waiters.find((waiter) => match(waiter.at));
        if (found !== undefined) {
          return found.at;
        }
        yield* race([
          changed.operation,
          (function* (): Operation<never> {
            yield* sleep(30_000);
            throw new Error("the watch never slept where this row expected it to");
          })(),
        ]);
      }
    },
    advanceTo(at) {
      clock.now = at;
      for (const waiter of clock.waiters.filter((candidate) => candidate.at <= at)) {
        waiter.wake();
      }
    },
    register(at, wake) {
      const waiter = { at, wake };
      clock.waiters.push(waiter);
      const previous = changed;
      changed = withResolvers<void>();
      previous.resolve();
      return () => {
        const index = clock.waiters.indexOf(waiter);
        if (index >= 0) {
          clock.waiters.splice(index, 1);
        }
      };
    },
  };
  return clock;
}

function* installClock(clock: TestClock): Operation<void> {
  yield* PullRequestWatchClock.around(
    {
      // deno-lint-ignore require-yield
      *now(): Operation<number> {
        return clock.now;
      },
      *sleep([milliseconds]: [number]): Operation<void> {
        const woken = withResolvers<void>();
        const remove = clock.register(clock.now + milliseconds, () => woken.resolve());
        try {
          yield* woken.operation;
        } finally {
          remove();
        }
      },
    },
    { at: "min" },
  );
}

function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-watch-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const store = gitHubStore({
      owner: "owner",
      repository: "repository",
      token: TOKEN,
      pullRequests: [
        {
          nodeId: "PR_kwDOA",
          number: 1,
          state: "open",
          title: "Prepare 1.4",
          body: "Ready for review.",
          draft: false,
          headRef: "review/1.4",
          headSha: HEAD,
          baseRef: "main",
          baseSha: "c".repeat(40),
        },
      ],
    });
    const ci: Ci = { runs: [], statuses: [] };
    const inFlight = { count: 0, closed: 0 };
    const endpoint = yield* useGitHub(store, ci, inFlight);
    const before = process.env["GH_TOKEN"];
    process.env["GH_TOKEN"] = TOKEN;
    yield* ensure(() => {
      if (before === undefined) {
        delete process.env["GH_TOKEN"];
      } else {
        process.env["GH_TOKEN"] = before;
      }
    });
    yield* provide({ root, store, ci, endpoint, clock: testClock(START), inFlight });
  });
}

/** The modeled GitHub: the shared pull-request model, and this suite's CI routes. */
function useGitHub(
  store: GitHubStore,
  ci: Ci,
  inFlight: { count: number; closed: number },
): Operation<string> {
  return resource<string>(function* (provide) {
    const base = { endpoint: "" };
    const scope = yield* useScope();
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      inFlight.count += 1;
      scope.run(function* (): Operation<void> {
        yield* spawn(function* (): Operation<void> {
          yield* once(incoming.socket, "close");
          inFlight.closed += 1;
        });
        try {
          const chunks: Uint8Array[] = [];
          for (const chunk of yield* each(fromReadable(incoming))) {
            chunks.push(chunk);
            yield* each.next();
          }
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(incoming.headers)) {
            headers[name === "authorization" ? "Authorization" : name] = String(value);
          }
          const request: GitHubHttpRequest = {
            method: "GET",
            url: `${base.endpoint}${incoming.url ?? "/"}`,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          if (ci.before !== undefined) {
            yield* ci.before(request);
          }
          const pull = /\/pulls\/[1-9][0-9]*$/.test(new URL(request.url).pathname);
          const answer =
            pull && ci.pullRefuses !== undefined
              ? { status: ci.pullRefuses, body: JSON.stringify({ message: "Server Error" }) }
              : (checksAnswer(store, ci, request) ?? respond(store, request));
          outgoing.writeHead(answer.status, {
            "content-type": "application/json",
            ...(answer.link === undefined ? {} : { link: answer.link }),
          });
          outgoing.end(answer.body);
        } finally {
          inFlight.count -= 1;
        }
      });
    });
    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* (): Operation<void> {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    base.endpoint = `http://127.0.0.1:${listeningPort(server.address())}`;
    yield* provide(base.endpoint);
  });
}

function listeningPort(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") {
    throw new Error("this listener reported no address with a port");
  }
  return address.port;
}

function checksAnswer(
  store: GitHubStore,
  ci: Ci,
  request: GitHubHttpRequest,
): { status: number; body: string; link?: string } | undefined {
  const url = new URL(request.url);
  const prefix = `/repos/${store.owner}/${store.repository}/commits/`;
  if (!url.pathname.startsWith(prefix)) {
    return undefined;
  }
  store.requests.push(request);
  if (request.headers["Authorization"] !== `Bearer ${TOKEN}`) {
    return { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
  }
  if (ci.refuses !== undefined) {
    return { status: ci.refuses, body: JSON.stringify({ message: "Server Error" }) };
  }
  const runs = /^([0-9a-f]+)\/check-runs$/.exec(url.pathname.slice(prefix.length));
  if (runs !== null && ci.partial === true) {
    if (url.searchParams.get("page") === "2") {
      return { status: 502, body: JSON.stringify({ message: "Bad Gateway" }) };
    }
    const next = new URL(url);
    next.searchParams.set("page", "2");
    return {
      status: 200,
      link: `<${next.href}>; rel="next"`,
      body: JSON.stringify({
        total_count: ci.runs.length + 1,
        check_runs: ci.runs.map((item) => ({ head_sha: runs[1], ...item })),
      }),
    };
  }
  if (runs !== null) {
    return {
      status: 200,
      body: JSON.stringify({
        total_count: ci.runs.length,
        check_runs: ci.runs.map((item) => ({ head_sha: runs[1], ...item })),
      }),
    };
  }
  const combined = /^([0-9a-f]+)\/status$/.exec(url.pathname.slice(prefix.length));
  if (combined !== null) {
    return { status: 200, body: JSON.stringify({ sha: combined[1], statuses: ci.statuses }) };
  }
  return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
}

function checkRun(id: number, name: string, status: string, conclusion: string | null) {
  return {
    id,
    name,
    status,
    conclusion,
    html_url: `https://github.com/owner/repository/runs/${id}`,
    started_at: "2026-11-23T12:00:00Z",
    completed_at: status === "completed" ? "2026-11-23T12:05:00Z" : null,
    output: { title: name, summary: `${name} ${conclusion ?? status}`, text: null },
  };
}

function commitStatus(id: number, context: string, state: string) {
  return {
    id,
    context,
    state,
    description: `CI is ${state}`,
    target_url: `https://github.com/owner/repository/actions/runs/${id}`,
    created_at: "2026-11-23T12:00:00Z",
    updated_at: "2026-11-23T12:01:00Z",
  };
}

/** The check-run record a run above becomes, whole. */
function runRecord(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  head = HEAD,
) {
  return {
    kind: "check-run",
    id: String(id),
    headSha: head,
    name,
    status,
    conclusion,
    url: `https://github.com/owner/repository/runs/${id}`,
    startedAt: "2026-11-23T12:00:00Z",
    completedAt: status === "completed" ? "2026-11-23T12:05:00Z" : null,
    title: name,
    summary: `${name} ${conclusion ?? status}`,
    text: null,
  };
}

function statusRecord(id: number, context: string, state: string, head = HEAD) {
  return {
    kind: "commit-status",
    id: String(id),
    headSha: head,
    name: context,
    state,
    description: `CI is ${state}`,
    url: `https://github.com/owner/repository/actions/runs/${id}`,
    createdAt: "2026-11-23T12:00:00Z",
    updatedAt: "2026-11-23T12:01:00Z",
  };
}

interface Run {
  readonly output: string;
  readonly live: readonly string[];
  readonly events: readonly DurableEvent[];
  readonly refusal: string | undefined;
}

interface RunOptions {
  /** The answer a question in this entry receives. */
  readonly answer?: unknown;
  /** Hold every question this entry asks, so the row can leave it there. */
  readonly holdQuestion?: () => void;
  /** Where live output is collected, when a row reads it before the entry ends. */
  readonly live?: string[];
}

/** One entry, over one journal, with the production entry capability. */
function run(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
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
        // deno-lint-ignore require-yield
        *env([name]: [string]): Operation<string | undefined> {
          return name === REPL_GITHUB_BASE ? fixture.endpoint : undefined;
        },
      },
      { at: "min" },
    );
    const files = hostFilesHandler();
    yield* API.Files.around(
      {
        checkFilePath: ([input]: [FilePathInput]) => files.checkFilePath(input),
        readTextFile: ([input]: [FilePathInput]) => files.readTextFile(input),
        globFiles: ([input]) => files.globFiles(input),
        temporaryDirectory: () => files.temporaryDirectory(),
        writeTextFile: ([input]: [FileWriteInput]) => files.writeTextFile(input),
        copyFile: ([input]) => files.copyFile(input),
        deleteFile: ([input]) => files.deleteFile(input),
        ensureDirectory: ([input]) => files.ensureDirectory(input),
      },
      { at: "min" },
    );
    yield* useCompositionComponents();
    yield* installClock(fixture.clock);
    const live: string[] = options.live ?? [];
    yield* DocumentOutput.around({
      *output([text, exact], next) {
        live.push(text);
        return yield* next(text, exact);
      },
    });
    const hold = options.holdQuestion;
    const answer = options.answer;
    if (hold !== undefined || answer !== undefined) {
      yield* Elicitation.around(
        {
          *elicit(): Operation<unknown> {
            if (hold !== undefined) {
              hold();
              return yield* suspend();
            }
            return answer;
          },
        },
        { at: "min" },
      );
    }
    const installation = yield* replRepositoryInstallation(OWNER, {});
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream, includes: [fixture.root] }, [
            { admissions: [(history) => admitReplRepositoryHistory(history)] },
            installation,
          ]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, live, events: yield* stream.readAll(), refusal };
  });
}

/** The one pull request the model holds. */
function pullRequest(fixture: Fixture) {
  const found = fixture.store.pullRequests[0];
  if (found === undefined) {
    throw new Error("the model holds no pull request");
  }
  return found;
}

/** The watch every row runs unless it says otherwise. */
function watching(timeoutSeconds: number | null = 60, after: readonly string[] = []): string {
  const timeout = timeoutSeconds === null ? "" : ` timeoutSeconds={${timeoutSeconds}}`;
  return [
    `<PullRequest.Checks url=${JSON.stringify(URL_1)} watch${timeout} as="checkResult" />`,
    "",
    "<Json value={checkResult} />",
    "",
    ...after,
  ].join("\n");
}

/** The retained values of one effect type, in journal order. */
function retained(events: readonly DurableEvent[], type: string): unknown[] {
  const values: unknown[] = [];
  for (const event of events) {
    if (event.type === "yield" && event.description.type === type && event.result.status === "ok") {
      values.push(event.result.value);
    }
  }
  return values;
}

function results(events: readonly DurableEvent[]): unknown[] {
  return retained(events, PULL_REQUEST_CHECKS_WATCH_RESULT);
}

/** The progress lines a run wrote live, without the rendered result. */
function progress(live: readonly string[]): string[] {
  return live.filter((text) => text.startsWith("Checks")).map((text) => text.trim());
}

/** The JSON a `<Json>` element rendered, read back. */
function rendered(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  return JSON.parse(output.slice(start, end + 1));
}

function checkRequests(fixture: Fixture): number {
  return fixture.store.requests.filter((request) =>
    new URL(request.url).pathname.includes("/commits/"),
  ).length;
}

/** Start an entry in the background, so the row can move the clock under it. */
function* started(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  options: RunOptions = {},
): Operation<Task<Run>> {
  return yield* spawn(() => run(fixture, source, stream, options));
}

/** The entry's run, or a failure if it never settles once its deadline has passed. */
function* finished(task: Task<Run>): Operation<Run> {
  return yield* race([
    task,
    (function* (): Operation<never> {
      yield* sleep(30_000);
      throw new Error("the watch did not end at its deadline");
    })(),
  ]);
}

/**
 * When the watch next sleeps between polls, once it does.
 *
 * A row changes what CI reports after this answers and before it advances, so
 * the next cycle reads exactly that state.
 */
function pollAt(fixture: Fixture, deadline = START + 60_000): Operation<number> {
  return fixture.clock.waitFor((at) => at < deadline && at > fixture.clock.now);
}

function* nextPoll(fixture: Fixture): Operation<void> {
  fixture.clock.advanceTo(yield* pollAt(fixture));
}

describe("watching one pull request's checks", () => {
  it("W1: waits through pending checks and binds a success with every record whole", function* () {
    const fixture = yield* useFixture();
    fixture.ci.runs = [checkRun(31, "build", "in_progress", null)];
    fixture.ci.statuses = [commitStatus(42, "green", "pending")];
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);

    const poll = yield* pollAt(fixture);
    fixture.ci.runs = [checkRun(31, "build", "completed", "success")];
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    fixture.clock.advanceTo(poll);

    const ran = yield* task;
    expect(ran.refusal).toBe(undefined);
    const expected = {
      outcome: "success",
      headSha: HEAD,
      checks: [
        runRecord(31, "build", "completed", "success"),
        statusRecord(42, "green", "success"),
      ],
    };
    expect(results(ran.events)).toEqual([expected]);
    expect(rendered(ran.output)).toEqual(expected);
    expect(retained(ran.events, PULL_REQUEST_CHECKS_WATCH_HEAD)).toEqual([
      { headSha: HEAD, failing: false },
    ]);
    expect(retained(ran.events, PULL_REQUEST_CHECKS_WATCH_DEADLINE)).toEqual([
      { deadline: START + 60_000 },
    ]);
    // No intermediate poll is retained as an evidence read.
    expect(retained(ran.events, PULL_REQUEST_READ)).toEqual([]);
  });

  it("W2: keeps waiting after one check fails, and fails once every check settles", function* () {
    const fixture = yield* useFixture();
    fixture.ci.runs = [
      checkRun(31, "build", "completed", "failure"),
      checkRun(32, "lint", "queued", null),
    ];
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);

    const poll = yield* pollAt(fixture);
    fixture.ci.runs = [
      checkRun(31, "build", "completed", "failure"),
      checkRun(32, "lint", "completed", "skipped"),
    ];
    fixture.clock.advanceTo(poll);

    const ran = yield* task;
    expect(results(ran.events)).toEqual([
      {
        outcome: "failure",
        headSha: HEAD,
        checks: [
          runRecord(31, "build", "completed", "failure"),
          runRecord(32, "lint", "completed", "skipped"),
        ],
      },
    ]);
    expect(progress(ran.live)).toEqual([
      "Checks at aaaaaaa: 0 passed, 1 failed, 1 pending",
      "Checks at aaaaaaa: 1 passed, 1 failed, 0 pending",
    ]);
  });

  it("W3: treats neutral and skipped as passing, and every terminal failure as failing", function* () {
    const fixture = yield* useFixture();
    const failing = ["failure", "cancelled", "timed_out", "action_required"];
    fixture.ci.runs = [
      checkRun(1, "neutral", "completed", "neutral"),
      checkRun(2, "skipped", "completed", "skipped"),
      ...failing.map((conclusion, index) =>
        checkRun(10 + index, conclusion, "completed", conclusion),
      ),
    ];
    fixture.ci.statuses = [commitStatus(20, "errored", "error")];
    const ran = yield* run(fixture, watching(), new InMemoryStream());
    expect(ran.refusal).toBe(undefined);
    expect(progress(ran.live)).toEqual(["Checks at aaaaaaa: 2 passed, 5 failed, 0 pending"]);
    expect(results(ran.events).map((value) => Reflect.get(Object(value), "outcome"))).toEqual([
      "failure",
    ]);

    fixture.ci.runs = [checkRun(1, "neutral", "completed", "neutral")];
    fixture.ci.statuses = [commitStatus(20, "green", "success")];
    const passed = yield* run(fixture, watching(), new InMemoryStream());
    expect(results(passed.events).map((value) => Reflect.get(Object(value), "outcome"))).toEqual([
      "success",
    ]);
  });

  it("W4: an empty collection keeps waiting until a check reports", function* () {
    const fixture = yield* useFixture();
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);
    yield* nextPoll(fixture);
    const poll = yield* pollAt(fixture);
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    fixture.clock.advanceTo(poll);
    const ran = yield* task;
    expect(results(ran.events)).toEqual([
      { outcome: "success", headSha: HEAD, checks: [statusRecord(42, "green", "success")] },
    ]);
    // The repeated empty observation is shown once.
    expect(progress(ran.live)).toEqual([
      "Checks at aaaaaaa: 0 passed, 0 failed, 0 pending",
      "Checks at aaaaaaa: 1 passed, 0 failed, 0 pending",
    ]);
  });
});

describe("a watch that cannot settle", () => {
  it("W5: the budget expiring while a check is pending binds incomplete with its records", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "pending")];
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);
    yield* pollAt(fixture);
    fixture.clock.advanceTo(START + 60_000);
    const ran = yield* task;
    expect(ran.refusal).toBe(undefined);
    expect(results(ran.events)).toEqual([
      {
        outcome: "incomplete",
        reason: "timeout",
        headSha: HEAD,
        checks: [statusRecord(42, "green", "pending")],
      },
    ]);
  });

  it("W6: an unresolved read failure at the deadline binds read-error with the last accepted records", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "pending")];
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);
    const poll = yield* pollAt(fixture);
    // A first page of check runs whose next page cannot be read is a partial
    // collection: none of it may replace what was accepted.
    fixture.ci.runs = [checkRun(31, "build", "completed", "failure")];
    fixture.ci.partial = true;
    fixture.clock.advanceTo(poll);
    yield* fixture.clock.waitFor((at) => at === poll + CHECK_WATCH_RETRY_MS);
    fixture.clock.advanceTo(START + 60_000);
    const ran = yield* task;
    expect(results(ran.events)).toEqual([
      {
        outcome: "incomplete",
        reason: "read-error",
        headSha: HEAD,
        checks: [statusRecord(42, "green", "pending")],
      },
    ]);
    expect(progress(ran.live)).toEqual([
      "Checks at aaaaaaa: 0 passed, 0 failed, 1 pending",
      "Checks at aaaaaaa: retrying after a read error",
    ]);
  });

  it("W7: a later successful read clears a transient failure", function* () {
    const fixture = yield* useFixture();
    fixture.ci.refuses = 503;
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);
    const retry = yield* fixture.clock.waitFor((at) => at === START + CHECK_WATCH_RETRY_MS);
    delete fixture.ci.refuses;
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    fixture.clock.advanceTo(retry);
    const ran = yield* task;
    expect(results(ran.events)).toEqual([
      { outcome: "success", headSha: HEAD, checks: [statusRecord(42, "green", "success")] },
    ]);
    expect(progress(ran.live)).toEqual([
      "Checks at aaaaaaa: retrying after a read error",
      "Checks at aaaaaaa: 1 passed, 0 failed, 0 pending",
    ]);
  });

  it("W8: no head before the deadline binds a null head and no records", function* () {
    const fixture = yield* useFixture();
    fixture.ci.refuses = 500;
    fixture.ci.pullRefuses = 500;
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(10), stream);
    yield* fixture.clock.waitFor((at) => at === START + CHECK_WATCH_RETRY_MS);
    fixture.clock.advanceTo(START + 10_000);
    const ran = yield* task;
    expect(results(ran.events)).toEqual([
      { outcome: "incomplete", reason: "read-error", headSha: null, checks: [] },
    ]);
    expect(retained(ran.events, PULL_REQUEST_CHECKS_WATCH_HEAD)).toEqual([
      { headSha: null, failing: true },
    ]);
  });

  it("W9: a head that moves during a settling read binds head-changed with only accepted records", function* () {
    const fixture = yield* useFixture();
    fixture.ci.runs = [checkRun(31, "build", "in_progress", null)];
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);
    const poll = yield* pollAt(fixture);
    fixture.ci.runs = [checkRun(31, "build", "completed", "success")];
    // The pull request moves after the collection is read and before the head
    // is verified again, so the collection that would settle it is discarded.
    fixture.ci.before = function* (request) {
      if (new URL(request.url).pathname.endsWith("/status")) {
        pullRequest(fixture).headSha = MOVED;
      }
    };
    fixture.clock.advanceTo(poll);
    const ran = yield* task;
    expect(results(ran.events)).toEqual([
      {
        outcome: "incomplete",
        reason: "head-changed",
        headSha: HEAD,
        checks: [runRecord(31, "build", "in_progress", null)],
      },
    ]);
  });
});

describe("a watch's lifetime", () => {
  it("W10: progress shows live while the entry waits and stays out of its rendered output", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "pending")];
    const stream = new InMemoryStream();
    const live: string[] = [];
    const task = yield* started(fixture, watching(), stream, { live });
    // A poll held open: the first line is already visible while it waits.
    const poll = yield* pollAt(fixture);
    const held = withResolvers<void>();
    const reached = withResolvers<void>();
    fixture.ci.before = function* () {
      reached.resolve();
      yield* held.operation;
    };
    fixture.clock.advanceTo(poll);
    yield* reached.operation;
    expect(progress(live)).toEqual(["Checks at aaaaaaa: 0 passed, 0 failed, 1 pending"]);
    expect(results(yield* stream.readAll())).toEqual([]);
    delete fixture.ci.before;
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    held.resolve();
    const ran = yield* task;
    expect(progress(ran.live)).toEqual([
      "Checks at aaaaaaa: 0 passed, 0 failed, 1 pending",
      "Checks at aaaaaaa: 1 passed, 0 failed, 0 pending",
    ]);
    expect(ran.output).not.toContain("Checks at");
    expect(Reflect.get(Object(rendered(ran.output)), "outcome")).toBe("success");
  });

  it("W11: cancelling during a blocked request closes it and binds nothing", function* () {
    const fixture = yield* useFixture();
    const reached = withResolvers<void>();
    fixture.ci.before = function* () {
      reached.resolve();
      yield* suspend();
    };
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(null), stream);
    yield* reached.operation;
    expect(fixture.clock.waiters).toEqual([]);
    yield* task.halt();
    const events = yield* stream.readAll();
    expect(results(events)).toEqual([]);
    expect(retained(events, PULL_REQUEST_CHECKS_WATCH_HEAD)).toEqual([]);
    // The request the entry was waiting on was torn down with it.
    for (let attempt = 0; attempt < 100 && fixture.inFlight.closed === 0; attempt += 1) {
      yield* sleep(10);
    }
    expect(fixture.inFlight.closed).toBeGreaterThan(0);
  });

  it("W12: an unfinished watch continues with its pinned head and original deadline", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "pending")];
    const first = new InMemoryStream();
    const task = yield* started(fixture, watching(), first);
    yield* pollAt(fixture);
    yield* task.halt();
    const prefix = [...(yield* first.readAll())];
    expect(retained(prefix, PULL_REQUEST_CHECKS_WATCH_HEAD)).toEqual([
      { headSha: HEAD, failing: false },
    ]);
    expect(results(prefix)).toEqual([]);

    // Away for forty seconds: the PR moved and the budget kept running.
    fixture.clock.now = START + 40_000;
    pullRequest(fixture).headSha = MOVED;
    const resumed = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, watching(), resumed);
    expect(again.refusal).toBe(undefined);
    expect(results(again.events)).toEqual([
      { outcome: "incomplete", reason: "head-changed", headSha: HEAD, checks: [] },
    ]);

    // Same head this time, still pending: it gives up at the original deadline.
    pullRequest(fixture).headSha = HEAD;
    fixture.clock.now = START + 40_000;
    const waiting = yield* started(fixture, watching(), new InMemoryStream([...prefix]));
    expect(yield* pollAt(fixture)).toBe(START + 40_000 + CHECK_WATCH_POLL_MS);
    fixture.clock.advanceTo(START + 60_000);
    const expired = yield* finished(waiting);
    expect(results(expired.events)).toEqual([
      {
        outcome: "incomplete",
        reason: "timeout",
        headSha: HEAD,
        checks: [statusRecord(42, "green", "pending")],
      },
    ]);
  });

  it("W13: a completed watch restores its result without a read or a line of progress", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    const question = [
      `<Elicit schema={{ type: "object", properties: { choice: { enum: ["continue"] } },`,
      `  required: ["choice"], additionalProperties: false }} as="answer">`,
      `Continue?`,
      `</Elicit>`,
      "",
      "after {answer.choice}",
    ];
    const source = watching(null, question);
    const first = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* started(fixture, source, first, { holdQuestion: () => reached.resolve() });
    yield* reached.operation;
    const prefix = [...(yield* first.readAll())];
    yield* task.halt();
    expect(results(prefix)).toHaveLength(1);

    const before = fixture.store.requests.length;
    fixture.ci.refuses = 500;
    const continued = yield* run(fixture, source, new InMemoryStream([...prefix]), {
      answer: { choice: "continue" },
    });
    expect(continued.refusal).toBe(undefined);
    expect(continued.output).toContain("after continue");
    expect(Reflect.get(Object(rendered(continued.output.split("after")[0] ?? "")), "outcome")).toBe(
      "success",
    );
    expect(fixture.store.requests).toHaveLength(before);
    expect(fixture.clock.waiters).toEqual([]);
    expect(progress(continued.live)).toEqual([]);
  });
});

describe("what a watch refuses before contacting anything", () => {
  it("W14: invalid watch input refuses with no request", function* () {
    const fixture = yield* useFixture();
    const element = `<PullRequest.Checks url=${JSON.stringify(URL_1)}`;
    const cases: [string, string][] = [
      [`${element} timeoutSeconds={60} as="checks" />`, "`timeoutSeconds` bounds a watch"],
      [`${element} watch timeoutSeconds={0} as="checks" />`, "Prop validation failed"],
      [`${element} watch timeoutSeconds={1.5} as="checks" />`, "Prop validation failed"],
      [`${element} watch timeoutSeconds={60} />`, "must be invoked with `as`"],
    ];
    for (const [source, refusal] of cases) {
      const ran = yield* run(fixture, source, new InMemoryStream());
      expect(`${source}: ${ran.refusal ?? "bound"}`).toContain(refusal);
    }
    expect(fixture.store.requests).toEqual([]);
  });

  it("W15: a URL no installed provider handles refuses with no request", function* () {
    const fixture = yield* useFixture();
    const ran = yield* run(
      fixture,
      `<PullRequest.Checks url="https://example.com/owner/repository/pull/1" watch timeoutSeconds={60} as="checks" />`,
      new InMemoryStream(),
    );
    expect(ran.refusal).toContain("no pull-request provider handles");
    expect(fixture.store.requests).toEqual([]);
    expect(results(ran.events)).toEqual([]);
  });

  it("W16: omitting watch keeps the snapshot array, including an empty one", function* () {
    const fixture = yield* useFixture();
    const ran = yield* run(
      fixture,
      [
        `<PullRequest.Checks url=${JSON.stringify(URL_1)} as="checks" />`,
        "",
        "<Json value={checks} />",
        "",
      ].join("\n"),
      new InMemoryStream(),
    );
    expect(ran.refusal).toBe(undefined);
    expect(ran.output.trim()).toBe("[]");
    expect(retained(ran.events, PULL_REQUEST_READ)).toHaveLength(1);
    expect(results(ran.events)).toEqual([]);
  });
});

describe("a retained watch this entry cannot account for", () => {
  it("W18: every tampered checkpoint refuses before anything replays or is asked", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    const source = watching();
    const ran = yield* run(fixture, source, new InMemoryStream());
    expect(ran.refusal).toBe(undefined);
    // Without the root's close, so the history is one a continuation reads.
    const history = ran.events.filter(
      (event) => !(event.type === "close" && event.coroutineId === "root"),
    );
    const at = (type: string) => {
      const index = history.findIndex(
        (event) => event.type === "yield" && event.description.type === type,
      );
      const event = history[index];
      if (event === undefined || event.type !== "yield") {
        throw new Error(`that run retained no ${type}`);
      }
      return { index, event };
    };
    const deadline = at(PULL_REQUEST_CHECKS_WATCH_DEADLINE);
    const head = at(PULL_REQUEST_CHECKS_WATCH_HEAD);
    const result = at(PULL_REQUEST_CHECKS_WATCH_RESULT);
    const sent = fixture.store.requests.length;

    const tampered: [string, number, DurableEvent][] = [
      [
        "a deadline that is not a time",
        deadline.index,
        { ...deadline.event, result: { status: "ok", value: { deadline: "soon" } } },
      ],
      [
        "a budget its name was not made from",
        deadline.index,
        {
          ...deadline.event,
          description: {
            ...deadline.event.description,
            input: { ...Object(deadline.event.description.input), timeoutSeconds: 600 },
          },
        },
      ],
      [
        "a pinned head that names nothing",
        head.index,
        { ...head.event, result: { status: "ok", value: { headSha: "", failing: false } } },
      ],
      [
        "a pin under another name",
        head.index,
        { ...head.event, description: { ...head.event.description, name: "something-else" } },
      ],
      [
        "a result made under another owner",
        result.index,
        {
          ...result.event,
          description: {
            ...result.event.description,
            input: { ...Object(result.event.description.input), runId: "someone-else" },
          },
        },
      ],
      [
        "a success that no collection settles",
        result.index,
        {
          ...result.event,
          result: { status: "ok", value: { outcome: "success", headSha: HEAD, checks: [] } },
        },
      ],
      [
        "a settled outcome with a reason",
        result.index,
        {
          ...result.event,
          result: {
            status: "ok",
            value: {
              outcome: "success",
              reason: "timeout",
              headSha: HEAD,
              checks: [statusRecord(42, "green", "success")],
            },
          },
        },
      ],
    ];
    for (const [what, index, event] of tampered) {
      const replacement = [...history];
      replacement[index] = event;
      const again = yield* run(fixture, source, new InMemoryStream(replacement));
      expect([what, again.refusal?.includes("checks watch") ?? false]).toEqual([what, true]);
      expect([what, fixture.store.requests.length]).toEqual([what, sent]);
      expect([what, progress(again.live)]).toEqual([what, []]);
    }
  });
});

/** Whether the watch read anything at this head's commits. */
function pagedAt(fixture: Fixture, head: string): boolean {
  return fixture.store.requests.some((request) =>
    new URL(request.url).pathname.includes(`/commits/${head}/`),
  );
}

describe("the head a watch observed before its collection failed", () => {
  it("W19: head A, a failed page, then green checks on B: head-changed for A, nothing of B", function* () {
    const fixture = yield* useFixture();
    fixture.ci.runs = [checkRun(31, "build", "completed", "success")];
    fixture.ci.partial = true;
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);
    // The pull request answered with A, and A's check-run paging failed.
    const retry = yield* fixture.clock.waitFor((at) => at === START + CHECK_WATCH_RETRY_MS);
    expect(pagedAt(fixture, HEAD)).toBe(true);

    pullRequest(fixture).headSha = MOVED;
    delete fixture.ci.partial;
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    fixture.clock.advanceTo(retry);
    const ran = yield* finished(task);

    expect(ran.refusal).toBe(undefined);
    expect(results(ran.events)).toEqual([
      { outcome: "incomplete", reason: "head-changed", headSha: HEAD, checks: [] },
    ]);
    expect(retained(ran.events, PULL_REQUEST_CHECKS_WATCH_HEAD)).toEqual([
      { headSha: HEAD, failing: false },
    ]);
    // The watch saw B and reported A: B's green checks were never collected.
    expect(pullRequest(fixture).headSha).toBe(MOVED);
    expect(pagedAt(fixture, MOVED)).toBe(false);
    expect(JSON.stringify(rendered(ran.output))).not.toContain(MOVED);
  });

  it("W20: a head that moves after pinning ends the watch before its collection is paged", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "pending")];
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(), stream);
    const poll = yield* pollAt(fixture);
    pullRequest(fixture).headSha = MOVED;
    // B's paging would fail; the watch must not reach it.
    fixture.ci.partial = true;
    fixture.clock.advanceTo(poll);
    const ran = yield* finished(task);
    expect(results(ran.events)).toEqual([
      {
        outcome: "incomplete",
        reason: "head-changed",
        headSha: HEAD,
        checks: [statusRecord(42, "green", "pending")],
      },
    ]);
    expect(pagedAt(fixture, MOVED)).toBe(false);
  });

  it("W21: a transient paging failure on A that recovers on A settles for A", function* () {
    const fixture = yield* useFixture();
    fixture.ci.runs = [checkRun(31, "build", "completed", "success")];
    fixture.ci.partial = true;
    const stream = new InMemoryStream();
    const task = yield* started(fixture, watching(null), stream);
    const retry = yield* fixture.clock.waitFor((at) => at === START + CHECK_WATCH_RETRY_MS);
    expect(fixture.clock.waiters.map(({ at }) => at)).toEqual([retry]);
    delete fixture.ci.partial;
    fixture.clock.advanceTo(retry);
    const ran = yield* finished(task);
    expect(results(ran.events)).toEqual([
      {
        outcome: "success",
        headSha: HEAD,
        checks: [runRecord(31, "build", "completed", "success")],
      },
    ]);
    expect(progress(ran.live)).toEqual([
      "Checks at aaaaaaa: retrying after a read error",
      "Checks at aaaaaaa: 1 passed, 0 failed, 0 pending",
    ]);
  });

  it("W22: a watch cut while retrying a failed page resumes on A and reports B's move", function* () {
    const fixture = yield* useFixture();
    fixture.ci.runs = [checkRun(31, "build", "completed", "success")];
    fixture.ci.partial = true;
    const first = new InMemoryStream();
    const task = yield* started(fixture, watching(null), first);
    yield* fixture.clock.waitFor((at) => at === START + CHECK_WATCH_RETRY_MS);
    yield* task.halt();
    const prefix = [...(yield* first.readAll())];
    expect(retained(prefix, PULL_REQUEST_CHECKS_WATCH_HEAD)).toEqual([
      { headSha: HEAD, failing: false },
    ]);
    expect(results(prefix)).toEqual([]);

    fixture.clock.now = START + 86_400_000;
    pullRequest(fixture).headSha = MOVED;
    delete fixture.ci.partial;
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    const again = yield* run(fixture, watching(null), new InMemoryStream([...prefix]));
    expect(again.refusal).toBe(undefined);
    expect(results(again.events)).toEqual([
      { outcome: "incomplete", reason: "head-changed", headSha: HEAD, checks: [] },
    ]);
    expect(retained(again.events, PULL_REQUEST_CHECKS_WATCH_DEADLINE)).toEqual([
      { deadline: null },
    ]);
    expect(pagedAt(fixture, MOVED)).toBe(false);
  });
});

describe("read failures without a deadline", () => {
  it("W23: a terminal error before pinning binds read-error without a retry", function* () {
    const fixture = yield* useFixture();
    fixture.ci.pullRefuses = 401;
    let requests = 0;
    // deno-lint-ignore require-yield
    fixture.ci.before = function* () {
      requests += 1;
    };
    const task = yield* started(fixture, watching(null), new InMemoryStream());
    const ran = yield* finished(task);
    expect(results(ran.events)).toEqual([
      { outcome: "incomplete", reason: "read-error", headSha: null, checks: [] },
    ]);
    expect(requests).toBe(1);
    expect(progress(ran.live)).toEqual([]);
  });

  it("W24: invalid evidence stops an unbounded watch with its last accepted checks", function* () {
    const fixture = yield* useFixture();
    fixture.ci.runs = [checkRun(31, "build", "in_progress", null)];
    const task = yield* started(fixture, watching(null), new InMemoryStream());
    const poll = yield* pollAt(fixture);
    fixture.ci.runs = [{ ...checkRun(32, "other", "completed", "success"), head_sha: MOVED }];
    fixture.clock.advanceTo(poll);
    const ran = yield* finished(task);
    expect(results(ran.events)).toEqual([
      {
        outcome: "incomplete",
        reason: "read-error",
        headSha: HEAD,
        checks: [runRecord(31, "build", "in_progress", null)],
      },
    ]);
    expect(progress(ran.live)).toEqual(["Checks at aaaaaaa: 0 passed, 0 failed, 1 pending"]);
  });

  it("W25: a long explicit timeout keeps polling across a maximum timer arm", function* () {
    const fixture = yield* useFixture();
    fixture.ci.statuses = [commitStatus(42, "green", "pending")];
    const seconds = Number.MAX_SAFE_INTEGER;
    const task = yield* started(fixture, watching(seconds), new InMemoryStream());
    const arm = yield* fixture.clock.waitFor((at) => at === START + 2_147_483_647);
    yield* pollAt(fixture);
    fixture.clock.advanceTo(arm);
    yield* fixture.clock.waitFor((at) => at === arm + 2_147_483_647);
    const next = yield* fixture.clock.waitFor((at) => at === arm + CHECK_WATCH_POLL_MS);
    fixture.ci.statuses = [commitStatus(42, "green", "success")];
    fixture.clock.advanceTo(next);
    const ran = yield* finished(task);
    expect(results(ran.events)).toEqual([
      { outcome: "success", headSha: HEAD, checks: [statusRecord(42, "green", "success")] },
    ]);
    expect(retained(ran.events, PULL_REQUEST_CHECKS_WATCH_DEADLINE)).toEqual([
      { deadline: String(BigInt(START) + BigInt(seconds) * 1000n) },
    ]);
  });
});
