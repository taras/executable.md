/**
 * The native Git this provider performs, and the vocabulary it answers in.
 *
 * Every function here runs one or more Git commands inside a materialization and
 * returns either a value or a `GitRefusal` carrying a word from the composition
 * vocabulary. Nothing Git printed travels with it. A refusal names the condition
 * a document can act on — a locator that could not be used, a base that resolves
 * to nothing, a branch already checked out — and a caller cannot tell from the
 * answer which Git version, transport, or message produced it.
 *
 * ## Resolution happens once
 *
 * A base is resolved and a commit pinned when the Repository is first reached,
 * and the pin is what is retained. A remote whose default branch moves
 * afterwards changes nothing about this run: replay restores the commit rather
 * than asking again. That is why every resolution here reads a ref and returns
 * an object id — a name that could still be a name later is not an answer.
 *
 * ## HEAD is never detached
 *
 * A checkout on a detached HEAD has no branch for a later Switch, Commit or Push
 * to mean anything against, so the provider always ends on a named branch. When
 * a supplied base is a tag or a bare commit rather than a branch, it creates one
 * with a deterministic provider-owned name and records that name, so the run's
 * retained identity says which branch the checkout was made on rather than
 * leaving a reader to infer it.
 */

import type { Operation } from "effection";
import type { GitObjectFormat } from "../../composition/records.ts";
import {
  GitOperationInfrastructureError,
  type GitFailureReason,
} from "../../composition/errors.ts";
import type { GitOutcome, RepositoryHost } from "./host.ts";

/** The branch a checkout gets when the base names something that is not one. */
export const PROVIDER_BRANCH = "xmd/base";

/** A condition Git reported, reduced to one word from the fixed vocabulary. */
export class GitRefusal extends Error {
  override name = "GitRefusal";
  readonly reason: string;

  constructor(reason: string) {
    super(`git refused: ${reason}`);
    this.reason = reason;
  }
}

/**
 * A Git session bound to one materialization root.
 *
 * The root is also `HOME`, so Git reads no configuration belonging to whoever
 * happens to be running the host.
 */
/** The two things one command may need beyond its arguments and its directory. */
export interface GitCommand {
  /** Bytes handed to the command on standard input. */
  readonly input?: string;
  /** The whole Unix second an object-writing command records. */
  readonly committedAt?: number;
}

export interface GitSession {
  run(args: readonly string[], cwd: string, command?: GitCommand): Operation<GitOutcome>;
  read(args: readonly string[], cwd: string): Operation<string | undefined>;
}

export function gitSession(host: RepositoryHost, root: string): GitSession {
  return {
    run(args, cwd, command = {}) {
      return host.git({ args, cwd, home: root, ...command });
    },

    *read(args, cwd): Operation<string | undefined> {
      const outcome = yield* host.git({ args, cwd, home: root });
      if (outcome.code !== 0) {
        return undefined;
      }
      const value = outcome.stdout.trim();
      return value === "" ? undefined : value;
    },
  };
}

/** The full object id this revision names, or `undefined` when it names none. */
export function resolveCommit(
  git: GitSession,
  directory: string,
  revision: string,
): Operation<string | undefined> {
  // `--end-of-options` stops a revision that looks like a flag from being read
  // as one, and `^{commit}` refuses a tag that points at anything else.
  return git.read(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
    directory,
  );
}

export function currentBranch(git: GitSession, directory: string): Operation<string | undefined> {
  return git.read(["symbolic-ref", "--quiet", "--short", "HEAD"], directory);
}

/** The object format a checkout reports, or `undefined` when it reports none. */
export function* readObjectFormat(
  git: GitSession,
  directory: string,
): Operation<GitObjectFormat | undefined> {
  const reported = yield* git.read(["rev-parse", "--show-object-format"], directory);
  return reported === "sha1" || reported === "sha256" ? reported : undefined;
}

export function* objectFormat(git: GitSession, directory: string): Operation<GitObjectFormat> {
  const reported = yield* readObjectFormat(git, directory);
  if (reported === undefined) {
    throw new GitRefusal("unusable-repository");
  }
  return reported;
}

