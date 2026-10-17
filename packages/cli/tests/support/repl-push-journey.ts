/**
 * The one real-terminal journey an entry's publications rest on.
 *
 * Shared by two rows that differ in exactly one thing: which `xmd` runs. The
 * Deno source row proves the entry capability this repository builds; the
 * compiled row proves the binary carries it. Writing the journey twice would
 * let the two drift, and a compiled row asserting something slightly weaker
 * than the source row is how a packaging defect survives.
 *
 * Every other row of this feature's evidence installs its own host, which is
 * what makes those rows portable and deterministic. None of them can show the
 * thing a person actually does: type an entry that commits and publishes a
 * branch, walk away at a question, advance the checkout from a shell, and come
 * back to the printed location. So this launches the production entrypoint on a
 * pty against a bare remote on disk, and reads the answer off the screen, off
 * the checkout and off that remote.
 *
 * Nothing is substituted but `git` itself, and that only to count invocations:
 * the shim forwards unchanged to the real Git, which is the only way to ask a
 * *packaged* binary whether a reopened publication ran anything at all.
 */

import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { allocate, showing, showingAcross } from "./pty.ts";
import type { Pty } from "./pty.ts";

/**
 * How long reaching the screen may take, and how long one interaction may take.
 *
 * Reaching the screen compiles or loads an entrypoint, which is slow and
 * uninteresting. Everything after that is the subject.
 */
const REACH_MS = 180_000;
const ACT_MS = 60_000;

/** How this row's `xmd` is invoked, as one shell command. */
export type ReplCommand = (args: readonly string[]) => string;

/** The author and committer this journey's entry commits under. */
const JOURNEY_IDENTITY = { name: "Journey Author", email: "journey-author@example.test" };

/** The branch this journey publishes, which is not the repository's primary one. */
const BRANCH = "review/push";

const QUESTION =
  '<Elicit schema={{ type: "object", properties: { decision: { type: "string", ' +
  'enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} ' +
  'as="answer">Published commit: {commit}. Continue this experiment?</Elicit>';

/**
 * The entry this journey types, as the specification shows it.
 *
 * A managed Repository, a Worktree whose captured path a `<Dir>` renders at, a
 * commit inside that linked checkout, the publication, the question that shows
 * what was committed, and a write after it. The publication is written from
 * inside the captured path, which is how a document reaches a linked checkout.
 */
