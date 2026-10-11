/**
 * R7/R8 — one entry's external work: a push, a pull request, an issue and the
 * three evidence reads.
 *
 * Everything here runs a document through canonical execution with the entry
 * host installed, against a real checkout and a real bare remote. The Git host
 * is modeled, because what is under test is which requests are made and which
 * are refused before one is — and a model is what lets a suite count them.
 *
 * Each scenario gets its own remote, checkout, managed root, journal and store.
 * Nothing is shared: most of what these assert is what a *second* open of one
 * history does, and a shared service would make the second open depend on the
 * first test's leftovers.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import { collect } from "@executablemd/core";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { denoGitAuthentication } from "../src/deno/composition/authentication.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../src/deno/composition/host.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { useRetainedRepositoryEntry } from "../src/deno/retained-repository/provider.ts";
import {
  REPL_REPOSITORY_REQUEST,
  parseReplRepositoryRequest,
} from "../src/retained-repository/records.ts";
import {
  parseRetainedIssueRequest,
  parseRetainedPullRequestRequest,
  parseRetainedPushRequest,
} from "../src/retained-repository/requests.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import {
  gitHostRequestFingerprint,
  parseGitHostReconciliationRecord,
} from "../src/git-host/records.ts";
import { ISSUE_EFFECT } from "../src/issue/effect-type.ts";
import { PULL_REQUEST_READ } from "../src/deno/composition/pull-request-operations.ts";
import { git, remoteRefs, useBareRemote } from "./support/git-remotes.ts";
import type { BareRemote } from "./support/git-remotes.ts";
import {
  creations,
  fakeGitHubAccess,
  gitHubStore,
  issueCreations,
  patches,
} from "./support/github.ts";
import type { GitHubStore } from "./support/github.ts";
import { useHostCheckout } from "./support/run-composition.ts";
import { admitRetainedRepositoryHistory } from "../src/retained-repository/admission.ts";
import { retainedRepositoryOwner } from "../src/retained-repository/records.ts";
import { admittedPublications } from "../src/deno/retained-repository/publication.ts";
import { evidenceRoutes } from "./support/run-composition-tier.ts";
import type { GitHubPullRequestsOptions } from "../src/deno/composition/pull-request-reads.ts";
import type { GitHubAccess, GitHubHttpResponse } from "../src/deno/composition/github.ts";
import type { HostCheckout } from "./support/run-composition.ts";

/** The repository a document names, which the host rewrites to the bare remote. */
const LOCATOR = "https://github.com/octo/project";

const BRANCH = "publish/1.4";

const REMOTE = {
  commits: [{ message: "seed", entries: [{ path: "seed.md", content: "seed\n" }] }],
} as const;

interface Fixture {
  readonly root: string;
  readonly checkout: HostCheckout;
  readonly remote: BareRemote;
  readonly store: GitHubStore;
  /** Every Git command this entry ran, in order. */
  readonly commands: string[][];
  /** How many authentication sessions this entry's host was asked to open. */
  readonly sessions: { opened: number };
  /** How many host directories it was asked to make. */
  readonly directories: { made: number };
  readonly host: RepositoryHost;
}

/**
 * One entry's world: a bare remote, a checkout of it that records the GitHub
 * locator as its origin, a managed root, and a modeled GitHub.
 *
 * The locator substitution goes both ways, because Git records where a checkout
 * came from and this host reads it back. What is replaced is one string in each
 * direction; every other byte Git says travels untouched.
 */
function useFixture(
  options: {
    readonly faultyPush?: boolean;
    readonly faultyObservation?: boolean;
    readonly driftAfterPush?: boolean;
  } = {},
): Operation<Fixture> {
  return resource(function* (provide) {
    const remote = yield* useBareRemote(REMOTE);
    const checkout = yield* useHostCheckout(remote.locator);
    checkout.run("remote", "set-url", "origin", LOCATOR);
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "retained-ext-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(join(root, "managed"));
    const store = gitHubStore({ token: "github-credential-for-this-test" });
    // The modeled GitHub reads a branch's commit out of the bare remote, the
    // way the real one reads it out of the repository `<Git.Push />` published
    // to.
    store.resolveHead = (branch) => remoteRefs(remote).get(`refs/heads/${branch}`);
    const commands: string[][] = [];
    // Counted where the host lends them, so "a replay reaches no credential"
    // is a measurement rather than a reading of the code.
    const sessions = { opened: 0 };
    const directories = { made: 0 };
    const ambient = denoGitAuthentication();
    const inner = denoRepositoryHost({
      authentication: {
        open(locator: string) {
          sessions.opened += 1;
          return ambient.open(locator);
        },
      },
    });
    yield* provide({
      root,
      checkout,
      remote,
      store,
      commands,
      sessions,
      directories,
      host: watching(commands, counting(directories, rewriting(LOCATOR, remote.locator, inner)), {
        ...(options.faultyPush === undefined ? {} : { faultyPush: options.faultyPush }),
        ...(options.faultyObservation === undefined
          ? {}
          : { faultyObservation: options.faultyObservation }),
        ...(options.driftAfterPush === true ? { driftAfterPush: checkout.root } : {}),
      }),
    });
  });
}

/** The production host, with one locator standing in for another. */
function rewriting(named: string, actual: string, inner = denoRepositoryHost()): RepositoryHost {
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      const outcome = yield* inner.git({
        ...invocation,
        args: invocation.args.map((argument) => (argument === named ? actual : argument)),
      });
      return { ...outcome, stdout: outcome.stdout.split(actual).join(named) };
    },
    useDirectory: inner.useDirectory,
    ...(inner.useAuthentication === undefined
      ? {}
      : { useAuthentication: inner.useAuthentication }),
  };
}

/** The same host, counting the directories it was asked to make. */
function counting(directories: { made: number }, inner: RepositoryHost): RepositoryHost {
  return {
    git: inner.git,
    ...(inner.useAuthentication === undefined
      ? {}
      : { useAuthentication: inner.useAuthentication }),
    useDirectory(): Operation<string> {
      directories.made += 1;
      return inner.useDirectory();
    },
  };
}