/**
 * Copy a repository into the materialization without checking anything out.
 *
 * `--no-checkout` because the branch this checkout ends on has not been decided
 * yet, and `--no-hardlinks` because a local clone otherwise shares object files
 * with the remote: the retained tree has to be complete on its own, since the
 * remote may be gone by the time the run resumes.
 */
export function* clone(
  git: GitSession,
  locator: string,
  directory: string,
  parent: string,
): Operation<void> {
  const outcome = yield* git.run(
    ["clone", "--no-checkout", "--no-hardlinks", "--", locator, directory],
    parent,
  );
  if (outcome.code !== 0) {
    throw new GitRefusal("invalid-locator");
  }
}

/** Where a Repository's primary checkout starts: one commit, on one named branch. */
export interface RepositoryStart {
  readonly commit: string;
  readonly primaryBranch: string;
}

/**
 * Decide the commit and the branch a fresh clone's primary checkout begins on.
 *
 * With no base, the remote's default branch is what a clone already put HEAD on,
 * and its commit is the pin. With a base, a remote branch of that name wins —
 * that is the case a document means when it writes `base="main"` — and anything
 * else that resolves to a commit gets the provider-owned branch instead of a
 * detached HEAD.
 */
export function* resolveRepositoryStart(
  git: GitSession,
  directory: string,
  base: string | undefined,
): Operation<RepositoryStart> {
  if (base === undefined) {
    const branch = yield* currentBranch(git, directory);
    const commit = yield* resolveCommit(git, directory, "HEAD");
    if (branch === undefined || commit === undefined) {
      throw new GitRefusal("missing-remote-default");
    }
    return { commit, primaryBranch: branch };
  }

  const remote = yield* resolveCommit(git, directory, `refs/remotes/origin/${base}`);
  if (remote !== undefined) {
    return { commit: remote, primaryBranch: base };
  }

  const other = yield* resolveCommit(git, directory, base);
  if (other === undefined) {
    throw new GitRefusal("unresolved-base");
  }
  return { commit: other, primaryBranch: PROVIDER_BRANCH };
}

/**
 * Put the checkout on its named branch at its pinned commit.
 *
 * `-B` rather than `-b` because the branch a clone already created for the
 * remote default is the same branch this may be naming, and creating it twice
 * would fail on the ordinary case.
 */
export function* checkoutPrimary(
  git: GitSession,
  directory: string,
  start: RepositoryStart,
): Operation<void> {
  const outcome = yield* git.run(
    ["checkout", "-B", start.primaryBranch, start.commit, "--"],
    directory,
  );
  if (outcome.code !== 0) {
    throw new GitRefusal("unresolved-base");
  }
  const branch = yield* currentBranch(git, directory);
  if (branch !== start.primaryBranch) {
    throw new GitRefusal("unusable-repository");
  }
}

/** What a linked worktree became: where it starts, and what Git named its record. */
export interface AddedWorktree {
  readonly commit: string;
  /** The directory name Git gave this worktree beneath `.git/worktrees`. */
  readonly slot: string;
}

/**
 * Whether this Git failure is a branch that is checked out somewhere else.
 *
 * The message is read to *select* a word and is then discarded; `LC_ALL=C` is
 * what makes reading it stable. A refusal this cannot recognize is reported as
 * an unusable repository rather than guessed at.
 */
function checkedOutElsewhere(outcome: GitOutcome): boolean {
  return /already (checked out|used by worktree)/.test(outcome.stderr);
}

