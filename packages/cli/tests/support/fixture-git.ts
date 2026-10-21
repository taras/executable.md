/**
 * One `git`, run the way a person at a shell runs it.
 *
 * What a fixture needs from Git is a repository arranged on disk, and the
 * ordinary executable is the whole of that. These suites deliberately do not
 * reach the package's own host or session to do it: those are private
 * implementation on the other side of the boundary this command now owns, and
 * a fixture that imported them would make the partition untrue in the one
 * place that is supposed to prove it.
 *
 * The child belongs to the scope that asked for it. `exec()` is the process
 * owner this repository already has: it registers the child's release before
 * the spawn, puts it in its own process group, and kills and joins that group
 * when the asking scope unwinds. A hand-built promise around `execFile` would
 * stop *waiting* on cancellation while leaving the command running and still
 * writing into a fixture whose scope had already gone.
 *
 * The environment is the isolation the entry's own Git has — no global or
 * system configuration, and a home of the scenario's own — with a stated
 * identity, because a runner holding no `user.name` would otherwise turn a
 * fixture commit into a refusal. It is layered over the caller's own because
 * `env` replaces rather than extends: a command spawned without `PATH` could
 * not find `git` at all.
 */

import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import process from "node:process";

/** What every fixture command runs with, over the caller's own environment. */
function environment(home: string | undefined): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  return {
    ...inherited,
    ...(home === undefined ? {} : { HOME: home }),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
}

/** What a fixture may say about one command. */
export interface FixtureGitOptions {
  /** The home this command runs with, when the scenario owns one. */
  readonly home?: string;
}

/**
 * One `git`, run to completion under the asking scope.
 *
 * `join()` rather than `expect()`, because both callers below decide what a
 * non-zero exit means for themselves — one raises it with what Git printed,
 * and the other reads it as an answer.
 */
function ran(
  cwd: string,
  args: readonly string[],
  options: FixtureGitOptions,
): Operation<ProcessResult> {
  return exec("git", {
    arguments: [...args],
    cwd,
    env: environment(options.home),
  }).join();
}

/**
 * One fixture `git` that must succeed, so a broken fixture is loud.
 *
 * Answers trimmed standard output, which is what every caller reads.
 */
export function* runGit(
  cwd: string,
  args: readonly string[],
  options: FixtureGitOptions = {},
): Operation<string> {
  const result = yield* ran(cwd, args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * One fixture `git` whose failure is an answer rather than a fault.
 *
 * Any non-zero exit reads as "nothing": a ref that is not there is what most
 * of these reads are asking about, and Git spells its absence differently
 * depending on the question.
 */
export function* readGit(
  cwd: string,
  args: readonly string[],
  options: FixtureGitOptions = {},
): Operation<string | undefined> {
  const result = yield* ran(cwd, args, options);
  return result.code === 0 ? result.stdout.trim() : undefined;
}
