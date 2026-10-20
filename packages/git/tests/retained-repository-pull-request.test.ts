/**
 * What one REPL entry's `<PullRequest>` and its three evidence reads ask for,
 * do once, and answer from afterwards.
 *
 * Every row runs a document through canonical execution with the production
 * entry capability installed, against a real checkout, a real bare remote, and
 * a GitHub model behind a real loopback listener the shipped transport reaches
 * over HTTP. Nothing between those two host boundaries is substituted: the
 * authored components ask the composition Api, the request is written down, the
 * shared Git-host engine observes, the modeled service is contacted at most
 * once, and what it holds is read back from the store rather than from what the
 * run believes.
 *
 * The contract these rows hold the host to is the REPL's execution model, and
 * it differs from publication in the one way that decides most of this file. A
 * pull request publishes nothing: it is a statement about a branch that already
 * exists at the Git host, so what admits one is *this* entry's own acknowledged
 * publication of that branch. The rows that matter most are therefore the ones
 * where some other publication is available — another checkout's, another
 * entry's, a synthetic middleware answer, a superseded one — and the upsert
 * still has to refuse before a request, a credential or a call exists.
 *
 * These rows carry B1's retained half, B2, B3, B4, B5, B7, and B10's assembly,
 * rootless-read and absent-upsert cases. B6's portable foundation is in
 * `retained-repository-pull-request-records.test.ts`; the public terminal
 * journey is B9's and is not demonstrated here.
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
import type { Operation, WithResolvers } from "effection";
import { fromReadable } from "@effectionx/node";
import { rm, writeTextFile } from "@effectionx/fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { collect, Elicitation } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { Git } from "../src/composition/git-api.ts";
import type { GitPushInvocation } from "../src/composition/git-api.ts";
import type { GitPushOutcome } from "../src/composition/git-push-records.ts";
import { PullRequestAPI } from "../src/composition/pull-request-api.ts";
import { parseCompletePullRequestReadResult } from "../src/composition/pull-request-read-records.ts";
import type { PullRequestReadResult } from "../src/composition/pull-request-read-records.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type {
  GitInvocation,
  GitOutcome,
  RepositoryHost,
  RepositoryHostOptions,
} from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import type { GitAuthenticationSession } from "../src/deno/composition/authentication.ts";
import { UNAUTHENTICATED } from "../src/deno/composition/authentication.ts";
import { replRepositoryInstallation } from "../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import { GITHUB_PULL_REQUESTS_ENV } from "../src/deno/composition/pull-request-configuration.ts";
import {
  parseReplPullRequestRequestRecord,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
} from "../src/retained-repository/pull-request-records.ts";
import type { ReplPullRequestRequestRecord } from "../src/retained-repository/pull-request-records.ts";
import {
  parseReplPushRequestRecord,
  REPL_REPOSITORY_PUSH_REQUEST,
} from "../src/retained-repository/push-records.ts";
import type { ReplPushRequestRecord } from "../src/retained-repository/push-records.ts";
import { PULL_REQUEST_READ } from "../src/deno/composition/pull-request-read-retention.ts";
import { gitHubStore, mutations, respond } from "./support/github.ts";
import { stored } from "./support/pull-requests.ts";
import type { GitHubHttpRequest, GitHubHttpResponse } from "../src/deno/composition/github.ts";
import type { GitHubStore } from "./support/github.ts";

/** The owner the CLI derives for an entry, as this suite states one. */
const OWNER = '["executablemd.repl.issue-owner",1,"execution-pull-request","1"]';

/** A second entry's owner, for the history that is not this entry's. */
const FOREIGN_OWNER = '["executablemd.repl.issue-owner",1,"execution-pull-request","2"]';

/**
 * The repository every document names, and the one the modeled GitHub holds.
 *
 * `owner/repository` because that is the pull request URL the shared GitHub
 * model reports, and a read's identity *is* its URL: the container that admits
 * the three evidence reads has to be the one the created pull request says it
 * lives in. Git is handed the bare repository beside the test instead, through
 * the one substitution below.
 */
const LOCATOR = "https://github.com/owner/repository";

const BRANCH = "review/1.4";
const TITLE = "Prepare 1.4";
const BODY = "Ready for review.";

/** A credential no journal, result or read record may ever hold. */
const TOKEN = "github-credential-for-this-test";

const STATED_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_IDENT: "Entry Author <author@example.test> 1700000000 +0000",
  GIT_COMMITTER_IDENT: "Entry Committer <committer@example.test> 1700000000 +0000",
};

/** That identity, as the host reads one. */
// deno-lint-ignore require-yield
function* statedIdentity(variable: string): Operation<string | undefined> {
  return STATED_IDENTITY[variable];
}

interface Fixture {
  /** The scenario's own directory: checkouts, managed root and HOME. */
  readonly root: string;
  /** The bare repository every managed Repository is cloned from. */
  readonly origin: string;
  /** Where this scenario's managed checkouts live. */
  readonly managed: string;
  /** A symbolic link an entry is opened through. */
  readonly link: string;
  /** The GitHub this scenario's entries reach, and what it was asked. */
  readonly store: GitHubStore;
  /** The API base the shipped transport is configured with. */
  readonly endpoint: string;
  /** The evidence this GitHub reports for the three collections. */
  readonly evidence: Evidence;
  /** What a row makes this GitHub do before it answers a request. */
  readonly gate: { hold?: (request: GitHubHttpRequest) => Operation<void> };
}

/** What the modeled GitHub answers the three evidence collections with. */
interface Evidence {
  /** The reviews the pull request holds. */
  reviews: readonly Record<string, unknown>[];
  /** The conversation comments on its issue. */
  conversation: readonly Record<string, unknown>[];
  /** The inline review comments on its diff. */
  inline: readonly Record<string, unknown>[];
  /** The check runs for its head. */
  runs: readonly Record<string, unknown>[];
  /** The commit statuses for its head. */
  statuses: readonly Record<string, unknown>[];
  /** A status every evidence route answers with instead of its collection. */
  refuses?: number;
}

function evidence(): Evidence {
  return { reviews: [], conversation: [], inline: [], runs: [], statuses: [] };
}

/**
 * One bare remote with a commit in it, one GitHub, and this scenario's root.
 *
 * The listener is a real `node:http` server on an ephemeral port, so the
 * shipped transport builds real URLs, reads a real credential and parses a real
 * response — the entry assembly offers no seam to inject an access through, and
 * pointing a configured endpoint at a loopback is how a deployment reaches
 * something other than GitHub's own.
 */
function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "repl-pr-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const git = gitSession(denoRepositoryHost(), root);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    yield* until(mkdir(seed, { recursive: true }));
    yield* git.run(["init", "--bare", "-b", "main", origin], root);
    yield* git.run(["init", "-b", "main", seed], root);
    yield* until(writeFile(join(seed, "seed.md"), "seed\n"));
    yield* git.run(["add", "seed.md"], seed);
    yield* git.run(["commit", "-m", "seed"], seed);
    yield* git.run(["push", origin, "main:refs/heads/main"], seed);

    const checkout = join(root, "checkout");
    yield* git.run(["clone", origin, checkout], root);
    const link = join(root, "entered");
    yield* until(symlink(checkout, link));

    const store = gitHubStore({ owner: "owner", repository: "repository", token: TOKEN });
    const held = evidence();
    const gate: { hold?: (request: GitHubHttpRequest) => Operation<void> } = {};
    const endpoint = yield* useGitHub(store, held, gate);

    // The credential the shipped transport reads. Set for this file's process
    // and restored on teardown, because `denoGitHubAccess` asks the invoking
    // environment for one and a machine login is not something a suite may
    // reach: an unset variable would send this test to the host's own `gh`.
    const before = process.env["GH_TOKEN"];
    process.env["GH_TOKEN"] = TOKEN;
    yield* ensure(function* (): Operation<void> {
      if (before === undefined) {
        delete process.env["GH_TOKEN"];
        return;
      }
      process.env["GH_TOKEN"] = before;
    });

    yield* provide({
      root,
      origin,
      managed: join(root, "repositories"),
      link,
      store,
      endpoint,
      evidence: held,
      gate,
    });
  });
}

