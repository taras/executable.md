/**
 * What one REPL entry's `<PullRequest>` asks for, opens once, and answers from
 * afterwards.
 *
 * Every row runs a document through canonical execution with the production
 * entry capability installed, against a real checkout, a real bare remote and a
 * modeled Git host. What is proven is the whole path: the authored component
 * asks the composition Api, this entry's own publication memory authorizes the
 * head, the request is written down, the shared Git-host engine observes, the
 * pull request is opened at most once, and a continuation answers from the
 * receipt rather than from what the run believes.
 *
 * The contract these rows hold the host to is the REPL's execution model. The
 * request is retained before anything is contacted, and a continuation
 * reconciles *that* request — the head, the base and the body it named —
 * however far the checkout has moved since. So the rows that matter most are
 * the ones where the two disagree, and the ones where something that looks like
 * evidence is not.
 *
 * These rows carry V2, V3, V4, V5 and V8 of the delivery-5 matrix.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  ensure,
  race,
  resource,
  scoped,
  sleep,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation, WithResolvers } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";

import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation, registerComponents } from "@executablemd/core";
import { useCompositionComponents } from "../src/composition/installation.ts";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import { gitHubSource } from "../src/deno/composition/github.ts";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../src/deno/composition/github.ts";
// From the subpath that publishes them rather than from the source modules:
// these are public, and reaching one by relative path would bypass the export
// map the partition test holds every consumer to.
import { Git, PullRequestAPI } from "@executablemd/git/api";
import type {
  GitPushOutcome,
  PullRequestReadResult,
  PullRequestResult,
  RepositorySelection,
} from "@executablemd/git/api";
import { PullRequestOperations } from "../src/composition/pull-request-operations.ts";
import type { PullRequestUpsertInvocation } from "../src/composition/pull-request-operations.ts";
import { replRepositoryInstallation } from "../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import {
  parseReplPullRequestRequestRecord,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  replPullRequestRequestJson,
} from "../src/retained-repository/pull-request-records.ts";
import { REPL_REPOSITORY_LOCAL } from "../src/retained-repository/records.ts";
import {
  parseReplPlacementRecord,
  REPL_REPOSITORY_PLACEMENT,
} from "../src/retained-repository/placement-records.ts";
import { parsePullRequestReadRequest } from "../src/composition/pull-request-read-records.ts";
import { PULL_REQUEST_READ } from "../src/composition/pull-request-read-records.ts";
import { gitOutput } from "./support/git-remotes.ts";
import { useGitHubServer } from "./support/github.ts";
import {
  creations,
  fakeGitHubAccess,
  gitHubStore,
  mutations,
  patches,
  type GitHubStore,
} from "./support/github.ts";

/** The owner the CLI derives for an entry, as this suite states one. */
const OWNER = '["executablemd.repl.issue-owner",1,"execution-pull-request","1"]';

/** The repository the document names, and the one the modeled host holds. */
const LOCATOR = "https://github.com/octo/project";

const TOKEN = "github-credential-for-this-test";

const BRANCH = "review/notes";

interface Fixture {
  /** The scenario's own directory: checkouts, managed root and HOME. */
  readonly root: string;
  /** The bare repository every managed Repository is cloned from. */
  readonly origin: string;
  /** Where this scenario's managed checkouts live. */
  readonly managed: string;
  /** A symbolic link an entry is opened through. */
  readonly link: string;
  /** An ordinary checkout an entry is opened in. */
  readonly checkout: string;
}

/**
 * One bare remote with a commit in it, plus this scenario's own root.
 *
 * The same shape the publication suite builds, because a pull request is about
 * a branch a publication put somewhere: the remote is real, `git` really
 * pushes to it, and the modeled host resolves a branch by asking it.
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
    yield* writeTextFile(join(seed, "seed.md"), "seed\n");
    yield* git.run(["add", "seed.md"], seed);
    yield* git.run(["commit", "-m", "seed"], seed);
    yield* git.run(["push", origin, "main:refs/heads/main"], seed);

    const checkout = join(root, "checkout");
    yield* git.run(["clone", origin, checkout], root);
    const link = join(root, "entered");
    yield* until(symlink(checkout, link));
    yield* provide({ root, origin, managed: join(root, "repositories"), link, checkout });
  });
}

/**
 * The production host, with the one github.com locator standing in for this
 * scenario's bare remote.
 *
 * The substitution goes both ways, because Git remembers where a checkout came
 * from and this entry's own origin check reads it back — and the Repository
 * identity is fingerprinted from the locator the document wrote, so what the
 * entry observes has to stay that locator.
 */
function rewriting(to: string, inner: RepositoryHost = denoRepositoryHost()): RepositoryHost {
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      const outcome = yield* inner.git({
        ...invocation,
        args: invocation.args.map((argument) => (argument === LOCATOR ? to : argument)),
      });
      return { ...outcome, stdout: outcome.stdout.split(to).join(LOCATOR) };
    },
    useDirectory: inner.useDirectory,
  };
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
  readonly answer?: unknown;
  /** Resolved when the entry reaches a question, which then never answers. */
  readonly atQuestion?: WithResolvers<void>;
  /** The host this row installs, when it watches or refuses native work. */
  readonly host?: RepositoryHost;
  readonly owner?: string;
  readonly cwd?: string;
  /** What this deployment authorizes reading, when a row narrows it. */
  readonly allowed?: readonly string[];
  /** A gated transport, when a row cuts around the Git host. */
  readonly access?: GitHubAccess;
  /** A configured endpoint instead of an injected transport. */
  readonly endpoint?: string;
  readonly between?: () => Operation<void>;
}

/**
 * Run one document as the session runs it: one per-entry factory, called in the
 * entry's own task, for the owner the CLI derived.
 */