export function* addWorktree(
  git: GitSession,
  repositoryDirectory: string,
  worktreeDirectory: string,
  branch: string,
  base: string | undefined,
): Operation<AddedWorktree> {
  if (branch.startsWith("-")) {
    throw new GitRefusal("unresolved-base");
  }

  const args = yield* worktreeArguments(
    git,
    repositoryDirectory,
    worktreeDirectory,
    branch,
    base,
    yield* branchExists(git, repositoryDirectory, branch),
  );
  const outcome = yield* git.run(args, repositoryDirectory);
  if (outcome.code !== 0) {
    throw new GitRefusal(
      checkedOutElsewhere(outcome) ? "branch-checked-out-elsewhere" : "unresolved-base",
    );
  }

  const commit = yield* resolveCommit(git, worktreeDirectory, "HEAD");
  const administration = yield* git.read(["rev-parse", "--git-dir"], worktreeDirectory);
  if (commit === undefined || administration === undefined) {
    throw new GitRefusal("unusable-repository");
  }
  const slot = administration.slice(administration.lastIndexOf("/") + 1);
  if (slot === "") {
    throw new GitRefusal("unusable-repository");
  }
  return { commit, slot };
}

/**
 * Whether this branch already exists, locally or on the repository's remote.
 *
 * A fresh clone has one local branch — the one its primary checkout is on — and
 * every other branch the remote published is a remote-tracking ref. A document
 * naming one of those means that branch, so both count as existing. Git's own
 * `worktree add <path> <branch>` then creates the local branch tracking it,
 * which is the same thing a person would get by hand.
 */
export function* branchExists(
  git: GitSession,
  directory: string,
  branch: string,
): Operation<boolean> {
  const local = yield* resolveCommit(git, directory, `refs/heads/${branch}`);
  if (local !== undefined) {
    return true;
  }
  return (yield* resolveCommit(git, directory, `refs/remotes/origin/${branch}`)) !== undefined;
}

/**
 * The `worktree add` this request is.
 *
 * An existing branch is checked out rather than recreated, which is what makes
 * a second Worktree on a branch another checkout holds fail rather than move it.
 * A missing branch is created from the supplied base, or from the primary
 * checkout's current commit when there is none — never from a remote asked
 * again.
 */
function* worktreeArguments(
  git: GitSession,
  repositoryDirectory: string,
  worktreeDirectory: string,
  branch: string,
  base: string | undefined,
  branchExists: boolean,
): Operation<string[]> {
  if (branchExists) {
    return ["worktree", "add", worktreeDirectory, branch];
  }

  const start =
    base === undefined
      ? yield* resolveCommit(git, repositoryDirectory, "HEAD")
      : yield* resolveBaseCommit(git, repositoryDirectory, base);
  if (start === undefined) {
    throw new GitRefusal("unresolved-base");
  }
  return ["worktree", "add", "-b", branch, worktreeDirectory, start];
}

/**
 * The commit a supplied base names, preferring the repository's own remote.
 *
 * A document that writes `base="main"` means the branch of that name, which in a
 * clone is a remote-tracking ref rather than a local one. Anything else that
 * resolves to a commit — a tag, an object id, a local branch — is taken as
 * written.
 */
export function* resolveBaseCommit(
  git: GitSession,
  directory: string,
  base: string,
): Operation<string | undefined> {
  const remote = yield* resolveCommit(git, directory, `refs/remotes/origin/${base}`);
  return remote ?? (yield* resolveCommit(git, directory, base));
}

/** The tree `HEAD` names, or `undefined` when the checkout reports none. */
export function headTree(git: GitSession, directory: string): Operation<string | undefined> {
  return git.read(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{tree}"],
    directory,
  );
}

/**
 * The tree the index currently describes.
 *
 * `write-tree` rather than a read of a ref, because the index is the only place
 * that state lives: staged content that no commit holds yet has no other name.
 * It writes tree objects into the checkout's own object database and moves no
 * ref, so what a run retains is the identity of what was staged rather than a
 * summary of it — and the objects travel back into the Workspace with the rest
 * of the checkout.
 */
export function indexTree(git: GitSession, directory: string): Operation<string | undefined> {
  return git.read(["write-tree"], directory);
}

/**
 * Put a checkout on a branch, creating it at `start` when it has none.
 *
 * `switch` rather than `checkout`, and with no force, discard or detach: the
 * refusals are the point. A branch another checkout of the same repository holds
 * is refused rather than moved, and changes Git would overwrite are refused
 * rather than discarded — both are conditions a document can act on, and neither
 * is something this provider decides on an author's behalf.
 *
 * With no start point the branch already exists, locally or on the repository's
 * remote. Git creates the local tracking branch for the second case, which is
 * the same thing a person would get by hand and the same thing `<Worktree>`
 * already does with a branch the remote published.
 */