function entry(origin: string, file: string): string {
  return [
    `<Repository name="project" url=${JSON.stringify(origin)}>`,
    '<Worktree name="experiment" branch="review/push" as="worktree" />',
    "<Dir path={worktree}>",
    `<File path=${JSON.stringify(file)}>ready</File>`,
    `<Git.Add paths=${JSON.stringify(file)} />`,
    '<Git.Commit message="Prepare notes" as="commit" />',
    "<Git.Push />",
    QUESTION,
    '<File path="after.md">continued</File>',
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/** A second entry, which publishes whatever that worktree holds now. */
function republishing(origin: string): string {
  return [
    `<Repository name="project" url=${JSON.stringify(origin)}>`,
    '<Worktree name="experiment" branch="review/push" as="worktree" />',
    "<Dir path={worktree}>",
    "<Git.Push />",
    "published again",
    "</Dir>",
    "</Repository>",
  ].join("\n");
}

/**
 * Run the whole journey, and answer with nothing.
 *
 * Takes the command rather than building one, so the only difference between
 * the two rows that call this is which `xmd` they name.
 */
export function replPushJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-push-pty-");
    const shim = yield* gitShim(home);
    yield* seedIdentity(home);
    const origin = yield* seedBareOrigin(home);
    // Typed from a directory inside no checkout, so what the entry works in is
    // the placement it selected.
    const away = join(home, "away");
    yield* until(mkdir(away, { recursive: true }));
    const open = (args: readonly string[]): string =>
      `cd ${shellQuote(away)} && ${shim.prefix} ${repl(args)}`;

    const first = yield* allocate(open(["repl", "--deny-all"]), home);
    yield* showing(first, "[exit]", REACH_MS);
    yield* first.type(entry(origin, "notes.md"));
    yield* sleep(500);
    yield* first.type("\r");

    const working = yield* managedCheckout(home, "worktrees");

    // The prefix ran: the file is there, the commit was made, the branch was
    // published, and the write after the question is not there.
    yield* holding(join(working, "notes.md"), "ready");
    yield* showing(first, "waiting for an answer", ACT_MS);
    expect(yield* exists(join(working, "after.md"))).toBe(false);
    const published = yield* gitSaid(working, ["rev-parse", "HEAD"], home);
    expect(published).toMatch(/^[0-9a-f]{40}$/);
    yield* remoteHolding(origin, BRANCH, published, home);
    // One publication, and the repository's primary branch is untouched: a
    // Push publishes the branch the checkout is on and nothing else.
    expect(yield* pushes(shim.log)).toHaveLength(1);
    const primary = yield* remoteRef(origin, "main", home);
    expect(primary).toMatch(/^[0-9a-f]{40}$/);
    expect(primary).not.toBe(published);

    yield* reach(first, "[exit]");
    yield* first.type("\r");
    expect(yield* ended(first)).toBe(0);
    const location = printedLocation((yield* first.shows()).join("\n"));

    // Changed from outside: the branch this entry published advances while the
    // person is away, which is exactly what this execution model allows.
    yield* writeTextFile(join(working, "later.md"), "later\n");
    yield* gitSaid(working, ["add", "later.md"], home);
    yield* gitSaid(working, ["commit", "-m", "theirs"], home);
    const advanced = yield* gitSaid(working, ["rev-parse", "HEAD"], home);
    expect(advanced).not.toBe(published);

    // Forgotten here, so what the log holds afterwards is what *reopening* ran.
    yield* writeTextFile(shim.log, "");

    const second = yield* allocate(open(["repl", "--deny-all", location]), home);
    yield* showing(second, "[exit]", REACH_MS);
    yield* showing(second, "waiting for an answer", ACT_MS);

    // The acknowledged publication did not happen again: no `git` ran at all,
    // and the destination still holds the commit that was published rather
    // than the one the checkout has moved to.
    expect(yield* logged(shim.log)).toEqual([]);
    expect(yield* remoteRef(origin, BRANCH, home)).toBe(published);
    expect(yield* gitSaid(working, ["rev-parse", "HEAD"], home)).toBe(advanced);
    expect(yield* exists(join(working, "after.md"))).toBe(false);

    yield* reach(second, "[answer]");
    yield* second.type("\r");
    // The saved commit, which describes what was published rather than where
    // the branch is now.
    yield* showing(second, `Published commit: ${published}`, ACT_MS);
    yield* click(second, "( ) continue");
    yield* showing(second, "[ok] entry-1", ACT_MS);

    // The suffix write executed, for the first time, on the answer — and
    // answering published nothing further.
    yield* holding(join(working, "after.md"), "continued");
    expect(yield* pushes(shim.log)).toEqual([]);
    expect(yield* remoteRef(origin, BRANCH, home)).toBe(published);

    yield* reach(second, "[exit]");
    yield* second.type("\r");
    expect(yield* ended(second)).toBe(0);

    // A separate new entry: its publication is new work, so it resolves today's
    // branch and advances the destination to what the checkout holds now.
    const third = yield* allocate(open(["repl", "--deny-all", location]), home);
    yield* showing(third, "[exit]", REACH_MS);
    yield* third.type(republishing(origin));
    yield* sleep(500);
    yield* third.type("\r");
    yield* showing(third, "published again", ACT_MS);
    yield* remoteHolding(origin, BRANCH, advanced, home);
    expect(yield* pushes(shim.log)).toHaveLength(1);
    expect(yield* remoteRef(origin, "main", home)).toBe(primary);

    yield* reach(third, "[exit]");
    yield* third.type("\r");
    expect(yield* ended(third)).toBe(0);
  });
}

/**
 * What a publication does on a runtime with no entry capability.
 *
 * Node and Bun assemble none — the Deno adapter's module graph reaches
 * `node:sqlite`, which Bun has not got — so `<Git.Push />` there says no
 * provider is installed rather than reaching a remote, and says it before
 * anything is contacted or any managed root is made.
 */
