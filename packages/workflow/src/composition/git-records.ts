/**
 * What one transactional Git operation asks for, and what it retains.
 *
 * A Git operation is not identified by a path a document wrote. It runs in the
 * checkout the enclosing `<Repository>` and the contextual working directory
 * select, so what a component sends is the whole Repository record it observed
 * and the logical directory it observed — neither of which carries authority.
 * The provider authenticates both against what this run retained; a record that
 * is not the retained one, or a directory inside no retained checkout, is a
 * failure of authority rather than an outcome, and nothing is published for it.
 *
 * What comes back is evidence rather than a summary. The checkout the operation
 * ran in, and the branch, commit, HEAD tree and index tree the checkout held
 * before and after native Git ran: enough for a reader of the run's history to
 * say what moved, and enough for a later slice to reconcile against. Nothing
 * here holds a host path, a Git message, or the bytes of anything Git wrote.
 *
 * Every value is parsed on the way back in, exactly. A replayed result arrives
 * as whatever the journal holds, so these parsers are what decide it is a result
 * at all — and a value carrying more or fewer members than the protocol declares
 * is not a result this run wrote.
 */

import type { Json } from "@executablemd/durable-streams";
import { beneath, canonicalWorkspacePath, members, optionalText, text } from "./parse.ts";
import type { GitObjectFormat, RepositoryRecord } from "./records.ts";

/** Which retained checkout one Git operation ran in. */
export interface GitCheckoutIdentity {
  readonly repositoryName: string;
  /** The Worktree's name, or `null` when the operation ran in the primary checkout. */
  readonly worktreeName: string | null;
  /** The Workspace-relative path of that checkout. */
  readonly checkoutPath: string;
}

/** What the checkout held at one instant, as Git reported it. */
export interface GitCheckoutState {
  readonly branch: string;
  readonly commit: string;
  readonly headTree: string;
  readonly indexTree: string;
}

/**
 * What a `<Git.Switch>` invocation asks the provider to do.
 *
 * The Repository arrives whole rather than by name. A name alone can only be
 * looked up; the record can be *compared*, which is what lets the provider hold
 * a replaced context to the exact row this run retained rather than to whichever
 * Repository happens to answer to that name.
 *
 * The working directory is kept apart from the checkout throughout. A checkout
 * is what the operation belongs to; the working directory is where inside it the
 * element was written, and the two are equal only when a document wrote the
 * element at the checkout root.
 */
export interface GitSwitchRequest {
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
  readonly branch: string;
  readonly base: string | undefined;
}

/**
 * What a completed `<Git.Switch>` retained.
 *
 * The requested branch beside the branch the checkout ended on, and the
 * requested base beside the commit it actually started from — `null` when the
 * branch already existed, because a base is consulted only when one has to be
 * created. Both halves are kept: what a document asked for and what Git did are
 * different facts, and a history holding only one of them cannot say which.
 */
export interface GitSwitchResult {
  readonly checkout: GitCheckoutIdentity;
  readonly requestedBranch: string;
  readonly resolvedBranch: string;
  readonly requestedBase: string | null;
  readonly resolvedBase: string | null;
  readonly before: GitCheckoutState;
  readonly after: GitCheckoutState;
}

const IDENTITY_MEMBERS = ["repositoryName", "worktreeName", "checkoutPath"] as const;

const STATE_MEMBERS = ["branch", "commit", "headTree", "indexTree"] as const;

const SWITCH_MEMBERS = [
  "checkout",
  "requestedBranch",
  "resolvedBranch",
  "requestedBase",
  "resolvedBase",
  "before",
  "after",
] as const;

/**
 * An object id in the algorithm this repository names its objects with.
 *
 * Length and case both, because a digest is a fixed-width lowercase hex string
 * everywhere Git writes one. A value that is merely a non-empty string is not an
 * object id, and treating one as an id is how a retained result that says
 * nothing passes for one that says something.
 */