export interface BranchSwitch {
  /** The component this is performed for, as a document writes it. */
  readonly operation: string;
  /** Where the command runs. */
  readonly workingDirectory: string;
  /** The checkout the command answers about. */
  readonly checkout: string;
  readonly branch: string;
  /** The commit a missing branch is created at, or `undefined` when it exists. */
  readonly start: string | undefined;
}

export function* switchBranch(git: GitSession, request: BranchSwitch): Operation<void> {
  const { branch, start } = request;
  const outcome = yield* git.run(
    start === undefined ? ["switch", branch, "--"] : ["switch", "--create", branch, start, "--"],
    request.workingDirectory,
  );
  if (outcome.code !== 0) {
    const refusal = switchFailure(outcome);
    if (refusal === undefined) {
      throw new GitOperationInfrastructureError(
        request.operation,
        "native Git refused it in a way this provider has no word for",
      );
    }
    throw new GitRefusal(refusal);
  }
  if ((yield* currentBranch(git, request.checkout)) !== branch) {
    throw new GitOperationInfrastructureError(
      request.operation,
      "the checkout did not end on the branch the command reported switching to",
    );
  }
}

/**
 * Stage exactly these pathspecs, from the directory the element was written in.
 *
 * One command for the whole array. `--` separates the pathspecs from the
 * options, so an entry that reads as a flag is still a pathspec, and Git's own
 * magic keeps its ordinary meaning.
 *
 * **Native Git is not all-or-none here.** A command naming an ignored path
 * stages everything else it matched and *then* refuses, so the index it leaves
 * behind holds part of what was asked for. What makes an Add all-or-none is the
 * effect around it: this throws before anything is imported, the disposable
 * materialization Git worked in is discarded with the scope, and the effect's
 * savepoint takes back the attempt — so the Workspace never holds a partial
 * staging, and the failed result describes a root that did not move.
 *
 * Four conditions are refusals a document can act on, and the set is closed. Any
 * other nonzero exit is infrastructure: naming it the nearest refusal would
 * publish a durable result claiming this run knows what happened.
 */
export function* addPaths(
  git: GitSession,
  request: {
    readonly operation: string;
    readonly workingDirectory: string;
    readonly paths: readonly string[];
  },
): Operation<void> {
  const outcome = yield* git.run(["add", "--", ...request.paths], request.workingDirectory);
  if (outcome.code !== 0) {
    const refusal = addFailure(outcome, request.paths);
    if (refusal === undefined) {
      throw new GitOperationInfrastructureError(
        request.operation,
        "native Git refused it in a way this provider has no word for",
      );
    }
    throw new GitRefusal(refusal);
  }
}

/** The one line Git prints when a path a command named is ignored. */
const IGNORED_ADVISORY = "The following paths are ignored by one of your .gitignore files:";

/**
 * Which condition a refused `add` reported, or `undefined` for none of them.
 *
 * Git puts the pathspec it is complaining about *inside* its own diagnostic, so
 * a document's own text appears in the message this reads. Searching that
 * message for a phrase therefore lets the text answer the question: a pathspec
 * written `../did not match any files` produces an outside-repository
 * diagnostic that contains the unmatched phrase, and one written
 * `:(did not match any files)x` produces an invalid-magic diagnostic that
 * contains it too.
 *
 * So nothing here searches. Each condition has a fixed frame Git builds around
 * the pathspec, and the pathspecs are what this provider just sent — so the
 * frame is reconstructed for each of them and compared. A document can put any
 * text it likes inside the frame; it cannot make one condition's diagnostic take
 * another condition's shape around its own text.
 *
 * A diagnostic is not a line. A pathspec is any non-empty string, newlines
 * included, and Git embeds it verbatim — so `paths={"missing\nfile"}` produces a
 * two-line diagnostic that is still one message. The whole of what Git wrote is
 * compared, less the newline it ends with, which is what keeps a pathspec's own
 * spelling from deciding where the message stops.
 *
 * The exit status is part of the match, and a diagnostic that fits no frame is
 * not given a word: it is infrastructure.
 */