/**
 * The modeled GitHub, behind a listener the shipped transport can reach.
 *
 * The pull-request and issue routes are the shared model's own. The five
 * evidence routes are this suite's, because the shared model does not answer
 * them — and they are built from the live endpoint, since a review that does
 * not name the pull request it belongs to is refused by the adapter before it
 * becomes an item.
 */
function useGitHub(
  store: GitHubStore,
  held: Evidence,
  gate: { hold?: (request: GitHubHttpRequest) => Operation<void> },
): Operation<string> {
  return resource<string>(function* (provide) {
    const base = { endpoint: "" };
    const scope = yield* useScope();
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      scope.run(function* (): Operation<void> {
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
          method:
            incoming.method === "POST" ? "POST" : incoming.method === "PATCH" ? "PATCH" : "GET",
          url: `${base.endpoint}${incoming.url ?? "/"}`,
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        if (gate.hold !== undefined) {
          // This listener answers from its own task, so a row that holds a
          // request here leaves it genuinely in flight: the entry is waiting on
          // a call this GitHub has received and not answered.
          yield* gate.hold(request);
        }
        let answer: GitHubHttpResponse;
        try {
          answer = evidenceAnswer(store, held, base.endpoint, request) ?? respond(store, request);
        } catch {
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(answer.status, {
          "content-type": "application/json",
          ...(answer.link === undefined ? {} : { link: answer.link }),
        });
        outgoing.end(answer.body);
      });
    });

    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* (): Operation<void> {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    const address = server.address() as AddressInfo;
    base.endpoint = `http://127.0.0.1:${address.port}`;
    yield* provide(base.endpoint);
  });
}

/** This suite's answer for one of the five evidence routes, or nothing. */
function evidenceAnswer(
  store: GitHubStore,
  held: Evidence,
  endpoint: string,
  request: GitHubHttpRequest,
): GitHubHttpResponse | undefined {
  const url = new URL(request.url);
  const prefix = `/repos/${store.owner}/${store.repository}`;
  if (!url.pathname.startsWith(`${prefix}/`)) {
    return undefined;
  }
  store.requests.push(request);
  store.observe?.(request);
  if (store.token !== undefined && request.headers["Authorization"] !== `Bearer ${store.token}`) {
    return { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
  }
  const rest = url.pathname.slice(prefix.length);
  if (held.refuses !== undefined && !/^\/pulls\/[1-9][0-9]*$/.test(rest)) {
    return { status: held.refuses, body: JSON.stringify({ message: "Server Error" }) };
  }
  const reviews = /^\/pulls\/([1-9][0-9]*)\/reviews$/.exec(rest);
  if (reviews !== null) {
    return page(
      held.reviews.map((item) => ({
        ...subjectOf(endpoint, store, "pulls", reviews[1] ?? ""),
        ...item,
      })),
    );
  }
  const conversation = /^\/issues\/([1-9][0-9]*)\/comments$/.exec(rest);
  if (conversation !== null) {
    return page(
      held.conversation.map((item) => ({
        issue_url: `${endpoint}/repos/${store.owner}/${store.repository}/issues/${conversation[1]}`,
        ...item,
      })),
    );
  }
  const inline = /^\/pulls\/([1-9][0-9]*)\/comments$/.exec(rest);
  if (inline !== null) {
    return page(
      held.inline.map((item) => ({
        ...subjectOf(endpoint, store, "pulls", inline[1] ?? ""),
        ...item,
      })),
    );
  }
  const runs = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest);
  if (runs !== null) {
    const head = runs[1] ?? "";
    return {
      status: 200,
      body: JSON.stringify({
        total_count: held.runs.length,
        check_runs: held.runs.map((item) => ({ head_sha: head, ...item })),
      }),
    };
  }
  const combined = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest);
  if (combined !== null) {
    return {
      status: 200,
      body: JSON.stringify({ sha: combined[1] ?? "", statuses: held.statuses }),
    };
  }
  // Not an evidence route. Take the request back off the log so the shared
  // model records it exactly once.
  store.requests.pop();
  return undefined;
}

/** One page of evidence, as every collection route answers with one. */
function page(items: readonly unknown[]): GitHubHttpResponse {
  return { status: 200, body: JSON.stringify(items) };
}

/** The subject URL an item names its pull request by. */
function subjectOf(
  endpoint: string,
  store: GitHubStore,
  collection: string,
  number: string,
): Record<string, unknown> {
  return {
    pull_request_url: `${endpoint}/repos/${store.owner}/${store.repository}/${collection}/${number}`,
  };
}

/** One review, as GitHub reports one. */
function review(id: number, state: string, body: string): Record<string, unknown> {
  return {
    id,
    user: { login: "reviewer" },
    state,
    body,
    submitted_at: "2026-10-20T00:00:00Z",
    commit_id: "0".repeat(40),
    html_url: `https://github.com/owner/repository/pull/1#r${id}`,
  };
}

/** One review, as the boundary that validates one has already read it. */
function reviewEvidence(
  id: number,
  state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending",
) {
  return {
    id: String(id),
    author: "reviewer",
    state,
    body: "added by a handler",
    submittedAt: null,
    commitSha: null,
    url: `https://github.com/owner/repository/pull/1#r${id}`,
  } as const;
}

/** One conversation comment, as GitHub reports one. */
function comment(id: number, body: string): Record<string, unknown> {
  return {
    id,
    user: { login: "commenter" },
    body,
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    html_url: `https://github.com/owner/repository/pull/1#c${id}`,
  };
}

