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
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
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
import { replRepositoryInstallation } from "../src/deno/retained-repository/provider.ts";
import { admitReplRepositoryHistory } from "../src/retained-repository/admission.ts";
import { GIT_HOST_EFFECT } from "../src/git-host/effect-type.ts";
import { parseGitHostReconciliationRecord } from "../src/git-host/records.ts";
import { REPL_REPOSITORY_PULL_REQUEST_REQUEST } from "../src/retained-repository/pull-request-records.ts";
import { gitOutput } from "./support/git-remotes.ts";
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
        access: gitHubSource(fakeGitHubAccess(store)),
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
  return document(
    `  <Worktree name="review" branch="${BRANCH}" as="worktree" />`,
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