function objectId(value: unknown, format: GitObjectFormat): string | undefined {
  const candidate = text(value);
  const width = format === "sha1" ? 40 : 64;
  return candidate !== undefined && new RegExp(`^[0-9a-f]{${width}}$`).test(candidate)
    ? candidate
    : undefined;
}

export function parseGitCheckoutIdentity(value: unknown): GitCheckoutIdentity | undefined {
  const record = members(value, IDENTITY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repositoryName = text(record.repositoryName);
  const worktreeName = optionalText(record.worktreeName);
  const checkoutPath = canonicalWorkspacePath(record.checkoutPath);
  if (repositoryName === undefined || worktreeName === undefined || checkoutPath === undefined) {
    return undefined;
  }
  return Object.freeze({ repositoryName, worktreeName, checkoutPath });
}

export function parseGitCheckoutState(
  value: unknown,
  format: GitObjectFormat,
): GitCheckoutState | undefined {
  const record = members(value, STATE_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const branch = text(record.branch);
  const commit = objectId(record.commit, format);
  const headTree = objectId(record.headTree, format);
  const indexTree = objectId(record.indexTree, format);
  if (
    branch === undefined ||
    commit === undefined ||
    headTree === undefined ||
    indexTree === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ branch, commit, headTree, indexTree });
}

/**
 * What the invocation this result is being read for asked for.
 *
 * A result is read back for one request, and a result that does not describe
 * *that* request is not this invocation's result whatever else it is. Passing
 * the request in is what turns reading into checking: the identity, the branch,
 * the base and the transition are all compared rather than accepted.
 */
/**
 * What every Git operation's request says about where it ran.
 *
 * The two observations a component makes, which every result is read against:
 * the Repository record and the working directory inside it.
 */
export interface GitCheckoutExpectation {
  readonly repository: RepositoryRecord;
  readonly workingDirectory: string;
}

/**
 * Whether this identity is the checkout that request selects.
 *
 * The repository it names has to be the observed one, the working directory has
 * to be inside the checkout it names, and a Worktree and the primary checkout
 * cannot be at one path. What it cannot decide is *where* a name is placed —
 * that is the provider's own function, and the caller holds the identity to it.
 */
function selects(checkout: GitCheckoutIdentity, expected: GitCheckoutExpectation): boolean {
  if (
    checkout.repositoryName !== expected.repository.name ||
    !beneath(checkout.checkoutPath, expected.workingDirectory)
  ) {
    return false;
  }
  return checkout.worktreeName === null
    ? checkout.checkoutPath === expected.repository.checkoutPath
    : checkout.checkoutPath !== expected.repository.checkoutPath;
}

export interface GitSwitchExpectation extends GitCheckoutExpectation {
  readonly branch: string;
  readonly base: string | undefined;
}

/**
 * The switch result this value describes for this request, or `undefined`.
 *
 * Total, exact about membership, and closed about meaning. Beyond the shape it
 * refuses a result whose checkout is not the one the request selects, whose
 * branch or base is not the one the request asked for, and whose two readings do
 * not describe a switch: a created branch ends at the commit it was created
 * from and cannot be the branch the checkout was already on, and a checkout that
 * ends on the branch it began on cannot have moved — not its commit, not its
 * HEAD tree, and not its index.
 *
 * What it cannot decide is where a name is placed. A checkout path is a function
 * of identity, and whose function it is belongs to the provider, so the caller
 * holds the parsed identity to its own placement before using it.
 */
export function parseGitSwitchResult(
  value: unknown,
  expected: GitSwitchExpectation,
): GitSwitchResult | undefined {
  const record = members(value, SWITCH_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const format = expected.repository.objectFormat;
  const checkout = parseGitCheckoutIdentity(record.checkout);
  const requestedBranch = text(record.requestedBranch);
  const resolvedBranch = text(record.resolvedBranch);
  const requestedBase = optionalText(record.requestedBase);
  const resolvedBase = record.resolvedBase === null ? null : objectId(record.resolvedBase, format);
  const before = parseGitCheckoutState(record.before, format);
  const after = parseGitCheckoutState(record.after, format);
  if (
    checkout === undefined ||
    requestedBranch === undefined ||
    resolvedBranch === undefined ||
    requestedBase === undefined ||
    resolvedBase === undefined ||
    before === undefined ||
    after === undefined
  ) {
    return undefined;
  }

  if (!selects(checkout, expected)) {
    return undefined;
  }

  if (
    requestedBranch !== expected.branch ||
    requestedBase !== (expected.base ?? null) ||
    resolvedBranch !== expected.branch ||
    after.branch !== resolvedBranch
  ) {
    return undefined;
  }

  const created = resolvedBase !== null;
  if (created && (after.commit !== resolvedBase || before.branch === after.branch)) {
    return undefined;
  }
  // Switching to the branch a checkout is already on moves nothing: no reset,
  // no reference change, and nothing staged or unstaged. A retained result whose
  // commit, HEAD tree or index tree changed across it describes a transition
  // Switch does not make.
  if (
    !created &&
    before.branch === after.branch &&
    (before.commit !== after.commit ||
      before.headTree !== after.headTree ||
      before.indexTree !== after.indexTree)
  ) {
    return undefined;
  }

  return Object.freeze({
    checkout,
    requestedBranch,
    resolvedBranch,
    requestedBase,
    resolvedBase,
    before,
    after,
  });
}

export function gitCheckoutIdentityJson(identity: GitCheckoutIdentity): Json {
  return {
    repositoryName: identity.repositoryName,
    worktreeName: identity.worktreeName,
    checkoutPath: identity.checkoutPath,
  };
}

export function gitCheckoutStateJson(state: GitCheckoutState): Json {
  return {
    branch: state.branch,
    commit: state.commit,
    headTree: state.headTree,
    indexTree: state.indexTree,
  };
}

export function gitSwitchResultJson(result: GitSwitchResult): Json {
  return {
    checkout: gitCheckoutIdentityJson(result.checkout),
    requestedBranch: result.requestedBranch,
    resolvedBranch: result.resolvedBranch,
    requestedBase: result.requestedBase,
    resolvedBase: result.resolvedBase,
    before: gitCheckoutStateJson(result.before),
    after: gitCheckoutStateJson(result.after),
  };
}

/**
 * What a `<Git.Add>` invocation asks the provider to do.
 *
 * `paths` is what the document wrote, canonicalized to an array and otherwise
 * untouched: order, duplicates, spelling and Git's own pathspec magic all
 * survive, because each of them changes what Git stages. It is a pathspec, not
 * a way of choosing a checkout — every entry is read by native Git relative to
 * the working directory the element was written in.
 */
export interface GitAddRequest {
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
  readonly paths: readonly string[];
}

/**
 * What a completed `<Git.Add>` retained.
 *
 * The pathspecs exactly as they were given, and the checkout on both sides of
 * the command. Staging moves the index and nothing else, so the branch, the
 * commit and the HEAD tree are the same in both readings — retaining them is
 * what makes that checkable rather than assumed — and the index tree is the one
 * value the operation may have changed. What was staged is not enumerated:
 * naming files Git discovered would put content beyond the document's own
 * pathspecs into retained history.
 */
export interface GitAddResult {
  readonly checkout: GitCheckoutIdentity;
  readonly paths: readonly string[];
  readonly before: GitCheckoutState;
  readonly after: GitCheckoutState;
}

export interface GitAddExpectation extends GitCheckoutExpectation {
  readonly paths: readonly string[];
}

const ADD_MEMBERS = ["checkout", "paths", "before", "after"] as const;

/** The pathspec array this value is, once every entry is one. */
function pathspecs(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const entries: string[] = [];
  for (const entry of value) {
    const pathspec = text(entry);
    if (pathspec === undefined) {
      return undefined;
    }
    entries.push(pathspec);
  }
  return Object.freeze(entries);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * The add result this value describes for this request, or `undefined`.
 *
 * Exact about membership and closed about meaning, on the same terms as every
 * other retained result. Beyond the shape it refuses a result whose checkout is
 * not the one the request selects, whose pathspecs are not the ones it was
 * given — in the same order, with the same repetitions — and whose two readings
 * describe something other than staging: the branch, the commit and the HEAD
 * tree a `git add` leaves exactly where it found them.
 *
 * The index tree may differ or not. Staging a path that is already staged, or
 * one whose content matches the index, changes nothing, and a run that describes
 * that is describing what happened.
 */
export function parseGitAddResult(
  value: unknown,
  expected: GitAddExpectation,
): GitAddResult | undefined {
  const record = members(value, ADD_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const format = expected.repository.objectFormat;
  const checkout = parseGitCheckoutIdentity(record.checkout);
  const paths = pathspecs(record.paths);
  const before = parseGitCheckoutState(record.before, format);
  const after = parseGitCheckoutState(record.after, format);
  if (
    checkout === undefined ||
    paths === undefined ||
    before === undefined ||
    after === undefined
  ) {
    return undefined;
  }

  if (!selects(checkout, expected) || !samePaths(paths, expected.paths)) {
    return undefined;
  }

  if (
    before.branch !== after.branch ||
    before.commit !== after.commit ||
    before.headTree !== after.headTree
  ) {
    return undefined;
  }

  return Object.freeze({ checkout, paths, before, after });
}

export function gitAddResultJson(result: GitAddResult): Json {
  return {
    checkout: gitCheckoutIdentityJson(result.checkout),
    paths: [...result.paths],
    before: gitCheckoutStateJson(result.before),
    after: gitCheckoutStateJson(result.after),
  };
}

/** Where the text of one commit message came from. */
export type GitCommitMessageSource = "prop" | "children" | "both";

const MESSAGE_SOURCES: readonly GitCommitMessageSource[] = ["prop", "children", "both"];

export function parseGitCommitMessageSource(value: unknown): GitCommitMessageSource | undefined {
  return MESSAGE_SOURCES.find((source) => source === value);
}

/**
 * What a `<Git.Commit>` invocation asks the provider to do.
 *
 * The message arrives canonical, because canonicalization is a decision about
 * what a document meant and the component is where a document is read. What the
 * provider does with it is arithmetic: these are the bytes Git receives, and the
 * bytes the retained digest describes.
 *
 * `messageSource` travels beside it because the two are different facts. A
 * reader of the run's history can see that a message came from prose written
 * inside the element rather than from a prop, which no digest of the result
 * would say.
 */
export interface GitCommitRequest {
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
  /** The exact bytes to commit, already canonical. */
  readonly message: string;
  readonly messageSource: GitCommitMessageSource;
}

/**
 * What a completed `<Git.Commit>` retained.
 *
 * The commit is described rather than quoted. Its message is retained as a
 * digest and a byte length instead of as text, because a run's history is read
 * by people and machines that have no business holding authored prose a second
 * time — and a digest is what proves the bytes Git committed are the bytes the
 * document composed, which the text itself could not.
 *
 * `parent`, `tree` and `commit` are the object graph the transition made:
 * exactly one parent, which is the commit the checkout was on; the tree the
 * index described; and the commit those two produced. `committedAt` is the whole
 * Unix second the provider stamped both author and committer with, so a replay
 * reads a time rather than a clock.
 */
export interface GitCommitResult {
  readonly checkout: GitCheckoutIdentity;
  readonly messageSource: GitCommitMessageSource;
  /** Lowercase SHA-256 of the canonical message bytes. */
  readonly messageDigest: string;
  /** The canonical message's length in UTF-8 bytes. */
  readonly messageLength: number;
  readonly parent: string;
  readonly tree: string;
  readonly commit: string;
  /** The whole Unix second this commit was authored and committed at. */
  readonly committedAt: number;
  readonly before: GitCheckoutState;
  readonly after: GitCheckoutState;
}

/**
 * What the invocation this commit result is being read for asked for.
 *
 * The message evidence rather than the message: the caller derives it once from
 * the bytes it admitted, and the parser compares. A parser that recomputed a
 * digest from a message it was handed would be checking the result against
 * itself.
 */
export interface GitCommitExpectation extends GitCheckoutExpectation {
  readonly messageSource: GitCommitMessageSource;
  readonly messageDigest: string;
  readonly messageLength: number;
}

const COMMIT_MEMBERS = [
  "checkout",
  "messageSource",
  "messageDigest",
  "messageLength",
  "parent",
  "tree",
  "commit",
  "committedAt",
  "before",
  "after",
] as const;

/** A SHA-256 digest, which is one width and one case wherever one is written. */
function digest(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate !== undefined && /^[0-9a-f]{64}$/.test(candidate) ? candidate : undefined;
}

/** A count of something, which is a whole number and never a negative one. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The commit result this value describes for this request, or `undefined`.
 *
 * Exact about membership and closed about meaning, like every retained result
 * here. What it adds is the object graph: a commit of the index has exactly one
 * parent and that parent is where the checkout was, its tree is the tree the
 * index described, and the checkout ends on that commit with its HEAD tree and
 * its index both equal to it. A commit also has to have been a commit — the
 * parent and the new commit differ, and the index differed from HEAD before it,
 * because committing an index that already matched HEAD is the condition this
 * operation refuses rather than one it records.
 *
 * The branch is unchanged across it. Committing moves a branch's tip; it does
 * not move the checkout to another branch, so a result saying otherwise
 * describes a transition Commit does not make.
 */
export function parseGitCommitResult(
  value: unknown,
  expected: GitCommitExpectation,
): GitCommitResult | undefined {
  const record = members(value, COMMIT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const format = expected.repository.objectFormat;
  const checkout = parseGitCheckoutIdentity(record.checkout);
  const messageSource = parseGitCommitMessageSource(record.messageSource);
  const messageDigest = digest(record.messageDigest);
  const messageLength = count(record.messageLength);
  const parent = objectId(record.parent, format);
  const tree = objectId(record.tree, format);
  const commit = objectId(record.commit, format);
  const committedAt = count(record.committedAt);
  const before = parseGitCheckoutState(record.before, format);
  const after = parseGitCheckoutState(record.after, format);
  if (
    checkout === undefined ||
    messageSource === undefined ||
    messageDigest === undefined ||
    messageLength === undefined ||
    parent === undefined ||
    tree === undefined ||
    commit === undefined ||
    committedAt === undefined ||
    before === undefined ||
    after === undefined
  ) {
    return undefined;
  }

  if (!selects(checkout, expected)) {
    return undefined;
  }

  if (
    messageSource !== expected.messageSource ||
    messageDigest !== expected.messageDigest ||
    messageLength !== expected.messageLength
  ) {
    return undefined;
  }

  if (
    parent !== before.commit ||
    tree !== before.indexTree ||
    commit !== after.commit ||
    after.headTree !== tree ||
    after.indexTree !== tree ||
    before.branch !== after.branch ||
    parent === commit ||
    before.indexTree === before.headTree
  ) {
    return undefined;
  }

  return Object.freeze({
    checkout,
    messageSource,
    messageDigest,
    messageLength,
    parent,
    tree,
    commit,
    committedAt,
    before,
    after,
  });
}

export function gitCommitResultJson(result: GitCommitResult): Json {
  return {
    checkout: gitCheckoutIdentityJson(result.checkout),
    messageSource: result.messageSource,
    messageDigest: result.messageDigest,
    messageLength: result.messageLength,
    parent: result.parent,
    tree: result.tree,
    commit: result.commit,
    committedAt: result.committedAt,
    before: gitCheckoutStateJson(result.before),
    after: gitCheckoutStateJson(result.after),
  };
}