/** One check run, as GitHub reports one. */
function checkRun(id: number, name: string): Record<string, unknown> {
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/owner/repository/runs/${id}`,
    started_at: "2026-10-20T00:00:00Z",
    completed_at: "2026-10-20T00:01:00Z",
    output: { title: name, summary: "ok", text: null },
  };
}

/** What the host beneath the recorder was asked to do. */
interface Counters {
  commands: string[][];
  directories: number;
  sessions: string[];
  /** Every configuration variable this entry read, in order. */
  env: string[];
}

function counters(): Counters {
  return { commands: [], directories: 0, sessions: [], env: [] };
}

/** The host filesystem, as the production one. */
function hostFiles(): FilesHandler {
  const host = hostFilesHandler();
  return {
    checkFilePath: (input: FilePathInput) => host.checkFilePath(input),
    readTextFile: (input: FilePathInput) => host.readTextFile(input),
    globFiles: (input) => host.globFiles(input),
    temporaryDirectory: () => host.temporaryDirectory(),
    writeTextFile: (input: FileWriteInput) => host.writeTextFile(input),
    deleteFile: (input) => host.deleteFile(input),
    ensureDirectory: (input) => host.ensureDirectory(input),
  };
}

/** What a row may do to one `git` invocation before the real one runs. */
type GitBarrier = (invocation: GitInvocation) => Operation<void>;

/**
 * The production host, counted, with one locator standing in for another.
 *
 * Every leaf is wrapped rather than replaced: what these rows need to know is
 * whether a publication really happened and what the pull request's head really
 * is, and the only honest way to answer is to let the real `push` happen and
 * then read the remote. The substitution goes both ways and replaces exactly one
 * string, because Git remembers where a checkout came from and this entry's own
 * origin readback reads it back.
 *
 * It also tells the modeled GitHub the commit each branch holds, by watching the
 * refspec of a publication that succeeded — which is how the real GitHub knows
 * it too, because `<Git.Push />` put it there.
 */
function countingHost(
  fixture: Fixture,
  counted: Counters,
  options: RunOptions = {},
): RepositoryHost {
  const host = denoRepositoryHost(options.hostOptions ?? {});
  const barrier = options.barrier;
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      counted.commands.push([...invocation.args]);
      if (barrier !== undefined) {
        yield* barrier(invocation);
      }
      if (options.refuseNative === true) {
        throw new Error("this row's native Git must not be reached");
      }
      const outcome = yield* host.git({
        ...invocation,
        args: invocation.args.map((argument) => (argument === LOCATOR ? fixture.origin : argument)),
      });
      if (outcome.code === 0) {
        learnHeads(fixture, invocation);
      }
      return { ...outcome, stdout: outcome.stdout.split(fixture.origin).join(LOCATOR) };
    },
    *useDirectory(): Operation<string> {
      counted.directories += 1;
      return yield* host.useDirectory();
    },
    *useAuthentication(locator: string): Operation<GitAuthenticationSession> {
      counted.sessions.push(locator);
      return host.useAuthentication === undefined
        ? UNAUTHENTICATED
        : yield* host.useAuthentication(locator);
    },
  };
}

/** Record what a successful publication put at the remote. */
function learnHeads(fixture: Fixture, invocation: GitInvocation): void {
  if (!invocation.args.includes("push")) {
    return;
  }
  for (const argument of invocation.args) {
    const refspec = /^([0-9a-f]{7,64}):refs\/heads\/(.+)$/.exec(argument);
    if (refspec !== null && refspec[1] !== undefined && refspec[2] !== undefined) {
      fixture.store.heads.set(refspec[2], refspec[1]);
    }
  }
}

interface Run {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  readonly refusal: string | undefined;
}

interface RunOptions {
  /** The directory the entry is opened in. Defaults to the fixture's link. */
  readonly cwd?: string;
  /** What this row installs between the host and the recording. */
  readonly between?: () => Operation<void>;
  /** A barrier inside one `git` invocation. */
  readonly barrier?: GitBarrier;
  /** What this row states about the native host it drives. */
  readonly hostOptions?: RepositoryHostOptions;
  /** Whether native Git is a refusing leaf for this row. */
  readonly refuseNative?: boolean;
  /** Whether this entry installs a managed root at all. */
  readonly root?: string | undefined;
  /** The owner this entry's work is retained under. */
  readonly owner?: string;
  /** The answer a question in this entry receives, when a row supplies one. */
  readonly answer?: Json;
  /** The containers this deployment allows pull-request reads in. */
  readonly allowed?: readonly string[];
  /** Whether this deployment states any pull-request configuration at all. */
  readonly configured?: boolean;
}

/** One entry, over one journal, in one checkout. */
function run(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  counted: Counters,
  options: RunOptions = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const working = options.cwd ?? fixture.link;
    const stated =
      options.configured === false
        ? undefined
        : JSON.stringify({
            allowed: options.allowed ?? [LOCATOR],
            endpoint: fixture.endpoint,
          });
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return working;
        },
        // deno-lint-ignore require-yield
        *env([name]: [string]): Operation<string | undefined> {
          counted.env.push(name);
          return name === GITHUB_PULL_REQUESTS_ENV ? stated : undefined;
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
    if (options.answer !== undefined) {
      const answer = options.answer;
      yield* Elicitation.around(
        {
          // deno-lint-ignore require-yield
          *elicit(): Operation<unknown> {
            return answer;
          },
        },
        { at: "min" },
      );
    }
    if (options.between !== undefined) {
      yield* options.between();
    }
    const managed = "root" in options ? options.root : fixture.managed;
    // Built the way the session builds it: one per-entry factory, called in the
    // entry's own task, for the owner the CLI derived.
    const installation = yield* replRepositoryInstallation(options.owner ?? OWNER, {
      host: countingHost(fixture, counted, options),
      identity: statedIdentity,
      ...(managed === undefined ? {} : { root: managed }),
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

/**
 * The prefix an entry left behind when it was left at a question.
 *
 * A real unfinished history, not a complete one with its closes removed: a
 * journal whose run finished replays every position it holds and runs no
 * component, so a continuation with a new suffix would never reach it.
 */
function left(
  fixture: Fixture,
  source: string,
  counted: Counters,
  options: RunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    const task = yield* spawn(() =>
      run(fixture, source, stream, counted, {
        ...options,
        *between(): Operation<void> {
          if (options.between !== undefined) {
            yield* options.between();
          }
          yield* Elicitation.around({
            *elicit(): Operation<unknown> {
              reached.resolve();
              return yield* suspend();
            },
          });
        },
      }),
    );
    yield* race([
      reached.operation,
      (function* (): Operation<never> {
        yield* sleep(60_000);
        throw new Error("the entry never reached its question");
      })(),
    ]);
    const prefix = [...(yield* stream.readAll())];
    yield* task.halt();
    return prefix;
  });
}

/**
 * The history an entry left behind when it was cut at a named request.
 *
 * The honest shape of an interrupted pull request: the modeled service receives
 * the call and never answers it, so the entry is halted with the request in
 * flight and what the journal holds is whatever had already been acknowledged.
 * The cut is the halt below, not a fabricated prefix.
 */
function cut(
  fixture: Fixture,
  source: string,
  counted: Counters,
  at: (request: GitHubHttpRequest) => boolean,
  options: RunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    const reached = withResolvers<void>();
    fixture.gate.hold = function* (request: GitHubHttpRequest): Operation<void> {
      if (at(request)) {
        reached.resolve();
        yield* suspend();
      }
    };
    yield* ensure(() => {
      delete fixture.gate.hold;
    });
    const task = yield* spawn(() => run(fixture, source, stream, counted, options));
    yield* race([
      reached.operation,
      (function* (): Operation<never> {
        yield* sleep(60_000);
        throw new Error("the entry never reached the request it was cut at");
      })(),
    ]);
    const prefix = [...(yield* stream.readAll())];
    yield* task.halt();
    return prefix;
  });
}

/** Every saved pull-request request this history holds, parsed. */
function requests(events: readonly DurableEvent[]): ReplPullRequestRequestRecord[] {
  const found: ReplPullRequestRequestRecord[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    if (event.description.type !== REPL_REPOSITORY_PULL_REQUEST_REQUEST) {
      continue;
    }
    const record = parseReplPullRequestRequestRecord(event.result.value);
    if (record !== undefined) {
      found.push(record);
    }
  }
  return found;
}

/** Every saved publication request this history holds, parsed. */
function publications(events: readonly DurableEvent[]): ReplPushRequestRecord[] {
  const found: ReplPushRequestRecord[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    if (event.description.type !== REPL_REPOSITORY_PUSH_REQUEST) {
      continue;
    }
    const record = parseReplPushRequestRecord(event.result.value);
    if (record !== undefined) {
      found.push(record);
    }
  }
  return found;
}

/** Every Git-host outcome this history holds, as the journal holds it. */
function outcomes(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === GIT_HOST_EFFECT,
  );
}

/** Every retained evidence read this history holds, in append order. */
function reads(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === PULL_REQUEST_READ,
  );
}

/**
 * What each retained read holds, sorted so a schedule cannot decide the answer.
 *
 * The collection and its size, read back through the delivered parser: two
 * concurrent reads are two complete envelopes, and which of them was appended
 * first is a fact about when they finished rather than about what each asked.
 */
function collections(
  retained: readonly DurableEvent[],
): { readonly kind: string; readonly items: number }[] {
  const held: { readonly kind: string; readonly items: number }[] = [];
  for (const event of retained) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    for (const kind of ["reviews", "comments", "checks"] as const) {
      const parsed = parseCompletePullRequestReadResult(event.result.value, kind);
      if (parsed !== undefined) {
        held.push({ kind, items: parsed.items.length });
      }
    }
  }
  return held.toSorted((first, second) => first.kind.localeCompare(second.kind));
}

/** Every event but the root's own close, which is what an unfinished run has. */
function terminal(event: DurableEvent): boolean {
  return !(event.type === "close" && event.coroutineId === "root");
}

/** Whether the root settled, which a durability failure leaves unwritten. */
function closedRoot(events: readonly DurableEvent[]): boolean {
  return events.some((event) => event.type === "close" && event.coroutineId === "root");
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

/**
 * A journal that refuses one durable type's appends after the first few.
 *
 * What a pull request's own acknowledgement window needs: an entry publishes a
 * branch and then opens a pull request, and both reconcile through the one
 * shared Git-host position. Refusing every append of that type would stop the
 * entry at its publication, long before the window this is about.
 */
function refusingAfter(inner: InMemoryStream, type: string, allow: number): DurableStream {
  let seen = 0;
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === type) {
        seen += 1;
        if (seen > allow) {
          throw new Error("the journal backend refused this append");
        }
      }
      yield* inner.append(event);
    },
  };
}

/** A journal that holds every append of one durable type, and says when it did. */
function holdingAppend(
  inner: InMemoryStream,
  type: string,
  reached: WithResolvers<void>,
): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (event.type === "yield" && event.description.type === type) {
        reached.resolve();
        yield* suspend();
      }
      yield* inner.append(event);
    },
  };
}

/** The managed checkout a `<Repository name={name}>` row selected. */
function checkoutOf(events: readonly DurableEvent[], branch: string): string {
  const saved = publications(events).find((record) => record.resolved.inputs.branch === branch);
  if (saved === undefined) {
    throw new Error("this history holds no publication of that branch");
  }
  return saved.resolved.checkoutRoot;
}

/** Commit one more file in a managed checkout, as a person at a shell would. */
function* commitThere(checkout: string, name: string): Operation<string> {
  const git = gitSession(denoRepositoryHost(), checkout);
  yield* writeTextFile(join(checkout, name), `${name}\n`);
  yield* git.run(["add", name], checkout);
  yield* git.run(
    [
      "-c",
      "user.name=Shell",
      "-c",
      "user.email=shell@example.test",
      "commit",
      "-m",
      `outside ${name}`,
    ],
    checkout,
  );
  const outcome = yield* git.run(["rev-parse", "HEAD"], checkout);
  return outcome.stdout.trim();
}

/** A question with a file after it, so a continuation has a suffix to run. */
const QUESTION = [
  `  <Elicit schema={{ type: "object", properties: { choice: { enum: ["continue"] } },`,
  `    required: ["choice"], additionalProperties: false }} as="answer">`,
  `The pull request is open. Continue?`,
  `  </Elicit>`,
  `  <File path="after.md">continued</File>`,
].join("\n");

/** The element that opens or updates this suite's pull request. */
function upsert(...attributes: string[]): string[] {
  return [
    `  <PullRequest title=${JSON.stringify(TITLE)}${attributes.join("")} as="pullRequest">`,
    BODY,
    `  </PullRequest>`,
    "",
    `opened {pullRequest.number} at {pullRequest.url} as {pullRequest.state}`,
    "",
  ];
}

/** All three evidence reads of whatever the upsert bound, and their sizes. */
const READS = [
  `  <PullRequest.Reviews url={pullRequest.url} as="reviews" />`,
  `  <PullRequest.Comments url={pullRequest.url} as="comments" />`,
  `  <PullRequest.Checks url={pullRequest.url} as="checks" />`,
  "",
  `evidence {reviews.length} {comments.length} {checks.length}`,
  "",
];

/**
 * A document that publishes a branch in a managed Repository, and then does
 * whatever this row is about.
 */
function entry(
  options: {
    readonly name?: string;
    readonly branch?: string;
    readonly file?: string;
    readonly lines?: readonly string[];
  } = {},
): string {
  const branch = options.branch ?? BRANCH;
  const file = options.file ?? "notes.md";
  return [
    `<Repository name=${JSON.stringify(options.name ?? "project")} url=${JSON.stringify(LOCATOR)}>`,
    `  <Git.Switch branch=${JSON.stringify(branch)} />`,
    `  <File path=${JSON.stringify(file)}>ready</File>`,
    `  <Git.Add paths=${JSON.stringify(file)} />`,
    `  <Git.Commit message="Prepare the release" as="commit" />`,
    `  <Git.Push />`,
    ...(options.lines ?? []),
    `</Repository>`,
    "",
  ].join("\n");
}

describe("one entry's pull request", () => {
  it("Q1: opens it once, and answers a completed one with no Git and no call", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    fixture.evidence.conversation = [comment(21, "thanks")];
    fixture.evidence.runs = [checkRun(31, "build")];
    const first = counters();
    const stream = new InMemoryStream();
    const source = entry({ lines: [...upsert(), ...READS] });

    const ran = yield* run(fixture, source, stream, first);
    expect(ran.refusal).toBe(undefined);

    // One pull request, created once, and the arrays the document bound are
    // what the modeled service holds.
    expect(ran.output).toContain("opened 1 at https://github.com/owner/repository/pull/1 as open");
    expect(ran.output).toContain("evidence 1 1 1");
    expect(mutations(fixture.store)).toEqual(["create"]);
    const saved = requests(ran.events);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.owner).toBe(OWNER);
    expect(saved[0]?.resolved.origin).toBe(LOCATOR);
    expect(saved[0]?.requested.pullRequest.number).toBe(null);
    expect(saved[0]?.requested.pullRequest.title).toBe(TITLE);
    expect(saved[0]?.requested.pullRequest.draft).toBe(false);
    expect(saved[0]?.requested.pullRequest.base).toBe("main");
    // The head is the commit the published branch holds, not a value anything
    // told this entry.
    expect(saved[0]?.resolved.inputs.headSha).toBe(fixture.store.heads.get(BRANCH));
    expect(saved[0]?.resolved.inputs.headBranch).toBe(BRANCH);
    // A publication and a pull request are two outcomes at two positions, and
    // the three reads are three separate retained collections.
    expect(outcomes(ran.events)).toHaveLength(2);
    expect(reads(ran.events)).toHaveLength(3);
    // The credential reached the service and nothing else.
    expect(fixture.store.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(ran.events)).not.toContain(TOKEN);

    // The same entry again, over the history it left. Nothing native happens,
    // nothing is asked of the service, and the arrays are the retained ones.
    const second = counters();
    const sent = fixture.store.requests.length;
    const replayed = new InMemoryStream([...ran.events].filter(terminal));
    const again = yield* run(fixture, source, replayed, second);
    expect(again.refusal).toBe(undefined);
    expect(again.output).toContain(
      "opened 1 at https://github.com/owner/repository/pull/1 as open",
    );
    expect(again.output).toContain("evidence 1 1 1");
    expect(second.commands).toEqual([]);
    expect(second.directories).toBe(0);
    expect(second.sessions).toEqual([]);
    expect(fixture.store.requests.length).toBe(sent);
    const settled = yield* replayed.readAll();
    expect(requests(settled)).toHaveLength(1);
    expect(outcomes(settled)).toHaveLength(2);
    expect(reads(settled)).toHaveLength(3);
  });

  it("Q2: a superseding publication of the same branch decides the head", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    // Two publications of one destination in one entry, then the pull request.
    // The second is what the branch at the host holds, so it is the one the
    // pull request may be opened over.
    const source = [
      `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
      `  <Git.Switch branch=${JSON.stringify(BRANCH)} />`,
      `  <File path="first.md">one</File>`,
      `  <Git.Add paths="first.md" />`,
      `  <Git.Commit message="One" as="one" />`,
      `  <Git.Push />`,
      `  <File path="second.md">two</File>`,
      `  <Git.Add paths="second.md" />`,
      `  <Git.Commit message="Two" as="two" />`,
      `  <Git.Push />`,
      ...upsert(),
      `</Repository>`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, stream, counted);
    expect(ran.refusal).toBe(undefined);
    const published = publications(ran.events);
    expect(published).toHaveLength(2);
    const latest = published[1]?.resolved.inputs.sourceCommit;
    expect(latest).not.toBe(published[0]?.resolved.inputs.sourceCommit);
    expect(requests(ran.events)[0]?.resolved.inputs.headSha).toBe(latest);
    expect(mutations(fixture.store)).toEqual(["create"]);
  });

  it("Q3: another checkout's publication of the same commit authorizes nothing", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    // One entry, two Repositories of the same remote. The first publishes the
    // branch; the second fetches and stands on the very same commit, and asks
    // for the pull request there.
    const source = [
      entry().trimEnd(),
      `<Repository name="second" url=${JSON.stringify(LOCATOR)}>`,
      `  <Git.Switch branch=${JSON.stringify(BRANCH)} />`,
      ...upsert(),
      `</Repository>`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, stream, counted);
    expect(ran.refusal).not.toBe(undefined);
    expect(String(ran.refusal)).toContain("publication");
    // The branch really is at the host, and really is at that commit. What is
    // missing is this checkout's own acknowledged publication of it.
    expect(publications(ran.events)).toHaveLength(1);
    expect(requests(ran.events)).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
  });

  it("Q4: a publication retained under another entry authorizes nothing", function* () {
    const fixture = yield* useFixture();
    const foreign = counters();
    const published = yield* left(fixture, entry({ lines: [QUESTION] }), foreign, {
      owner: FOREIGN_OWNER,
    });
    expect(publications(published)).toHaveLength(1);

    // The same journal, continued by an entry of its own. The history is valid
    // and names a publication of exactly this branch — under somebody else.
    const counted = counters();
    const stream = new InMemoryStream([...published]);
    const ran = yield* run(fixture, entry({ lines: [...upsert(), QUESTION] }), stream, counted, {
      answer: { choice: "continue" },
    });
    expect(ran.refusal).not.toBe(undefined);
    expect(requests(yield* stream.readAll())).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
  });

  it("Q5: a synthetic publication answer authorizes nothing", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    let answered = 0;
    const ran = yield* run(fixture, entry({ lines: [...upsert()] }), stream, counted, {
      *between(): Operation<void> {
        // A handler above the entry's own policy that answers the
        // publication itself. The document is satisfied; nothing was
        // published and nothing was retained, so there is no acknowledged
        // pair for a pull request to be admitted by.
        yield* Git.around({
          // deno-lint-ignore require-yield
          *push([invocation]: [GitPushInvocation]): Operation<GitPushOutcome> {
            answered += 1;
            return {
              decision: "performed",
              result: {
                repository: invocation.repository.identity,
                remote: "origin",
                branch: BRANCH,
                destinationRef: `refs/heads/${BRANCH}`,
                refspec: `${"0".repeat(40)}:refs/heads/${BRANCH}`,
                sourceCommit: "0".repeat(40),
                observedRemoteCommit: "0".repeat(40),
              },
            };
          },
        });
      },
    });
    expect(answered).toBe(1);
    expect(ran.refusal).not.toBe(undefined);
    expect(publications(ran.events)).toEqual([]);
    expect(requests(ran.events)).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
  });

  it("Q6: a head the last publication did not put there refuses before contact", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = entry({ lines: [QUESTION.split("\n").slice(0, 4).join("\n"), ...upsert()] });

    // Published, then left at the question. This pair is exact for the branch
    // it names, and it is the only one.
    const prefix = yield* left(fixture, source, counted);
    const published = publications(prefix);
    expect(published).toHaveLength(1);
    const checkout = checkoutOf(prefix, BRANCH);

    // Somebody advances the managed checkout while the entry is away, without
    // publishing it. The branch at the host still holds the published commit,
    // so the head this pull request would name was never published by anyone.
    const moved = yield* commitThere(checkout, "later.md");
    expect(moved).not.toBe(published[0]?.resolved.inputs.sourceCommit);

    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
    });
    expect(again.refusal).not.toBe(undefined);
    expect(String(again.refusal)).toContain("different");
    expect(requests(yield* stream.readAll())).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
  });

  it("Q7: two spawned publications restore in reverse order and still decide", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // Two branches, two managed Repositories, two questions. Each publishes at
    // its own position in its own coroutine, and each opens its own pull
    // request after its own question is answered.
    const branch = (name: string) =>
      [
        `<Spawn><Repository name=${JSON.stringify(name)} url=${JSON.stringify(LOCATOR)}>`,
        `  <Git.Switch branch=${JSON.stringify(`review/${name}`)} />`,
        `  <File path="${name}.md">${name}</File>`,
        `  <Git.Add paths="${name}.md" />`,
        `  <Git.Commit message="Prepare ${name}" as="commit" />`,
        `  <Git.Push />`,
        `  <Elicit schema={{ type: "object" }} as="answer">Question for ${name}</Elicit>`,
        `  <PullRequest title=${JSON.stringify(`${TITLE} ${name}`)} as="pullRequest">`,
        BODY,
        `  </PullRequest>`,
        "",
        `${name} opened {pullRequest.number} head {pullRequest.headSha}`,
        "",
        `</Repository></Spawn>`,
      ].join("\n");
    const source = ["<All>", branch("alpha"), branch("beta"), "</All>", ""].join("\n");

    const prefix = yield* scoped(function* (): Operation<readonly DurableEvent[]> {
      const stream = new InMemoryStream();
      const waiting = withResolvers<void>();
      let asked = 0;
      const task = yield* spawn(() =>
        run(fixture, source, stream, counted, {
          *between(): Operation<void> {
            yield* Elicitation.around({
              *elicit(): Operation<unknown> {
                asked += 1;
                if (asked === 2) {
                  waiting.resolve();
                }
                return yield* suspend();
              },
            });
          },
        }),
      );
      yield* race([
        waiting.operation,
        (function* (): Operation<never> {
          yield* sleep(60_000);
          throw new Error("both branches never reached their questions");
        })(),
      ]);
      const held = [...(yield* stream.readAll())];
      yield* task.halt();
      return held;
    });

    // Two publications, in a known journal order, and no pull request yet.
    const published = publications(prefix);
    expect(published).toHaveLength(2);
    expect(new Set(published.map((record) => record.site)).size).toBe(2);
    expect(requests(prefix)).toEqual([]);

    // Continued with the answers arriving in the other order, so the two
    // branches reach their pull requests in the opposite scheduling order from
    // the one their publications were acknowledged in. Each pull request is
    // still decided by its own branch's own acknowledged pair.
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      *between(): Operation<void> {
        yield* Elicitation.around({
          *elicit([request]: [{ readonly message: string }]): Operation<unknown> {
            yield* sleep(request.message.includes("alpha") ? 40 : 0);
            return {};
          },
        });
      },
    });
    expect(again.refusal).toBe(undefined);
    const asked = requests(yield* stream.readAll());
    expect(asked).toHaveLength(2);
    expect(new Set(asked.map((record) => record.site)).size).toBe(2);
    for (const name of ["alpha", "beta"]) {
      const own = asked.find((record) => record.requested.pullRequest.title.endsWith(name));
      expect(own).not.toBe(undefined);
      expect(own?.resolved.inputs.headBranch).toBe(`review/${name}`);
      expect(own?.resolved.inputs.headSha).toBe(fixture.store.heads.get(`review/${name}`));
    }
    expect(mutations(fixture.store)).toEqual(["create", "create"]);
  });
});