/**
 * The same host, counting what it was asked to run — and able to fail one
 * command.
 *
 * `faultyPush` is the interruption window this suite needs most: the push is
 * refused *after* the entry has written its request down and before the remote
 * has heard anything, which is exactly the state a crash between the two
 * leaves. `faultyObservation` is the other one a document must never be able to
 * read as absence.
 */
function watching(
  commands: string[][],
  inner: RepositoryHost,
  options: {
    readonly faultyPush?: boolean;
    readonly faultyObservation?: boolean;
    /** Where to leave a file behind the moment a push succeeds. */
    readonly driftAfterPush?: string;
  },
): RepositoryHost {
  return {
    ...(inner.useAuthentication === undefined
      ? {}
      : { useAuthentication: inner.useAuthentication }),
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      commands.push([...invocation.args]);
      if (options.faultyPush === true && invocation.args[0] === "push") {
        throw new Error("the fixture refused to run this push");
      }
      if (options.faultyObservation === true && invocation.args[0] === "ls-remote") {
        return { code: 128, stdout: "", stderr: "the fixture could not reach the remote" };
      }
      const outcome = yield* inner.git(invocation);
      if (options.driftAfterPush !== undefined && invocation.args[0] === "push") {
        // Something else writing in the checkout the instant the branch was
        // published. The remote is where it was asked to be and the checkout
        // is not where this entry's records say it is.
        yield* writeTextFile(join(options.driftAfterPush, "stray.md"), "somebody else\n");
      }
      return outcome;
    },
    useDirectory: inner.useDirectory,
  };
}

/**
 * Put `commit` at one branch of the bare remote, from outside this entry.
 *
 * Written straight into the bare repository rather than pushed from a second
 * clone: what these scenarios need is a destination that moved, and the
 * shortest honest way to move one is to move its ref.
 */
function seedRemoteBranch(fixture: Fixture, branch: string, commit: string): void {
  git(
    ["update-ref", `refs/heads/${branch}`, commit],
    fixture.remote.locator,
    fixture.checkout.home,
  );
}

/** A commit at the bare remote that shares no history with this checkout. */
function unrelatedCommit(fixture: Fixture): string {
  const bare = fixture.remote.locator;
  const home = fixture.checkout.home;
  const tree = git(["rev-parse", "HEAD^{tree}"], bare, home);
  return git(["commit-tree", tree, "-m", "somebody else's work"], bare, home);
}

/** Which Git subcommands this entry ran. */
function subcommands(commands: readonly string[][]): string[] {
  return commands.flatMap((args) => (args[0] === undefined ? [] : [args[0]]));
}

/** A Files provider over the real filesystem, so writes land in the checkout. */
function leafFiles(): FilesHandler {
  return hostFilesHandler();
}

/** The public Files layer a retained entry installs: mutations delegate. */
function* useEntryFiles(fixture: Fixture, leaf: FilesHandler): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd() {
        return fixture.checkout.root;
      },
    },
    { at: "min" },
  );
  yield* API.Files.around({
    checkFilePath: ([input]) => leaf.checkFilePath(input),
    readTextFile: ([input]) => leaf.readTextFile(input),
    globFiles: ([input]) => leaf.globFiles(input),
    temporaryDirectory: () => leaf.temporaryDirectory(),
    *ensureDirectory([input], next) {
      return yield* next(input);
    },
    *writeTextFile([input], next) {
      return yield* next(input);
    },
    *deleteFile([input], next) {
      return yield* next(input);
    },
  });
}

interface Run {
  readonly output: string;
  readonly events: readonly DurableEvent[];
  /** What ended the entry, when something did. */
  readonly refusal: string | undefined;
}

/** One entry, over one journal, in one checkout. */
function run(
  fixture: Fixture,
  source: string,
  stream: InMemoryStream,
  options: {
    readonly entryKey?: string;
    readonly host?: RepositoryHost;
    /** A pull-request transport of this scenario's own, for the evidence reads. */
    readonly pullRequests?: GitHubPullRequestsOptions;
  } = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const leaf = leafFiles();
    yield* useEntryFiles(fixture, leaf);
    // The ordinary vocabulary, so `<IssueTracker>` exists and the entry's own
    // declarations are the ones that answer for the names it owns.
    yield* useCompositionComponents();
    const entry = yield* useRetainedRepositoryEntry({
      executionId: "execution-1",
      entryKey: options.entryKey ?? "0001",
      source: "entry.md",
      cwd: fixture.checkout.root,
      managedRoot: join(fixture.root, "managed"),
      host: options.host ?? fixture.host,
      files: leaf,
      gitHubIssues: {
        access: gitHubSource(fakeGitHubAccess(fixture.store)),
        configuration: { ceiling: [LOCATOR] },
      },
      gitHubPullRequests: options.pullRequests ?? {
        access: gitHubSource(fakeGitHubAccess(fixture.store)),
      },
    });
    let refusal: string | undefined;
    let output = "";
    try {
      output = String(
        yield* collect(
          yield* executeInstalled({ path, stream, includes: [fixture.root] }, [entry.installation]),
        ),
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    return { output, events: yield* stream.readAll(), refusal };
  });
}

/** The records of one durable type this journal holds, in order. */
function recordsOf(events: readonly DurableEvent[], type: string): readonly Json[] {
  const held: Json[] = [];
  for (const event of events) {
    if (event.type === "yield" && event.description.type === type && event.result.status === "ok") {
      held.push(event.result.value ?? null);
    }
  }
  return held;
}

/** Where in the journal each durable type's records stand. */
function positionsOf(events: readonly DurableEvent[], type: string): number[] {
  const at: number[] = [];
  events.forEach((event, index) => {
    if (event.type === "yield" && event.description.type === type) {
      at.push(index);
    }
  });
  return at;
}

/** The resolved requests of one external operation this journal holds. */
function requestsOf(events: readonly DurableEvent[], operation: string) {
  return recordsOf(events, REPL_REPOSITORY_REQUEST)
    .map((record) => parseReplRepositoryRequest(record))
    .filter((request) => request !== undefined && request.operation === operation);
}

