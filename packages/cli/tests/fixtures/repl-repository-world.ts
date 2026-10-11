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

import { scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import process from "node:process";
import { shellQuote } from "@executablemd/test-support/launch";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { evidenceRoutes } from "../../../git/tests/support/run-composition-tier.ts";
import { creations, issueCreations, useGitHubServer } from "../../../git/tests/support/github.ts";
import type { GitHubStore } from "../../../git/tests/support/github.ts";
import type {
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../../../git/src/deno/composition/github.ts";
import { platformDataRoot } from "../../src/repl-assembly.ts";
import { REPL_DIRECTORY } from "../../src/repl/storage.ts";
import { ended, reaching, showing } from "./pty.ts";
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
 * Every boundary one entry can reach, each with a question standing after it.
 *
 * The table is the journey: a boundary's own lines, the name a report calls it
 * by, and what has to be true of the world once it has happened. The document is
 * assembled from it with an ordinary `<Elicit>` after each one, so each boundary
 * has a place a person can be when they walk away — and a place a later
 * invocation finds them, with everything above it done and nothing below it
 * started.
 *
 * What each row asserts is the world rather than the screen: bytes on disk, the
 * index and the refs a real Git reports, the branch at the bare remote, and the
 * mutations that actually reached the forge. The walk below asks each row twice
 * — before leaving and again after reopening — so a boundary that was done
 * cannot have been done differently by its own replay.
 *
 * The last boundary carries no question of its own: the entry settling *is* the
 * place after it, and the walk reads its answer out of the settled output.
 */
export interface Boundary {
  /** What this boundary is called, in a report and in a failure. */
  readonly name: string;
  /** The document lines it is made of. */
  readonly lines: readonly string[];
  /** What must be true once it has happened. */
  done(state: BoundaryState): Operation<void>;
}

/** What a boundary's own assertion is handed. */
export interface BoundaryState {
  readonly world: World;
  readonly store: GitHubStore;
  /**
   * The managed checkout this journey's `<Repository>` was placed in.
   *
   * Asked for rather than handed over, because the first boundary is the one
   * that creates it: a state built before that boundary ran would have to
   * guess, and guessing is how a row ends up asserting about a directory that
   * does not exist yet.
   */
  checkout(): Operation<string>;
}

/** The state a journey's assertions are made against. */
function stateOf(world: World, store: GitHubStore): BoundaryState {
  return { world, store, checkout: () => managedCheckout(world) };
}

/** The managed checkout of this world's one placement. */
export function* managedCheckout(world: World): Operation<string> {
  const placements = join(world.home, ".xmd", "repositories", "repositories");
  const names = yield* until(readdir(placements));
  if (names.length !== 1) {
    throw new Error(`this world holds ${names.length} managed placements, not one`);
  }
  return join(placements, names[0] ?? "", "checkout");
}

/** What `git` reports, for a row that is asking about the index or the refs. */
function reports(args: readonly string[], cwd: string, world: World): string {
  return git(args, cwd, world.home);
}

/** The whole journey, boundary by boundary. */
export const BOUNDARIES: readonly Boundary[] = Object.freeze([
  {
    name: "Repository",
    lines: [`<Repository name="project" url="${LOCATOR}">`],
    *done({ world, ...state }: BoundaryState): Operation<void> {
      // A checkout of its own, placed under this host's root and holding what
      // the remote's branch holds.
      const checkout = yield* state.checkout();
      expect(yield* until(readFile(join(checkout, "seed.md"), "utf8"))).toBe("seed\n");
      expect(reports(["rev-parse", "HEAD"], checkout, world)).toBe(
        reports(["rev-parse", "main"], world.remote, world),
      );
    },
  },
  {
    name: "Git.Switch",
    lines: ['<Git.Switch branch="publish/1.4" />'],
    *done({ world, ...state }: BoundaryState): Operation<void> {
      const checkout = yield* state.checkout();
      expect(reports(["symbolic-ref", "--short", "HEAD"], checkout, world)).toBe("publish/1.4");
    },
  },
  {
    name: "Dir and authored File",
    lines: ['<Dir path="notes">', '<File path="authored.md">authored</File>', "</Dir>"],
    *done(state: BoundaryState): Operation<void> {
      const checkout = yield* state.checkout();
      expect(yield* until(readFile(join(checkout, "notes", "authored.md"), "utf8"))).toBe(
        "authored",
      );
    },
  },
  {
    name: "generated File",
    lines: ['<Evaluate text={fragment} allow={["write"]} />'],
    /**
     * The bytes a generated program wrote, where it actually wrote them.
     *
     * Which is the directory the *command* started in, and not the checkout the
     * enclosing `<Repository>` selected: a fragment resolves its paths against
     * the file access this entry captured when it began, and that access
     * carries the entry's own working directory rather than the one composed
     * around the element that invoked it. An authored `<File>` beside it lands
     * in the selected checkout, so the two disagree.
     *
     * This row therefore says where the write went and nothing about who owns
     * it: in this journey the write lands outside every selected checkout, and
     * on a continuation it leaves no retained record at all. Both are reported
     * with their own evidence rather than asserted away here — a row that
     * demanded the documented behaviour would fail for the product's reason
     * while claiming to be about leaving and reopening.
     */
    *done({ world }: BoundaryState): Operation<void> {
      expect(yield* until(readFile(join(world.checkout, "generated.md"), "utf8"))).toBe(
        "generated",
      );
    },
  },
  {
    name: "Git.Add",
    lines: ['<Git.Add paths="." />'],
    *done({ world, ...state }: BoundaryState): Operation<void> {
      const checkout = yield* state.checkout();
      // Staged, which is a fact about the index rather than about the files —
      // and exactly what is in this checkout to stage: the authored file. The
      // generated one is in the directory the command started in, as the
      // boundary above says, so `.` here cannot reach it.
      expect(reports(["diff", "--cached", "--name-only"], checkout, world).split("\n")).toEqual([
        "notes/authored.md",
      ]);
    },
  },
  {
    name: "Git.Commit",
    lines: ['<Git.Commit message="Prepare 1.4" as="commit" />'],
    *done({ world, ...state }: BoundaryState): Operation<void> {
      const checkout = yield* state.checkout();
      expect(reports(["log", "-1", "--format=%s"], checkout, world)).toBe("Prepare 1.4");
      expect(reports(["show", "HEAD:notes/authored.md"], checkout, world)).toBe("authored");
      // Nothing left staged: the commit took what Add had put there.
      expect(reports(["diff", "--cached", "--name-only"], checkout, world)).toBe("");
    },
  },
  {
    name: "Git.Push",
    lines: ["<Git.Push />"],
    *done({ world, ...state }: BoundaryState): Operation<void> {
      const checkout = yield* state.checkout();
      expect(reports(["rev-parse", "publish/1.4"], world.remote, world)).toBe(
        reports(["rev-parse", "HEAD"], checkout, world),
      );
    },
  },
  {
    name: "PullRequest",
    lines: ['<PullRequest title="Prepare 1.4" as="pullRequest">', "the body", "</PullRequest>"],
    // deno-lint-ignore require-yield
    *done({ store }: BoundaryState): Operation<void> {
      expect(creations(store)).toBe(1);
      expect(store.pullRequests.map((one) => one.title)).toEqual(["Prepare 1.4"]);
    },
  },
  {
    name: "PullRequest.Reviews",
    lines: [`<PullRequest.Reviews url="${LOCATOR}/pull/${OPENED}" as="reviews" />`],
    // deno-lint-ignore require-yield
    *done({ store }: BoundaryState): Operation<void> {
      expect(forgePaths(store).some((one) => one.endsWith("/reviews"))).toBe(true);
    },
  },
  {
    name: "PullRequest.Comments",
    lines: [`<PullRequest.Comments url="${LOCATOR}/pull/${OPENED}" as="comments" />`],
    // deno-lint-ignore require-yield
    *done({ store }: BoundaryState): Operation<void> {
      expect(forgePaths(store).some((one) => one.endsWith("/comments"))).toBe(true);
    },
  },
  {
    name: "PullRequest.Checks",
    lines: [`<PullRequest.Checks url="${LOCATOR}/pull/${OPENED}" as="checks" />`],
    // deno-lint-ignore require-yield
    *done({ store }: BoundaryState): Operation<void> {
      expect(forgePaths(store).some((one) => one.endsWith("/check-runs"))).toBe(true);
    },
  },
  {
    name: "Worktree",
    lines: [
      '<Worktree name="review" branch="review/1.4">',
      '<File path="review.md">reviewing</File>',
      "</Worktree>",
    ],
    *done({ world, ...state }: BoundaryState): Operation<void> {
      const checkout = yield* state.checkout();
      // A linked checkout of the same repository, with its own branch and the
      // file that entry wrote inside it.
      const linked = reports(["worktree", "list", "--porcelain"], checkout, world)
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      expect(linked).toHaveLength(2);
      const other = linked.find((one) => one !== checkout);
      if (other === undefined) {
        throw new Error(`no linked worktree beside ${checkout}: ${linked.join(", ")}`);
      }
      expect(reports(["symbolic-ref", "--short", "HEAD"], other, world)).toBe("review/1.4");
      expect(yield* until(readFile(join(other, "review.md"), "utf8"))).toBe("reviewing");
    },
  },
  {
    name: "Issue",
    lines: [
      `<IssueTracker url="${LOCATOR}">`,
      '<Issue title="Follow up on 1.4" as="filed">',
      "the description",
      "</Issue>",
      "</IssueTracker>",
      "</Repository>",
    ],
    // deno-lint-ignore require-yield
    *done({ store }: BoundaryState): Operation<void> {
      expect(issueCreations(store)).toBe(1);
      expect(store.issues.map((one) => one.title)).toEqual(["Follow up on 1.4"]);
    },
  },
]);

/** What every checkpoint is answered with, one character so a reading of all of
 * them fits on a line. */
export const ANSWER = "y";

/** The schema and the fragment every checkpoint's question is judged against. */
const PREAMBLE: readonly string[] = [
  "```js eval",
  'const ask = { type: "object", properties: { ok: { type: "string" } }, ' +
    'required: ["ok"], additionalProperties: false };',
  "const fragment = '<File path=\"generated.md\">generated</File>';",
  "```",
  "",
];

/** The name a checkpoint's binding is retained under. */
function binding(at: number): string {
  return `after${at + 1}`;
}

/**
 * The document this journey is, assembled from the table.
 *
 * Every boundary but the last is followed by its own question, and the closing
 * lines read back a value from each end of the journey: the pull request it
 * opened, the commit it made, the issue it filed, the three collections it read
 * and every answer it was given. A reopen that lost one of them would say so
 * here rather than in a counter.
 */
export const JOURNEY: string = [
  ...PREAMBLE,
  ...BOUNDARIES.flatMap((boundary, at) => [
    ...boundary.lines,
    ...(at === BOUNDARIES.length - 1
      ? []
      : [`<Elicit schema={ask} as="${binding(at)}">After ${boundary.name}?</Elicit>`]),
  ]),
  "",
  "opened {pullRequest.number} at {commit.commit} filed {filed.url}",
  "read {reviews.length} {comments.length} {checks.length}",
  `answered ${BOUNDARIES.slice(0, -1)
    .map((_, at) => `{${binding(at)}.ok}`)
    .join("")}`,
].join("\n");

/**
 * What the settled journey prints, which only the whole of it can produce.
 *
 * One answer per checkpoint, in order, which is what makes this a reading of
 * the whole walk rather than of its last step: an answer lost to a reopen
 * leaves a gap here.
 */
export const JOURNEY_OUTPUT: readonly string[] = Object.freeze([
  `opened ${OPENED} at `,
  "read 1 2 2",
  `answered ${ANSWER.repeat(BOUNDARIES.length - 1)}`,
]);

/**
 * Every path this entry has retained a write of, as its own records name them.
 *
 * Read from the file the command wrote, which is the only authority on what
 * this entry owns: a write that reached ordinary file handling leaves nothing
 * here, whatever appeared on disk.
 */
export function* retainedWrites(world: World): Operation<string[]> {
  const held: string[] = [];
  for (const body of yield* histories(world.home)) {
    for (const line of body.trim().split("\n")) {
      if (!line.includes("file-write")) {
        continue;
      }
      const target = /"path":"([^"]+)"/.exec(line)?.[1];
      if (target !== undefined) {
        held.push(target);
      }
    }
  }
  return held;
}