describe("resuming a pull request", () => {
  it("Q8: an interrupted create resumes the request it saved, not today's head", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = entry({ lines: [...upsert(), QUESTION] });

    // Cut with the request acknowledged and the service holding an observation
    // it never answered: nothing was created, and the journal holds what this
    // entry asked for.
    const prefix = yield* cut(
      fixture,
      source,
      counted,
      (request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/pulls"),
    );
    const saved = requests(prefix);
    expect(saved).toHaveLength(1);
    expect(outcomes(prefix).filter((event) => event.result.status === "ok")).toHaveLength(1);
    expect(fixture.store.pullRequests).toEqual([]);
    const asked = saved[0]?.resolved.inputs;
    expect(asked?.number).toBe(null);

    // Somebody advances the managed checkout while the entry is away. The
    // continuation reconciles the request it already made, at the head that
    // request named.
    const checkout = checkoutOf(prefix, BRANCH);
    const moved = yield* commitThere(checkout, "later.md");
    expect(moved).not.toBe(asked?.headSha);

    let retargeted = 0;
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
      *between(): Operation<void> {
        // Live middleware installed after the cut. A saved request is
        // reconciled as it stands, so nothing here can retarget it.
        yield* PullRequestAPI.around({
          *read([url, options], next): Operation<PullRequestReadResult> {
            retargeted += 1;
            return yield* next(url, options);
          },
        });
      },
    });
    expect(again.refusal).toBe(undefined);
    expect(retargeted).toBe(0);

    // One request, one creation, and every member of it is the one that was
    // written down — including the verbatim body and the original head.
    const settled = yield* stream.readAll();
    expect(requests(settled)).toHaveLength(1);
    expect(mutations(fixture.store)).toEqual(["create"]);
    const created = fixture.store.pullRequests[0];
    expect(created?.title).toBe(TITLE);
    expect(created?.body).toBe(asked?.body);
    expect(created?.draft).toBe(false);
    expect(created?.baseRef).toBe("main");
    expect(created?.headRef).toBe(BRANCH);
    expect(created?.headSha).toBe(asked?.headSha);
    expect(created?.headSha).not.toBe(moved);
  });

  it("Q9: an interrupted numbered update adopts the update it already made", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // One pull request this GitHub already holds, saying something else.
    fixture.store.pullRequests.push(
      stored({ number: 1, title: "Stale title", body: "stale", headRef: BRANCH }),
    );
    const source = entry({ lines: [...upsert(" number={1}"), QUESTION] });

    // The service accepts the update and the journal refuses to record the
    // outcome, which is the window this protocol exists for.
    const backing = new InMemoryStream();
    const ran = yield* run(fixture, source, refusingAfter(backing, GIT_HOST_EFFECT, 1), counted, {
      answer: { choice: "continue" },
    });
    expect(ran.refusal).not.toBe(undefined);
    const prefix = yield* backing.readAll();
    expect(requests(prefix)).toHaveLength(1);
    // The publication's outcome stands; the pull request's never arrived.
    expect(outcomes(prefix)).toHaveLength(1);
    expect(closedRoot(prefix)).toBe(false);
    expect(mutations(fixture.store)).toEqual(["patch"]);
    expect(fixture.store.pullRequests[0]?.title).toBe(TITLE);

    // The continuation observes once, finds the pull request already saying
    // what this entry asked for, and adopts it. Nothing is patched twice.
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
    });
    expect(again.refusal).toBe(undefined);
    expect(again.output).toContain("opened 1 at");
    expect(mutations(fixture.store)).toEqual(["patch"]);
    const settled = yield* stream.readAll();
    expect(requests(settled)).toHaveLength(1);
    expect(outcomes(settled)).toHaveLength(2);
  });

  it("Q10: a cut before the request is acknowledged leaves nothing to resume", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = entry({ lines: [...upsert(), QUESTION] });

    const backing = new InMemoryStream();
    const prefix = yield* scoped(function* (): Operation<readonly DurableEvent[]> {
      const reached = withResolvers<void>();
      const task = yield* spawn(() =>
        run(
          fixture,
          source,
          holdingAppend(backing, REPL_REPOSITORY_PULL_REQUEST_REQUEST, reached),
          counted,
          { answer: { choice: "continue" } },
        ),
      );
      yield* race([
        reached.operation,
        (function* (): Operation<never> {
          yield* sleep(60_000);
          throw new Error("the entry never reached its pull-request request");
        })(),
      ]);
      const held = [...(yield* backing.readAll())];
      yield* task.halt();
      return held;
    });
    // The request was in flight and is not history, so there is nothing for a
    // continuation to restore — and nothing was asked of the service.
    expect(requests(prefix)).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);

    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
    });
    expect(again.refusal).toBe(undefined);
    expect(requests(yield* stream.readAll())).toHaveLength(1);
    expect(mutations(fixture.store)).toEqual(["create"]);
  });
});