function run(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  store: GitHubStore,
  options: RunOptions = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const working = options.cwd ?? fixture.link;
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd() {
          return working;
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
    if (options.atQuestion !== undefined) {
      const reached = options.atQuestion;
      yield* Elicitation.around(
        {
          *elicit(): Operation<unknown> {
            reached.resolve();
            return yield* suspend();
          },
        },
        { at: "min" },
      );
    }
    if (options.between !== undefined) {
      yield* options.between();
    }
    const installation = yield* replRepositoryInstallation(options.owner ?? OWNER, {
      host: options.host ?? rewriting(fixture.origin),
      root: fixture.managed,
      pullRequests: {
        // The modeled host, injected: an access that outranks any configured
        // endpoint, so no row reaches a network.
        access: gitHubSource(options.access ?? fakeGitHubAccess(store)),
        configuration: {
          allowed: options.allowed === undefined ? [LOCATOR] : [...options.allowed],
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

/** One document inside the Repository this suite names. */
function document(...lines: string[]): string {
  return [`<Repository name="project" url="${LOCATOR}">`, ...lines, "</Repository>"].join("\n");
}

/** The whole journey: publish a branch, then open its pull request. */
function opening(...extra: string[]): string {
  return openingOn(BRANCH, ...extra);
}

/** The same journey on a named branch, for a row that runs more than once. */
function openingOn(branch: string, ...extra: string[]): string {
  return document(
    `  <Worktree name="${branch.replace(/[^a-z0-9]/gi, "-")}" branch="${branch}" as="worktree" />`,
    "  <Dir path={worktree}>",
    '    <File path="notes.md">Ready for review.</File>',
    '    <Git.Add paths="notes.md" />',
    '    <Git.Commit message="Prepare notes" as="commit" />',
    "    <Git.Push />",
    '    <PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
    "    <Json value={pullRequest.number} />",
    ...extra,
    "  </Dir>",
  );
}

/** Every saved pull-request request this history holds. */
function requests(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) =>
      event.type === "yield" && event.description.type === REPL_REPOSITORY_PULL_REQUEST_REQUEST,
  );
}

/** Every pull-request reconciliation this history acknowledged. */
function upserts(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter((event) => {
    if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
      return false;
    }
    if (event.result.status !== "ok") {
      return false;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    return record?.request.kind === "pull-request";
  });
}

/**
 * The modeled Git host, resolving a branch by asking the real bare remote.
 *
 * Which is how the real one knows the commit a pull request is opened from:
 * `<Git.Push />` put it there, so the host is told to look where it was put
 * rather than being handed a commit this suite made up.
 */
function store(fixture: Fixture): GitHubStore {
  const forge = gitHubStore({ token: TOKEN });
  forge.resolveHead = (branch) => {
    try {
      return gitOutput(["rev-parse", `refs/heads/${branch}`], fixture.origin, fixture.root).trim();
    } catch {
      return undefined;
    }
  };
  return forge;
}

/** A publication answer a handler can build, and that proves nothing. */
const SYNTHETIC_PUSH: GitPushOutcome = Object.freeze({
  decision: "performed" as const,
  result: Object.freeze({
    repository: Object.freeze({
      name: "project",
      locatorFingerprint: "0".repeat(64),
      requestedBase: null,
      creationCommit: "0".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1" as const,
    }),
    remote: "origin",
    branch: "review/synthetic",
    destinationRef: "refs/heads/review/synthetic",
    refspec: `${"0".repeat(40)}:refs/heads/review/synthetic`,
    sourceCommit: "0".repeat(40),
    observedRemoteCommit: "0".repeat(40),
  }),
});

/** The question half every left-at-a-question row writes. */

const QUESTION = [
  `  <Elicit schema={{ type: "object", properties: { choice: { enum: ["continue"] } },`,
  `    required: ["choice"], additionalProperties: false }} as="answer">`,
  `The pull request is open. Continue?`,
  `  </Elicit>`,
].join("\n");

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

/**
 * The modeled host, plus the one evidence route a read in a body needs.
 *
 * The fake GitHub answers pull-request routes; a reviews collection is not one
 * of them, so this answers that path from the pull request the store holds and
 * leaves every other request exactly as it was.
 */
function readable(store: GitHubStore): { readonly access: GitHubAccess } {
  const inner = fakeGitHubAccess(store);
  return {
    access: {
      endpoint: inner.endpoint,
      token: () => inner.token(),
      *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
        const url = new URL(request.url);
        const reviews = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(url.pathname);
        if (reviews === null) {
          return yield* inner.send(request);
        }
        const number = Number(reviews[1]);
        const found = store.pullRequests.find((pullRequest) => pullRequest.number === number);
        if (found === undefined) {
          return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
        }
        return {
          status: 200,
          body: JSON.stringify([
            {
              id: 11,
              user: { login: "reviewer" },
              state: "APPROVED",
              body: "looks right",
              submitted_at: "2026-08-24T00:00:00Z",
              commit_id: found.headSha,
              html_url: `${LOCATOR}/pull/${number}#r11`,
              pull_request_url: `${inner.endpoint}/repos/${store.owner}/${store.repository}/pulls/${number}`,
            },
          ]),
        };
      },
    },
  };
}

/** A host that answers exactly as the production one does, and counts. */
function watching(fixture: Fixture): { readonly host: RepositoryHost; readonly ran: string[] } {
  const ran: string[] = [];
  const inner = rewriting(fixture.origin);
  return {
    ran,
    host: {
      *git(invocation: GitInvocation): Operation<GitOutcome> {
        ran.push(invocation.args[0] ?? "");
        return yield* inner.git(invocation);
      },
      useDirectory: inner.useDirectory,
    },
  };
}

/** A transport that fails the row if a credential or a service is reached. */
function unreachableAccess(): GitHubAccess {
  return {
    endpoint: "https://api.github.test",
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      throw new Error("a credential was read for a completed upsert");
    },
    // deno-lint-ignore require-yield
    *send(): Operation<GitHubHttpResponse> {
      throw new Error("the service was contacted for a completed upsert");
    },
  };
}

/** The same predicate, true only on its nth match. */
function nth(
  at: (event: DurableEvent) => boolean,
  which: number,
): (event: DurableEvent) => boolean {
  let seen = 0;
  return (event) => {
    if (!at(event)) {
      return false;
    }
    seen += 1;
    return seen === which;
  };
}

/** Every managed checkout this history's placement records name. */
function* placements(events: readonly DurableEvent[]): Operation<string[]> {
  const found: string[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== REPL_REPOSITORY_PLACEMENT) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parseReplPlacementRecord(event.result.value);
    if (record !== undefined && record.outcome.ok) {
      found.push(record.outcome.value.checkoutRoot);
    }
  }
  return found;
}

/** The directory this branch is checked out in, as Git itself lists them. */
function* worktreeOn(fixture: Fixture, checkout: string, branch: string): Operation<string> {
  const git = gitSession(denoRepositoryHost(), fixture.root);
  const outcome = yield* git.run(["worktree", "list", "--porcelain"], checkout);
  let directory: string | undefined;
  for (const line of outcome.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      directory = line.slice("worktree ".length).trim();
    }
    if (line.trim() === `branch refs/heads/${branch}` && directory !== undefined) {
      return directory;
    }
  }
  throw new Error(`no worktree of ${checkout} is on ${branch}`);
}