/**
 * The same history with its closes removed: one entry that did the work and
 * never finished.
 *
 * A complete journal is projected rather than executed, so a replay assertion
 * made against one would be asserting on canonical core's completed-root view
 * instead of on this host — and this host would never have run at all.
 */
function unfinished(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type !== "close");
}

/**
 * The same history with one receipt performed under another identity.
 *
 * Only the Git-host record changes, and it stays a readable, correctly named
 * one: the substituted identity is carried into the durable name with the
 * production encoder, so what is being tested is the pairing rather than a
 * record that no longer parses or no longer belongs where it stands.
 */
function* withSubstitutedReceipt(
  events: readonly DurableEvent[],
  member: "runId" | "expansionId",
): Operation<DurableEvent[]> {
  const changed: DurableEvent[] = [];
  for (const event of events) {
    if (
      event.type !== "yield" ||
      event.description.type !== GIT_HOST_EFFECT ||
      event.result.status !== "ok"
    ) {
      changed.push(event);
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    if (record === undefined) {
      throw new Error("the positive control retained no readable receipt");
    }
    const value = {
      ...record,
      request: {
        ...record.request,
        identity: { ...record.request.identity, [member]: "another-owner-or-site" },
      },
    };
    // Still a receipt, and still named for the request it carries.
    expect(parseGitHostReconciliationRecord(value)).toBeDefined();
    changed.push({
      ...event,
      description: { ...event.description, name: yield* gitHostRequestFingerprint(value.request) },
      result: { status: "ok", value },
    });
  }
  return changed;
}

/** The branch this bare remote holds, or `undefined`. */
function published(fixture: Fixture, branch = BRANCH): string | undefined {
  return remoteRefs(fixture.remote).get(`refs/heads/${branch}`);
}

/** The endpoint the modeled evidence routes answer at. */
const ENDPOINT = "https://api.github.test";

/** A transport that answers canned bodies, counts requests, and may change. */
interface Serving {
  readonly access: GitHubAccess;
  /** Every request it answered, as method and path. */
  readonly requests: string[];
  /** The bodies it answers with, which a scenario may replace between opens. */
  bodies: Record<string, string>;
}

function serving(bodies: Record<string, string>): Serving {
  const held: Serving = {
    requests: [],
    bodies,
    access: {
      endpoint: ENDPOINT,
      // deno-lint-ignore require-yield
      *token(): Operation<string | undefined> {
        return "evidence-credential";
      },
      // deno-lint-ignore require-yield
      *send(request): Operation<GitHubHttpResponse> {
        const path = new URL(request.url).pathname;
        held.requests.push(`${request.method} ${path}`);
        const body = held.bodies[path];
        return body === undefined ? { status: 404, body: "{}" } : { status: 200, body };
      },
    },
  };
  return held;
}

/** One review, as the modeled forge reports it. */
function review(id: number, login: string, body: string, at: string): Record<string, unknown> {
  return {
    id,
    user: { login },
    state: id === 10 ? "APPROVED" : "COMMENTED",
    body,
    submitted_at: at,
    commit_id: "a".repeat(40),
    html_url: `https://github.test/pr/4#r${id}`,
    pull_request_url: `${ENDPOINT}/repos/octo/project/pulls/4`,
  };
}

/** The commit the checkout's branch is on. */
function head(fixture: Fixture): string {
  return fixture.checkout.run("rev-parse", "HEAD");
}

/** The tracker and the issue a document files in it. */
const ISSUE = [
  `<IssueTracker url="${LOCATOR}">`,
  `<Issue title="Retry the publish step" as="filed">`,
  "the description",
  "</Issue>",
  "</IssueTracker>",
  "",
  "filed {filed.url}",
];

/**
 * The same issue, filed from inside the checkout this entry has selected.
 *
 * The write is what selects it: an entry that writes no file inside a
 * repository has done no repository work, and filing an issue is not repository
 * work either — so the lane an issue's request is written down in is one some
 * earlier element established.
 */
const FILE_ISSUE = [`<File path="notes.md">prepared</File>`, "", ...ISSUE];

/** The URL the modeled tracker answers a creation with. */
const FILED = "https://github.com/owner/repository/issues/1";

const PUBLISH = [
  `<Git.Switch branch="${BRANCH}" />`,
  `<File path="notes.md">prepared</File>`,
  `<Git.Add paths="notes.md" />`,
  `<Git.Commit message="Prepare 1.4" as="commit" />`,
  `<Git.Push />`,
];

describe("retained repository: one entry's external work", () => {
  it("R7: a push freezes its request before the remote hears of it", function* () {
    const fixture = yield* useFixture();
    const { events, refusal } = yield* run(fixture, PUBLISH.join("\n"), new InMemoryStream());
    expect(refusal).toBeUndefined();

    // The branch is at the remote, at the commit this entry made.
    expect(published(fixture)).toBe(head(fixture));

    // One resolved push request, and the Git-host record after it: the request
    // this entry would make was written down before the remote was contacted at
    // all.
    const intents = requestsOf(events, "push");
    expect(intents).toHaveLength(1);
    const frozen = parseRetainedPushRequest(intents[0]?.resolved ?? null);
    expect(frozen?.inputs.branch).toBe(BRANCH);
    expect(frozen?.inputs.sourceCommit).toBe(head(fixture));
    expect(frozen?.inputs.destinationRef).toBe(`refs/heads/${BRANCH}`);
    expect(frozen?.checkout).toBe(fixture.checkout.root);

    const effect = positionsOf(events, GIT_HOST_EFFECT);
    expect(effect).toHaveLength(1);
    // The resolved request stands before the Git-host record, which is the
    // order that matters: what this entry asked for was written down before
    // anything was asked of the service.
    const requests = positionsOf(events, REPL_REPOSITORY_REQUEST);
    expect(requests).toHaveLength(1);
    expect(effect[0]).toBeGreaterThan(requests[requests.length - 1] ?? -1);
  });

  it("R7: a completed push replays with no remote work at all", function* () {
    const fixture = yield* useFixture();
    const stream = new InMemoryStream();
    const source = [
      ...PUBLISH,
      `<File path="later.md">later</File>`,
      `<Git.Add paths="later.md" />`,
      `<Git.Commit message="Later" as="second" />`,
      "",
      "head {second.commit}",
    ].join("\n");
    const first = yield* run(fixture, source, stream);
    expect(first.refusal).toBeUndefined();
    const publishedAt = published(fixture);
    expect(publishedAt).toBeDefined();
    // The live push did ask the host for a credential session and a directory
    // to publish out of, which is what makes the zeroes below mean something.
    expect(fixture.sessions.opened).toBeGreaterThan(0);
    expect(fixture.directories.made).toBeGreaterThan(0);
    // The entry committed again after publishing, so HEAD has moved past what
    // it published.
    expect(head(fixture)).not.toBe(publishedAt);

    // The same journal, reopened. Nothing is observed and nothing is pushed:
    // the completed push replays the request it froze rather than resolving
    // this checkout's branch and commit again — which would ask about the
    // commit it has since made.
    const replayed = yield* useFixture();
    const reopened = yield* run(
      { ...replayed, checkout: fixture.checkout, remote: fixture.remote },
      source,
      new InMemoryStream(unfinished(first.events)),
    );
    expect(reopened.refusal).toBeUndefined();
    expect(reopened.output).toBe(first.output);
    // The entry really resumed — its output repeats the commit it made, out of
    // the saved result — and asked Git for nothing at all while doing it, not
    // even for the branch and commit the push resolved, which have since moved
    // on. That this fixture's recorder catches replay-time Git work is what the
    // interrupted-push rows below measure, through the same wiring.
    expect(replayed.commands).toEqual([]);
    expect(published(fixture)).toBe(publishedAt);
    // And none of the work a live push needs before it reaches one: the
    // completed record answers before a provider is asked anything, so there
    // is no control repository to build and no credential to read.
    expect(replayed.sessions.opened).toBe(0);
    expect(replayed.directories.made).toBe(0);
  });

  it("R7: a push interrupted before the remote performs it once on reopening", function* () {
    const fixture = yield* useFixture({ faultyPush: true });
    const stream = new InMemoryStream();
    const first = yield* run(fixture, PUBLISH.join("\n"), stream);
    // The entry ended where the push failed, with its request written down and
    // the remote never asked to change anything.
    expect(first.refusal).toBeDefined();
    expect(requestsOf(first.events, "push")).toHaveLength(1);
    // Nothing at all was published for it: a boundary that failed before the
    // provider answered reaches no outcome, so there is no record to replay.
    expect(positionsOf(first.events, GIT_HOST_EFFECT)).toHaveLength(0);
    expect(published(fixture)).toBeUndefined();

    // The same journal, reopened with a host that can push. The destination is
    // proven absent and the saved request is performed, once.
    const working = yield* useFixture();
    const reopened = yield* run(
      { ...working, checkout: fixture.checkout, remote: fixture.remote, store: fixture.store },
      PUBLISH.join("\n"),
      new InMemoryStream([...first.events]),
      { host: watching(working.commands, rewriting(LOCATOR, fixture.remote.locator), {}) },
    );
    expect(reopened.refusal).toBeUndefined();
    expect(published(fixture)).toBe(head(fixture));
    expect(subcommands(working.commands).filter((name) => name === "push")).toHaveLength(1);
    const record = parseGitHostReconciliationRecord(recordsOf(reopened.events, GIT_HOST_EFFECT)[0]);
    expect(record?.decision).toBe("performed");
  });

  it("R7: a push interrupted after the remote adopts it without pushing again", function* () {
    const fixture = yield* useFixture();
    const stream = new InMemoryStream();
    const first = yield* run(fixture, PUBLISH.join("\n"), stream);
    expect(first.refusal).toBeUndefined();
    const publishedAt = published(fixture);
    expect(publishedAt).toBe(head(fixture));

    // The journal with the Git-host record cut off: the remote was mutated and
    // this end never learned that it was.
    const effect = positionsOf(first.events, GIT_HOST_EFFECT)[0] ?? 0;
    const working = yield* useFixture();
    const reopened = yield* run(
      { ...working, checkout: fixture.checkout, remote: fixture.remote, store: fixture.store },
      PUBLISH.join("\n"),
      new InMemoryStream([...first.events.slice(0, effect)]),
      { host: watching(working.commands, rewriting(LOCATOR, fixture.remote.locator), {}) },
    );
    expect(reopened.refusal).toBeUndefined();
    // Observed, recognized and adopted: the branch was published once.
    expect(subcommands(working.commands)).toContain("ls-remote");
    expect(subcommands(working.commands)).not.toContain("push");
    expect(published(fixture)).toBe(publishedAt);
    const record = parseGitHostReconciliationRecord(recordsOf(reopened.events, GIT_HOST_EFFECT)[0]);
    expect(record?.decision).toBe("adopted");
  });

  it("R7: a destination holding somebody else's commit is refused, not replaced", function* () {
    const fixture = yield* useFixture({ faultyPush: true });
    const first = yield* run(fixture, PUBLISH.join("\n"), new InMemoryStream());
    expect(first.refusal).toBeDefined();
    expect(published(fixture)).toBeUndefined();

    // Between the two opens the destination comes to hold work this branch
    // does not contain.
    const other = unrelatedCommit(fixture);
    seedRemoteBranch(fixture, BRANCH, other);

    const working = yield* useFixture();
    const reopened = yield* run(
      { ...working, checkout: fixture.checkout, remote: fixture.remote, store: fixture.store },
      PUBLISH.join("\n"),
      new InMemoryStream([...first.events]),
      { host: watching(working.commands, rewriting(LOCATOR, fixture.remote.locator), {}) },
    );
    expect(reopened.refusal).toContain("conflict");
    expect(subcommands(working.commands)).not.toContain("push");
    // Every byte of somebody else's work is where it was.
    expect(published(fixture)).toBe(other);
  });

  it("R7: a destination holding an ancestor is advanced without fetching anything", function* () {
    const fixture = yield* useFixture({ faultyPush: true });
    const first = yield* run(fixture, PUBLISH.join("\n"), new InMemoryStream());
    expect(first.refusal).toBeDefined();

    // The destination holds the commit this branch was made on, which the
    // commit being published contains.
    const parent = fixture.checkout.run("rev-parse", "HEAD^");
    seedRemoteBranch(fixture, BRANCH, parent);

    const working = yield* useFixture();
    const reopened = yield* run(
      { ...working, checkout: fixture.checkout, remote: fixture.remote, store: fixture.store },
      PUBLISH.join("\n"),
      new InMemoryStream([...first.events]),
      { host: watching(working.commands, rewriting(LOCATOR, fixture.remote.locator), {}) },
    );
    expect(reopened.refusal).toBeUndefined();
    expect(published(fixture)).toBe(head(fixture));
    // Advanced from objects this entry already holds: nothing was fetched.
    expect(subcommands(working.commands)).not.toContain("fetch");
  });

  it("R7/R8: a pull request is opened for the head this entry published", function* () {
    const fixture = yield* useFixture();
    const source = [
      ...PUBLISH,
      `<PullRequest title="Prepare 1.4" as="pullRequest">`,
      "the body",
      "</PullRequest>",
      "",
      "opened {pullRequest.number} at {pullRequest.state}",
    ].join("\n");
    const first = yield* run(fixture, source, new InMemoryStream());
    expect(first.refusal).toBeUndefined();
    expect(first.output).toContain("opened 1 at open");
    expect(creations(fixture.store)).toBe(1);

    // Its request was written down before the forge heard of it, with the head
    // this entry published and the base its selection pinned.
    const intents = requestsOf(first.events, "pull-request");
    expect(intents).toHaveLength(1);
    const frozen = parseRetainedPullRequestRequest(intents[0]?.resolved ?? null);
    expect(frozen?.inputs.headBranch).toBe(BRANCH);
    expect(frozen?.inputs.headSha).toBe(head(fixture));
    expect(frozen?.inputs.baseBranch).toBe("main");
    expect(frozen?.inputs.body).toContain("the body");

    // The same journal, reopened against a forge that would notice any
    // request: a completed upsert replays its record.
    const asked = fixture.store.requests.length;
    const before = fixture.commands.length;
    const reopened = yield* run(fixture, source, new InMemoryStream(unfinished(first.events)));
    expect(reopened.refusal).toBeUndefined();
    expect(reopened.output).toBe(first.output);
    // The entry resumed and produced its saved answer without asking anything
    // of either side: every operation in it is completed, so neither the forge
    // nor Git is reached. The live run above left `before` well above zero,
    // which is what makes this a measurement.
    expect(before).toBeGreaterThan(0);
    expect(fixture.commands.length).toBe(before);
    expect(fixture.store.requests).toHaveLength(asked);
    expect(creations(fixture.store)).toBe(1);
  });

  it("R7: a pull request the forge created but never acknowledged is adopted", function* () {
    const fixture = yield* useFixture();
    const source = [
      ...PUBLISH,
      `<PullRequest title="Prepare 1.4" as="pullRequest">`,
      "the body",
      "</PullRequest>",
      "",
      "opened {pullRequest.number}",
    ].join("\n");
    const first = yield* run(fixture, source, new InMemoryStream());
    expect(first.refusal).toBeUndefined();
    expect(creations(fixture.store)).toBe(1);

    // The journal with the pull request's own Git-host record cut off: the
    // forge created it and this end never learned that it had.
    const effects = positionsOf(first.events, GIT_HOST_EFFECT);
    const upsert = effects[effects.length - 1] ?? 0;
    const reopened = yield* run(
      fixture,
      source,
      new InMemoryStream([...first.events.slice(0, upsert)]),
    );
    expect(reopened.refusal).toBeUndefined();
    expect(reopened.output).toBe(first.output);
    // Observed under the same natural key, recognized and adopted: one pull
    // request exists, and nothing was patched to make it match.
    expect(creations(fixture.store)).toBe(1);
    expect(patches(fixture.store)).toBe(0);
    const records = recordsOf(reopened.events, GIT_HOST_EFFECT);
    const record = parseGitHostReconciliationRecord(records[records.length - 1]);
    expect(record?.decision).toBe("adopted");
  });

  it("R8: a reopened entry rebuilds the publication its own push recorded", function* () {
    const fixture = yield* useFixture();
    const source = [
      ...PUBLISH,
      `<PullRequest title="Prepare 1.4" as="pullRequest">`,
      "the body",
      "</PullRequest>",
      "",
      "opened {pullRequest.number}",
    ].join("\n");
    const first = yield* run(fixture, source, new InMemoryStream());
    expect(first.refusal).toBeUndefined();
    expect(creations(fixture.store)).toBe(1);

    // Cut before the pull request's own records: the branch is published and
    // the pull request is work this entry has not reached yet. Reopening makes
    // it fresh work, decided against publication evidence rebuilt out of
    // accepted records into a provider closure that has never seen it.
    const intents = positionsOf(first.events, REPL_REPOSITORY_REQUEST);
    const upsert = intents[intents.length - 1] ?? 0;
    const reopened = yield* run(
      fixture,
      source,
      new InMemoryStream([...first.events.slice(0, upsert)]),
    );
    expect(reopened.refusal).toBeUndefined();
    expect(reopened.output).toContain("opened 1");
    // The repository, checkout, origin, branch and commit it rebuilt are the
    // ones its push recorded, so the pull request is admitted — and the one
    // the forge already holds is adopted rather than opened again.
    expect(creations(fixture.store)).toBe(1);
  });

  it("R8: a pull request this entry did not publish for is refused", function* () {
    const fixture = yield* useFixture();
    const { refusal } = yield* run(
      fixture,
      [
        `<Git.Switch branch="${BRANCH}" />`,
        `<File path="notes.md">prepared</File>`,
        `<Git.Add paths="notes.md" />`,
        `<Git.Commit message="Prepare 1.4" as="commit" />`,
        `<PullRequest title="Prepare 1.4" as="pullRequest">body</PullRequest>`,
      ].join("\n"),
      new InMemoryStream(),
    );
    expect(refusal).toContain("holds no successful <Git.Push> result");
    // Decided before an adapter was selected: nothing was asked of the forge.
    expect(fixture.store.requests).toHaveLength(0);
    expect(published(fixture)).toBeUndefined();
  });

  it("R8: a commit made after the push needs its own publication", function* () {
    const fixture = yield* useFixture();
    const { refusal } = yield* run(
      fixture,
      [
        ...PUBLISH,
        `<File path="later.md">later</File>`,
        `<Git.Add paths="later.md" />`,
        `<Git.Commit message="Later" as="second" />`,
        `<PullRequest title="Prepare 1.4" as="pullRequest">body</PullRequest>`,
      ].join("\n"),
      new InMemoryStream(),
    );
    expect(refusal).toContain("published that branch at a different commit");
    expect(fixture.store.requests).toHaveLength(0);
  });

  it("R2/R8/R9: another entry publishes for itself or not at all", function* () {
    const fixture = yield* useFixture();
    // The first entry publishes the branch and opens its pull request.
    const first = yield* run(
      fixture,
      [...PUBLISH, `<PullRequest title="Prepare 1.4" as="pullRequest">body</PullRequest>`].join(
        "\n",
      ),
      new InMemoryStream(),
      { entryKey: "0001" },
    );
    expect(first.refusal).toBeUndefined();
    expect(creations(fixture.store)).toBe(1);

    // A second entry, in the same execution and the same checkout, writing the
    // same text. Its own segment holds no publication of its own, and the
    // records of the entry before it authorize nothing.
    const second = yield* run(
      fixture,
      `<PullRequest title="Prepare 1.4" as="pullRequest">body</PullRequest>`,
      new InMemoryStream(),
      { entryKey: "0002" },
    );
    expect(second.refusal).toContain("holds no successful <Git.Push> result");
    expect(creations(fixture.store)).toBe(1);

    // It may publish for itself. The destination already holds this exact
    // commit, so the push is adopted rather than performed — and an adopted
    // publication is this entry's own evidence.
    const third = yield* run(
      fixture,
      [`<Git.Push />`, `<PullRequest title="Prepare 1.4" as="pullRequest">body</PullRequest>`].join(
        "\n",
      ),
      new InMemoryStream(),
      { entryKey: "0003" },
    );
    expect(third.refusal).toBeUndefined();
    // One pull request at the forge, adopted by the entry that found it.
    expect(creations(fixture.store)).toBe(1);
    // And it got that far at all only by taking the shared Git directory's
    // lease, which the entries before it released when they ended: a successor
    // that could not acquire it refuses before it reads a byte.
    expect(subcommands(fixture.commands)).toContain("ls-remote");
  });

  it("R7: completed evidence reads answer from the journal, and a later one observes", function* () {
    const fixture = yield* useFixture();
    const evidence = serving({ ...evidenceRoutes(ENDPOINT) });
    const options = {
      pullRequests: {
        access: gitHubSource(evidence.access),
        // What this deployment authorized reading. Absent authorizes no URL
        // read at all, which is this adapter's own contract.
        configuration: { allowed: [LOCATOR] },
      },
    };
    // One document, with a fourth read written after the first three: a later
    // observation is a site of its own, and the same document has to hold both
    // — a resumed entry runs the source its own history recorded, not a
    // longer one somebody edited in between.
    const reads = [
      `<PullRequest.Reviews url="${LOCATOR}/pull/4" as="reviews" />`,
      `<PullRequest.Comments url="${LOCATOR}/pull/4" as="comments" />`,
      `<PullRequest.Checks url="${LOCATOR}/pull/4" as="checks" />`,
      "",
      "held {reviews.length} {comments.length} {checks.length}",
      "",
      `<PullRequest.Reviews url="${LOCATOR}/pull/4" as="again" />`,
      "",
      "now {again.length}",
    ].join("\n");

    const first = yield* run(fixture, reads, new InMemoryStream(), options);
    expect(first.refusal).toBeUndefined();
    expect(first.output).toContain("held 1 2 2");
    expect(first.output).toContain("now 1");
    expect(recordsOf(first.events, PULL_REQUEST_READ)).toHaveLength(4);
    const asked = evidence.requests.length;
    expect(asked).toBeGreaterThan(0);

    // The reviews collection changes at the forge, and the entry is reopened
    // from the prefix that holds its first three reads.
    evidence.bodies = {
      ...evidence.bodies,
      "/repos/octo/project/pulls/4/reviews": JSON.stringify([
        review(10, "reviewer", "looks right", "2026-01-01T00:00:00Z"),
        review(11, "another", "and one more", "2026-01-01T03:00:00Z"),
      ]),
    };
    const third = positionsOf(first.events, PULL_REQUEST_READ)[2] ?? 0;
    const reopened = yield* run(
      fixture,
      reads,
      new InMemoryStream(unfinished(first.events).slice(0, third + 1)),
      options,
    );
    expect(reopened.refusal).toBeUndefined();
    // The three completed reads answer with the collections they saw, with
    // nothing asked of the forge for them; the fourth is a new observation and
    // sees what is there now.
    expect(reopened.output).toContain("held 1 2 2");
    expect(reopened.output).toContain("now 2");
    expect(evidence.requests.length).toBeGreaterThan(asked);
    // Exactly the later read's own requests, and no refresh of the three
    // before it: one reviews listing, and nothing else.
    expect(evidence.requests.slice(asked)).toEqual(["GET /repos/octo/project/pulls/4/reviews"]);
  });

  it("R7: an issue is filed once, with its request written down first", function* () {
    const fixture = yield* useFixture();
    const first = yield* run(fixture, FILE_ISSUE.join("\n"), new InMemoryStream());
    expect(first.refusal).toBeUndefined();
    expect(first.output).toContain(`filed ${FILED}`);
    expect(issueCreations(fixture.store)).toBe(1);

    // The request this entry would make stands written down before the tracker
    // was contacted, in the lane of the checkout the issue was filed from.
    const intents = requestsOf(first.events, "issue");
    expect(intents).toHaveLength(1);
    const frozen = parseRetainedIssueRequest(intents[0]?.request ?? null);
    expect(frozen?.target).toBe(LOCATOR);
    expect(frozen?.issue.title).toBe("Retry the publish step");
    expect(frozen?.issue.description).toContain("the description");
    const effect = positionsOf(first.events, ISSUE_EFFECT);
    expect(effect).toHaveLength(1);
    // The resolved request stands before the tracker was asked anything.
    const requests = positionsOf(first.events, REPL_REPOSITORY_REQUEST);
    expect(effect[0]).toBeGreaterThan(requests[requests.length - 1] ?? -1);

    // Reopened: the completed upsert replays its record, and the tracker is
    // asked nothing at all.
    const asked = fixture.store.requests.length;
    const reopened = yield* run(
      fixture,
      FILE_ISSUE.join("\n"),
      new InMemoryStream(unfinished(first.events)),
    );
    expect(reopened.refusal).toBeUndefined();
    expect(reopened.output).toBe(first.output);
    expect(fixture.store.requests).toHaveLength(asked);
    expect(issueCreations(fixture.store)).toBe(1);
  });

  it("R7: an issue the tracker created but never acknowledged is adopted", function* () {
    const fixture = yield* useFixture();
    // The tracker files the issue and then fails the answer: the state an
    // interrupted creation leaves behind.
    fixture.store.fault = { on: "issue-create", afterEffect: true };
    const first = yield* run(fixture, FILE_ISSUE.join("\n"), new InMemoryStream());
    expect(first.refusal).toBeDefined();
    expect(issueCreations(fixture.store)).toBe(1);
    // Its request stands written down, and the answer this run did get is the
    // effect's own failure.
    expect(requestsOf(first.events, "issue")).toHaveLength(1);
    expect(recordsOf(first.events, ISSUE_EFFECT)).toHaveLength(0);
    const answered = positionsOf(first.events, ISSUE_EFFECT);
    expect(answered).toHaveLength(1);

    // A crash at that same instant records nothing at all, which is the gap
    // this reopens from: the journal cut just before that answer, with the
    // issue already at the tracker and this end never having learned it.
    fixture.store.fault = undefined;
    const reopened = yield* run(
      fixture,
      FILE_ISSUE.join("\n"),
      new InMemoryStream([...first.events.slice(0, answered[0] ?? 0)]),
    );
    expect(reopened.refusal).toBeUndefined();
    expect(reopened.output).toContain(`filed ${FILED}`);
    expect(issueCreations(fixture.store)).toBe(1);
  });

  it("R2/R7: the same issue text at two sites is two effects", function* () {
    const fixture = yield* useFixture();
    const { refusal, output, events } = yield* run(
      fixture,
      [
        `<File path="notes.md">prepared</File>`,
        "",
        `<IssueTracker url="${LOCATOR}">`,
        `<Issue title="Retry the publish step" as="first">`,
        "the description",
        "</Issue>",
        `<Issue title="Retry the publish step" as="second">`,
        "the description",
        "</Issue>",
        "</IssueTracker>",
        "",
        "filed {first.url} and {second.url}",
      ].join("\n"),
      new InMemoryStream(),
    );
    expect(refusal).toBeUndefined();
    // Two occurrences, two effects, two issues — the text is the same and the
    // site is not.
    expect(issueCreations(fixture.store)).toBe(2);
    expect(output).toContain(
      "filed https://github.com/owner/repository/issues/1 and " +
        "https://github.com/owner/repository/issues/2",
    );
    expect(requestsOf(events, "issue")).toHaveLength(2);
    expect(recordsOf(events, ISSUE_EFFECT)).toHaveLength(2);
  });

  it("R7: an issue filed outside every selection is its own record's to resume", function* () {
    const fixture = yield* useFixture();
    const first = yield* run(fixture, ISSUE.join("\n"), new InMemoryStream());
    expect(first.refusal).toBeUndefined();
    expect(issueCreations(fixture.store)).toBe(1);
    // No checkout was selected, so there is no state lane for a request to be
    // written down in — and nothing was resolved from live state that a frozen
    // copy would protect. The effect's own record is the whole of its history.
    expect(requestsOf(first.events, "issue")).toHaveLength(0);
    expect(recordsOf(first.events, ISSUE_EFFECT)).toHaveLength(1);
    // And no repository was opened on the way: filing an issue is not
    // repository work.
    expect(requestsOf(first.events, "ambient")).toHaveLength(0);

    const asked = fixture.store.requests.length;
    const reopened = yield* run(
      fixture,
      ISSUE.join("\n"),
      new InMemoryStream(unfinished(first.events)),
    );
    expect(reopened.refusal).toBeUndefined();
    expect(reopened.output).toBe(first.output);
    expect(fixture.store.requests).toHaveLength(asked);
  });

  it("R8: a publication this entry never asked for is not this entry's", function* () {
    const fixture = yield* useFixture();
    const publishing = yield* run(fixture, PUBLISH.join("\n"), new InMemoryStream(), {
      entryKey: "0001",
    });
    expect(publishing.refusal).toBeUndefined();

    // Its own records, admitted under its own owner: one publication.
    const mine = yield* admitRetainedRepositoryHistory(
      publishing.events,
      retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0001" }),
    );
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(admittedPublications(publishing.events, mine.value)).toHaveLength(1);
    }

    // The same successful Git-host record, read by an owner that froze no
    // request for it: a record of somebody's publication is not this owner's
    // evidence, whatever its inputs say.
    const theirs = yield* admitRetainedRepositoryHistory(
      publishing.events.filter(
        (event) => event.type !== "yield" || event.description.type === GIT_HOST_EFFECT,
      ),
      retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0002" }),
    );
    expect(theirs.ok).toBe(true);
    if (theirs.ok) {
      expect(admittedPublications(publishing.events, theirs.value)).toHaveLength(0);
    }
  });

  for (const member of ["runId", "expansionId"] as const) {
    it(`R2/R8: a receipt performed under another ${member} authorizes nothing`, function* () {
      const fixture = yield* useFixture();
      const first = yield* run(fixture, PUBLISH.join("\n"), new InMemoryStream(), {
        entryKey: "0001",
      });
      expect(first.refusal).toBeUndefined();
      const admitted = yield* admitRetainedRepositoryHistory(
        first.events,
        retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0001" }),
      );
      expect(admitted.ok).toBe(true);
      if (admitted.ok) {
        // Its own receipt pairs with the request it froze: one publication.
        expect(admittedPublications(first.events, admitted.value)).toHaveLength(1);
        // The same Git inputs, the same successful outcome, the same
        // destination and commit — performed under an identity this request was
        // not frozen under. The pair is what a publication is, so there is
        // none.
        const substituted = yield* withSubstitutedReceipt(first.events, member);
        expect(admittedPublications(substituted, admitted.value)).toHaveLength(0);
      }
    });
  }

  it("R2: an evidence read retained under another owner is not this entry's", function* () {
    const fixture = yield* useFixture();
    const evidence = serving({ ...evidenceRoutes(ENDPOINT) });
    const options = {
      pullRequests: {
        access: gitHubSource(evidence.access),
        configuration: { allowed: [LOCATOR] },
      },
    };
    const source = [
      `<PullRequest.Reviews url="${LOCATOR}/pull/4" as="reviews" />`,
      "",
      "held {reviews.length}",
    ].join("\n");
    const first = yield* run(fixture, source, new InMemoryStream(), options);
    expect(first.refusal).toBeUndefined();
    expect(first.output).toContain("held 1");
    const at = positionsOf(first.events, PULL_REQUEST_READ)[0];
    expect(at).toBeDefined();

    // The prefix through that read, with the observation retained under another
    // entry's owner. Its durable name is unchanged, because the name a read is
    // matched by deliberately leaves the owner out — which is the whole reason
    // the record's own request has to be read.
    const changed = first.events.slice(0, (at ?? 0) + 1).map((event): DurableEvent => {
      if (event.type !== "yield" || event.description.type !== PULL_REQUEST_READ) {
        return event;
      }
      const input = event.description.input;
      if (input === undefined || input === null || typeof input !== "object") {
        throw new Error("the positive control retained no readable request");
      }
      return {
        ...event,
        description: {
          ...event.description,
          input: {
            ...input,
            runId: retainedRepositoryOwner({ executionId: "execution-1", entryKey: "0002" }),
          },
        },
      };
    });
    const asked = evidence.requests.length;
    const resumed = yield* run(fixture, source, new InMemoryStream(changed), options);
    // Refused where the history is read: nothing was answered with somebody
    // else's observation, and the forge was not asked for a fresh one either.
    expect(resumed.refusal).toContain("retained under another owner");
    expect(evidence.requests).toHaveLength(asked);
  });

  it("R7: a pull request refused before the forge created it is performed once", function* () {
    const fixture = yield* useFixture();
    // The forge refuses the creation, so this attempt reaches it and leaves
    // nothing behind.
    fixture.store.fault = { on: "create" };
    const source = [
      ...PUBLISH,
      `<PullRequest title="Prepare 1.4" as="pullRequest">body</PullRequest>`,
      "",
      "opened {pullRequest.number}",
    ].join("\n");
    const first = yield* run(fixture, source, new InMemoryStream());
    expect(first.refusal).toBeDefined();
    expect(fixture.store.pullRequests).toHaveLength(0);
    const attempted = creations(fixture.store);
    expect(requestsOf(first.events, "pull-request")).toHaveLength(1);

    // Reopened from the prefix that holds its frozen request and not its
    // answer, against a forge that works: the saved request is performed once.
    fixture.store.fault = undefined;
    const gap = positionsOf(first.events, GIT_HOST_EFFECT).at(-1) ?? 0;
    const second = yield* run(fixture, source, new InMemoryStream(first.events.slice(0, gap)));
    expect(second.refusal).toBeUndefined();
    expect(second.output).toContain("opened 1");
    expect(fixture.store.pullRequests).toHaveLength(1);
    expect(creations(fixture.store) - attempted).toBe(1);
    expect(patches(fixture.store)).toBe(0);
  });

  it("R7: an issue refused before the tracker filed it is performed once", function* () {
    const fixture = yield* useFixture();
    fixture.store.fault = { on: "issue-create" };
    const first = yield* run(fixture, FILE_ISSUE.join("\n"), new InMemoryStream());
    expect(first.refusal).toBeDefined();
    expect(fixture.store.issues).toHaveLength(0);
    const attempted = issueCreations(fixture.store);
    expect(requestsOf(first.events, "issue")).toHaveLength(1);

    fixture.store.fault = undefined;
    const gap = positionsOf(first.events, ISSUE_EFFECT).at(-1) ?? 0;
    const second = yield* run(
      fixture,
      FILE_ISSUE.join("\n"),
      new InMemoryStream(first.events.slice(0, gap)),
    );
    expect(second.refusal).toBeUndefined();
    expect(second.output).toContain(`filed ${FILED}`);
    expect(fixture.store.issues).toHaveLength(1);
    expect(issueCreations(fixture.store) - attempted).toBe(1);
  });

  it("R7: a remote that could not answer is a failure and never absence", function* () {
    const fixture = yield* useFixture({ faultyObservation: true });
    const { refusal, events } = yield* run(fixture, PUBLISH.join("\n"), new InMemoryStream());
    expect(refusal).toContain("temporarily unavailable");
    // Nothing was performed on that answer, and the destination is untouched.
    expect(subcommands(fixture.commands)).not.toContain("push");
    expect(published(fixture)).toBeUndefined();
    // The request still stands written down, and the failure is this effect's
    // own published result rather than a gap in the history.
    expect(requestsOf(events, "push")).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "yield" &&
          event.description.type === GIT_HOST_EFFECT &&
          event.result.status === "err",
      ),
    ).toHaveLength(1);
  });
});