describe("what a reopened entry restores", () => {
  it("Q11: a completed upsert and three snapshots restore with refusing leaves", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    fixture.evidence.conversation = [comment(21, "thanks")];
    fixture.evidence.runs = [checkRun(31, "build")];
    const counted = counters();
    const source = entry({ lines: [...upsert(), ...READS, QUESTION] });

    const prefix = yield* left(fixture, source, counted);
    expect(requests(prefix)).toHaveLength(1);
    expect(reads(prefix)).toHaveLength(3);
    const sent = fixture.store.requests.length;

    // The checkout is gone, and the service now says something else entirely.
    yield* rm(checkoutOf(prefix, BRANCH), { recursive: true, force: true });
    fixture.evidence.reviews = [
      review(12, "CHANGES_REQUESTED", "not yet"),
      review(13, "COMMENTED", "a note"),
    ];
    fixture.evidence.conversation = [];
    fixture.evidence.runs = [checkRun(32, "build"), checkRun(33, "lint")];
    const held = fixture.store.pullRequests[0];
    if (held !== undefined) {
      held.title = "Renamed by somebody else";
    }

    // Resumed with both leaves refusing: native Git raises, and this GitHub
    // raises on any request at all.
    fixture.store.observe = () => {
      throw new Error("this GitHub must not be contacted by a continuation");
    };
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
      refuseNative: true,
    });
    delete fixture.store.observe;
    expect(again.refusal).toBe(undefined);

    // The historical pull request and the three historical arrays, exactly.
    expect(again.output).toContain(
      "opened 1 at https://github.com/owner/repository/pull/1 as open",
    );
    expect(again.output).toContain("evidence 1 1 1");
    // Nothing native, nothing sent, and no second request, outcome or read.
    expect(resumed.commands).toEqual([]);
    expect(resumed.sessions).toEqual([]);
    expect(resumed.directories).toBe(0);
    expect(fixture.store.requests.length).toBe(sent);
    const settled = yield* stream.readAll();
    // The suffix after the question ran and the entry finished.
    expect(closedRoot(settled)).toBe(true);
    expect(requests(settled)).toHaveLength(1);
    expect(outcomes(settled)).toHaveLength(2);
    expect(reads(settled)).toHaveLength(3);
  });

  it("Q12: a completed upsert alone restores without reading configuration", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = entry({ lines: [...upsert()] });
    const ran = yield* run(fixture, source, new InMemoryStream(), counted);
    expect(ran.refusal).toBe(undefined);

    const resumed = counters();
    const replayed = new InMemoryStream([...ran.events].filter(terminal));
    const again = yield* run(fixture, source, replayed, resumed, { refuseNative: true });
    expect(again.refusal).toBe(undefined);
    expect(again.output).toContain("opened 1 at");
    // No transport was needed, so this deployment's pull-request configuration
    // was never read and no source was ever built.
    expect(resumed.env).toEqual([]);
    expect(resumed.commands).toEqual([]);
  });

  it("Q13: an authored read after the question observes today's evidence", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    const source = entry({
      lines: [
        ...upsert(),
        `  <PullRequest.Reviews url={pullRequest.url} as="reviews" />`,
        "",
        `historical {reviews.length}`,
        "",
        QUESTION.split("\n").slice(0, 4).join("\n"),
        `  <PullRequest.Reviews url={pullRequest.url} as="fresh" />`,
        "",
        `fresh {fresh.length}`,
        "",
      ],
    });

    const prefix = yield* left(fixture, source, counted);
    expect(reads(prefix)).toHaveLength(1);

    // The service gains two more reviews while the entry is away.
    fixture.evidence.reviews = [
      review(11, "APPROVED", "ship it"),
      review(12, "COMMENTED", "a note"),
      review(13, "COMMENTED", "another"),
    ];
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
    });
    expect(again.refusal).toBe(undefined);
    // The first read answers historically; the one after the question is a new
    // occurrence and reaches today's transport.
    expect(again.output).toContain("historical 1");
    expect(again.output).toContain("fresh 3");
    expect(reads(yield* stream.readAll())).toHaveLength(2);
  });
});