/** Commit one more file in a checkout, as a person at a shell would. */
function* commitThere(checkout: string, name: string): Operation<string> {
  const git = gitSession(denoRepositoryHost(), checkout);
  yield* writeTextFile(join(checkout, name), `${name}\n`);
  yield* git.run(["add", name], checkout);
  yield* git.run(
    ["-c", "user.name=Shell", "-c", "user.email=shell@example.test", "commit", "-m", name],
    checkout,
  );
  const outcome = yield* git.run(["rev-parse", "HEAD"], checkout);
  return outcome.stdout.trim();
}

/** The saved request record one retained event holds. */
function savedRequest(event: DurableEvent | undefined) {
  if (event?.type !== "yield" || event.result.status !== "ok") {
    return undefined;
  }
  const value = event.result.value;
  return value === undefined ? undefined : parseReplPullRequestRequestRecord(value);
}

describe("one entry's pull request", () => {
  it("V2a: opens a pull request for the head it published, once", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    const first = yield* run(fixture, opening(), stream, forge);

    expect(first.refusal).toBeUndefined();
    // One request written down, one reconciliation acknowledged, one pull
    // request created at the host.
    expect(requests(first.events).length).toBe(1);
    expect(upserts(first.events).length).toBe(1);
    expect(creations(forge)).toBe(1);
    expect(first.output).toContain("1");
  });

  it("V2b: refuses when this entry published no such head", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    // The same document without its `<Git.Push />`: there is a branch and a
    // commit, and nothing published them.
    const unpublished = document(
      `  <Worktree name="review" branch="${BRANCH}" as="worktree" />`,
      "  <Dir path={worktree}>",
      '    <File path="notes.md">Ready for review.</File>',
      '    <Git.Add paths="notes.md" />',
      '    <Git.Commit message="Prepare notes" as="commit" />',
      '    <PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
      "  </Dir>",
    );
    const attempt = yield* run(fixture, unpublished, stream, forge);

    expect(attempt.refusal).toBeDefined();
    // Nothing was written down and nothing was contacted.
    expect(requests(attempt.events).length).toBe(0);
    expect(mutations(forge)).toEqual([]);
  });

  it("V4a: a completed upsert replays from its receipt, contacting nothing", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    const first = yield* run(fixture, opening(), stream, forge);
    expect(first.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);

    // The same document again over the same history. The upsert is complete, so
    // it answers from what it acknowledged.
    const again = yield* run(fixture, opening(), stream, forge);
    expect(again.refusal).toBeUndefined();
    expect(requests(again.events).length).toBe(1);
    expect(upserts(again.events).length).toBe(1);
    // No second create, and no mutation of any kind.
    expect(creations(forge)).toBe(1);
    expect(patches(forge)).toBe(0);
  });

  it("V2c: a head this entry has not published yet refuses, until it publishes it", function* () {
    const fixture = yield* useFixture();
    // Published at A, then committed again: the checkout is on B and this
    // entry's only publication is of A.
    const moved = (branch: string, ...extra: string[]): string =>
      document(
        `  <Worktree name="${branch}" branch="review/${branch}" as="worktree" />`,
        "  <Dir path={worktree}>",

        '    <File path="notes.md">Ready for review.</File>',
        '    <Git.Add paths="notes.md" />',
        '    <Git.Commit message="Prepare notes" as="first" />',
        "    <Git.Push />",
        '    <File path="more.md">And more.</File>',
        '    <Git.Add paths="more.md" />',
        '    <Git.Commit message="And more" as="second" />',
        ...extra,
        '    <PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
        "  </Dir>",
      );

    const stale = store(fixture);
    const refused = yield* run(fixture, moved("stale"), new InMemoryStream(), stale);

    expect(refused.refusal).toBeDefined();
    // The branch is published; this commit is not. Refused before a request
    // exists and before anything was contacted.
    expect(refused.refusal).toContain("different commit");
    expect(mutations(stale)).toEqual([]);

    // The same document with the entry publishing B explicitly. Now the last
    // publication to that branch is the head the pull request names.
    const fresh = store(fixture);
    const opened = yield* run(
      fixture,
      moved("fresh", "    <Git.Push />"),
      new InMemoryStream(),
      fresh,
    );

    expect(opened.refusal).toBeUndefined();
    expect(creations(fresh)).toBe(1);
  });

  it("V2d: a synthetic publication answer authorizes nothing", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    // A handler that answers `Git.push` itself. The branch is never published,
    // nothing is retained for it, and a pull request resting on it is resting
    // on a value a handler made up.
    const synthetic = yield* run(fixture, openingOn("review/synthetic"), stream, forge, {
      *between(): Operation<void> {
        yield* Git.around({
          // deno-lint-ignore require-yield
          *push(): Operation<GitPushOutcome> {
            return SYNTHETIC_PUSH;
          },
        });
      },
    });

    expect(synthetic.refusal).toBeDefined();
    expect(synthetic.refusal).toContain("no acknowledged");
    expect(requests(synthetic.events).length).toBe(0);
    expect(mutations(forge)).toEqual([]);
  });

  it("V7k: a read authored in the pull request's body keeps its own handoff", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const reviewed = readable(forge);
    const stream = new InMemoryStream();
    // The second element updates what the first opened, and its body reads
    // that pull request's reviews. The read runs inside an upsert's own
    // invocation and is still its own retained read, under its own identity.
    const nested = document(
      `  <Worktree name="review" branch="${BRANCH}" as="worktree" />`,
      "  <Dir path={worktree}>",
      '    <File path="notes.md">Ready for review.</File>',
      '    <Git.Add paths="notes.md" />',
      '    <Git.Commit message="Prepare notes" as="commit" />',
      "    <Git.Push />",
      '    <PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
      '    <PullRequest number={1} title="Prepare notes" as="updated">',
      `      <PullRequest.Reviews url="${LOCATOR}/pull/1" as="reviews" />`,
      "      Ready for review.",
      "    </PullRequest>",
      "    <Json value={reviews} />",
      "  </Dir>",
    );
    const ran = yield* run(fixture, nested, stream, forge, { access: reviewed.access });

    expect(ran.refusal).toBeUndefined();
    expect(ran.output).toContain("reviewer");
    const retained = reads(ran.events);
    expect(retained.length).toBe(1);
    const asked = question(retained[0]!);
    expect(asked?.url).toBe(`${LOCATOR}/pull/1`);
    expect(asked?.runId).toBe(OWNER);
    // Two upserts asked for, and the read is neither of their invocations: a
    // nested read's handoff is its own.
    const sites = new Set(requests(ran.events).map((event) => savedRequest(event)?.site));
    expect(sites.size).toBe(2);
    expect(sites.has(asked?.expansionId)).toBe(false);
  });
});

