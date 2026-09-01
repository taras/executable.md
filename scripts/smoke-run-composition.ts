/**
 * Repository composition through the compiled binary (#643).
 *
 * The ordinary provider is assembled at a runtime-named entrypoint, holds its
 * managed checkouts with a kernel-released advisory lock, and discovers the
 * ambient repository from the directory the command was run in. Every one of
 * those is a fact about the program that is running, so only the binary shows
 * they survived `deno compile`.
 *
 * Four claims, each observed from outside the process:
 *
 * 1. a root-level `<Worktree>` belongs to the repository the binary was run in,
 *    and a command inside it runs there;
 * 2. that checkout is a real linked worktree — `.git` is a file — and it is
 *    still on disk after the process exits;
 * 3. a second binary, run while the first still holds the slot, is refused
 *    without waiting and changes nothing; and
 * 4. once the first exits, the slot is taken by the next one, which finds the
 *    same checkout.
 *
 * The managed root is a temporary directory named through the same environment
 * a person's would be reached through, so nothing here touches
 * `~/.xmd/repositories`.
 */

import { main } from "effection";
import { sleep, until } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "./lib/temp-directory.ts";
import * as path from "node:path";

const BINARY = path.join(Deno.cwd(), "dist", "xmd");

function fail(claim: string): never {
  console.error(`run-composition smoke: ${claim}`);
  Deno.exit(1);
}

/** Git, run with an environment a caller's own configuration cannot reach. */
function git(args: readonly string[], cwd: string, home: string): string {
  const outcome = new Deno.Command("git", {
    args: [...args],
    cwd,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Smoke",
      GIT_AUTHOR_EMAIL: "smoke@example.invalid",
      GIT_COMMITTER_NAME: "Smoke",
      GIT_COMMITTER_EMAIL: "smoke@example.invalid",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const printed = new TextDecoder().decode(outcome.stdout).trim();
  if (!outcome.success) {
    fail(`git ${args.join(" ")} failed: ${new TextDecoder().decode(outcome.stderr)}`);
  }
  return printed;
}

/**
 * One invocation of the compiled binary on the smoke document.
 *
 * The long-lived one inherits its streams. A piped stream nobody is draining is
 * a buffer that fills, and the run this script gates on is deliberately held
 * open — so the one invocation that must not be blocked by its own output is
 * the one whose output nothing is reading.
 */
function binary(
  cwd: string,
  env: Record<string, string>,
  streams: "piped" | "null" = "piped",
): Deno.Command {
  return new Deno.Command(BINARY, {
    args: ["run", "smoke.md", "--raw"],
    cwd,
    env,
    clearEnv: true,
    stdout: streams,
    stderr: streams,
  });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** The environment every binary invocation in this smoke runs under. */
function environment(home: string, managed: string): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "",
    // The managed root follows `HOME`, so this smoke never reaches the real
    // `~/.xmd/repositories` and never needs an option that does not exist.
    HOME: managed,
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

await main(function* () {
  if (!(yield* exists(BINARY))) {
    fail(`no compiled binary at ${BINARY} — run \`deno task build\` first`);
  }

  const home = yield* useTempDirectory("xmd-smoke-orc-home-");
  const managed = yield* useTempDirectory("xmd-smoke-orc-managed-");
  const workspace = yield* useTempDirectory("xmd-smoke-orc-");
  const checkout = path.join(workspace, "checkout");

  // A configured identity, because an ordinary run commits as the invoking user
  // and refuses when this host cannot say who that is.
  yield* writeTextFile(
    path.join(home, ".gitconfig"),
    ["[user]", "\tname = Smoke Runner", "\temail = smoke@example.invalid", ""].join("\n"),
  );

  git(["init", "--initial-branch=main", checkout], workspace, home);
  git(["commit", "--allow-empty", "-m", "first"], checkout, home);
  const started = git(["rev-parse", "HEAD"], checkout, home);

  // 1 and 2. A root-level Worktree of the repository the binary was run in, a
  //    command inside it, and a gate the document holds itself open on. The
  //    command writes where it is standing to a file rather than to its own
  //    output, so what this script reads is the checkout Git resolved rather
  //    than a line it had to parse out of a rendered document.
  const release = path.join(workspace, "release");
  const marker = path.join(workspace, "standing-in");
  yield* writeTextFile(
    path.join(checkout, "smoke.md"),
    [
      "# Ordinary repository composition",
      "",
      '<Worktree name="smoke" branch="smoke" as="worktree" />',
      "",
      "<Dir path={worktree}>",
      "",
      "```bash exec",
      `git rev-parse --show-toplevel > ${marker}; while [ ! -f ${release} ]; do sleep 0.05; done`,
      "```",
      "",
      "</Dir>",
      "",
    ].join("\n"),
  );

  const holding = binary(checkout, environment(home, managed), "null").spawn();

  // Observed while the child is still waiting for a file this script has not
  // written yet, so the slot is genuinely held when the second binary asks for
  // it.
  for (let attempt = 0; !(yield* exists(marker)); attempt += 1) {
    if (attempt > 600) {
      fail("the document never reached its worktree command");
    }
    yield* sleep(100);
  }

  // 3. A second binary, while the first still holds the slot.
  const contended = yield* until(binary(checkout, environment(home, managed)).output());
  const reported = decode(contended.stdout) + decode(contended.stderr);
  if (contended.success) {
    fail("a second process was allowed into a slot the first was holding");
  }
  if (!reported.includes("another process is working in")) {
    fail(`a second process refused for the wrong reason: ${reported}`);
  }

  yield* writeTextFile(release, "go\n");
  const first = yield* until(holding.status);
  if (!first.success) {
    fail(`the holding run exited ${first.code}`);
  }

  // Where the command inside the Worktree was actually standing.
  const slot = (yield* readTextFile(marker)).trim();

  // The worktree the run made is still there, and it is a real linked one.
  if (!(yield* exists(slot))) {
    fail(`the managed worktree did not survive the run: ${slot}`);
  }
  const administration = yield* readTextFile(path.join(slot, ".git"));
  if (!administration.startsWith("gitdir:")) {
    fail(`the managed worktree's .git is not a file naming its repository: ${administration}`);
  }
  if (git(["rev-parse", "--show-toplevel"], slot, home) !== slot) {
    fail("the managed worktree does not report itself as its own checkout root");
  }
  // It belongs to the ambient repository, which is what "ambient" means, and
  // the ambient checkout was left where it was.
  if (git(["rev-parse", "HEAD"], checkout, home) !== started) {
    fail("the ambient checkout moved");
  }
  if (git(["rev-parse", "--abbrev-ref", "HEAD"], slot, home) !== "smoke") {
    fail("the managed worktree is not on the branch the document asked for");
  }

  // 4. The slot is free again, and the next run finds the same checkout. The
  //    marker is removed first, so what it holds afterwards is that run's own
  //    answer rather than the first one's.
  yield* rm(marker);
  const later = yield* until(binary(checkout, environment(home, managed)).output());
  if (!later.success) {
    fail(`the slot was not released for a later run: ${decode(later.stderr)}`);
  }
  if ((yield* readTextFile(marker)).trim() !== slot) {
    fail("a later run did not reuse the checkout the first one made");
  }
  if (!(yield* exists(slot))) {
    fail("the managed worktree did not survive the later run");
  }

  console.log("run-composition smoke: ok");
});
