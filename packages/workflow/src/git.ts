/**
 * The Git capability.
 *
 * Workflow infrastructure asks one question of the repository — resolve this
 * revision expression to a commit — and asks it through a contextual Api, so a
 * host or a test replaces the answer lexically rather than by arranging a
 * repository on disk. Core never reaches Git at all: ordinary `execute()` and
 * `xmd run` stay Git-independent.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import type { Operation } from "effection";
import { cwd, exec } from "@executablemd/runtime";

export interface GitApi {
  /**
   * Verify one revision expression and answer with the full object id it names.
   *
   * The semantics of `git rev-parse --verify --end-of-options <revision>` in the
   * contextual working directory.
   */
  revParse(revision: string): Operation<string>;
}

/** Git could not answer for this revision. Carries what Git reported, not a guess. */
export class GitRevisionError extends Error {
  override name = "GitRevisionError";

  constructor(revision: string, result: { exitCode: number; stderr: string }) {
    const reported = result.stderr.trim();
    super(
      `git rev-parse could not resolve "${revision}": exited ${result.exitCode}` +
        (reported === "" ? " with no output" : ` — ${reported}`),
    );
  }
}

export const Git: Api<GitApi> = createApi<GitApi>("Git", {
  *revParse(revision: string): Operation<string> {
    // `--verify` makes an unresolvable revision an error rather than an echo,
    // and `--end-of-options` stops a revision that looks like a flag from being
    // read as one. The command is an array, so nothing is ever parsed by a shell.
    const command = ["git", "rev-parse", "--verify", "--end-of-options", revision];
    const result = yield* exec({ command, cwd: yield* cwd() });
    if (result.exitCode !== 0) {
      throw new GitRevisionError(revision, result);
    }
    const objectId = result.stdout.trim();
    if (objectId === "") {
      // A clean exit that names nothing is not a commit, and trusting it would
      // pin a workflow run to no repository state at all.
      throw new GitRevisionError(revision, result);
    }
    return objectId;
  },
});

export const revParse: Operations<GitApi>["revParse"] = Git.operations.revParse;