/**
 * An access that holds the first service call matching a predicate.
 *
 * What makes a cut around the Git host deterministic: the request is in flight
 * when the row halts the entry, so what the journal holds is everything up to
 * that call and nothing after it.
 */
function gatedAccess(
  store: GitHubStore,
  at: (request: GitHubHttpRequest) => boolean,
  reached: WithResolvers<void>,
): GitHubAccess {
  const inner = fakeGitHubAccess(store);
  return {
    endpoint: inner.endpoint,
    token: () => inner.token(),
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      if (at(request)) {
        reached.resolve();
        yield* suspend();
      }
      return yield* inner.send(request);
    },
  };
}

/**
 * Whether this event is the pull-request half of the shared Git-host type.
 *
 * Both external protocols settle through `git_host_effect`, so a barrier on
 * the durable type alone would catch the publication this journey needs — which
 * is the same reason the history classifier cannot read a kind off the
 * envelope. What discriminates is the record's own request kind.
 */
function isUpsert(event: DurableEvent): boolean {
  if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
    return false;
  }
  if (event.result.status !== "ok") {
    return false;
  }
  const record = parseGitHostReconciliationRecord(event.result.value);
  return record?.request.kind === "pull-request";
}

/** A journal that holds one append, and says when it did. */
function holdingAppend(
  inner: InMemoryStream,
  at: (event: DurableEvent) => boolean,
  reached: WithResolvers<void>,
): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (at(event)) {
        reached.resolve();
        yield* suspend();
      }
      yield* inner.append(event);
    },
  };
}

/** A journal that refuses every append this predicate names. */
function refusing(inner: InMemoryStream, at: (event: DurableEvent) => boolean): DurableStream {
  return {
    readAll: () => inner.readAll(),
    *append(event: DurableEvent): Operation<void> {
      if (at(event)) {
        throw new Error("the journal backend refused this append");
      }
      yield* inner.append(event);
    },
  };
}

/** Whether this event is a saved pull-request request. */
function isRequest(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === REPL_REPOSITORY_PULL_REQUEST_REQUEST;
}

/** Run the entry and halt it the moment `reached` resolves, keeping the prefix. */
function cutAt(
  fixture: Fixture,
  source: string,
  stream: DurableStream,
  forge: GitHubStore,
  reached: WithResolvers<void>,
  options: RunOptions = {},
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const task = yield* spawn(() => run(fixture, source, stream, forge, options));
    yield* race([
      reached.operation,
      (function* (): Operation<never> {
        yield* sleep(30_000);
        throw new Error("the entry never reached the barrier it was cut at");
      })(),
    ]);
    const prefix = [...(yield* stream.readAll())];
    yield* task.halt();
    return prefix;
  });
}

