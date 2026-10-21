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
 * The environment is the isolation the entry's own Git has — no global or
 * system configuration, and a home of the scenario's own — with a stated
 * identity, because a runner holding no `user.name` would otherwise turn a
 * fixture commit into a refusal.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { execFile } from "node:child_process";
import process from "node:process";

/** What every fixture command runs with, over the caller's own environment. */
function environment(home: string | undefined): Record<string, string | undefined> {
  return {
    ...process.env,
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
 * One fixture `git` that must succeed, so a broken fixture is loud.
 *
 * Answers trimmed standard output, which is what every caller reads.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: FixtureGitOptions = {},
): Operation<string> {
  return until(
    new Promise<string>((resolve, reject) => {
      execFile("git", [...args], { cwd, env: environment(options.home) }, (error, stdout, stderr) =>
        error === null
          ? resolve(stdout.trim())
          : reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`)),
      );
    }),
  );
}

/**
 * One fixture `git` whose failure is an answer rather than a fault.
 *
 * Any non-zero exit reads as "nothing": a ref that is not there is what most
 * of these reads are asking about, and Git spells its absence differently
 * depending on the question.
 */
export function readGit(
  cwd: string,
  args: readonly string[],
  options: FixtureGitOptions = {},
): Operation<string | undefined> {
  return until(
    new Promise<string | undefined>((resolve) => {
      execFile("git", [...args], { cwd, env: environment(options.home) }, (error, stdout) =>
        resolve(error === null ? stdout.trim() : undefined),
      );
    }),
  );
}
