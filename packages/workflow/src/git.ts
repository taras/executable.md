/**
 * The Git capability.
 *
 * Workflow infrastructure asks a small, fixed set of questions of the
 * repository, and asks them through a contextual Api, so a host or a test
 * replaces the answers lexically rather than by arranging a repository on disk.
 * Core never reaches Git at all: ordinary `execute()` and `xmd run` stay
 * Git-independent.
 *
 * All four questions are about *one* repository — the one containing the
 * contextual working directory — and none of them mutates it. Together they are
 * what an immutable workflow definition is made of: which repository, which
 * commit, in which object format, and what the root document held in it.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import { scoped } from "effection";
import type { Operation } from "effection";
import { cwd, exec, useQuietProcessOutput } from "@executablemd/runtime";

/**
 * What Git said, without Git having said it to the terminal.
 *
 * Every answer here is a payload this module reads and returns, so echoing it
 * would put a commit id and a document's own bytes into whatever the caller was
 * rendering. `stderr` is left alone: it is where a failing Git explains itself,
 * and that is a diagnostic rather than a payload.
 */
function asked(command: string[], directory: string): Operation<ExecResult> {
  return scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({ command, cwd: directory });
  });
}

interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The hash algorithm a repository names its objects with. */
export type GitObjectFormat = "sha1" | "sha256";

export interface GitApi {
  /**
   * Verify one revision expression and answer with the full object id it names.
   *
   * The semantics of `git rev-parse --verify --end-of-options <revision>` in the
   * contextual working directory.
   */
  revParse(revision: string): Operation<string>;

  /**
   * The absolute path of the working tree containing the contextual working
   * directory.
   *
   * The semantics of `git rev-parse --show-toplevel`. A directory that is not
   * inside a working tree is an error rather than an empty answer.
   */
  repositoryRoot(): Operation<string>;

  /**
   * The repository's object format.
   *
   * The semantics of `git rev-parse --show-object-format`. It is part of a
   * definition's identity: two hosts that agree about a commit only agree about
   * the run if they agree about which algorithm named it.
   */
  objectFormat(): Operation<GitObjectFormat>;

  /**
   * The bytes one path held in one commit, as text.
   *
   * The semantics of `git cat-file blob <commit>:<path>`. What comes back is the
   * pinned object rather than whatever the working tree holds now, which is what
   * lets a run claim a commit as its identity and mean it.
   */
  readObject(commit: string, path: string): Operation<string>;
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

/** Git could not answer a question about the repository itself. */
export class GitRepositoryError extends Error {
  override name = "GitRepositoryError";

  constructor(question: string, result: { exitCode: number; stderr: string }) {
    const reported = result.stderr.trim();
    super(
      `git could not answer ${question}: exited ${result.exitCode}` +
        (reported === "" ? " with no output" : ` — ${reported}`),
    );
  }
}

/** The object a definition names is not in the repository, or is not a file. */
export class GitObjectError extends Error {
  override name = "GitObjectError";

  constructor(commit: string, path: string, result: { exitCode: number; stderr: string }) {
    const reported = result.stderr.trim();
    super(
      `git could not read "${path}" from commit ${commit}: exited ${result.exitCode}` +
        (reported === "" ? " with no output" : ` — ${reported}`),
    );
  }
}

function objectFormat(value: string): GitObjectFormat | undefined {
  return value === "sha1" || value === "sha256" ? value : undefined;
}

export const Git: Api<GitApi> = createApi<GitApi>("Git", {
  *revParse(revision: string): Operation<string> {
    // `--verify` makes an unresolvable revision an error rather than an echo,
    // and `--end-of-options` stops a revision that looks like a flag from being
    // read as one. The command is an array, so nothing is ever parsed by a shell.
    const command = ["git", "rev-parse", "--verify", "--end-of-options", revision];
    const result = yield* asked(command, yield* cwd());
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

  *repositoryRoot(): Operation<string> {
    const result = yield* asked(["git", "rev-parse", "--show-toplevel"], yield* cwd());
    const root = result.stdout.trim();
    if (result.exitCode !== 0 || root === "") {
      throw new GitRepositoryError("which working tree this directory is in", result);
    }
    return root;
  },

  *objectFormat(): Operation<GitObjectFormat> {
    const result = yield* asked(["git", "rev-parse", "--show-object-format"], yield* cwd());
    const format = objectFormat(result.stdout.trim());
    if (result.exitCode !== 0 || format === undefined) {
      throw new GitRepositoryError("which object format it uses", result);
    }
    return format;
  },

  *readObject(commit: string, path: string): Operation<string> {
    // `cat-file blob` rather than `show`: it refuses a tree or a commit instead
    // of rendering one, so a root document path that names a directory fails
    // here rather than executing as whatever `show` chose to print.
    const result = yield* asked(["git", "cat-file", "blob", `${commit}:${path}`], yield* cwd());
    if (result.exitCode !== 0) {
      throw new GitObjectError(commit, path, result);
    }
    return result.stdout;
  },
});

export const revParse: Operations<GitApi>["revParse"] = Git.operations.revParse;
export const repositoryRoot: Operations<GitApi>["repositoryRoot"] = Git.operations.repositoryRoot;
export const gitObjectFormat: Operations<GitApi>["objectFormat"] = Git.operations.objectFormat;
export const readGitObject: Operations<GitApi>["readObject"] = Git.operations.readObject;
