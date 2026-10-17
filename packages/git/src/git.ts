/**
 * The read-only Git query capability.
 *
 * Workflow infrastructure asks a small, fixed set of questions of the
 * repository, and asks them through a contextual Api, so a host or a test
 * replaces the answers lexically rather than by arranging a repository on disk.
 * Core never reaches Git at all: ordinary `execute()` and `xmd run` stay
 * Git-independent.
 *
 * The four legacy questions are about *one* repository — the one containing the
 * contextual working directory — and none of them mutates it. Together they are
 * what an immutable workflow definition is made of: which repository, which
 * commit, in which object format, and what the root document held in it.
 *
 * The four selected-checkout reads beside them answer the same kind of
 * question about a checkout a `<Repository>` selected, which is what
 * `<Git.Files>`, `<Git.Changes>`, `<Git.Diff>` and `<Git.File>` ask. They carry
 * the Repository selection and the working directory the component observed, so
 * which checkout answers is the installed provider's decision rather than the
 * process's own directory.
 *
 * Asking is all this Api does. The authored transitions a document writes —
 * `<Git.Switch>`, `<Git.Add>`, `<Git.Commit>`, `<Git.Push>` — are the separate
 * `Git` Api, and a replacement installed here never becomes a route to one.
 */

import { type Api, createApi, type Operations } from "@effectionx/context-api";
import { scoped } from "effection";
import type { Operation } from "effection";
import { cwd, exec, useQuietProcessOutput } from "@executablemd/runtime";
import { GitObservationProviderError } from "./composition/errors.ts";
import type {
  GitChangesInvocation,
  GitChangesResult,
  GitDiffInvocation,
  GitDiffResult,
  GitFileInvocation,
  GitFileResult,
  GitFilesInvocation,
  GitFilesResult,
} from "./composition/observation-api.ts";

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

export interface GitQueryApi {
  /**
   * Verify one revision expression and answer with the full object id it names.
   *
   * The semantics of `git rev-parse --verify --end-of-options <revision>` in the
   * contextual working directory.
   */
  resolve(revision: string): Operation<string>;

  /**
   * The absolute path of the working tree containing the contextual working
   * directory.
   *
   * The semantics of `git rev-parse --show-toplevel`. A directory that is not
   * inside a working tree is an error rather than an empty answer.
   */
  root(): Operation<string>;

  /**
   * The repository's object format.
   *
   * The semantics of `git rev-parse --show-object-format`. It is part of a
   * definition's identity: two hosts that agree about a commit only agree about
   * the run if they agree about which algorithm named it.
   */
  format(): Operation<GitObjectFormat>;

  /**
   * The bytes one path held in one commit, as text.
   *
   * The semantics of `git cat-file blob <commit>:<path>`. What comes back is
   * the pinned object rather than whatever the working tree holds now, which is
   * what lets a run use a commit as its identity and mean it.
   */
  read(commit: string, path: string): Operation<string>;

  /**
   * The tracked paths one selected checkout's index holds.
   *
   * Four questions about a checkout a Repository selected, rather than about
   * whichever one the contextual working directory happens to be in. They are
   * here because they are read-only Git questions and nothing else: answering
   * one moves no branch, writes no object and changes no file.
   *
   * The invocation carries what the component observed — the Repository
   * selection and the working directory — and the normalized request. Which
   * checkout those select is the installed provider's to decide, and the
   * default below decides nothing: a host with no native checkout to read
   * refuses rather than falling back to the caller's own filesystem.
   */
  files(invocation: GitFilesInvocation): Operation<GitFilesResult>;

  /** What one comparison of the selected checkout changed, path by path. */
  changes(invocation: GitChangesInvocation): Operation<GitChangesResult>;

  /** A window of the unified patch one comparison of the selected checkout produces. */
  diff(invocation: GitDiffInvocation): Operation<GitDiffResult>;

  /** A window of the text one commit of the selected checkout holds at one path. */
  file(invocation: GitFileInvocation): Operation<GitFileResult>;
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

export const GitQuery: Api<GitQueryApi> = createApi<GitQueryApi>("executablemd.git.query", {
  *resolve(revision: string): Operation<string> {
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

  *root(): Operation<string> {
    const result = yield* asked(["git", "rev-parse", "--show-toplevel"], yield* cwd());
    const root = result.stdout.trim();
    if (result.exitCode !== 0 || root === "") {
      throw new GitRepositoryError("which working tree this directory is in", result);
    }
    return root;
  },

  *format(): Operation<GitObjectFormat> {
    const result = yield* asked(["git", "rev-parse", "--show-object-format"], yield* cwd());
    const format = objectFormat(result.stdout.trim());
    if (result.exitCode !== 0 || format === undefined) {
      throw new GitRepositoryError("which object format it uses", result);
    }
    return format;
  },

  *read(commit: string, path: string): Operation<string> {
    // `cat-file blob` rather than `show`: it refuses a tree or a commit instead
    // of rendering one, so a root document path that names a directory fails
    // here rather than executing as whatever `show` chose to print.
    const result = yield* asked(["git", "cat-file", "blob", `${commit}:${path}`], yield* cwd());
    if (result.exitCode !== 0) {
      throw new GitObjectError(commit, path, result);
    }
    return result.stdout;
  },

  // deno-lint-ignore require-yield
  *files(_invocation: GitFilesInvocation): Operation<GitFilesResult> {
    throw new GitObservationProviderError("<Git.Files>");
  },
  // deno-lint-ignore require-yield
  *changes(_invocation: GitChangesInvocation): Operation<GitChangesResult> {
    throw new GitObservationProviderError("<Git.Changes>");
  },
  // deno-lint-ignore require-yield
  *diff(_invocation: GitDiffInvocation): Operation<GitDiffResult> {
    throw new GitObservationProviderError("<Git.Diff>");
  },
  // deno-lint-ignore require-yield
  *file(_invocation: GitFileInvocation): Operation<GitFileResult> {
    throw new GitObservationProviderError("<Git.File>");
  },
});

export const resolveGitRevision: Operations<GitQueryApi>["resolve"] = GitQuery.operations.resolve;
export const gitRoot: Operations<GitQueryApi>["root"] = GitQuery.operations.root;
export const gitObjectFormat: Operations<GitQueryApi>["format"] = GitQuery.operations.format;
export const readGitObject: Operations<GitQueryApi>["read"] = GitQuery.operations.read;

/**
 * The four selected-checkout reads, pre-bound for a caller who wants the
 * operation rather than the seam.
 *
 * Beside the four legacy accessors above and on the same terms: calling one
 * reaches whatever is installed, and a host that installs nothing refuses.
 */
export const readGitFiles: Operations<GitQueryApi>["files"] = GitQuery.operations.files;
export const readGitChanges: Operations<GitQueryApi>["changes"] = GitQuery.operations.changes;
export const readGitDiff: Operations<GitQueryApi>["diff"] = GitQuery.operations.diff;
export const readGitFile: Operations<GitQueryApi>["file"] = GitQuery.operations.file;