/** A journal holding exactly one unfinished history's events. */
function replaying(prefix: readonly DurableEvent[]): InMemoryStream {
  // Every event but the root's own close, which is what an unfinished run has:
  // a journal whose run finished replays every position it holds and runs no
  // component, so a continuation would never reach the suffix.
  return new InMemoryStream(
    [...prefix].filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
}

/** The same history, with every saved request's recorded origin replaced. */
function* retargeted(events: readonly DurableEvent[], origin: string): Operation<DurableEvent[]> {
  const rewritten: DurableEvent[] = [];
  for (const event of events) {
    const record = isRequest(event) ? savedRequest(event) : undefined;
    if (record === undefined) {
      rewritten.push(event);
      continue;
    }
    rewritten.push({
      ...event,
      result: {
        status: "ok",
        value: replPullRequestRequestJson({
          ...record,
          resolved: { ...record.resolved, origin },
        }),
      },
    });
  }
  return rewritten;
}

/** A closed result a handler can build and offer as a completion. */
const SYNTHETIC = Object.freeze({
  repository: Object.freeze({
    name: "project",
    locatorFingerprint: "a".repeat(64),
    requestedBase: null,
    creationCommit: "b".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1" as const,
  }),
  providerId: "PR_synthetic",
  number: 4242,
  url: "https://github.com/octo/project/pull/4242",
  state: "open" as const,
  headSha: "c".repeat(40),
  baseSha: "d".repeat(40),
});

describe("one entry's pull request, interrupted", () => {
  it("V3a: a pending request reconciles its saved question, reading no checkout", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const reached = withResolvers<void>();

    // Cut at the first service call: the request is acknowledged, nothing is
    // open at the host yet.
    const prefix = yield* cutAt(fixture, opening(), inner, forge, reached, {
      access: gatedAccess(forge, () => true, reached),
    });
    expect(requests(prefix).length).toBe(1);
    expect(upserts(prefix).length).toBe(0);
    expect(mutations(forge)).toEqual([]);

    // What that record holds is the whole question, complete enough to ask the
    // service without reading anything again.
    const published = savedRequest(requests(prefix)[0]);
    expect(published?.resolved.inputs.title).toBe("Prepare notes");
    expect(published?.resolved.inputs.body).toBe("Ready for review.");
    expect(published?.resolved.inputs.draft).toBe(false);
    expect(published?.resolved.inputs.number).toBe(null);
    expect(published?.resolved.inputs.headBranch).toBe(BRANCH);
    expect(published?.resolved.inputs.baseBranch).toBe("main");
    expect(published?.resolved.inputs.headSha).toMatch(/^[0-9a-f]{40}$/);

    // Now the checkout it published from is gone. A pending request needs none
    // of it: the head, the base and the body are in the record.
    yield* rm(join(fixture.managed), { recursive: true, force: true });

    const watched = watching(fixture);
    const resumed = yield* run(fixture, opening(), replaying(prefix), forge, {
      host: watched.host,
    });
    expect(resumed.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);
    // And it read no checkout to do it: reconciling a saved request is a
    // service call over parsed facts.
    expect(watched.ran).toEqual([]);
  });

  it("V3b: a remote completion whose outcome was never acknowledged is adopted", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const reached = withResolvers<void>();

    // Cut while the reconciliation's own result is being appended: the pull
    // request exists at the host and this history does not say so.
    const prefix = yield* cutAt(
      fixture,
      opening(),
      holdingAppend(inner, isUpsert, reached),
      forge,
      reached,
    );
    expect(requests(prefix).length).toBe(1);
    expect(upserts(prefix).length).toBe(0);
    expect(creations(forge)).toBe(1);

    // Resuming observes what is there and adopts it rather than creating a
    // second pull request.
    const resumed = yield* run(fixture, opening(), replaying(prefix), forge);
    expect(resumed.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);
    expect(upserts(yield* replaying(prefix).readAll()).length).toBe(0);
  });

  it("V8a: a refused request append contacts nothing and fences what follows", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const attempt = yield* run(
      fixture,
      opening('    <File path="after.md">continued</File>'),
      refusing(inner, isRequest),
      forge,
    );

    expect(attempt.refusal).toBeDefined();
    const events = yield* inner.readAll();
    expect(requests(events).length).toBe(0);
    expect(upserts(events).length).toBe(0);
    // Nothing was asked of the Git host.
    expect(mutations(forge)).toEqual([]);
    // The write after it never ran: a first persistence failure fences what
    // follows rather than letting the run continue past a position the journal
    // does not hold.
    const checkout = (yield* placements(events))[0];
    expect(checkout).toBeDefined();
    const worktree = yield* worktreeOn(fixture, checkout ?? "", BRANCH);
    expect(yield* exists(join(worktree, "after.md"))).toBe(false);
    // And nothing compensated for it: no coroutine was closed, so a
    // continuation replays this position rather than stepping over it.
    expect(events.filter((event) => event.type === "close")).toEqual([]);
  });

  it("V8b: a refused outcome append binds nothing and leaves the completion to adopt", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const attempt = yield* run(
      fixture,
      opening('    <File path="after.md">continued</File>'),
      refusing(inner, isUpsert),
      forge,
    );

    expect(attempt.refusal).toBeDefined();
    const events = yield* inner.readAll();
    // The request stands, the outcome does not, and the remote work may have
    // happened: that is the window reconciliation exists to close.
    expect(requests(events).length).toBe(1);
    expect(upserts(events).length).toBe(0);
    // The write after it never ran, and nothing was closed to compensate.
    const checkout = (yield* placements(events))[0];
    expect(checkout).toBeDefined();
    expect(
      yield* exists(join(yield* worktreeOn(fixture, checkout ?? "", BRANCH), "after.md")),
    ).toBe(false);
    expect(events.filter((event) => event.type === "close")).toEqual([]);

    // A later attempt over that history adopts the completion, and reaches the
    // write that was fenced.
    const resumed = yield* run(
      fixture,
      opening('    <File path="after.md">continued</File>'),
      replaying(events),
      forge,
    );
    expect(resumed.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);
    expect(
      yield* exists(join(yield* worktreeOn(fixture, checkout ?? "", BRANCH), "after.md")),
    ).toBe(true);
  });

  it("V3c: a numbered update whose outcome was never acknowledged is adopted", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const reached = withResolvers<void>();
    // One document that opens a pull request and then brings that number to a
    // new title. The cut holds the *second* reconciliation's append, so the
    // update happened at the host and this history does not say so.
    const source = document(
      `  <Worktree name="review" branch="${BRANCH}" as="worktree" />`,
      "  <Dir path={worktree}>",
      '    <File path="notes.md">Ready for review.</File>',
      '    <Git.Add paths="notes.md" />',
      '    <Git.Commit message="Prepare notes" as="commit" />',
      "    <Git.Push />",
      '    <PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
      '    <PullRequest number={1} title="Retitled" as="updated">Ready for review.</PullRequest>',
      "    <Json value={updated.number} />",
      "  </Dir>",
    );

    const prefix = yield* cutAt(
      fixture,
      source,
      holdingAppend(inner, nth(isUpsert, 2), reached),
      forge,
      reached,
    );
    expect(requests(prefix).length).toBe(2);
    expect(upserts(prefix).length).toBe(1);
    expect(patches(forge)).toBe(1);

    // Resuming observes the pull request already says what the update asked
    // for, records that, and patches nothing a second time.
    const resumed = yield* run(fixture, source, replaying(prefix), forge);
    expect(resumed.refusal).toBeUndefined();
    expect(patches(forge)).toBe(1);
    expect(creations(forge)).toBe(1);
    expect(upserts(resumed.events).length).toBe(2);
  });

  it("V3d: a cut before the request is acknowledged resolves today's commit", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const reached = withResolvers<void>();

    // Cut with the request append in flight: the publication of A is history
    // and the pull request asked for nothing yet.
    const prefix = yield* cutAt(
      fixture,
      opening(),
      holdingAppend(inner, isRequest, reached),
      forge,
      reached,
    );
    expect(requests(prefix).length).toBe(0);
    expect(mutations(forge)).toEqual([]);

    // Somebody advances the branch while the entry is away. Nothing was
    // recorded for the pull request, so the continuation resolves it now — at
    // B, which this entry never published.
    const checkout = (yield* placements(prefix))[0];
    expect(checkout).toBeDefined();
    const worktree = yield* worktreeOn(fixture, checkout ?? "", BRANCH);
    yield* commitThere(worktree, "later.md");

    const resumed = yield* run(fixture, opening(), replaying(prefix), forge);
    expect(resumed.refusal).toBeDefined();
    expect(resumed.refusal).toContain("different commit");
    // No request was invented for the commit it published an hour ago, and
    // nothing was contacted.
    expect(requests(resumed.events).length).toBe(0);
    expect(mutations(forge)).toEqual([]);
  });

  it("V4b: an unfinished prefix restores the upsert with nothing native or remote", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const reached = withResolvers<void>();

    // A genuine unfinished history: the pull request is open and acknowledged,
    // and the entry is standing at a question it has not answered.
    const source = opening(QUESTION);
    const prefix = yield* cutAt(fixture, source, inner, forge, reached, { atQuestion: reached });
    expect(requests(prefix).length).toBe(1);
    expect(upserts(prefix).length).toBe(1);
    expect(creations(forge)).toBe(1);
    expect(
      prefix.filter((event) => event.type === "close" && event.coroutineId === "root"),
    ).toEqual([]);

    // Now take away everything a fresh upsert would need: the managed root is
    // gone, the transport fails if it is asked anything, and reading a
    // credential fails too.
    yield* rm(fixture.managed, { recursive: true, force: true });
    const watched = watching(fixture);
    const resumed = yield* run(fixture, source, replaying(prefix), forge, {
      answer: { choice: "continue" },
      access: unreachableAccess(),
      host: watched.host,
    });

    expect(resumed.refusal).toBeUndefined();
    expect(resumed.output).toContain("1");
    // The completed upsert came back from its own receipt: no `git`, no
    // provider, no credential, no service.
    expect(watched.ran).toEqual([]);
    expect(creations(forge)).toBe(1);
    expect(patches(forge)).toBe(0);
    expect(upserts(resumed.events).length).toBe(1);
  });

  it("V6d: a saved request whose recorded origin was edited is refused on readback", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    const first = yield* run(fixture, opening(), stream, forge);
    expect(first.refusal).toBeUndefined();

    // The same history with one letter of its recorded origin changed. The
    // name covers the question rather than what routing resolved, so the name
    // still matches and nothing upstream of this notices.
    const edited = yield* retargeted(yield* stream.readAll(), "https://github.com/octo/elsewhere");
    const resumed = yield* run(fixture, opening(), replaying(edited), forge);

    // Held to the fingerprint the Repository identity in the record carries,
    // so a request edited to name another repository continues nothing.
    expect(resumed.refusal).toBeDefined();
    expect(creations(forge)).toBe(1);
    expect(patches(forge)).toBe(0);
  });
});

