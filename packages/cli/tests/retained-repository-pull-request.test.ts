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
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import process from "node:process";
import { readGit, runGit } from "./support/fixture-git.ts";
import { gitShim } from "./support/repl-push-journey.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { collect, Elicitation } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { Git } from "@executablemd/git/api";
import type { GitPushInvocation } from "@executablemd/git/api";
import type { GitPushOutcome } from "@executablemd/git";
import { PullRequestAPI } from "@executablemd/git/api";
import { createApi } from "@effectionx/context-api";
import { PULL_REQUEST_OPERATIONS } from "@executablemd/git/api";
import type { PullRequestOperationsApi } from "@executablemd/git/api";
import type { PullRequestResult } from "@executablemd/git";
import { parseCompletePullRequestReadResult } from "@executablemd/git";
import type { PullRequestReadResult } from "@executablemd/git/api";
import { useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import type { GitHostProvider } from "@executablemd/git";
import { replRepositoryInstallation } from "../src/repl/repositories/deno/provider.ts";
import { admitReplRepositoryHistory } from "../src/repl/repositories/admission.ts";
import { useCompositionComponents } from "@executablemd/git";
import { GIT_HOST_EFFECT } from "@executablemd/git";
import { parseGitHostReconciliationRecord } from "@executablemd/git";
import { parsePullRequestInputs } from "@executablemd/git";
import {
  parseReplPullRequestRequestRecord,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
} from "../src/repl/repositories/pull-request-records.ts";
import type { ReplPullRequestRequestRecord } from "../src/repl/repositories/pull-request-records.ts";
import {
  parseReplPushRequestRecord,
  REPL_REPOSITORY_PUSH_REQUEST,
} from "../src/repl/repositories/push-records.ts";
import type { ReplPushRequestRecord } from "../src/repl/repositories/push-records.ts";
import { PULL_REQUEST_READ } from "@executablemd/git/deno";
import { gitHubStore, mutations, respond } from "../../git/tests/support/github.ts";
import { stored } from "../../git/tests/support/pull-requests.ts";
import type { GitHubStore } from "../../git/tests/support/github.ts";

/**
 * The variable a deployment writes its pull-request configuration into.
 *
 * Stated as data rather than imported: the name is part of the released
 * configuration contract, and a fixture that reached the adapter's own private
 * constant to spell it would be asserting the adapter against itself.
 */
const PULL_REQUEST_CONFIGURATION = "XMD_WORKFLOW_GITHUB_PULL_REQUESTS";

/** One request this suite's modeled GitHub receives, as its transport sees it. */
interface GitHubHttpRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** One answer it gives back. */
interface GitHubHttpResponse {
  readonly status: number;
  readonly body: string;
  /** The `Link` header, when there is one. Pagination is read from it. */
  readonly link?: string;
}

/**
 * The semantic pull-request chain, as a composing caller reaches it.
 *
 * Built from the published name and interface, which is what makes a
 * contextual Api composable: a descriptor created under the same stable name
 * joins the same chain the entry's own invocation-local terminal sits at the
 * end of. The value Git builds internally is private and is not what a caller
 * composes onto — this suite is a caller.
 *
 * Its defaults refuse, because a row installing middleware here always
 * delegates to the live chain below and never wants this object to answer.
 */
const PullRequestOperations = createApi<PullRequestOperationsApi>(PULL_REQUEST_OPERATIONS, {
  *read(): Operation<never> {
    throw new Error("this suite composes onto the read chain and never terminates it");
  },
  *upsert(): Operation<never> {
    throw new Error("this suite composes onto the upsert chain and never terminates it");
  },
});

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
  /** Every `git` the shim has seen, so a row may read what really ran. */
  readonly commands: string;
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
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    yield* until(mkdir(seed, { recursive: true }));
    yield* runGit(root, ["init", "--bare", "-b", "main", origin]);
    yield* runGit(root, ["init", "-b", "main", seed]);
    yield* writeTextFile(join(seed, "seed.md"), "seed\n");
    yield* runGit(seed, ["add", "seed.md"]);
    yield* runGit(seed, ["commit", "-m", "seed"]);
    yield* runGit(seed, ["push", origin, "main:refs/heads/main"]);

    const checkout = join(root, "checkout");
    yield* runGit(root, ["clone", origin, checkout]);
    const link = join(root, "entered");
    yield* until(symlink(checkout, link));

    // Where the logical GitHub locator this suite's documents write actually
    // goes. Mapped at the executable leaf rather than inside the entry: the
    // production host pins every configuration *file* off, so only an
    // invocation-local `-c` reaches its Git — and this `url.<real>.insteadOf`
    // is applied at transport time, which leaves `remote.origin.url` holding
    // the locator the document wrote. `protocol.allow=never` with `file`
    // allowed is what makes a missed mapping a refusal rather than a request
    // to the real service.
    const shim = yield* gitShim(root, { map: { from: LOCATOR, to: origin } });
    const shimmed = join(root, "git-shim");
    const beforePath = process.env.PATH;
    process.env.PATH = `${shimmed}:${beforePath ?? ""}`;
    yield* ensure(function* (): Operation<void> {
      if (beforePath === undefined) {
        delete process.env.PATH;
        return;
      }
      process.env.PATH = beforePath;
    });

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
      commands: shim.log,
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
    base.endpoint = `http://127.0.0.1:${listeningPort(server.address())}`;
    yield* provide(base.endpoint);
  });
}