/** What the world holds, as a reopen must find it. */
interface Standing {
  /** Every ref the bare remote holds, and where it points. */
  readonly remote: string;
  /** The managed checkout's own head, index and worktree. */
  readonly local: string;
  /** Pull requests created at the forge. */
  readonly creations: number;
  /** Issues created at the forge. */
  readonly issues: number;
  /** Every request the forge answered. */
  readonly requests: number;
}

/** What the world holds right now. */
function* standing(state: BoundaryState): Operation<Standing> {
  const { world, store } = state;
  const checkout = yield* state.checkout();
  return {
    remote: reports(["for-each-ref", "--format=%(refname) %(objectname)"], world.remote, world),
    local: [
      reports(["rev-parse", "HEAD"], checkout, world),
      reports(["symbolic-ref", "--short", "HEAD"], checkout, world),
      reports(["status", "--porcelain"], checkout, world),
      // The checkout the command was started in, too: a generated program
      // writes there, so leaving it out would leave a reopen free to write
      // again where nobody was looking.
      reports(["status", "--porcelain"], world.checkout, world),
    ].join("\n"),
    creations: creations(store),
    issues: issueCreations(store),
    requests: store.requests.length,
  };
}

/** Wait until this boundary's own claim holds, or say which one did not. */
function* reached(state: BoundaryState, boundary: Boundary, within: number): Operation<void> {
  const deadline = Date.now() + within;
  while (true) {
    try {
      yield* boundary.done(state);
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        // What each checkout holds, because "the file is not there" is a
        // different defect depending on which directory it is not in.
        const where: string[] = [];
        for (const [name, at] of [
          ["managed", yield* state.checkout()],
          ["ambient", state.world.checkout],
        ] as const) {
          try {
            where.push(`${name}=${JSON.stringify(yield* until(readdir(at)))}`);
          } catch (reason) {
            where.push(`${name}=unreadable(${String(reason)})`);
          }
        }
        throw new Error(
          `${boundary.name} did not happen within ${within}ms: ${
            error instanceof Error ? error.message : String(error)
          }. ${where.join(" ")}`,
        );
      }
    }
    yield* sleep(200);
  }
}