describe("one entry's pull request, composed", () => {
  it("V5a: a synthetic answer at either chain binds and retains nothing", function* () {
    const fixture = yield* useFixture();

    for (const chain of ["operations", "api"] as const) {
      const forge = store(fixture);
      const stream = new InMemoryStream();
      const answered = yield* run(fixture, openingOn(`synthetic/${chain}`), stream, forge, {
        *between(): Operation<void> {
          if (chain === "operations") {
            yield* PullRequestOperations.around({
              // deno-lint-ignore require-yield
              *upsert(): Operation<PullRequestResult> {
                return SYNTHETIC;
              },
            });
          } else {
            yield* PullRequestAPI.around({
              // deno-lint-ignore require-yield
              *upsert(): Operation<PullRequestResult> {
                return SYNTHETIC;
              },
            });
          }
        },
      });

      expect(answered.refusal).toBeUndefined();
      expect(answered.output).toContain("4242");
      const events = yield* stream.readAll();
      // Nothing was written down and nothing was asked of the Git host.
      expect(requests(events).length).toBe(0);
      expect(upserts(events).length).toBe(0);
      expect(mutations(forge)).toEqual([]);
    }
  });

  it("V5b: after delegation the owned outcome binds, whatever an outer handler returns", function* () {
    const fixture = yield* useFixture();

    // Delegates, then rewrites the answer, at each of the two chains a
    // document composes through. Neither rewrite can bind another pull
    // request: what binds is what this entry actually acknowledged.
    for (const chain of ["operations", "api"] as const) {
      const forge = store(fixture);
      const stream = new InMemoryStream();
      const rewritten = yield* run(fixture, openingOn(`rewritten/${chain}`), stream, forge, {
        *between(): Operation<void> {
          if (chain === "operations") {
            yield* PullRequestOperations.around({
              *upsert([invocation], next): Operation<PullRequestResult> {
                yield* next(invocation);
                return SYNTHETIC;
              },
            });
          } else {
            yield* PullRequestAPI.around({
              *upsert([pullRequest, options], next): Operation<PullRequestResult> {
                yield* next(pullRequest, options);
                return SYNTHETIC;
              },
            });
          }
        },
      });
      expect(rewritten.refusal).toBeUndefined();
      expect(rewritten.output).not.toContain("4242");
      expect(creations(forge)).toBe(1);
      expect(requests(yield* stream.readAll()).length).toBe(1);
    }
  });

  it("V5c: a swallowed delegated failure stays a failure", function* () {
    const fixture = yield* useFixture();

    for (const chain of ["operations", "api"] as const) {
      const forge = store(fixture);
      forge.fault = { on: "create", status: 503 };
      const stream = new InMemoryStream();
      const swallowed = yield* run(fixture, openingOn(`swallowed/${chain}`), stream, forge, {
        *between(): Operation<void> {
          if (chain === "operations") {
            yield* PullRequestOperations.around({
              *upsert([invocation], next): Operation<PullRequestResult> {
                try {
                  return yield* next(invocation);
                } catch {
                  // Catching the delegated failure and answering with a
                  // success cannot rescue it.
                  return SYNTHETIC;
                }
              },
            });
          } else {
            yield* PullRequestAPI.around({
              *upsert([pullRequest, options], next): Operation<PullRequestResult> {
                try {
                  return yield* next(pullRequest, options);
                } catch {
                  return SYNTHETIC;
                }
              },
            });
          }
        },
      });
      expect(swallowed.refusal).toBeDefined();
      expect(swallowed.output).not.toContain("4242");
    }
  });

  for (const chain of ["operations", "api"] as const) {
    it(`V5c: a swallowed selection-authentication refusal stays a failure through ${chain}`, function* () {
      const fixture = yield* useFixture();
      const forge = store(fixture);
      const stream = new InMemoryStream();
      let caught = "";
      let later = false;
      const result = yield* run(
        fixture,
        openingOn(`auth-refusal/${chain}`).replace("</Repository>", "<After />\n</Repository>"),
        stream,
        forge,
        {
          *between(): Operation<void> {
            yield* registerComponents([
              {
                name: "After",
                origin: "test",
                props: { type: "object", properties: {}, additionalProperties: false },
                // deno-lint-ignore require-yield
                *fn(): Operation<string> {
                  later = true;
                  return "";
                },
              },
            ]);
            if (chain === "operations") {
              yield* PullRequestOperations.around({
                *upsert([invocation], next): Operation<PullRequestResult> {
                  try {
                    return yield* next({
                      ...invocation,
                      repository: { ...invocation.repository, selection: "stale-selection" },
                    });
                  } catch (error) {
                    caught = error instanceof Error ? error.message : String(error);
                    return SYNTHETIC;
                  }
                },
              });
            } else {
              yield* PullRequestAPI.around({
                *upsert([input, options], next): Operation<PullRequestResult> {
                  try {
                    return yield* next(input, {
                      ...options,
                      repository: { ...options.repository, selection: "stale-selection" },
                    });
                  } catch (error) {
                    caught = error instanceof Error ? error.message : String(error);
                    return SYNTHETIC;
                  }
                },
              });
            }
          },
        },
      );
      expect(caught).toContain("not one this entry selected");
      expect(result.refusal).toBeDefined();
      expect(result.output).not.toContain("4242");
      expect(later).toBe(false);
      expect(requests(result.events)).toEqual([]);
      expect(upserts(result.events)).toEqual([]);
      expect(mutations(forge)).toEqual([]);
    });
  }

  it("V5d: one transform records both readings, and a saved request bypasses it", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();

    const transformed = yield* run(fixture, opening(), stream, forge, {
      *between(): Operation<void> {
        yield* PullRequestAPI.around({
          *upsert([pullRequest, options], next): Operation<PullRequestResult> {
            return yield* next({ ...pullRequest, title: "Transformed" }, options);
          },
        });
      },
    });
    expect(transformed.refusal).toBeUndefined();

    const events = yield* stream.readAll();
    const saved = requests(events)[0];
    expect(saved).toBeDefined();
    if (saved?.type === "yield" && saved.result.status === "ok") {
      const record = parseReplPullRequestRequestRecord(saved.result.value);
      // The question the invocation asked, and what the dispatch received.
      expect(record?.requested.pullRequest.title).toBe("Prepare notes");
      expect(record?.received.pullRequest.title).toBe("Transformed");
      expect(record?.resolved.inputs.title).toBe("Transformed");
    }

    // Replaying consumes the saved request before anything is dispatched, so a
    // handler that is no longer installed changes nothing.
    const resumed = yield* run(fixture, opening(), replaying(events), forge);
    expect(resumed.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);
  });

  it("V5h: a delegated Repository saves each place under its own identity", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const reached = withResolvers<void>();
    let target: { repository: RepositorySelection; workingDirectory: string } | undefined;

    // One entry, two Repositories. The branch is published from `target`; the
    // pull request is authored under `project`, and trusted middleware answers
    // the authored question with `target`'s own selection and working
    // directory. That is ordinary input transformation: it fabricates no
    // selection, no identity and no publication, and the typed Api permits it.
    const source = [
      `<Repository name="target" url="${LOCATOR}">`,
      '  <Worktree name="redirect" branch="review/redirect" as="worktree" />',
      "  <Dir path={worktree}>",
      '    <File path="notes.md">Ready for review.</File>',
      '    <Git.Add paths="notes.md" />',
      '    <Git.Commit message="Prepare notes" as="commit" />',
      "    <Git.Push />",
      "  </Dir>",
      "</Repository>",
      `<Repository name="project" url="${LOCATOR}">`,
      '  <PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
      "  <Json value={pullRequest.number} />",
      QUESTION,
      "</Repository>",
    ].join("\n");

    const delegating = function* (): Operation<void> {
      // Where `target` published from, taken from the Push invocation itself so
      // the document stays the document a person would write: the selection and
      // working directory below are the ones that operation observed, not ones
      // this row composed.
      yield* Git.around({
        *push([invocation], next): Operation<GitPushOutcome> {
          target = {
            repository: invocation.repository,
            workingDirectory: invocation.workingDirectory,
          };
          return yield* next(invocation);
        },
      });
      yield* PullRequestAPI.around({
        *upsert([pullRequest, options], next): Operation<PullRequestResult> {
          if (target === undefined) {
            throw new Error("the target Repository never published anything");
          }
          return yield* next(pullRequest, { ...options, ...target });
        },
      });
    };

    // A genuine unfinished history: the pull request is open and acknowledged,
    // and the entry is standing at a question it has not answered.
    const prefix = yield* cutAt(fixture, source, inner, forge, reached, {
      atQuestion: reached,
      between: delegating,
    });
    expect(requests(prefix).length).toBe(1);
    expect(upserts(prefix).length).toBe(1);
    expect(creations(forge)).toBe(1);

    const record = savedRequest(requests(prefix)[0]);
    expect(record).toBeDefined();
    // Three places, and each is a place of something different: the invocation
    // authenticated `project`, the dispatch received `target`'s own selection,
    // and routing resolved the worktree that selection was working in. All
    // three are placements this entry holds, and no single identity holds them
    // all — which is the composition the old validation refused.
    expect(record?.requested.place.repository.name).toBe("project");
    expect(record?.received.place.repository.name).toBe("target");
    expect(record?.received.place.selectionCheckout).toBe(target?.repository.checkoutPath);
    expect(record?.resolved.checkoutRoot).toBe(target?.workingDirectory);
    expect(record?.resolved.checkoutRoot).not.toBe(record?.requested.place.selectionCheckout);
    // And the pull request that opened is the delegated Repository's own work.
    expect(record?.resolved.inputs.headBranch).toBe("review/redirect");
    expect(forge.pullRequests.at(-1)?.headRef).toBe("review/redirect");

    // Continuing without the middleware that delegated: the saved request is
    // consumed before anything is dispatched, so the restored pull request is
    // still the one `target` published, and nothing is asked of the service
    // a second time.
    const resumed = yield* run(fixture, source, replaying(prefix), forge, {
      answer: { choice: "continue" },
    });

    expect(resumed.refusal).toBeUndefined();
    const restored = savedRequest(requests(resumed.events)[0]);
    expect(requests(resumed.events).length).toBe(1);
    expect(restored?.requested.place.repository.name).toBe("project");
    expect(restored?.received.place.repository.name).toBe("target");
    expect(upserts(resumed.events).length).toBe(1);
    expect(creations(forge)).toBe(1);
    expect(patches(forge)).toBe(0);
    expect(mutations(forge)).toEqual(["create"]);
  });

  it("V5e: a body child effect precedes the request, and a failed body contacts nothing", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();

    // The body writes a file. That child finishes at its own earlier position,
    // before this upsert has a position of its own.
    const withChild = document(
      `  <Worktree name="review" branch="${BRANCH}" as="worktree" />`,
      "  <Dir path={worktree}>",
      '    <File path="notes.md">Ready for review.</File>',
      '    <Git.Add paths="notes.md" />',
      '    <Git.Commit message="Prepare notes" as="commit" />',
      "    <Git.Push />",
      '    <PullRequest title="Prepare notes" as="pullRequest">',
      '      <File path="body.md">from the body</File>',
      "      Ready for review.",
      "    </PullRequest>",
      "  </Dir>",
    );
    const ordered = yield* run(fixture, withChild, stream, forge);
    expect(ordered.refusal).toBeUndefined();

    // The body's own `<File>` is a retained local record, and what matters is
    // that it stands before this upsert's request: a child effect in the
    // content finishes at its own earlier position, which is why the body is
    // projected before the parent has a position at all.
    const types = (yield* stream.readAll())
      .filter((event) => event.type === "yield")
      .map((event) => event.description.type);
    const requestAt = types.lastIndexOf(REPL_REPOSITORY_PULL_REQUEST_REQUEST);
    const lastWriteAt = types.lastIndexOf(REPL_REPOSITORY_LOCAL);
    expect(requestAt).toBeGreaterThan(-1);
    expect(lastWriteAt).toBeGreaterThan(-1);
    expect(lastWriteAt).toBeLessThan(requestAt);

    // A body that cannot render stops everything this component owns before a
    // request exists and before anything is contacted.
    const failingForge = store(fixture);
    const failing = new InMemoryStream();
    const refused = yield* run(
      fixture,
      document(
        `  <Worktree name="broken" branch="broken/notes" as="worktree" />`,
        "  <Dir path={worktree}>",
        '    <File path="notes.md">Ready for review.</File>',
        '    <Git.Add paths="notes.md" />',
        '    <Git.Commit message="Prepare notes" as="commit" />',
        "    <Git.Push />",
        '    <PullRequest title="Prepare notes" as="pullRequest">',
        '      <Git.Add paths="never-written.md" />',
        "    </PullRequest>",
        "  </Dir>",
      ),
      failing,
      failingForge,
    );
    expect(refused.refusal).toBeDefined();
    expect(requests(yield* failing.readAll()).length).toBe(0);
    expect(mutations(failingForge)).toEqual([]);
  });

  it("V5f: an outer throw after success leaves the record standing", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    // Delegates, gets the owned answer, and then fails for its own reasons.
    // That is an ordinary failure: the document stops, and what this entry
    // acknowledged is history either way.
    const thrown = yield* run(fixture, opening(), stream, forge, {
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *upsert([invocation], next): Operation<PullRequestResult> {
            yield* next(invocation);
            throw new Error("the handler above it failed");
          },
        });
      },
    });

    expect(thrown.refusal).toBe("the handler above it failed");
    const events = yield* stream.readAll();
    expect(requests(events).length).toBe(1);
    expect(upserts(events).length).toBe(1);
    expect(creations(forge)).toBe(1);

    // And the pull request it opened is restored rather than opened again.
    const resumed = yield* run(fixture, opening(), replaying(events), forge);
    expect(resumed.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);
    expect(patches(forge)).toBe(0);
  });

  it("V5g: a duplicate delegation performs no second owned call", function* () {
    const fixture = yield* useFixture();

    for (const chain of ["operations", "api"] as const) {
      const forge = store(fixture);
      const stream = new InMemoryStream();
      const twice = yield* run(fixture, openingOn(`duplicate/${chain}`), stream, forge, {
        *between(): Operation<void> {
          if (chain === "operations") {
            yield* PullRequestOperations.around({
              *upsert([invocation], next): Operation<PullRequestResult> {
                yield* next(invocation);
                return yield* next(invocation);
              },
            });
          } else {
            yield* PullRequestAPI.around({
              *upsert([pullRequest, options], next): Operation<PullRequestResult> {
                yield* next(pullRequest, options);
                return yield* next(pullRequest, options);
              },
            });
          }
        },
      });

      // Whatever the second dispatch did, it did not open or repoint a second
      // pull request, and this entry holds one request and one outcome.
      expect(creations(forge)).toBe(1);
      expect(patches(forge)).toBe(0);
      const events = yield* stream.readAll();
      expect(requests(events).length).toBe(1);
      expect(upserts(events).length).toBe(1);
      if (twice.refusal === undefined) {
        expect(twice.output).toContain("1");
      }
    }
  });
});