export function replUnsupportedPush(repl: ReplCommand): Operation<void> {
  return scoped(function* (): Operation<void> {
    const home = yield* useTempDirectory("xmd-repl-push-pty-");
    const shim = yield* gitShim(home);
    yield* seedIdentity(home);
    const origin = yield* seedBareOrigin(home);
    const head = yield* remoteRef(origin, "main", home);
    yield* writeTextFile(shim.log, "");

    const pty = yield* allocate(
      `cd ${shellQuote(home)} && ${shim.prefix} ${repl(["repl", "--deny-all"])}`,
      home,
    );
    yield* showing(pty, "[exit]", REACH_MS);
    yield* pty.type(
      [
        "<PrintErrors>",
        `<Repository name="project" url=${JSON.stringify(origin)}>`,
        "<Git.Push />",
        "</Repository>",
        "</PrintErrors>",
        '<File path="after.md">continued</File>',
      ].join("\n"),
    );
    yield* sleep(500);
    yield* pty.type("\r");

    // Refused before a managed checkout exists, which is before a remote exists
    // in the story at all. The refusal is a sentence, wrapped where the
    // Transcript's own width cuts it, so it is read across those rows.
    yield* showingAcross(pty, "composition provider is installed", ACT_MS);
    yield* holding(join(home, "after.md"), "continued");
    expect(yield* logged(shim.log)).toEqual([]);
    expect(yield* remoteRef(origin, "main", home)).toBe(head);
    expect(yield* exists(join(home, ".xmd", "repositories"))).toBe(false);

    yield* reach(pty, "[exit]");
    yield* pty.type("\r");
    expect(yield* ended(pty)).toBe(0);
  });
}

/** A bare repository with one commit on its primary branch. */
function* seedBareOrigin(home: string): Operation<string> {
  const origin = join(home, "origin.git");
  const seed = join(home, "seed");
  yield* until(mkdir(seed, { recursive: true }));
  yield* git(home, ["init", "--bare", "-b", "main", origin]);
  yield* git(home, ["init", "-b", "main", seed]);
  yield* writeTextFile(join(seed, "README.md"), "origin\n");
  yield* git(seed, ["add", "README.md"], home);
  yield* git(seed, ["commit", "-m", "first"], home);
  yield* git(seed, ["push", origin, "main:refs/heads/main"], home);
  return origin;
}

/** The commit a ref on the bare remote holds, or the empty string for absence. */
function* remoteRef(origin: string, branch: string, home: string): Operation<string> {
  const shown = yield* gitSaid(origin, ["for-each-ref", "--format=%(refname)|%(objectname)"], home);
  for (const line of shown.split("\n")) {
    const [name, commit] = line.split("|");
    if (name === `refs/heads/${branch}` && commit !== undefined) {
      return commit;
    }
  }
  return "";
}

/** Wait until the remote's branch holds this exact commit. */
function* remoteHolding(
  origin: string,
  branch: string,
  commit: string,
  home: string,
): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const held = yield* remoteRef(origin, branch, home);
    if (held === commit) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${origin} never held ${commit} at refs/heads/${branch}; it holds ` +
          JSON.stringify(held === "" ? "<absent>" : held),
      );
    }
    yield* sleep(250);
  }
}

/** Every `git push` the shim has seen since it was last forgotten. */
function* pushes(log: string): Operation<string[]> {
  return (yield* logged(log)).filter((line) => line.split(" ").includes("push"));
}

/**
 * A `git` on `PATH` that logs every invocation and forwards to the real one.
 *
 * Counting from outside the process is the only way to ask a *packaged* binary
 * whether a reopened publication ran anything, because a binary has no seam a
 * suite can substitute. Only the `xmd` invocation gets it on `PATH`; this
 * journey's own fixture commands keep the host's own Git, so the log holds what
 * the document did and nothing this harness did.
 */
function* gitShim(home: string): Operation<{ readonly prefix: string; readonly log: string }> {
  const real = yield* until(
    new Promise<string>((resolve, reject) => {
      execFile("sh", ["-c", "command -v git"], (error, stdout) =>
        error === null ? resolve(stdout.trim()) : reject(error),
      );
    }),
  );
  if (real === "") {
    throw new Error("this host has no git on PATH, so there is nothing to forward to");
  }
  const directory = join(home, "git-shim");
  yield* until(mkdir(directory, { recursive: true }));
  const log = join(home, "git-commands.log");
  const shim = join(directory, "git");
  yield* writeTextFile(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\nexec ${shellQuote(real)} "$@"\n`,
  );
  yield* until(chmod(shim, 0o755));
  yield* writeTextFile(log, "");
  return { prefix: `PATH=${shellQuote(directory)}:$PATH`, log };
}

/** Every `git` the shim has seen since it was last forgotten. */
function* logged(log: string): Operation<string[]> {
  const held = (yield* exists(log)) ? yield* readTextFile(log) : "";
  return held.split("\n").filter((line) => line !== "");
}

/** Give this journey's isolated home a Git identity to commit under. */
function* seedIdentity(home: string): Operation<void> {
  yield* writeTextFile(
    join(home, ".gitconfig"),
    `[user]\n\tname = ${JOURNEY_IDENTITY.name}\n\temail = ${JOURNEY_IDENTITY.email}\n`,
  );
}