function addFailure(outcome: GitOutcome, paths: readonly string[]): GitFailureReason | undefined {
  // Exactly the newline Git ends its message with, and nothing else: trimming
  // further would take characters a pathspec is allowed to end with.
  const reported = outcome.stderr.endsWith("\n") ? outcome.stderr.slice(0, -1) : outcome.stderr;

  if (outcome.code === 1) {
    // The advisory leads, and the paths Git found follow it. That first line is
    // the whole of what is matched here, because nothing else in the message is
    // Git's own words.
    return reported.startsWith(`${IGNORED_ADVISORY}\n`) ? "ignored-pathspec" : undefined;
  }
  if (outcome.code !== 128) {
    return undefined;
  }

  for (const path of paths) {
    if (reported === `fatal: pathspec '${path}' did not match any files`) {
      return "unmatched-pathspec";
    }
    // The repository root Git names is its own; what is pinned here is the
    // pathspec, which it prints twice before saying where the repository is.
    if (
      reported.startsWith(`fatal: ${path}: '${path}' is outside repository at '`) &&
      reported.endsWith("'")
    ) {
      return "outside-checkout-pathspec";
    }
    // The magic word is Git's; the pathspec closes the line.
    if (
      reported.startsWith("fatal: Invalid pathspec magic '") &&
      reported.endsWith(` in '${path}'`)
    ) {
      return "invalid-pathspec-magic";
    }
  }
  return undefined;
}

/**
 * Which condition a refused `switch` reported, or `undefined` for none of them.
 *
 * The message selects a word and is then discarded, on the same terms as every
 * other reading here; `LC_ALL=C` is what makes it stable. A condition this
 * cannot recognize is *not* given a word. The set of refusals is closed because
 * each of them is something a document can act on, and calling an unrecognized
 * exit the nearest one would publish a durable result claiming this run knows
 * what happened.
 */
function switchFailure(outcome: GitOutcome): GitFailureReason | undefined {
  if (checkedOutElsewhere(outcome)) {
    return "branch-checked-out-elsewhere";
  }
  if (/would be overwritten by/.test(outcome.stderr)) {
    return "overwrites-local-changes";
  }
  return undefined;
}

/**
 * Whether a materialized checkout is one Git can still read.
 *
 * Necessary and nowhere near sufficient. It says the administration describes a
 * repository; it says nothing about *which* repository, which is why the checks
 * below exist beside it. Deliberately not a question about where HEAD is: a
 * later Git effect may have moved it transactionally, and creation identity is
 * not a shadow of the current branch.
 */
export function* checkoutReadable(
  git: GitSession,
  directory: string,
): Operation<string | undefined> {
  return yield* resolveCommit(git, directory, "HEAD");
}

/**
 * The locator a checkout says it came from.
 *
 * `remote.origin.url` is what a clone writes and what this provider's clone
 * wrote. Reading it back is how the bytes in the Workspace are tied to the
 * identity the record claims for them: a checkout of another repository sitting
 * at the retained path answers with another locator, and no amount of HEAD
 * being readable would have said so.
 */
export function* originLocator(git: GitSession, directory: string): Operation<string | undefined> {
  return yield* git.read(["config", "--get", "remote.origin.url"], directory);
}

/** Whether this object id names a commit that is present in this checkout. */
export function* commitPresent(
  git: GitSession,
  directory: string,
  commit: string,
): Operation<boolean> {
  return (yield* resolveCommit(git, directory, commit)) !== undefined;
}

/**
 * The shared `.git` directory a checkout belongs to.
 *
 * For a primary checkout this is its own `.git`; for a linked worktree it is the
 * repository the worktree is a worktree *of*. Comparing it with the place the
 * enclosing Repository was materialized is what proves a retained worktree
 * belongs to the retained Repository it claims, rather than to some other
 * repository whose administration happens to resolve.
 */