/**
 * The two pull requests the read rows name directly.
 *
 * A read needs no Repository and no checkout, so these rows write the URL the
 * way a document that already has one does — and the entry they run in has no
 * managed root at all, which is also B10's rootless case.
 */
const FIRST_URL = `${LOCATOR}/pull/1`;
const SECOND_URL = `${LOCATOR}/pull/2`;

describe("evidence reads inside one entry", () => {
  it("Q14: outer handlers still compose over a restored snapshot", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    const source = [
      `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
      "",
      `reviews {reviews.length}`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, new InMemoryStream(), counted, { root: undefined });
    expect(ran.refusal).toBe(undefined);
    expect(ran.output).toContain("reviews 1");
    const retained = reads(ran.events);
    expect(retained).toHaveLength(1);
    const snapshot = JSON.stringify(retained[0]?.type === "yield" ? retained[0].result : undefined);
    const sent = fixture.store.requests.length;

    // Two handlers above the entry's own transport, each transforming what it
    // is answered with. Nothing below them is reached: the snapshot is history.
    const order: string[] = [];
    const resumed = counters();
    const replayed = new InMemoryStream([...ran.events].filter(terminal));
    const again = yield* run(fixture, source, replayed, resumed, {
      root: undefined,
      *between(): Operation<void> {
        yield* PullRequestAPI.around({
          *read([url, options], next): Operation<PullRequestReadResult> {
            order.push("outer");
            const answered = yield* next(url, options);
            return answered.kind === "reviews"
              ? { kind: "reviews", items: [...answered.items, reviewEvidence(91, "dismissed")] }
              : answered;
          },
        });
        yield* PullRequestAPI.around({
          *read([url, options], next): Operation<PullRequestReadResult> {
            order.push("inner");
            const answered = yield* next(url, options);
            return answered.kind === "reviews"
              ? { kind: "reviews", items: [...answered.items, reviewEvidence(92, "pending")] }
              : answered;
          },
        });
      },
    });
    expect(again.refusal).toBe(undefined);
    // What the document bound is what the whole composition finished with.
    expect(again.output).toContain("reviews 3");
    // In band order, and over a snapshot that was never asked for again.
    expect(order).toEqual(["outer", "inner"]);
    expect(fixture.store.requests.length).toBe(sent);
    const settled = reads(yield* replayed.readAll());
    expect(settled).toHaveLength(1);
    expect(JSON.stringify(settled[0]?.type === "yield" ? settled[0].result : undefined)).toBe(
      snapshot,
    );
  });

  it("Q15: a URL this deployment no longer allows refuses before the snapshot", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    const source = [
      `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
      "",
      `reviews {reviews.length}`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, new InMemoryStream(), counted, { root: undefined });
    expect(ran.refusal).toBe(undefined);
    const sent = fixture.store.requests.length;

    // The operator withdrew permission for that container while the entry was
    // away. A snapshot this entry already holds is not permission to bind it.
    const resumed = counters();
    const replayed = new InMemoryStream([...ran.events].filter(terminal));
    const again = yield* run(fixture, source, replayed, resumed, {
      root: undefined,
      allowed: ["https://github.com/owner/elsewhere"],
    });
    expect(again.refusal).not.toBe(undefined);
    expect(String(again.refusal)).toContain("has not authorized");
    expect(again.output).not.toContain("reviews 1");
    expect(fixture.store.requests.length).toBe(sent);
    expect(reads(yield* replayed.readAll())).toHaveLength(1);
  });

  it("Q16: two concurrent reads completing in reverse order keep their own questions", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    fixture.evidence.conversation = [comment(21, "one"), comment(22, "two")];
    const counted = counters();
    // Each binding is rendered inside the branch that made it, because a
    // `<Spawn>` child's binding belongs to its own branch rather than the root.
    const source = [
      "<All>",
      `<Spawn><PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="a" />`,
      "",
      `branch a {a.length}`,
      "",
      "</Spawn>",
      `<Spawn><PullRequest.Comments url=${JSON.stringify(SECOND_URL)} as="b" />`,
      "",
      `branch b {b.length}`,
      "",
      "</Spawn>",
      "</All>",
      "",
    ].join("\n");

    // The reviews call is held long enough that the comments occurrence
    // finishes first, so the two complete in the opposite order from the one
    // they were written in.
    fixture.gate.hold = function* (request: GitHubHttpRequest): Operation<void> {
      if (new URL(request.url).pathname.endsWith("/reviews")) {
        yield* sleep(60);
      }
    };
    const ran = yield* run(fixture, source, new InMemoryStream(), counted, { root: undefined });
    expect(ran.refusal).toBe(undefined);
    // Each occurrence bound its own collection, from its own URL.
    expect(ran.output).toContain("branch a 1");
    expect(ran.output).toContain("branch b 2");

    // Two retained reads, each holding the collection its own question asked
    // for, each named by that question, each standing in its own coroutine.
    const retained = reads(ran.events);
    expect(retained).toHaveLength(2);
    expect(collections(retained)).toEqual([
      { kind: "comments", items: 2 },
      { kind: "reviews", items: 1 },
    ]);
    const names = retained.map((event) => (event.type === "yield" ? event.description.name : ""));
    expect(new Set(names).size).toBe(2);
    const coroutines = new Set(
      retained.map((event) => (event.type === "yield" ? event.coroutineId : "")),
    );
    expect(coroutines.size).toBe(2);
    expect(coroutines.has("root")).toBe(false);

    // Replayed, each occurrence consumes its own snapshot and nothing else.
    const sent = fixture.store.requests.length;
    delete fixture.gate.hold;
    const resumed = counters();
    const replayed = new InMemoryStream([...ran.events].filter(terminal));
    const again = yield* run(fixture, source, replayed, resumed, { root: undefined });
    expect(again.refusal).toBe(undefined);
    expect(again.output).toContain("branch a 1");
    expect(again.output).toContain("branch b 2");
    expect(fixture.store.requests.length).toBe(sent);
    expect(reads(yield* replayed.readAll())).toHaveLength(2);
  });

  it("Q17: a read a handler starts for itself reaches no occurrence's callback", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    fixture.evidence.conversation = [comment(21, "one")];
    const counted = counters();
    const source = [
      `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
      "",
      `reviews {reviews.length}`,
      "",
    ].join("\n");

    let started = 0;
    let refused: string | undefined;
    const ran = yield* run(fixture, source, new InMemoryStream(), counted, {
      root: undefined,
      *between(): Operation<void> {
        yield* PullRequestAPI.around({
          *read([url, options], next): Operation<PullRequestReadResult> {
            // A read this handler starts for itself, from inside the dispatch
            // of an occurrence that asked for something else. There is no
            // ambient callback to find: the occurrence's own terminal belongs
            // to the descriptor it dispatched through, and this is not it.
            if (options.kind === "reviews" && started === 0) {
              started += 1;
              try {
                yield* PullRequestAPI.operations.read(SECOND_URL, { kind: "comments" });
              } catch (error) {
                refused = error instanceof Error ? error.message : String(error);
              }
            }
            return yield* next(url, options);
          },
        });
      },
    });
    expect(started).toBe(1);
    expect(refused).not.toBe(undefined);
    expect(String(refused)).toContain("no pull-request provider handles");
    // The occurrence that was actually written is unaffected, and exactly one
    // read was retained: the handler's own question consumed nothing.
    expect(ran.refusal).toBe(undefined);
    expect(ran.output).toContain("reviews 1");
    expect(reads(ran.events)).toHaveLength(1);
  });
});

describe("acknowledgement and failure", () => {
  it("Q18: a request this journal refused asks the Git host nothing", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const backing = new InMemoryStream();
    const ran = yield* run(
      fixture,
      entry({ lines: [...upsert()] }),
      refusing(backing, REPL_REPOSITORY_PULL_REQUEST_REQUEST),
      counted,
    );
    expect(ran.refusal).not.toBe(undefined);
    const held = yield* backing.readAll();
    // The publication stands. The pull request was never written down, so
    // nothing authorized a call — and no completion was invented for it.
    expect(publications(held)).toHaveLength(1);
    expect(requests(held)).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
    expect(closedRoot(held)).toBe(false);
  });

  it("Q19: a created pull request whose outcome was refused is adopted, never made twice", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = entry({ lines: [...upsert(), QUESTION] });
    const backing = new InMemoryStream();

    const ran = yield* run(fixture, source, refusingAfter(backing, GIT_HOST_EFFECT, 1), counted, {
      answer: { choice: "continue" },
    });
    expect(ran.refusal).not.toBe(undefined);
    const prefix = yield* backing.readAll();
    // The service holds the pull request and this end never learned that it
    // does: one saved request, the publication's outcome only, no binding and
    // no close.
    expect(requests(prefix)).toHaveLength(1);
    expect(outcomes(prefix)).toHaveLength(1);
    expect(mutations(fixture.store)).toEqual(["create"]);
    expect(closedRoot(prefix)).toBe(false);
    expect(ran.output).not.toContain("opened 1 at");

    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, { answer: { choice: "continue" } });
    expect(again.refusal).toBe(undefined);
    expect(again.output).toContain("opened 1 at");
    // Observed once and adopted. Nothing was created a second time.
    expect(mutations(fixture.store)).toEqual(["create"]);
    expect(fixture.store.pullRequests).toHaveLength(1);
    const settled = yield* stream.readAll();
    expect(requests(settled)).toHaveLength(1);
    expect(outcomes(settled)).toHaveLength(2);
  });

  it("Q20: an entry cancelled with its call in flight retains the request alone", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const prefix = yield* cut(
      fixture,
      entry({ lines: [...upsert(), QUESTION] }),
      counted,
      (request) => request.method === "POST",
    );
    // The creation was received and never answered, so the entry was halted
    // with its own attempt joined. What it retained is the request it had
    // already acknowledged, and nothing about an outcome.
    expect(requests(prefix)).toHaveLength(1);
    expect(outcomes(prefix)).toHaveLength(1);
    expect(fixture.store.pullRequests).toEqual([]);
    expect(closedRoot(prefix)).toBe(false);
    expect(reads(prefix)).toEqual([]);
  });
});

describe("what an entry's assembly reaches", () => {
  it("Q21: building the capability declares six names and acquires nothing", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* scoped(function* (): Operation<void> {
      const installation = yield* replRepositoryInstallation(OWNER, {
        host: countingHost(fixture, counted, { refuseNative: true }),
        identity: statedIdentity,
        root: fixture.managed,
      });
      expect((installation.components ?? []).map((component) => component.name).toSorted()).toEqual(
        [
          "Git.Push",
          "Issue",
          "PullRequest",
          "PullRequest.Checks",
          "PullRequest.Comments",
          "PullRequest.Reviews",
        ],
      );
      // One walk for the two publication protocols, one for issues, one for
      // retained reads.
      expect((installation.admissions ?? []).length).toBe(3);
    });
    // Naming it read no configuration, ran no Git, took no directory and
    // opened no session.
    expect(counted.commands).toEqual([]);
    expect(counted.directories).toBe(0);
    expect(counted.sessions).toEqual([]);
    expect(counted.env).toEqual([]);
    expect(fixture.store.requests).toEqual([]);
  });

  it("Q22: an entry with no managed root reads an allowed URL and opens nothing", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    const reading = yield* run(
      fixture,
      [
        `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
        "",
        `reviews {reviews.length}`,
        "",
      ].join("\n"),
      new InMemoryStream(),
      counted,
      { root: undefined },
    );
    expect(reading.refusal).toBe(undefined);
    expect(reading.output).toContain("reviews 1");
    // A read needs no Repository, so nothing local was discovered for it.
    expect(counted.commands).toEqual([]);
    expect(counted.directories).toBe(0);
    expect(reads(reading.events)).toHaveLength(1);

    // The upsert in the same entry keeps the absent local capability: with no
    // managed root there is no selection to publish from and none to open a
    // pull request over, and nothing is contacted about it.
    const absent = counters();
    const stream = new InMemoryStream();
    const opened = yield* run(fixture, entry({ lines: [...upsert()] }), stream, absent, {
      root: undefined,
    });
    expect(opened.refusal).not.toBe(undefined);
    expect(requests(yield* stream.readAll())).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
  });
});