describe("one entry's pull request, dispatched directly", () => {
  /** The journey, then an update of what it opened, then a read of it. */
  const twice = (...extra: string[]): string =>
    document(
      `  <Worktree name="review" branch="${BRANCH}" as="worktree" />`,
      "  <Dir path={worktree}>",
      '    <File path="notes.md">Ready for review.</File>',
      '    <Git.Add paths="notes.md" />',
      '    <Git.Commit message="Prepare notes" as="commit" />',
      "    <Git.Push />",
      '    <PullRequest title="Prepare notes" as="pullRequest">Ready for review.</PullRequest>',
      '    <PullRequest number={1} title="Prepare notes" as="updated">Ready for review.</PullRequest>',
      ...extra,
      "  </Dir>",
    );

  it("V9d: a read dispatched outside a read element is ordinary and retains nothing", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    let items: number | undefined;

    // Dispatched from inside the second upsert, where no read element is
    // expanding. It reaches the same adapter and the same ceiling, answers
    // from the service, and retains nothing: retention belongs to the authored
    // read's own bridge.
    const ran = yield* run(fixture, twice(), stream, forge, {
      access: readable(forge).access,
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *upsert([invocation], next): Operation<PullRequestResult> {
            if (invocation.pullRequest.number === 1) {
              const answered = yield* PullRequestOperations.operations.read({
                url: `${LOCATOR}/pull/1`,
                kind: "reviews",
                provider: undefined,
              });

              items = answered.items.length;
            }
            return yield* next(invocation);
          },
        });
      },
    });

    expect(ran.refusal).toBeUndefined();
    expect(items).toBe(1);
    expect(reads(ran.events).length).toBe(0);
    expect(requests(ran.events).length).toBe(2);
  });

  it("V9e: an upsert dispatched outside its component's invocation is refused", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const stream = new InMemoryStream();
    let captured: PullRequestUpsertInvocation | undefined;
    let refusedBy: string | undefined;

    // The same invocation the component made, re-dispatched from a position
    // that is not a `<PullRequest>` invocation. The entry's upsert lifecycle is
    // that component's own invocation-local default, so there is nothing here
    // to answer it and nothing is retained for it.
    const ran = yield* run(
      fixture,
      twice(`      <PullRequest.Reviews url="${LOCATOR}/pull/1" as="reviews" />`),
      stream,
      forge,
      {
        access: readable(forge).access,
        *between(): Operation<void> {
          yield* PullRequestOperations.around({
            *upsert([invocation], next): Operation<PullRequestResult> {
              captured = invocation;
              return yield* next(invocation);
            },
            *read([invocation], next): Operation<PullRequestReadResult> {
              if (captured !== undefined) {
                try {
                  yield* PullRequestOperations.operations.upsert(captured);
                } catch (error) {
                  refusedBy = error instanceof Error ? error.message : String(error);
                }
              }
              return yield* next(invocation);
            },
          });
        },
      },
    );

    expect(ran.refusal).toBeUndefined();
    expect(refusedBy).toContain("no pull-request provider is installed");
    // Two upserts asked for by two elements, and no third retained for the
    // dispatch that reached nothing.
    expect(requests(ran.events).length).toBe(2);
    expect(upserts(ran.events).length).toBe(2);
    expect(creations(forge)).toBe(1);
    expect(reads(ran.events).length).toBe(1);
  });
});

describe("one entry's pull request, over a configured transport", () => {
  it("V9a: reaches a configured endpoint rather than an injected transport", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const endpoint = yield* useGitHubServer(forge);
    const stream = new InMemoryStream();
    const ran = yield* run(fixture, opening(), stream, forge, { endpoint });
    expect(ran.refusal).toBeUndefined();
    // The adapter read where the API lives from configuration, built the
    // platform's own transport for it, and opened one pull request through it.
    expect(creations(forge)).toBe(1);
    expect(requests(ran.events).length).toBe(1);
  });
});
