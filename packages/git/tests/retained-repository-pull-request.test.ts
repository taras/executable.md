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
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { executeInstalled } from "@executablemd/core/host";
import { collect, Elicitation } from "@executablemd/core";
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
import { PullRequestAPI } from "../src/composition/pull-request-api.ts";
import { PullRequestOperations } from "../src/composition/pull-request-operations.ts";
import type { PullRequestResult } from "../src/composition/pull-request-records.ts";
import { replRepositoryInstallation } from "../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import {
  parseReplPullRequestRequestRecord,
  REPL_REPOSITORY_PULL_REQUEST_REQUEST,
} from "../src/retained-repository/pull-request-records.ts";
import { REPL_REPOSITORY_LOCAL } from "../src/retained-repository/records.ts";
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
    if (options.between !== undefined) {
      yield* options.between();
    }
    const installation = yield* replRepositoryInstallation(options.owner ?? OWNER, {
      host: rewriting(fixture.origin),
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

    // Now the checkout it published from is gone. A pending request needs none
    // of it: the head, the base and the body are in the record.
    yield* rm(join(fixture.managed), { recursive: true, force: true });

    const resumed = yield* run(fixture, opening(), replaying(prefix), forge);
    expect(resumed.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);
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
      opening("    <Json value={1} />"),
      refusing(inner, isRequest),
      forge,
    );

    expect(attempt.refusal).toBeDefined();
    const events = yield* inner.readAll();
    expect(requests(events).length).toBe(0);
    expect(upserts(events).length).toBe(0);
    // Nothing was asked of the Git host, and the sentinel after it never ran.
    expect(mutations(forge)).toEqual([]);
  });

  it("V8b: a refused outcome append binds nothing and leaves the completion to adopt", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    const inner = new InMemoryStream();
    const attempt = yield* run(fixture, opening(), refusing(inner, isUpsert), forge);

    expect(attempt.refusal).toBeDefined();
    const events = yield* inner.readAll();
    // The request stands, the outcome does not, and the remote work may have
    // happened: that is the window reconciliation exists to close.
    expect(requests(events).length).toBe(1);
    expect(upserts(events).length).toBe(0);

    // A later attempt over that history adopts the completion.
    const resumed = yield* run(fixture, opening(), replaying(events), forge);
    expect(resumed.refusal).toBeUndefined();
    expect(creations(forge)).toBe(1);
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
    const forge = store(fixture);
    const stream = new InMemoryStream();

    // Delegates, then rewrites the answer. The rewrite cannot bind another
    // pull request: what binds is what this entry actually acknowledged.
    const rewritten = yield* run(fixture, opening(), stream, forge, {
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *upsert([invocation], next): Operation<PullRequestResult> {
            yield* next(invocation);
            return SYNTHETIC;
          },
        });
      },
    });
    expect(rewritten.refusal).toBeUndefined();
    expect(rewritten.output).not.toContain("4242");
    expect(creations(forge)).toBe(1);
    expect(requests(yield* stream.readAll()).length).toBe(1);
  });

  it("V5c: a swallowed delegated failure stays a failure", function* () {
    const fixture = yield* useFixture();
    const forge = store(fixture);
    forge.fault = { on: "create", status: 503 };
    const stream = new InMemoryStream();

    const swallowed = yield* run(fixture, opening(), stream, forge, {
      *between(): Operation<void> {
        yield* PullRequestOperations.around({
          *upsert([invocation], next): Operation<PullRequestResult> {
            try {
              return yield* next(invocation);
            } catch {
              // Catching the delegated failure and answering with a success
              // cannot rescue it.
              return SYNTHETIC;
            }
          },
        });
      },
    });
    expect(swallowed.refusal).toBeDefined();
    expect(swallowed.output).not.toContain("4242");
  });

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