/** The port a listening server reports, or the failure that it reports none. */
function listeningPort(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") {
    throw new Error("this listener reported no address with a port");
  }
  return address.port;
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

/** What a substituted credential broker reported about its own lifetime. */
interface BlockingLogin {
  /** Resolves once the broker is running and has answered nothing. */
  readonly started: Operation<void>;
  /** Whether the broker's process is still there. */
  alive(): Operation<boolean>;
}

/**
 * A Git-host login command that blocks, on this entry's own path.
 *
 * The leaf this host asks for a credential when neither explicit variable
 * names one. Substituting the command rather than the source keeps the entry
 * assembly exactly as production builds it: nothing here is an option the
 * factory grew, and the operation under test still opens the shipped transport.
 */
function useBlockingLogin(fixture: Fixture): Operation<BlockingLogin> {
  return resource<BlockingLogin>(function* (provide) {
    const directory = join(fixture.root, "broker");
    const marks = join(fixture.root, "broker-marks");
    yield* ensureDir(directory);
    yield* ensureDir(marks);
    yield* writeTextFile(
      join(directory, "gh"),
      [
        "#!/bin/sh",
        `echo $$ > ${JSON.stringify(join(marks, "pid"))}`,
        `: > ${JSON.stringify(join(marks, "started"))}`,
        "while true; do sleep 0.05; done",
        "",
      ].join("\n"),
    );
    yield* until(chmod(join(directory, "gh"), 0o755));

    // No explicit credential, so the broker is what this host asks. Both
    // variables and the path are restored with this resource.
    const held = {
      path: process.env["PATH"],
      token: process.env["GH_TOKEN"],
      other: process.env["GITHUB_TOKEN"],
    };
    process.env["PATH"] = `${directory}:${held.path ?? ""}`;
    delete process.env["GH_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    yield* ensure(function* (): Operation<void> {
      restoreVariable("PATH", held.path);
      restoreVariable("GH_TOKEN", held.token);
      restoreVariable("GITHUB_TOKEN", held.other);
    });

    const reached = withResolvers<void>();
    const watching = yield* spawn(function* (): Operation<void> {
      while (!(yield* exists(join(marks, "started")))) {
        yield* sleep(10);
      }
      reached.resolve();
    });
    yield* ensure(() => watching.halt());

    yield* provide({
      started: reached.operation,
      *alive(): Operation<boolean> {
        if (!(yield* exists(join(marks, "pid")))) {
          return false;
        }
        const pid = Number((yield* readTextFile(join(marks, "pid"))).trim());
        try {
          // Signal 0 asks the operating system whether the process is there.
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    });
  });
}

/** Put one environment variable back exactly as it was, absence included. */
function restoreVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

/** What the host beneath the recorder was asked to do. */
interface Counters {
  /** Every repository-handle method this entry called, by name, in order. */
  methods: string[];
  /** Every configuration variable this entry read, in order. */
  env: string[];
}

function counters(): Counters {
  return { methods: [], env: [] };
}

/** The handle methods one entry called, in order. */
function methodsCalled(counted: Counters): string[] {
  return [...counted.methods];
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

/**
 * The production handle, counted, with the modeled host kept in step.
 *
 * Every method is wrapped rather than replaced: what these rows need to know is
 * whether a publication really happened and what the pull request's head really
 * is, and the only honest way to answer is to let the real provider publish and
 * then read the remote.
 *
 * The logical GitHub locator the document writes is not swapped here. It is
 * mapped at the executable leaf the fixture installs, so the rewrite is
 * invocation-local, every protocol but `file` is refused, and what Git stores
 * as `remote.origin.url` stays the locator the document wrote.
 *
 * The returned provider is decorated so the modeled GitHub learns what the real
 * remote now holds: after a delegated stage succeeds, this reads that branch's
 * bare ref with the fixture's own executable and refreshes the model from the
 * value it finds. The delegated `Result` is returned unchanged — nothing here
 * invents a publication or populates a head from what was merely asked for.
 */
function countingOperations(
  fixture: Fixture,
  counted: Counters,
  options: RunOptions = {},
): () => Operation<DenoRepositoryOperations> {
  if (options.refuseNative === true) {
    return refusingOperations(counted);
  }
  return function* (): Operation<DenoRepositoryOperations> {
    const operations = yield* useDenoRepositoryOperations();
    const wrapped: DenoRepositoryOperations = {
      ...operations,
      *currentBranch(directory) {
        counted.methods.push("currentBranch");
        return yield* operations.currentBranch(directory);
      },
      *resolveCommit(directory, revision) {
        counted.methods.push("resolveCommit");
        return yield* operations.resolveCommit(directory, revision);
      },
      *commitPresent(directory, commit) {
        counted.methods.push("commitPresent");
        return yield* operations.commitPresent(directory, commit);
      },
      *pushProvider(commonDirectory, origin, inputs) {
        counted.methods.push("pushProvider");
        const provider = yield* operations.pushProvider(commonDirectory, origin, inputs);
        const learned: GitHostProvider = {
          *observe(...given) {
            const observed = yield* provider.observe(...given);
            yield* learnHead(fixture, inputs.branch);
            return observed;
          },
          *perform(...given) {
            const performed = yield* provider.perform(...given);
            yield* learnHead(fixture, inputs.branch);
            return performed;
          },
        };
        return learned;
      },
    };
    return wrapped;
  };
}

/** A handle whose every method records the unexpected call and refuses it. */
function refusingOperations(counted: Counters): () => Operation<DenoRepositoryOperations> {
  function* refuse(method: string): Operation<never> {
    counted.methods.push(method);
    throw new Error(`this row's repository handle must not be reached: ${method}`);
  }
  // deno-lint-ignore require-yield
  return function* (): Operation<DenoRepositoryOperations> {
    return {
      *ambientCheckout() {
        return yield* refuse("ambientCheckout");
      },
      *ambientRepository() {
        return yield* refuse("ambientRepository");
      },
      *selectRepository() {
        return yield* refuse("selectRepository");
      },
      *selectWorktree() {
        return yield* refuse("selectWorktree");
      },
      *switch() {
        return yield* refuse("switch");
      },
      *add() {
        return yield* refuse("add");
      },
      *commit() {
        return yield* refuse("commit");
      },
      *currentBranch() {
        return yield* refuse("currentBranch");
      },
      *resolveCommit() {
        return yield* refuse("resolveCommit");
      },
      *commitPresent() {
        return yield* refuse("commitPresent");
      },
      *observe() {
        return yield* refuse("observe");
      },
      *pushProvider() {
        return yield* refuse("pushProvider");
      },
    };
  };
}

/**
 * Tell the modeled GitHub what the real remote now holds for one branch.
 *
 * Read rather than inferred: the value comes from the bare repository the
 * publication actually wrote to, so a model head is never populated from what
 * somebody asked for. An absent ref deletes the entry, because "not there" is
 * an answer the model has to be able to hold.
 */
function* learnHead(fixture: Fixture, branch: string): Operation<void> {
  const held = yield* readGit(fixture.origin, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (held === undefined) {
    fixture.store.heads.delete(branch);
    return;
  }
  fixture.store.heads.set(branch, held);
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
  /** Whether this entry's repository handle refuses every method. */
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
          return name === PULL_REQUEST_CONFIGURATION ? stated : undefined;
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
      operations: countingOperations(fixture, counted, options),
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

/** Where each durable position of one type stands in this history. */
function positionsOf(events: readonly DurableEvent[], type: string): number[] {
  const found: number[] = [];
  events.forEach((event, index) => {
    if (event.type === "yield" && event.description.type === type) {
      found.push(index);
    }
  });
  return found;
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
  yield* writeTextFile(join(checkout, name), `${name}\n`);
  yield* runGit(checkout, ["add", name]);
  yield* runGit(checkout, [
    "-c",
    "user.name=Shell",
    "-c",
    "user.email=shell@example.test",
    "commit",
    "-m",
    `outside ${name}`,
  ]);
  return yield* runGit(checkout, ["rev-parse", "HEAD"]);
}

/** The commit a ref on the bare remote holds, or `undefined` for absence. */
function remoteCommit(fixture: Fixture, branch: string): Operation<string | undefined> {
  return readGit(fixture.origin, ["rev-parse", "--verify", `refs/heads/${branch}`]);
}

/** Move a checkout back to an earlier commit, as a person at a shell would. */
function* resetThere(checkout: string, commit: string): Operation<void> {
  yield* runGit(checkout, ["reset", "--hard", commit]);
}

/** Leave the published branch behind for another one, as a person would. */
function* switchThere(checkout: string, branch: string): Operation<void> {
  yield* runGit(checkout, ["checkout", "-b", branch]);
}

/** The pull-request inputs reconciliation was actually asked about. */
function reconciledInputs(events: readonly DurableEvent[]): Record<string, unknown> | undefined {
  for (const event of outcomes(events)) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    const inputs = record === undefined ? undefined : parsePullRequestInputs(record.request.inputs);
    if (inputs !== undefined) {
      return {
        number: inputs.number,
        title: inputs.title,
        body: inputs.body,
        draft: inputs.draft,
        headBranch: inputs.headBranch,
        headSha: inputs.headSha,
        baseBranch: inputs.baseBranch,
      };
    }
  }
  return undefined;
}

/** What the shared engine decided at each reconciled position, in order. */
function decisionsOf(events: readonly DurableEvent[]): string[] {
  const found: string[] = [];
  for (const event of outcomes(events)) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    if (record !== undefined) {
      found.push(record.decision);
    }
  }
  return found;
}

/** One named question, for a branch whose readiness a row gates on. */
function question(name: string, text: string): string {
  return `    <Elicit schema={{ type: "object" }} as=${JSON.stringify(name)}>${text}</Elicit>`;
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
    expect(methodsCalled(second)).toEqual([]);
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

  it("Q7: two real publishers of one destination, restored in reverse, still decide", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    // Two publishers of the *same* destination in one entry, each in its own
    // coroutine. The second commits on top of the first and publishes the same
    // branch, so both pairs are relevant to the pull request below and only the
    // later one describes the branch the Git host now holds.
    //
    // The first publisher reads evidence *before* it publishes. That read is an
    // ordinary admitted occurrence, and on continuation it restores through the
    // live semantic chain — which is what gives this row somewhere to hold that
    // branch before its publication restores rather than after.
    const source = [
      `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
      `  <Git.Switch branch=${JSON.stringify(BRANCH)} />`,
      `  <File path="base.md">base</File>`,
      `  <Git.Add paths="base.md" />`,
      `  <Git.Commit message="Base" as="base" />`,
      `  <All>`,
      `    <Spawn>`,
      `      <File path="one.md">one</File>`,
      `      <Git.Add paths="one.md" />`,
      `      <Git.Commit message="One" as="one" />`,
      `      <PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="watched" />`,
      `      <Git.Push />`,
      question("afterFirst", "first published"),
      `    </Spawn>`,
      `    <Spawn>`,
      question("beforeSecond", "second waiting"),
      `      <File path="two.md">two</File>`,
      `      <Git.Add paths="two.md" />`,
      `      <Git.Commit message="Two" as="two" />`,
      `      <Git.Push />`,
      question("afterSecond", "second published"),
      `    </Spawn>`,
      `  </All>`,
      ...upsert(),
      `</Repository>`,
      "",
    ].join("\n");

    // Readiness gates rather than elapsed time: the second publisher is
    // released exactly when the first has published and reached its question,
    // so the acknowledged order is arranged rather than hoped for.
    const published = withResolvers<void>();
    const prefix = yield* scoped(function* (): Operation<readonly DurableEvent[]> {
      const stream = new InMemoryStream();
      const waiting = withResolvers<void>();
      let held = 0;
      const task = yield* spawn(() =>
        run(fixture, source, stream, counted, {
          *between(): Operation<void> {
            yield* Elicitation.around({
              *elicit([request]: [{ readonly message: string }]): Operation<unknown> {
                if (request.message.includes("second waiting")) {
                  // Released only once the first publication is history.
                  yield* published.operation;
                  return {};
                }
                if (request.message.includes("first published")) {
                  published.resolve();
                }
                held += 1;
                if (held === 2) {
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
          throw new Error("both publishers never reached their questions");
        })(),
      ]);
      const events = [...(yield* stream.readAll())];
      yield* task.halt();
      return events;
    });

    // Two publications of one destination, at two commits, in a known
    // acknowledged order — and no pull request yet.
    const pairs = publications(prefix);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((record) => record.resolved.inputs.branch === BRANCH)).toBe(true);
    const earlier = pairs[0]?.resolved.inputs.sourceCommit;
    const later = pairs[1]?.resolved.inputs.sourceCommit;
    expect(earlier).not.toBe(later);
    expect(outcomes(prefix)).toHaveLength(2);
    expect(reads(prefix)).toHaveLength(1);
    expect(requests(prefix)).toEqual([]);
    expect(yield* remoteCommit(fixture, BRANCH)).toBe(later);

    // Continued with the earlier publisher held at its own read, before its
    // publication can restore, until the later publisher has passed its own
    // post-publication checkpoint. So the two publications restore in the
    // opposite order from the one they were acknowledged in.
    const checkpoints: string[] = [];
    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const parked = withResolvers<void>();
    const release = withResolvers<void>();
    let holding = false;
    let heldWhenSecondRestored = false;
    // Both armed before anything waits on either, so a failure below cannot
    // leave a branch held at a gate nobody releases.
    yield* ensure(() => release.resolve());
    yield* ensure(() => parked.resolve());
    const again = yield* run(fixture, source, stream, resumed, {
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *read([invocation], next): Operation<PullRequestReadResult> {
            // The first publisher's own pre-publication read, restoring
            // through the live chain. Its branch is parked here, so its
            // `<Git.Push />` has not been reached at all — a coroutine runs in
            // document order, and the read is written above the publication.
            holding = true;
            parked.resolve();
            yield* release.operation;
            holding = false;
            return yield* next(invocation);
          },
        });
        yield* Elicitation.around({
          *elicit([request]: [{ readonly message: string }]): Operation<unknown> {
            if (request.message.includes("second published")) {
              // Waited for, rather than assumed: this checkpoint is not
              // recorded until the earlier branch is demonstrably parked
              // before its own publication.
              yield* parked.operation;
              heldWhenSecondRestored = holding;
              checkpoints.push("second");
              release.resolve();
              return {};
            }
            checkpoints.push("first");
            return {};
          },
        });
      },
    });
    expect(again.refusal).toBe(undefined);
    // The later publisher's publication had restored while the earlier branch
    // was still parked above its own, and the post-publication checkpoints
    // then arrived second-publisher first — opposite the acknowledged order
    // the journal holds.
    expect(heldWhenSecondRestored).toBe(true);
    expect(checkpoints).toEqual(["second", "first"]);
    expect(reads(yield* stream.readAll())).toHaveLength(1);

    // The last acknowledged pair decides: the head is the second publisher's
    // commit. An evidence list accumulated in restoration order would have
    // offered the first publisher's pair here, and its commit is refused by
    // this head's own provenance.
    const asked = requests(yield* stream.readAll());
    expect(asked).toHaveLength(1);
    expect(asked[0]?.resolved.inputs.headSha).toBe(later);
    expect(mutations(fixture.store)).toEqual(["create"]);
  });

  it("Q7a: an exact earlier pair superseded by a later one refuses the earlier head", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = [
      `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
      `  <Git.Switch branch=${JSON.stringify(BRANCH)} />`,
      `  <File path="one.md">one</File>`,
      `  <Git.Add paths="one.md" />`,
      `  <Git.Commit message="One" as="one" />`,
      `  <Git.Push />`,
      `  <File path="two.md">two</File>`,
      `  <Git.Add paths="two.md" />`,
      `  <Git.Commit message="Two" as="two" />`,
      `  <Git.Push />`,
      QUESTION.split("\n").slice(0, 4).join("\n"),
      ...upsert(),
      `</Repository>`,
      "",
    ].join("\n");

    // Both publications are this entry's own and both are exact for their own
    // commit. The earlier one is a real acknowledged pair for this destination.
    const prefix = yield* left(fixture, source, counted);
    const pairs = publications(prefix);
    expect(pairs).toHaveLength(2);
    const earlier = pairs[0]?.resolved.inputs.sourceCommit ?? "";
    const later = pairs[1]?.resolved.inputs.sourceCommit ?? "";
    expect(earlier).not.toBe(later);

    // The person moves the checkout back to the earlier commit while away, so
    // the pull request would name the head the *earlier* pair published.
    yield* resetThere(checkoutOf(prefix, BRANCH), earlier);

    const resumed = counters();
    const stream = new InMemoryStream([...prefix]);
    const again = yield* run(fixture, source, stream, resumed, {
      answer: { choice: "continue" },
    });
    expect(again.refusal).not.toBe(undefined);
    // The last acknowledged publication of that destination names a different
    // commit, so the two describe different work and this refuses before a
    // request is written, a credential is read or anything is contacted.
    expect(String(again.refusal)).toContain("different");
    expect(requests(yield* stream.readAll())).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
  });
});

