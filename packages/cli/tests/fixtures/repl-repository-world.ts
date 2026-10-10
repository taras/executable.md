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
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import process from "node:process";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { platformDataRoot } from "../../src/repl-assembly.ts";
import { REPL_DIRECTORY } from "../../src/repl/storage.ts";
import type { Pty } from "./pty.ts";

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

/** One world this row owns: a home, a bare remote, and a checkout of it. */
export function* useWorld(prefix: string): Operation<World> {
  const home = yield* useTempDirectory(prefix);
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

/** Type one entry into the draft and submit it. */
export function* submit(pty: Pty, source: string): Operation<void> {
  // One burst, the way a terminal delivers a paste: every line of it, newlines
  // included, is draft text. Submitting is the separate key after it.
  yield* pty.type(source);
  yield* sleep(800);
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

/** The entry a second invocation types, which is work of its own. */
export const SECOND: string = [
  '<File path="second.md">a second entry</File>',
  '<Git.Add paths="second.md" />',
  '<Git.Commit message="A second entry" as="second" />',
  "",
  "committed {second.commit}",
].join("\n");