/** How a journey starts one invocation of the public command. */
export type Invoking = (location?: string) => Operation<Pty>;

/** How long each part of a terminal journey may take. */
export interface JourneyDeadlines {
  /** Reaching a drawn screen, which compiles an entrypoint. */
  readonly reach: number;
  /** One boundary's own work. */
  readonly work: number;
  /** Leaving, and reaching a control. */
  readonly leave: number;
}

/**
 * Walk the whole table at a terminal, leaving and reopening at every boundary.
 *
 * One invocation per boundary. Each one finds the question the invocation
 * before it left standing, proves that boundary is still *exactly* as it was —
 * the same refs, the same head and index, the same forge mutations and not one
 * more request — answers it, waits for the next boundary to happen live, proves
 * that one, and leaves while its question is pending. The last invocation
 * answers the last question and the entry settles.
 *
 * So every boundary is asserted twice: once when it happened, and once after a
 * fresh public invocation replayed it. That is what makes "completed work is
 * not done again" a claim about each boundary rather than about the journey.
 */
export function* journeyThrough(
  world: World,
  store: GitHubStore,
  invoking: Invoking,
  within: JourneyDeadlines,
): Operation<void> {
  let location: string | undefined;
  let before: Standing | undefined;

  for (const [at, boundary] of BOUNDARIES.entries()) {
    const last = at === BOUNDARIES.length - 1;
    const standingBefore = before;
    const reopened = location;
    location = yield* scoped(function* (): Operation<string | undefined> {
      const pty = yield* invoking(reopened);
      const state = stateOf(world, store);

      if (reopened === undefined) {
        // The first invocation types the document; every other one is handed a
        // location and continues what this one started.
        yield* showing(pty, "[exit]", within.reach);
        yield* submit(pty, JOURNEY);
      } else {
        // The question the invocation before this one left standing, and the
        // world exactly as it left it: replay performed none of it again.
        yield* showing(pty, ASKING, within.work);
        const after = yield* standing(state);
        expect(after).toEqual(standingBefore);
        yield* BOUNDARIES[at - 1]?.done(state);
        yield* answer(pty, ANSWER, within.leave);
      }

      // This boundary, live. Its own claim is what says it has happened —
      // nothing on the screen can, because the draft holds the whole document.
      yield* reached(state, boundary, within.work);

      if (last) {
        // Nothing follows it, so the entry settles rather than asking again.
        yield* showing(pty, settledOk(1), within.work);
        // Read out of the file rather than off the screen: the transcript is
        // elided to the pane it is drawn in, and what the entry *produced* is
        // recorded. Every line of it has to be there — the pull request it
        // opened, the collections it read and one answer per checkpoint — so a
        // value lost to any of the reopens above shows up as a gap here.
        const journal = (yield* histories(world.home)).join("\n");
        for (const line of JOURNEY_OUTPUT) {
          expect(journal).toContain(line);
        }
      } else {
        yield* showing(pty, ASKING, within.work);
        before = yield* standing(state);
      }

      yield* reaching(pty, "[exit]", within.leave);
      yield* pty.type("\r");
      expect(
        yield* ended(
          pty,
          within.leave,
          `${boundary.name} had just happened, so this teardown joins a retained host.`,
        ),
      ).toBe(0);
      return last ? undefined : printed(yield* pty.shows());
    });
  }
}

/** The entry a second invocation types, which is work of its own. */
export const SECOND: string = [
  '<File path="second.md">a second entry</File>',
  '<Git.Add paths="second.md" />',
  '<Git.Commit message="A second entry" as="second" />',
  "",
  "committed {second.commit}",
].join("\n");