describe("what a bound pull-request body does first", () => {
  it("Q26: a Push child and an admitted read both acknowledge before the parent's request", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    const stream = new InMemoryStream();
    // The publication and the evidence read are children of the pull request
    // itself. All of the content finishes before the parent resolves, which is
    // what makes a `<Git.Push />` written inside the body the publication the
    // parent is then admitted by.
    const source = [
      `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
      `  <Git.Switch branch=${JSON.stringify(BRANCH)} />`,
      `  <File path="notes.md">ready</File>`,
      `  <Git.Add paths="notes.md" />`,
      `  <Git.Commit message="Prepare the release" as="commit" />`,
      `  <PullRequest title=${JSON.stringify(TITLE)} as="pullRequest">`,
      `<Git.Push />`,
      `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="inner" />`,
      BODY,
      `  </PullRequest>`,
      "",
      `opened {pullRequest.number} over {inner.length}`,
      "",
      `</Repository>`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, stream, counted);
    expect(ran.refusal).toBe(undefined);
    expect(ran.output).toContain("opened 1 over 1");

    // One of each, and the children stand before the parent at every position
    // the parent has: its request and its reconciled outcome alike.
    const publication = positionsOf(ran.events, REPL_REPOSITORY_PUSH_REQUEST);
    const snapshot = positionsOf(ran.events, PULL_REQUEST_READ);
    const asked = positionsOf(ran.events, REPL_REPOSITORY_PULL_REQUEST_REQUEST);
    const reconciled = positionsOf(ran.events, GIT_HOST_EFFECT);
    expect(publication).toHaveLength(1);
    expect(snapshot).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(reconciled).toHaveLength(2);
    const parent = asked[0] ?? -1;
    expect(publication[0] ?? -1).toBeLessThan(parent);
    expect(snapshot[0] ?? -1).toBeLessThan(parent);
    // The publication's own outcome too: the parent is admitted by an
    // acknowledged pair, not by a request still in flight.
    expect(reconciled[0] ?? -1).toBeLessThan(parent);
    expect(reconciled[1] ?? -1).toBeGreaterThan(parent);
    expect(mutations(fixture.store)).toEqual(["create"]);
  });

  it("Q27: a child that refuses leaves the parent with no request and nothing contacted", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    // The same body, with one child reading a container this deployment never
    // allowed. The parent never resolves, so it asks for nothing.
    const source = [
      `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
      `  <Git.Switch branch=${JSON.stringify(BRANCH)} />`,
      `  <File path="notes.md">ready</File>`,
      `  <Git.Add paths="notes.md" />`,
      `  <Git.Commit message="Prepare the release" as="commit" />`,
      `  <PullRequest title=${JSON.stringify(TITLE)} as="pullRequest">`,
      `<Git.Push />`,
      `<PullRequest.Reviews url="https://github.com/owner/elsewhere/pull/4" as="inner" />`,
      BODY,
      `  </PullRequest>`,
      "",
      `opened {pullRequest.number}`,
      "",
      `</Repository>`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, stream, counted);
    expect(ran.refusal).not.toBe(undefined);
    expect(String(ran.refusal)).toContain("has not authorized");
    const held = yield* stream.readAll();
    // The publication child did run and is history; the parent's own request
    // was never written and the Git host was never asked to open anything.
    expect(publications(held)).toHaveLength(1);
    expect(requests(held)).toEqual([]);
    expect(reads(held)).toEqual([]);
    expect(mutations(fixture.store)).toEqual([]);
    expect(ran.output).not.toContain("opened 1");
  });

  it("Q28: a repository-local component of either name answers instead, and retains nothing", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const stream = new InMemoryStream();
    // Repository-local Markdown of both names, which the resolver chooses
    // ahead of any registered default — including the one an entry declares in
    // its own scope. Declaring policy under a shared body reserves neither
    // name against a document that ships its own component for it.
    const local = ["---", "props:", "  type: object", "  additionalProperties: true", "---", ""];
    yield* ensureDir(join(fixture.root, "PullRequest"));
    yield* writeTextFile(
      join(fixture.root, "PullRequest.md"),
      [...local, "local pull request", ""].join("\n"),
    );
    yield* writeTextFile(
      join(fixture.root, "PullRequest", "Reviews.md"),
      [...local, "local reviews", ""].join("\n"),
    );

    const source = [
      `<Repository name="project" url=${JSON.stringify(LOCATOR)}>`,
      `  <Git.Switch branch=${JSON.stringify(BRANCH)} />`,
      `  <File path="notes.md">ready</File>`,
      `  <Git.Add paths="notes.md" />`,
      `  <Git.Commit message="Prepare the release" as="commit" />`,
      `  <Git.Push />`,
      `  <PullRequest title=${JSON.stringify(TITLE)} as="pullRequest">`,
      BODY,
      `  </PullRequest>`,
      `  <PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
      `</Repository>`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, stream, counted);
    expect(ran.refusal).toBe(undefined);
    // Both local components answered, so neither name reached this entry's
    // policy — no `as` was required of either, because the metadata resolved
    // is the local component's own.
    // Both names resolved to the local components, which is what the absence
    // below says: the entry's own bodies cannot run and leave no request, no
    // snapshot and no call behind them.
    const held = yield* stream.readAll();
    expect(requests(held)).toEqual([]);
    expect(reads(held)).toEqual([]);
    expect(fixture.store.requests).toEqual([]);
    // The publication beside them is untouched, which is what says this is
    // ordinary resolution rather than a disabled entry.
    expect(publications(held)).toHaveLength(1);
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
        // A supported upsert handler installed after the cut, which would
        // demonstrably retarget fresh work: it rewrites the title every
        // invocation it is given. A saved request is reconciled as it stands,
        // so it never reaches the chain this handler is part of.
        yield* PullRequestOperations.around({
          *upsert([invocation], next): Operation<PullRequestResult> {
            retargeted += 1;
            return yield* next({
              ...invocation,
              pullRequest: { ...invocation.pullRequest, title: "Retargeted by middleware" },
            });
          },
        });
      },
    });
    expect(again.refusal).toBe(undefined);
    // Never called, so the saved request did not come back through fresh
    // dispatch at all.
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

    // The saved request, as it stands, is what a continuation reconciles.
    const asked = requests(prefix)[0]?.resolved.inputs;
    expect(asked?.number).toBe(1);

    // The checkout moves on while the entry is away: a new commit, and the
    // branch it was published from is left behind for another one.
    const checkout = checkoutOf(prefix, BRANCH);
    const moved = yield* commitThere(checkout, "later.md");
    yield* switchThere(checkout, "someone/else");
    expect(moved).not.toBe(asked?.headSha);

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

    // Every member of the request reconciliation was asked about is the one
    // written down before the cut — the original number, title, verbatim body,
    // draft, base, head and destination — and none of it is today's checkout.
    const presented = reconciledInputs(settled);
    expect(presented).toEqual({
      number: 1,
      title: TITLE,
      body: asked?.body,
      draft: false,
      headBranch: BRANCH,
      headSha: asked?.headSha,
      baseBranch: "main",
    });
    expect(presented?.headSha).not.toBe(moved);
    // The adoption is what settled it, rather than a second update.
    expect(decisionsOf(settled)).toEqual(["performed", "adopted"]);
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
    expect(methodsCalled(resumed)).toEqual([]);
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
    expect(methodsCalled(resumed)).toEqual([]);
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
  it("Q14: a semantic and a transport handler both compose over a restored snapshot", function* () {
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

    // One handler at each of the two ordinary layers an entry read composes
    // through: the semantic lifecycle chain, and the transport chain beneath
    // it. Each transforms what it is answered with. Nothing below either is
    // reached on replay, because the snapshot is history.
    const order: string[] = [];
    const resumed = counters();
    const replayed = new InMemoryStream([...ran.events].filter(terminal));
    const again = yield* run(fixture, source, replayed, resumed, {
      root: undefined,
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *read([invocation], next): Operation<PullRequestReadResult> {
            order.push("semantic");
            const answered = yield* next(invocation);
            return answered.kind === "reviews"
              ? { kind: "reviews", items: [...answered.items, reviewEvidence(91, "dismissed")] }
              : answered;
          },
        });
        yield* PullRequestAPI.around({
          *read([url, options], next): Operation<PullRequestReadResult> {
            order.push("transport");
            const answered = yield* next(url, options);
            return answered.kind === "reviews"
              ? { kind: "reviews", items: [...answered.items, reviewEvidence(92, "pending")] }
              : answered;
          },
        });
      },
    });
    expect(again.refusal).toBe(undefined);
    // What the document bound is what the whole composition finished with, and
    // both layers contributed to it.
    expect(again.output).toContain("reviews 3");
    // The semantic layer is outside the transport layer, so it sees the read
    // first and transforms the answer last.
    expect(order).toEqual(["semantic", "transport"]);
    expect(fixture.store.requests.length).toBe(sent);
    const settled = reads(yield* replayed.readAll());
    expect(settled).toHaveLength(1);
    expect(JSON.stringify(settled[0]?.type === "yield" ? settled[0].result : undefined)).toBe(
      snapshot,
    );
  });

  it("Q15: a semantic answer that never delegates admits and retains nothing", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.reviews = [review(11, "APPROVED", "ship it")];
    const counted = counters();
    const source = [
      `<PullRequest.Reviews url=${JSON.stringify(FIRST_URL)} as="reviews" />`,
      "",
      `reviews {reviews.length}`,
      "",
    ].join("\n");

    // An ordinary lifecycle handler that answers the read itself. This is the
    // supported surface, and what it answers with has answered the document.
    let asked = 0;
    const stream = new InMemoryStream();
    const ran = yield* run(fixture, source, stream, counted, {
      root: undefined,
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          // deno-lint-ignore require-yield
          *read(): Operation<PullRequestReadResult> {
            asked += 1;
            return {
              kind: "reviews",
              items: [reviewEvidence(81, "commented"), reviewEvidence(82, "approved")],
            };
          },
        });
      },
    });
    expect(ran.refusal).toBe(undefined);
    expect(asked).toBe(1);
    // The handler's own two items, validated by the shared body like any other
    // final answer.
    expect(ran.output).toContain("reviews 2");
    // Nothing beneath it was reached: no transport was admitted, no
    // configuration was read, no session opened, and this entry retained no
    // read at all.
    expect(reads(yield* stream.readAll())).toEqual([]);
    expect(fixture.store.requests).toEqual([]);
    expect(counted.env).toEqual([]);
  });

  it("Q16: a URL this deployment no longer allows refuses before the snapshot", function* () {
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

  it("Q17: two concurrent reads completing in reverse order keep their own questions", function* () {
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

    // A readiness gate rather than elapsed time: the reviews call is released
    // exactly when the comments snapshot is already history, so the two
    // occurrences complete in the opposite order from the one they were
    // written in and the order is arranged rather than hoped for.
    const appended: string[] = [];
    const retained = withResolvers<void>();
    const stream = new InMemoryStream();
    stream.onAppend = (event: DurableEvent) => {
      if (event.type !== "yield" || event.description.type !== PULL_REQUEST_READ) {
        return;
      }
      const kind = Reflect.get(Object(event.description.input), "kind");
      appended.push(String(kind));
      if (kind === "comments") {
        retained.resolve();
      }
    };
    fixture.gate.hold = function* (request: GitHubHttpRequest): Operation<void> {
      if (new URL(request.url).pathname.endsWith("/reviews")) {
        yield* retained.operation;
      }
    };
    const ran = yield* run(fixture, source, stream, counted, { root: undefined });
    expect(ran.refusal).toBe(undefined);
    // The written order is reviews then comments; the acknowledged order is
    // the reverse of it.
    expect(appended).toEqual(["comments", "reviews"]);
    // Each occurrence bound its own collection, from its own URL.
    expect(ran.output).toContain("branch a 1");
    expect(ran.output).toContain("branch b 2");

    // Two retained reads, each holding the collection its own question asked
    // for, each named by that question, each standing in its own coroutine.
    const held = reads(ran.events);
    expect(held).toHaveLength(2);
    expect(collections(held)).toEqual([
      { kind: "comments", items: 2 },
      { kind: "reviews", items: 1 },
    ]);
    const names = held.map((event) => (event.type === "yield" ? event.description.name : ""));
    expect(new Set(names).size).toBe(2);
    const coroutines = new Set(
      held.map((event) => (event.type === "yield" ? event.coroutineId : "")),
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

  it("Q18: a read a handler starts for itself reaches no occurrence's callback", function* () {
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
  it("Q19: a request this journal refused asks the Git host nothing", function* () {
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

  it("Q20: a created pull request whose outcome was refused is adopted, never made twice", function* () {
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

  it("Q21: an entry cancelled with its call in flight retains the request alone", function* () {
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

describe("the credential one pull-request attempt acquires", () => {
  it("Q31: cancelling during acquisition joins the broker and retains the request alone", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    // The credential leaf this host really asks when no variable names one:
    // the Git-host login command. Substituted with a broker that reports its
    // own process, blocks, and records its own exit, so what a cancellation
    // does to it is observable rather than assumed.
    const broker = yield* useBlockingLogin(fixture);

    const stream = new InMemoryStream();
    const prefix = yield* scoped(function* (): Operation<readonly DurableEvent[]> {
      const task = yield* spawn(() =>
        run(fixture, entry({ lines: [...upsert(), QUESTION] }), stream, counted, {
          answer: { choice: "continue" },
        }),
      );
      yield* race([
        broker.started,
        (function* (): Operation<never> {
          yield* sleep(60_000);
          throw new Error("the entry never reached its credential acquisition");
        })(),
      ]);
      // Acquisition is genuinely pending here: the broker is running and has
      // answered nothing.
      expect(yield* broker.alive()).toBe(true);
      const held = [...(yield* stream.readAll())];
      yield* task.halt();
      return held;
    });

    // The attempt's cleanup was joined rather than merely signalled. The
    // broker's whole group is signalled and then *waited for*, so by the time
    // the halt above has returned the process is gone rather than on its way
    // out — which is what keeps a cancelled entry from leaving a credential
    // broker running behind it.
    expect(yield* broker.alive()).toBe(false);

    // The request this entry had already acknowledged, and nothing else. No
    // outcome was invented for work that never happened, the root never
    // settled, and the Git host was never reached — a credential was still
    // being asked for when this was cancelled.
    expect(requests(prefix)).toHaveLength(1);
    expect(outcomes(prefix)).toHaveLength(1);
    expect(closedRoot(prefix)).toBe(false);
    expect(fixture.store.requests).toEqual([]);
    const settled = yield* stream.readAll();
    expect(requests(settled)).toHaveLength(1);
    expect(outcomes(settled)).toHaveLength(1);
  });
});

describe("what an entry's assembly reaches", () => {
  it("Q22: building the capability declares six names and acquires nothing", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    yield* scoped(function* (): Operation<void> {
      const installation = yield* replRepositoryInstallation(OWNER, {
        operations: countingOperations(fixture, counted, { refuseNative: true }),
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
    expect(methodsCalled(counted)).toEqual([]);
    expect(counted.env).toEqual([]);
    expect(fixture.store.requests).toEqual([]);
  });

  it("Q23: an entry with no managed root reads an allowed URL and opens nothing", function* () {
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
    expect(methodsCalled(counted)).toEqual([]);
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

describe("a retained record this entry cannot account for", () => {
  it("Q24: every tampered read description refuses before anything replays", function* () {
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
      expect([what, methodsCalled(resumed)]).toEqual([what, []]);
    }
  });

  it("Q29: a retained checks envelope whose item names another head refuses", function* () {
    const fixture = yield* useFixture();
    fixture.evidence.runs = [checkRun(31, "build")];
    // A checks read asks this pull request which commit its head is before it
    // asks about that commit, so this GitHub has to hold one.
    fixture.store.pullRequests.push(
      stored({ number: 1, headRef: BRANCH, headSha: "d".repeat(40) }),
    );
    const counted = counters();
    const source = [
      `<PullRequest.Checks url=${JSON.stringify(FIRST_URL)} as="checks" />`,
      "",
      `checks {checks.length}`,
      "",
    ].join("\n");

    const ran = yield* run(fixture, source, new InMemoryStream(), counted, { root: undefined });
    expect(ran.refusal).toBe(undefined);
    expect(ran.output).toContain("checks 1");
    const history = [...ran.events].filter(terminal);
    const at = history.findIndex(
      (event) => event.type === "yield" && event.description.type === PULL_REQUEST_READ,
    );
    const original = history[at];
    if (original === undefined || original.type !== "yield" || original.result.status !== "ok") {
      throw new Error("that run retained no completed checks read");
    }
    const envelope = Object(original.result.value);
    const items = Array.isArray(envelope.items) ? envelope.items : [];
    expect(items).toHaveLength(1);
    const sent = fixture.store.requests.length;

    // One item moved onto another commit. A check that does not describe this
    // envelope's own head is evidence about something else, so the history is
    // not continued and no replacement snapshot is written.
    const replacement = [...history];
    replacement[at] = {
      ...original,
      result: {
        status: "ok",
        value: {
          ...envelope,
          items: [{ ...Object(items[0]), headSha: "e".repeat(40) }],
        },
      },
    };
    const resumed = counters();
    const stream = new InMemoryStream(replacement);
    const again = yield* run(fixture, source, stream, resumed, { root: undefined });
    expect(again.refusal).not.toBe(undefined);
    expect(again.output).not.toContain("checks 1");
    expect(fixture.store.requests.length).toBe(sent);
    expect(reads(yield* stream.readAll())).toHaveLength(1);
  });

  it("Q30: a saved request whose origin is not its Repository's refuses at readback", function* () {
    const fixture = yield* useFixture();
    const counted = counters();
    const source = entry({ lines: [...upsert()] });

    const ran = yield* run(fixture, source, new InMemoryStream(), counted);
    expect(ran.refusal).toBe(undefined);
    const history = [...ran.events].filter(terminal);
    const at = history.findIndex(
      (event) =>
        event.type === "yield" && event.description.type === REPL_REPOSITORY_PULL_REQUEST_REQUEST,
    );
    const original = history[at];
    if (original === undefined || original.type !== "yield" || original.result.status !== "ok") {
      throw new Error("that run retained no saved pull-request request");
    }
    const saved = Object(original.result.value);
    const sent = fixture.store.requests.length;

    // A locator this host would hand to Git, and a well-formed record — but
    // not the one the Repository in it was fingerprinted from. The question
    // this position is named by is unchanged, so the record is found and
    // restored, and what refuses it is the readback that holds a saved request
    // to the origin it says it belongs to.
    const replacement = [...history];
    replacement[at] = {
      ...original,
      result: {
        status: "ok",
        value: {
          ...saved,
          resolved: { ...Object(saved.resolved), origin: "https://github.com/owner/elsewhere" },
        },
      },
    };
    const resumed = counters();
    const stream = new InMemoryStream(replacement);
    const again = yield* run(fixture, source, stream, resumed, { refuseNative: true });
    expect(again.refusal).not.toBe(undefined);
    expect(again.output).not.toContain("opened 1 at");
    // Refused before reuse: nothing was contacted and no second request or
    // outcome was written.
    expect(fixture.store.requests.length).toBe(sent);
    const settled = yield* stream.readAll();
    expect(requests(settled)).toHaveLength(1);
    expect(outcomes(settled)).toHaveLength(2);
  });

  it("Q25: an ordinary failed read is admitted, and replays as the failure it was", function* () {
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