export function* commonDirectory(
  git: GitSession,
  directory: string,
): Operation<string | undefined> {
  // Without `--path-format=absolute`, which not every supported Git has: a
  // linked worktree already answers absolutely, and a primary checkout answers
  // `.git` relative to itself. Resolving the relative case here keeps the
  // comparison one string equality on every version.
  const reported = yield* git.read(["rev-parse", "--git-common-dir"], directory);
  if (reported === undefined) {
    return undefined;
  }
  return reported.startsWith("/") ? reported : `${directory}/${reported}`;
}

/**
 * What one commit of the index needs, beyond the session it runs in.
 *
 * The message travels as bytes on standard input rather than as an argument:
 * an argument list is not a boundary authored prose of any length crosses
 * unchanged, and `--cleanup=verbatim` is what says those bytes are the message.
 * Nothing is staged, nothing is amended, nothing is signed and no path is named
 * — the index is the whole of what this commits.
 *
 * `committedAt` is the provider's own second, bound to both author and
 * committer time, so what a commit records is an instant this run captured
 * rather than whatever the clock said by the time Git got around to reading it.
 *
 * `--no-gpg-sign` says at the command what the host's fixed configuration
 * already says: the object is what the admitted message, the index, the parent
 * and this run's own identity make it, and a signature would be a program run
 * and a header written that nothing here decided.
 */
export interface IndexCommit {
  /** The component this is performed for, as a document writes it. */
  readonly operation: string;
  /** Where the command runs. */
  readonly workingDirectory: string;
  /** The canonical message bytes, exactly as they are to be committed. */
  readonly message: string;
  readonly committedAt: number;
}

/**
 * Commit exactly what the index holds.
 *
 * There is no refusal to select here. The one condition a document can act on —
 * an index that already matches HEAD — is decided from the checkout's own state
 * before this runs, so a command that got this far and still failed reported
 * something this provider has no word for.
 */
export function* commitIndex(git: GitSession, request: IndexCommit): Operation<void> {
  const outcome = yield* git.run(
    ["commit", "--cleanup=verbatim", "--no-gpg-sign", "--file", "-"],
    request.workingDirectory,
    { input: request.message, committedAt: request.committedAt },
  );
  if (outcome.code !== 0) {
    throw new GitOperationInfrastructureError(
      request.operation,
      "native Git refused it in a way this provider has no word for",
    );
  }
}

/** What a commit object holds, read back out of the repository that wrote it. */
export interface CommitFacts {
  readonly parents: readonly string[];
  readonly tree: string;
  readonly authoredAt: number;
  readonly committedAt: number;
}

/**
 * Read one commit's own facts back.
 *
 * The parent list comes last in the format because a commit may have none, and
 * an empty line at the end is one this reading drops rather than one that shifts
 * every other value up by a line.
 */
export function* readCommit(
  git: GitSession,
  directory: string,
  commit: string,
): Operation<CommitFacts | undefined> {
  const reported = yield* git.read(
    ["log", "-1", "--pretty=format:%T%n%at%n%ct%n%P", commit, "--"],
    directory,
  );
  if (reported === undefined) {
    return undefined;
  }
  const [tree, authored, committed, parents] = reported.split("\n");
  const authoredAt = wholeSeconds(authored);
  const committedAt = wholeSeconds(committed);
  if (tree === undefined || tree === "" || authoredAt === undefined || committedAt === undefined) {
    return undefined;
  }
  return {
    parents: (parents ?? "").split(" ").filter((parent) => parent !== ""),
    tree,
    authoredAt,
    committedAt,
  };
}

function wholeSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/**
 * The exact bytes of one commit's message.
 *
 * `--pretty=format:` rather than `--format:`, which is `tformat:` and terminates
 * every record with a newline of its own — so what came back would be the
 * message plus a byte nobody committed, and a byte-for-byte comparison would
 * fail on every well-formed commit.
 */
export function* readCommitMessage(
  git: GitSession,
  directory: string,
  commit: string,
): Operation<string | undefined> {
  const outcome = yield* git.run(["log", "-1", "--pretty=format:%B", commit, "--"], directory);
  return outcome.code === 0 ? outcome.stdout : undefined;
}