/** One `git` command, in this journey's own isolated home. */
function git(cwd: string, args: readonly string[], home = cwd): Operation<void> {
  return until(
    new Promise<void>((resolve, reject) => {
      execFile("git", [...args], { cwd, env: environment(home) }, (error) =>
        error === null ? resolve() : reject(error),
      );
    }),
  );
}

/** What one `git` command printed, for a fixture that reads a repository. */
function gitSaid(cwd: string, args: readonly string[], home: string): Operation<string> {
  return until(
    new Promise<string>((resolve, reject) => {
      execFile("git", [...args], { cwd, env: environment(home) }, (error, stdout) =>
        error === null ? resolve(stdout.trim()) : reject(error),
      );
    }),
  );
}

function environment(home: string): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Journey",
    GIT_AUTHOR_EMAIL: "journey@example.test",
    GIT_COMMITTER_NAME: "Journey",
    GIT_COMMITTER_EMAIL: "journey@example.test",
  };
}

/**
 * The one managed checkout this journey's entry created, once it is there.
 *
 * Found rather than predicted. A slot is a digest of the whole identity under a
 * root this journey never names — the command decides where
 * `~/.xmd/repositories` is from the home it was given — so looking for the one
 * checkout beneath that layout is what asks the question the person asks.
 */
function* managedCheckout(home: string, kind: "repositories" | "worktrees"): Operation<string> {
  const base = join(home, ".xmd", "repositories", kind);
  const depth = kind === "repositories" ? 1 : 2;
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const found = yield* slotsBeneath(base, depth);
    if (found.length === 1 && (yield* exists(join(found[0] ?? "", "checkout")))) {
      return join(found[0] ?? "", "checkout");
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no single managed ${kind} slot appeared beneath ${base}; found ${JSON.stringify(found)}`,
      );
    }
    yield* sleep(200);
  }
}

/** Every slot directory at this depth beneath a managed layout root. */
function* slotsBeneath(base: string, depth: number): Operation<string[]> {
  if (!(yield* exists(base))) {
    return [];
  }
  let level = [base];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const directory of level) {
      for (const name of yield* until(readdir(directory))) {
        next.push(join(directory, name));
      }
    }
    level = next;
  }
  return level;
}

/** Walk the focus ring until this control is the marked one. */
function* reach(pty: Pty, label: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (!(yield* pty.shows()).some((line) => line.includes(`> ${label}`))) {
    if (Date.now() > deadline) {
      throw new Error(
        `focus never reached ${label} under ${cliRuntime()}. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* pty.type("\t");
    yield* sleep(250);
  }
}

/** Activate the control holding this text with a pointer. */
function* click(pty: Pty, text: string): Operation<void> {
  const screen = yield* pty.shows();
  const row = screen.findIndex((line) => line.includes(text));
  if (row < 0) {
    throw new Error(
      `nothing on this screen holds ${JSON.stringify(text)} to click. screen=` +
        JSON.stringify(screen.map((one) => one.trimEnd())),
    );
  }
  const column = (screen[row] ?? "").indexOf(text) + 1;
  yield* pty.type(`\u001b[<0;${column};${row + 1}M`);
  yield* pty.type(`\u001b[<0;${column};${row + 1}m`);
  yield* sleep(300);
}

/** Wait until this file holds this exact text. */
function* holding(path: string, content: string): Operation<void> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    if ((yield* exists(path)) && (yield* readTextFile(path)) === content) {
      return;
    }
    if (Date.now() > deadline) {
      const found = (yield* exists(path)) ? yield* readTextFile(path) : "<absent>";
      throw new Error(
        `${path} never held ${JSON.stringify(content)}; it holds ${JSON.stringify(found)}`,
      );
    }
    yield* sleep(200);
  }
}

/** Wait until this command finished, and answer with its exit status. */
function* ended(pty: Pty): Operation<number> {
  const deadline = Date.now() + ACT_MS;
  while (true) {
    const status = yield* pty.status();
    if (status !== undefined) {
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the command never finished under ${cliRuntime()}. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* sleep(150);
  }
}

/** The one location this command printed for a caller to come back with. */
function printedLocation(screen: string): string {
  const found = screen.match(/xmd repl '(xmd:\/\/repl\/[^']+)'/);
  if (found === null || found[1] === undefined) {
    throw new Error(
      `this command printed no reopenable location. screen=${JSON.stringify(screen)}`,
    );
  }
  return found[1];
}