describe("a retained read this entry cannot account for", () => {
  it("Q23: every tampered read description refuses before anything replays", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    const source = [
      `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
      "",
      `reviews {reviews.length}`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, new InMemoryStream(), counted, { root: undefined });
    expect(ran.refusal).toBe(undefined);
    const history = [...ran.events].filter(terminal);
    const retained = history.findIndex(
      (event) => event.type === "yield" && event.description.type === PULL_REQUEST_READ,
    );
    expect(retained).toBeGreaterThan(-1);
    const original = history[retained];
    if (original === undefined || original.type !== "yield") {
      throw new Error("that run retained no evidence read");
    }
    const sent = fixture.store.requests.length;

    // Six ways one retained read can fail to be this entry's own question, and
    // one answer to all of them: the history is not continued, nothing is
    // asked of the service, and the document binds nothing.
    const tampered: Record<string, DurableEvent> = {
      "a name its own question does not produce": {
        ...original,
        description: { ...original.description, name: "something-else" },
      },
      "an empty configuration": {
        ...original,
        description: { ...original.description, configuration: "" },
      },
      "a question made under another owner": {
        ...original,
        description: {
          ...original.description,
          input: { ...Object(original.description.input), runId: FOREIGN_OWNER },
        },
      },
      "a question whose collection is not one of the three": {
        ...original,
        description: {
          ...original.description,
          input: { ...Object(original.description.input), kind: "everything" },
        },
      },
      "a question whose URL is not canonical": {
        ...original,
        description: {
          ...original.description,
          input: { ...Object(original.description.input), url: `${FIRST_URL}?token=hunter2` },
        },
      },
      "a success holding another collection": {
        ...original,
        result: { status: "ok", value: { kind: "comments", items: [] } },
      },
    };

    for (const [what, event] of Object.entries(tampered)) {
      const replacement = [...history];
      replacement[retained] = event;
      const resumed = counters();
      const stream = new InMemoryStream(replacement);
      const again = yield* run(fixture, source, stream, resumed, { root: undefined });
      // `what` travels into the comparison so a failure names which tampering
      // was admitted rather than only that one of six was.
      expect([what, again.refusal === undefined]).toEqual([what, false]);
      expect([what, again.output.includes("reviews 1")]).toEqual([what, false]);
      expect([what, fixture.store.requests.length]).toEqual([what, sent]);
      expect([what, resumed.commands]).toEqual([what, []]);
    }
  });

  it("Q24: an ordinary failed read is admitted, and replays as the failure it was", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // The service cannot answer, so this read is an ordinary failure rather
    // than a success — and an ordinary failure is history like any other.
    fixture.evidence.refuses = 500;
    const source = [
      `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
      "",
      `reviews {reviews.length}`,
      "",
    ].join("\n");
    const backing = new InMemoryStream();
    const ran = yield* run(fixture, source, backing, counted, { root: undefined });
    expect(ran.refusal).not.toBe(undefined);
    const history = yield* backing.readAll();
    const retained = reads(history);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.type === "yield" ? retained[0].result.status : "ok").not.toBe("ok");

    // Continued: the failed read is admitted with its complete question, and
    // what it replays as is the same ordinary failure. Nothing is asked again.
    delete fixture.evidence.refuses;
    const sent = fixture.store.requests.length;
    const resumed = counters();
    const stream = new InMemoryStream([...history].filter(terminal));
    const again = yield* run(fixture, source, stream, resumed, { root: undefined });
    expect(again.refusal).not.toBe(undefined);
    expect(fixture.store.requests.length).toBe(sent);
    expect(reads(yield* stream.readAll())).toHaveLength(1);
  });
});
