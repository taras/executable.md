/**
 * A real repository for a real `xmd repl` to work in, and how to read it.
 *
 * Two rows drive the actual command on a pty over one of these: the source CLI
 * (`repl-repositories-pty`) and the compiled binary
 * (`scripts/tests/repl-repositories-compiled`). What they prove differs — one is
 * about the entrypoints this checkout runs, the other about what survived
 * `deno compile` — but the world is the same world, and two copies of it would
 * be two accounts of what an entry's repository is.
 *
 * Nothing here is substituted. The remote is a bare repository on disk, which is
 * what a `<Git.Push>` from a subprocess can reach without a credential or a
 * network: the publication is real, the objects really travel, and the branch
 * really moves. The home is the one the command reads its data root and its
 * managed root out of, so each row's histories and repositories are its own.
 */

import { sleep, until } from "effection";
import type { Operation } from "effection";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import process from "node:process";
import { shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { evidenceRoutes } from "../../../git/tests/support/run-composition-tier.ts";
import { useGitHubServer } from "../../../git/tests/support/github.ts";
import type { GitHubStore } from "../../../git/tests/support/github.ts";
import type {
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../../../git/src/deno/composition/github.ts";
import { platformDataRoot } from "../../src/repl-assembly.ts";
import { REPL_DIRECTORY } from "../../src/repl/storage.ts";
import { reaching, showing } from "./pty.ts";
import type { Pty } from "./pty.ts";

/** The repository a journey document names, and the forge it belongs to. */
export const LOCATOR = "https://github.com/octo/project";

/** The pull request this journey opens, which is the store's first. */
const OPENED = 1;

/** The pull request the canned evidence was written about. */
const CANNED = 4;

/** The commit that evidence names, which this journey's own commit stands for. */
const CANNED_HEAD = "a".repeat(40);

/** Git for the fixture itself, under an environment nothing inherits from. */
export function git(args: readonly string[], cwd: string, home: string): string {
  const outcome = spawnSync("git", [...args], {
    cwd,
    env: {
      ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (outcome.status !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${outcome.stderr}`);
  }
  return outcome.stdout.trim();
}

export interface World {
  /** The home every process in this row runs under. */
  readonly home: string;
  /** The checkout the command is started in. */
  readonly checkout: string;
  /** The bare repository it publishes to. */
  readonly remote: string;
  /** What the remote's branch pointed at before any entry ran. */
  readonly seeded: string;
}

/**
 * One world this row owns: a home, a bare remote, and a checkout of it.
 *
 * The home is canonicalized, because on this platform a temporary directory is
 * reached through a symlink (`/var` is `/private/var`) and a home is where the
 * command puts its managed checkouts. The host constructs those paths from the
 * home it was given and attributes a write by the path the write arrived on, so
 * a symlinked home makes the two spellings of one directory disagree: the write
 * lands in the managed checkout and is attributed to the ambient one, and the
 * next operation finds a state its own history does not account for. That is a
 * narrow product fragility worth reporting, and it is not what these rows are
 * about — so they hand the product the path it would have in production.
 */
export function* useWorld(prefix: string): Operation<World> {
  const home = yield* until(realpath(yield* useTempDirectory(prefix)));
  const remote = join(home, "remote.git");
  const checkout = join(home, "checkout");
  git(["init", "--bare", "-b", "main", remote], home, home);
  const seed = join(home, "seed");
  git(["clone", "--", remote, seed], home, home);
  yield* until(writeFile(join(seed, "seed.md"), "seed\n"));
  git(["add", "seed.md"], seed, home);
  git(["commit", "-m", "seed"], seed, home);
  git(["push", "origin", "main"], seed, home);
  git(["clone", "--", remote, checkout], home, home);
  // Repository-local, because the Git host neutralises global and system
  // configuration: an identity from whoever ran this suite is foreign state.
  git(["config", "user.name", "Entry"], checkout, home);
  git(["config", "user.email", "entry@example.invalid"], checkout, home);
  return { home, checkout, remote, seeded: git(["rev-parse", "main"], remote, home) };
}

/**
 * The histories this command wrote, in the directory the command chose.
 *
 * Resolved with the command's own `platformDataRoot()` rather than by spelling a
 * path here: a row sets a home and lets the product decide what that means, and
 * one that hard-coded the answer would stop checking it.
 */
export function* histories(home: string): Operation<string[]> {
  const root = join(
    platformDataRoot(process.platform, home, { XDG_DATA_HOME: join(home, "share") }, sep),
    ...REPL_DIRECTORY,
  );
  const held: string[] = [];
  for (const name of yield* until(readdir(root))) {
    held.push(yield* until(readFile(join(root, name), "utf8")));
  }
  return held;
}

/**
 * A `git` of this world's own, which reaches the bare remote beside it.
 *
 * The one thing a journey through the public command cannot otherwise have: a
 * document names a canonical GitHub repository, and a canonical GitHub
 * repository is what the production host insists on — it parses the locator,
 * refuses a port and a private hostname, and neutralises `GIT_CONFIG_GLOBAL`
 * and `GIT_CONFIG_SYSTEM` so no configuration file can redirect it.
 *
 * What it does carry is the caller's `PATH`, and it invokes `git` by name. So
 * the substituted leaf is `git` itself: a wrapper first on this world's `PATH`
 * that forwards every invocation, its arguments, streams and exit status
 * untouched, to the real Git it resolved once — with one command-line
 * `-c url.<remote>.insteadOf=<locator>` in front, which survives the
 * neutralisation because it is not a file.
 *
 * The stored `remote.origin.url` stays the canonical locator, exactly as the
 * product records it, and the objects really travel to the bare repository.
 * Nothing in the product is relaxed, and no production setting is added: this
 * is the transport leaf, substituted the way a test substitutes a service.
 */
function* useGitTransport(world: {
  readonly home: string;
  readonly remote: string;
}): Operation<string> {
  const found = spawnSync("which", ["git"], { encoding: "utf8" });
  if (found.status !== 0) {
    throw new Error(
      `this host has no \`git\` on PATH, so the journey's transport cannot be built: ${found.stderr}`,
    );
  }
  const real = found.stdout.trim();
  const bin = join(world.home, "transport-bin");
  yield* until(mkdir(bin, { recursive: true }));
  const wrapper = join(bin, "git");
  yield* until(
    writeFile(
      wrapper,
      `#!/bin/sh\nexec ${shellQuote(real)} -c ` +
        `${shellQuote(`url.${world.remote}.insteadOf=${LOCATOR}`)} "$@"\n`,
    ),
  );
  yield* until(chmod(wrapper, 0o755));
  return bin;
}

/**
 * The evidence three reads ask for, answered under what this journey published.
 *
 * The canned bodies belong to another pull request and another commit, because
 * they were written for a suite that had neither — so the path is normalised to
 * the one they were written about, and the body is answered back under the
 * number and the commit this journey actually made. An answer about a different
 * pull request is the wrong answer, and the adapter says so rather than taking
 * it, which is what makes this substitution worth making carefully.
 */
function evidenceAnswers(
  store: GitHubStore,
  endpoint: () => string,
): (request: GitHubHttpRequest) => GitHubHttpResponse | undefined {
  return (request) => {
    if (request.method !== "GET") {
      return undefined;
    }
    const path = new URL(request.url).pathname;
    const commit = /\/commits\/([0-9a-f]{40})\//.exec(path)?.[1];
    const asked = (commit === undefined ? path : path.replace(commit, CANNED_HEAD))
      .split(`/pulls/${OPENED}/`)
      .join(`/pulls/${CANNED}/`)
      .split(`/issues/${OPENED}/`)
      .join(`/issues/${CANNED}/`);
    const canned = evidenceRoutes(endpoint())[asked];
    if (canned === undefined) {
      return undefined;
    }
    // Counted like any other request this forge answered: what a journey
    // asserts about replay is that these reads happened once.
    store.requests.push(request);
    const body = canned
      .split(`/pulls/${CANNED}`)
      .join(`/pulls/${OPENED}`)
      .split(`/issues/${CANNED}`)
      .join(`/issues/${OPENED}`);
    return {
      status: 200,
      body: commit === undefined ? body : body.split(CANNED_HEAD).join(commit),
    };
  };
}

/**
 * The forge this world's entries reach, behind a real listener.
 *
 * The modeled GitHub the Git package's own suites drive, served over HTTP so a
 * subprocess can reach it: pull requests and issues are the store's, and the
 * three evidence collections are the canned bodies above. The store is this
 * process's, so what a journey asserts about requests and mutations is counted
 * where the requests actually arrived.
 */
export function useForge(store: GitHubStore): Operation<string> {
  let endpoint = "";
  return (function* (): Operation<string> {
    endpoint = yield* useGitHubServer(
      store,
      evidenceAnswers(store, () => endpoint),
    );
    return endpoint;
  })();
}

/**
 * Everything the public command needs exported to reach this world's leaves.
 *
 * The transport on `PATH`, the credential the two variables are read for, and
 * the two configurations that say which repository may be read and where its
 * API lives. All of it is ordinary operator configuration and an ordinary
 * `PATH`: nothing here is a mode, a flag or a policy the product would not
 * already honour.
 */
export function* useJourneyEnvironment(
  world: World,
  store: GitHubStore,
): Operation<Readonly<Record<string, string>>> {
  const bin = yield* useGitTransport(world);
  const endpoint = yield* useForge(store);
  return Object.freeze({
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    GH_TOKEN: store.token ?? "",
    XMD_WORKFLOW_GITHUB_PULL_REQUESTS: JSON.stringify({ allowed: [LOCATOR], endpoint }),
    XMD_WORKFLOW_GITHUB_ISSUES: JSON.stringify({ ceiling: [LOCATOR], endpoint }),
  });
}

/** What the store answered, as a GitHub request's own path reads. */
export function forgePaths(store: GitHubStore): string[] {
  return store.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
}

/** Type one entry into the draft and submit it. */
export function* submit(pty: Pty, source: string): Operation<void> {
  // One burst, the way a terminal delivers a paste: every line of it, newlines
  // included, is draft text. Submitting is the separate key after it.
  yield* pty.type(source);
  yield* sleep(800);
  yield* pty.type("\r");
}

/**
 * Wait until something this process can see is true, or say what it was for.
 *
 * The screen is not the only thing a terminal row waits on: a request that
 * reached this process's own forge is a fact about the world, and it is the
 * honest signal for work the transcript elides. A deadline rather than a sleep,
 * because how long a publication takes is the machine's business.
 */
export function* holds(what: string, within: number, ready: () => boolean): Operation<void> {
  const deadline = Date.now() + within;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} did not happen within ${within}ms`);
    }
    yield* sleep(100);
  }
}

/**
 * The control a waiting question puts on the footer, in every state.
 *
 * One fixed spelling rather than the question's own words, which is what the
 * product draws there for the same reason: a control as wide as somebody's
 * message is one the narrowest frame drops. It is also the only honest signal
 * for these rows, because the question's own text is in the document they typed.
 */
export const ASKING = "[answer]";

/**
 * Answer the question that is waiting, the way a person answers one.
 *
 * The footer control first, because the drawer is not opened for anybody: the
 * question announces itself there, and activating that control is what opens
 * the drawer with its field focused. Then the value, then Enter — which is the
 * submission, and which closes the drawer by answering it.
 */
export function* answer(pty: Pty, value: string, within: number): Operation<void> {
  yield* reaching(pty, ASKING, within);
  yield* pty.type("\r");
  yield* showing(pty, "ok", within);
  yield* pty.type(value);
  yield* sleep(400);
  yield* pty.type("\r");
}

/**
 * How these rows wait for an entry, and why it is not the entry's own words.
 *
 * The draft is drawn as it is typed, so every character of a document is already
 * on the screen before anything runs — a row that waited for text from its own
 * source would match the draft and assert nothing. The first version of the
 * source row waited for `published`, matched the draft, and went on to read a
 * checkout that had not been touched.
 *
 * The outcome marker is the opposite: `1. [ok]` is the catalog's reading of an
 * entry that settled successfully, drawn from a typed status rather than from
 * output, and there is no typing that produces it.
 *
 * It is the only thing these rows read off the screen. What an entry *did* is
 * asked of the repository — a commit that did not exist, a remote branch that
 * moved to it, a file readable out of that branch — because the transcript's own
 * rows are elided to the pane they are drawn in, and a row that insisted on
 * reading them would be asserting a layout on its way to asserting a push.
 */
export function settledOk(entry: number): string {
  return `${entry}. [ok]`;
}

/** The same reading for an entry that failed. */
export function settledErr(entry: number): string {
  return `${entry}. [err]`;
}

/** The one location this command printed for a caller to come back with. */
export function printed(screen: readonly string[]): string {
  const found = screen.join("\n").match(/xmd:\/\/repl\/[^\s'"]+/);
  if (found === null) {
    throw new Error(
      "the command printed no location to reopen with. screen=" +
        JSON.stringify(screen.map((line) => line.trimEnd()).filter((line) => line.length > 0)),
    );
  }
  return found[0];
}

/**
 * The entry one person types: repository work, in the checkout they are standing
 * in, published to the remote that checkout came from.
 *
 * Ambient rather than inside a `<Repository>`, because that is what a person at
 * a terminal has — they are already somewhere, and the retained host's ambient
 * selection is the thing these rows are reaching.
 */
export const ENTRY: string = [
  '<File path="typed.md">typed at a terminal</File>',
  '<Git.Add paths="typed.md" />',
  '<Git.Commit message="Typed at a terminal" as="commit" />',
  "<Git.Push />",
  "",
  "published {commit.commit}",
].join("\n");

/**
 * The whole vocabulary one entry can reach, with a checkpoint in the middle.
 *
 * In the order a person writes it: a managed checkout of its own, an authored
 * directory, a generated write, a branch, a commit — then an ordinary question
 * standing between the local work and the external work — then the publication,
 * the pull request, its three evidence collections, a second question, a linked
 * worktree and a deferred issue.
 *
 * The two questions are where a terminal journey leaves. Everything above a
 * question has happened by the time it is asked, and everything below it has
 * not, which is what makes each one a place to come back to.
 */
export const JOURNEY: string = [
  "```js eval",
  'const ask = { type: "object", properties: { ok: { type: "string" } }, ' +
    'required: ["ok"], additionalProperties: false };',
  "const fragment = '<File path=\"generated.md\">generated</File>';",
  "```",
  "",
  `<Repository name="project" url="${LOCATOR}">`,
  '<Git.Switch branch="publish/1.4" />',
  '<Dir path="notes">',
  '<File path="authored.md">authored</File>',
  "</Dir>",
  '<Evaluate text={fragment} allow={["write"]} />',
  '<Git.Add paths="." />',
  '<Git.Commit message="Prepare 1.4" as="commit" />',
  '<Elicit schema={ask} as="local">Local work ready?</Elicit>',
  "<Git.Push />",
  '<PullRequest title="Prepare 1.4" as="pullRequest">',
  "the body",
  "</PullRequest>",
  `<PullRequest.Reviews url="${LOCATOR}/pull/${OPENED}" as="reviews" />`,
  `<PullRequest.Comments url="${LOCATOR}/pull/${OPENED}" as="comments" />`,
  `<PullRequest.Checks url="${LOCATOR}/pull/${OPENED}" as="checks" />`,
  '<Elicit schema={ask} as="external">External work ready?</Elicit>',
  '<Worktree name="review" branch="review/1.4">',
  '<File path="review.md">reviewing</File>',
  "</Worktree>",
  `<IssueTracker url="${LOCATOR}">`,
  '<Issue title="Follow up on 1.4" as="filed">',
  "the description",
  "</Issue>",
  "</IssueTracker>",
  "</Repository>",
  "",
  "opened {pullRequest.number} at {commit.commit} filed {filed.url}",
  "read {reviews.length} {comments.length} {checks.length}",
  "answered {local.ok} {external.ok}",
].join("\n");

/** The entry a second invocation types, which is work of its own. */
export const SECOND: string = [
  '<File path="second.md">a second entry</File>',
  '<Git.Add paths="second.md" />',
  '<Git.Commit message="A second entry" as="second" />',
  "",
  "committed {second.commit}",
].join("\n");
