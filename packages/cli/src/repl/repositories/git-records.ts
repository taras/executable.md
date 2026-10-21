/**
 * What one REPL entry's local Add, Switch and Commit look like on the wire.
 *
 * An entry that stages a path, switches a branch or commits the index records
 * what the operation produced. Reopen the entry and the saved result answers
 * again: the same object id, the same before and after readings, and no `git`.
 * That is what lets an entry interrupted at a question be continued rather than
 * repeated — and it is why a saved commit id describes the commit that was made
 * then, not wherever HEAD is now.
 *
 * Three operations are recorded and nothing else. Push, pull requests and
 * Issues have their own protocols; a Glob, a path check and a `<Repository>`
 * selection are recorded elsewhere or nowhere.
 *
 * ## Identity is the request, and position is the journal's
 *
 * A record's name is the digest of the record version, the operation and the
 * whole normalized request: the repository identity, the checkout the
 * authenticated selection named, its common Git directory, the working
 * directory as received, and what the operation itself asks for. Two equal
 * requests produce one name, and that is allowed — telling two of them apart is
 * the durable engine's own positional matching, and nothing here searches
 * history by name.
 *
 * The working directory is named as it arrived. Resolving it through the
 * filesystem is a fact about the host at that moment, and the question the
 * document asked is not.
 *
 * Neither the commit message nor the commit identity is a request field. The
 * message is described by a digest and a byte length, because a journal already
 * holds the authored source and a second copy of the text would publish it
 * again. The author and committer are live inputs to a commit rather than
 * coordinates a replay matches on: who is at the keyboard is not part of which
 * operation this is.
 *
 * ## What a result may carry
 *
 * The ordinary result the performer returned, with its absolute host checkout
 * identity and its fixed scalar fields — the branch, commit, HEAD tree and index
 * tree on both sides, plus what the operation itself produced. These are small
 * operation results: no file list, no checkout snapshot, no Git output, no
 * credential and no handle.
 *
 * A refusal carries a vocabulary and a word from a closed set, so a continuation
 * raises the same ordinary failure the live call raised. Nothing a host printed
 * reaches a record: an unrecognized condition is infrastructure, and publishing
 * it as something the document asked for is exactly what must not happen.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, optionalText, text } from "@executablemd/git";
import {
  gitAddResultJson,
  gitCommitResultJson,
  gitSwitchResultJson,
  parseGitCheckoutState,
  parseGitCommitMessageSource,
  parseGitObjectId,
  type GitAddResult,
  type GitCheckoutIdentity,
  type GitCommitMessageSource,
  type GitCommitResult,
  type GitSwitchResult,
} from "@executablemd/git";
import { parseRepositoryIdentity, repositoryIdentityJson } from "@executablemd/git/api";
import { type RepositoryIdentity } from "@executablemd/git";
import { digest, RECORD_PREFIX, REPL_REPOSITORY_VERSION } from "./records.ts";

/** The durable type one completed local Git operation is journaled under. */
export const REPL_REPOSITORY_GIT = "repl_repository_git";

/** Which local Git operation a record describes. */
export type ReplGitOperation = "add" | "switch" | "commit";

const GIT_OPERATIONS: readonly ReplGitOperation[] = ["add", "switch", "commit"];

/** Where every local Git operation runs, as the entry authenticated it. */
export interface ReplGitPlace {
  /** All six members of the authenticated Repository identity. */
  readonly repository: RepositoryIdentity;
  /** The checkout root the authenticated selection named. */
  readonly selectionCheckout: string;
  /** That selection's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The working directory exactly as it was received, uncanonicalized. */
  readonly workingDirectory: string;
}

/** What one `<Git.Add>` asks for: the pathspecs, as the document wrote them. */
export interface ReplGitAddRequest extends ReplGitPlace {
  readonly operation: "add";
  /** Nonempty, preserving order, duplicates and every spelling. */
  readonly paths: readonly string[];
}

/** What one `<Git.Switch>` asks for. */
export interface ReplGitSwitchRequest extends ReplGitPlace {
  readonly operation: "switch";
  readonly branch: string;
  /**
   * The base exactly as it was supplied, or `null` when none was.
   *
   * Any string, the empty one included. `<Git.Switch base="">` is the absence
   * of a base as far as the component is concerned, so a document cannot write
   * one — but the public Api can be called with it, the ordinary performer
   * consults a base only when a branch has to be created, and an operation this
   * host acknowledged has to be one it can read back. Refusing the empty string
   * here would leave a successful switch journaled and unreadable.
   */
  readonly base: string | null;
}

/**
 * What one `<Git.Commit>` asks for, message included by description.
 *
 * The digest and the byte length are the admitted canonical message's, which is
 * what Git receives and what the result's own evidence describes. The text
 * itself stays in the live callback's closure.
 */
export interface ReplGitCommitRequest extends ReplGitPlace {
  readonly operation: "commit";
  readonly messageSource: GitCommitMessageSource;
  /** Lowercase SHA-256 of the canonical message bytes. */
  readonly messageDigest: string;
  /** The canonical message's length in UTF-8 bytes. */
  readonly messageLength: number;
}

export type ReplGitRequest = ReplGitAddRequest | ReplGitSwitchRequest | ReplGitCommitRequest;

/** What one completed local Git operation produced. */
export type ReplGitValue = GitAddResult | GitSwitchResult | GitCommitResult;

/**
 * Which route refused a local Git operation.
 *
 * Three, because the three conditions arrive by three routes and each rebuilds
 * its own failure. A native `GitRefusal` says what `git` itself reported; a
 * composition refusal is the provider's own closed classification; and an
 * absent ordinary identity is the host saying it cannot name a committer.
 *
 * Keeping them apart is what stops a native Add's ignored-path refusal from
 * being rebuilt with the Workflow formatter's sentence, which says the staging
 * was discarded. Nothing rolls back here, so nothing may say that.
 */
export type ReplGitVocabulary = "native-git" | "composition-git" | "ordinary-identity";

/** A word one local Git operation may be refused under. */
export type ReplGitRefusalReason =
  | "invalid-branch"
  | "unresolved-base"
  | "branch-checked-out-elsewhere"
  | "overwrites-local-changes"
  | "unmatched-pathspec"
  | "ignored-pathspec"
  | "outside-checkout-pathspec"
  | "invalid-pathspec-magic"
  | "empty-index"
  | "unresolved-identity";

/** The closed classification one refused local Git operation carries. */
export interface ReplGitRefusalData {
  readonly vocabulary: ReplGitVocabulary;
  readonly reason: ReplGitRefusalReason;
}

/**
 * Which operation each word belongs to, and which route reports it.
 *
 * One table rather than three, because a refusal is exactly one condition: the
 * operation it can happen to and the route that reports it are both functions
 * of the word. A record pairing a word with another operation or another
 * vocabulary describes a refusal this host does not produce, so it is not one it
 * may read back as an answer.
 */
const REFUSALS: ReadonlyMap<
  ReplGitRefusalReason,
  { readonly operation: ReplGitOperation; readonly vocabulary: ReplGitVocabulary }
> = new Map([
  ["invalid-branch", { operation: "switch", vocabulary: "composition-git" }],
  ["unresolved-base", { operation: "switch", vocabulary: "composition-git" }],
  ["branch-checked-out-elsewhere", { operation: "switch", vocabulary: "native-git" }],
  ["overwrites-local-changes", { operation: "switch", vocabulary: "native-git" }],
  ["unmatched-pathspec", { operation: "add", vocabulary: "native-git" }],
  ["ignored-pathspec", { operation: "add", vocabulary: "native-git" }],
  ["outside-checkout-pathspec", { operation: "add", vocabulary: "native-git" }],
  ["invalid-pathspec-magic", { operation: "add", vocabulary: "native-git" }],
  ["empty-index", { operation: "commit", vocabulary: "composition-git" }],
  ["unresolved-identity", { operation: "commit", vocabulary: "ordinary-identity" }],
] as const);

/**
 * A refused local Git operation, as the record carries it.
 *
 * The failure side of the internal `Result`, and never what a document sees: the
 * adapter rebuilds the ordinary error its own vocabulary names, by the same
 * route on a live refusal and on a replayed one, so the two cannot diverge.
 */
export class ReplGitRefusal extends Error {
  override name = "ReplGitRefusal";

  readonly refusal: ReplGitRefusalData;

  constructor(refusal: ReplGitRefusalData) {
    super(`${refusal.vocabulary} refused: ${refusal.reason}`);
    this.refusal = refusal;
  }
}

/** One completed local Git operation, as a continuation reads it back. */
export interface ReplGitRecord {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  readonly operation: ReplGitOperation;
  /** The digest of the version, the operation and the normalized request. */
  readonly fingerprint: string;
  readonly request: ReplGitRequest;
  /** The result it produced, or the refusal it answered with. */
  readonly outcome: Result<ReplGitValue>;
}

/** The stable name one local Git operation's record is journaled under. */
export function replGitRecordName(record: {
  readonly operation: ReplGitOperation;
  readonly fingerprint: string;
}): string {
  return canonicalJson([
    RECORD_PREFIX,
    "git",
    REPL_REPOSITORY_VERSION,
    record.operation,
    record.fingerprint,
  ]);
}

/** The digest of everything one local Git operation asks for. */
export function replGitFingerprint(request: ReplGitRequest): Operation<string> {
  return digest({
    version: REPL_REPOSITORY_VERSION,
    operation: request.operation,
    request: requestJson(request),
  });
}

/** The payload one completed local Git operation is journaled with. */
export function replGitRecordJson(input: {
  readonly fingerprint: string;
  readonly request: ReplGitRequest;
  readonly outcome: Result<ReplGitValue>;
}): Json {
  return {
    version: REPL_REPOSITORY_VERSION,
    operation: input.request.operation,
    fingerprint: input.fingerprint,
    request: requestJson(input.request),
    outcome: outcomeJson(input.request.operation, input.outcome),
  };
}

/**
 * The local Git operation this saved value describes, or `undefined`.
 *
 * Total, and exact about every member. A payload carrying anything this version
 * did not write describes something other than an operation this host
 * performed, and answering a document from it would bind an object id nobody
 * produced.
 */
export function parseReplGitRecord(value: unknown): ReplGitRecord | undefined {
  const read = members(value, ["version", "operation", "fingerprint", "request", "outcome"]);
  if (read === undefined || read["version"] !== REPL_REPOSITORY_VERSION) {
    return undefined;
  }
  const operation = parseReplGitOperation(read["operation"]);
  const fingerprint = text(read["fingerprint"]);
  if (operation === undefined || fingerprint === undefined) {
    return undefined;
  }
  const request = parseRequest(read["request"], operation);
  if (request === undefined) {
    return undefined;
  }
  const outcome = parseOutcome(read["outcome"], request);
  if (outcome === undefined) {
    return undefined;
  }
  return Object.freeze({
    version: REPL_REPOSITORY_VERSION,
    operation,
    fingerprint,
    request,
    outcome,
  });
}

/** The operation this value names, or `undefined`. */
export function parseReplGitOperation(value: unknown): ReplGitOperation | undefined {
  return GIT_OPERATIONS.find((operation) => operation === value);
}

/**
 * The refusal data this error carries, or `undefined` when it carries none.
 *
 * What decides whether a failed operation may be written down at all: a
 * classified refusal is an answer the document asked for, and anything else is a
 * condition this host has no word for.
 */
export function replGitRefusalOf(error: unknown): ReplGitRefusalData | undefined {
  return error instanceof ReplGitRefusal ? error.refusal : undefined;
}

/**
 * The refusal this word and vocabulary name for this operation, or `undefined`.
 *
 * The one place a word becomes a classification, so a live refusal and a
 * replayed one are classified by the same table. A word belonging to another
 * operation, or reported through a route that never reports it, is not a refusal
 * this format carries.
 */
export function replGitRefusal(
  operation: ReplGitOperation,
  vocabulary: string,
  reason: string,
): ReplGitRefusalData | undefined {
  for (const [word, source] of REFUSALS) {
    if (word !== reason || source.operation !== operation || source.vocabulary !== vocabulary) {
      continue;
    }
    return Object.freeze({ vocabulary: source.vocabulary, reason: word });
  }
  return undefined;
}

function requestJson(request: ReplGitRequest): Json {
  const place = {
    repository: repositoryIdentityJson(request.repository),
    selectionCheckout: request.selectionCheckout,
    commonDirectory: request.commonDirectory,
    workingDirectory: request.workingDirectory,
  };
  if (request.operation === "add") {
    return { ...place, paths: [...request.paths] };
  }
  if (request.operation === "switch") {
    return { ...place, branch: request.branch, base: request.base };
  }
  return {
    ...place,
    messageSource: request.messageSource,
    messageDigest: request.messageDigest,
    messageLength: request.messageLength,
  };
}

function outcomeJson(operation: ReplGitOperation, outcome: Result<ReplGitValue>): Json {
  if (!outcome.ok) {
    const data = refusalData(outcome.error);
    return { ok: false, error: { vocabulary: data.vocabulary, reason: data.reason } };
  }
  return { ok: true, value: valueJson(operation, outcome.value) };
}

/**
 * One result as the shared writer for its own operation writes it.
 *
 * Dispatched on the operation the request names rather than on which members
 * the value happens to carry: what this record describes is decided by the
 * request, and a value that is not that operation's result is caught by the
 * writer refusing to read it.
 */
function valueJson(operation: ReplGitOperation, value: ReplGitValue): Json {
  if (operation === "add" && "paths" in value) {
    return gitAddResultJson(value);
  }
  if (operation === "switch" && "requestedBranch" in value) {
    return gitSwitchResultJson(value);
  }
  if (operation === "commit" && "commit" in value) {
    return gitCommitResultJson(value);
  }
  throw new TypeError(`a retained ${operation} carries no ${operation} result`);
}

function refusalData(error: Error): ReplGitRefusalData {
  const data = replGitRefusalOf(error);
  if (data === undefined) {
    throw new TypeError("a retained local Git refusal carries no closed classification");
  }
  return data;
}

const PLACE_MEMBERS = [
  "repository",
  "selectionCheckout",
  "commonDirectory",
  "workingDirectory",
] as const;

function parseRequest(value: unknown, operation: ReplGitOperation): ReplGitRequest | undefined {
  const read = members(value, [...PLACE_MEMBERS, ...OWN_MEMBERS[operation]]);
  if (read === undefined) {
    return undefined;
  }
  const repository = parseRepositoryIdentity(read["repository"]);
  const selectionCheckout = text(read["selectionCheckout"]);
  const commonDirectory = text(read["commonDirectory"]);
  const workingDirectory = text(read["workingDirectory"]);
  if (
    repository === undefined ||
    selectionCheckout === undefined ||
    commonDirectory === undefined ||
    workingDirectory === undefined
  ) {
    return undefined;
  }
  const place = { repository, selectionCheckout, commonDirectory, workingDirectory };
  if (operation === "add") {
    const paths = pathspecs(read["paths"]);
    return paths === undefined
      ? undefined
      : Object.freeze({ operation: "add" as const, ...place, paths });
  }
  if (operation === "switch") {
    const branch = text(read["branch"]);
    const base = suppliedBase(read["base"]);
    return branch === undefined || base === undefined
      ? undefined
      : Object.freeze({ operation: "switch" as const, ...place, branch, base });
  }
  const messageSource = parseGitCommitMessageSource(read["messageSource"]);
  const messageDigest = sha256(read["messageDigest"]);
  const messageLength = count(read["messageLength"]);
  if (messageSource === undefined || messageDigest === undefined || messageLength === undefined) {
    return undefined;
  }
  return Object.freeze({
    operation: "commit" as const,
    ...place,
    messageSource,
    messageDigest,
    messageLength,
  });
}

const OWN_MEMBERS: Readonly<Record<ReplGitOperation, readonly string[]>> = {
  add: ["paths"],
  switch: ["branch", "base"],
  commit: ["messageSource", "messageDigest", "messageLength"],
};

function parseOutcome(value: unknown, request: ReplGitRequest): Result<ReplGitValue> | undefined {
  const refused = members(value, ["ok", "error"]);
  const succeeded = refused === undefined ? members(value, ["ok", "value"]) : undefined;
  if (refused !== undefined) {
    if (refused["ok"] !== false) {
      return undefined;
    }
    const data = parseRefusal(refused["error"], request.operation);
    return data === undefined ? undefined : Err(new ReplGitRefusal(data));
  }
  if (succeeded === undefined || succeeded["ok"] !== true) {
    return undefined;
  }
  const result = parseReplGitResult(succeeded["value"], request);
  return result === undefined ? undefined : Ok(result);
}

function parseRefusal(value: unknown, operation: ReplGitOperation): ReplGitRefusalData | undefined {
  const read = members(value, ["vocabulary", "reason"]);
  if (read === undefined) {
    return undefined;
  }
  const vocabulary = read["vocabulary"];
  const reason = read["reason"];
  if (typeof vocabulary !== "string" || typeof reason !== "string") {
    return undefined;
  }
  return replGitRefusal(operation, vocabulary, reason);
}

/**
 * The result this saved value describes for this request, or `undefined`.
 *
 * The same arithmetic the Workflow parsers apply, over an absolute host
 * checkout path instead of a Workspace-relative one. Where a checkout path is
 * placed is this host's own question and is held to the entry's private
 * registrations by the caller; what is decided here is that the result
 * describes *this* request and describes a transition the operation makes.
 */
export function parseReplGitResult(
  value: unknown,
  request: ReplGitRequest,
): ReplGitValue | undefined {
  if (request.operation === "add") {
    return addResult(value, request);
  }
  if (request.operation === "switch") {
    return switchResult(value, request);
  }
  return commitResult(value, request);
}

function addResult(value: unknown, request: ReplGitAddRequest): GitAddResult | undefined {
  const record = members(value, ["checkout", "paths", "before", "after"]);
  if (record === undefined) {
    return undefined;
  }
  const format = request.repository.objectFormat;
  const checkout = hostCheckoutIdentity(record["checkout"], request);
  const paths = pathspecs(record["paths"]);
  const before = parseGitCheckoutState(record["before"], format);
  const after = parseGitCheckoutState(record["after"], format);
  if (
    checkout === undefined ||
    paths === undefined ||
    before === undefined ||
    after === undefined ||
    !samePaths(paths, request.paths)
  ) {
    return undefined;
  }
  // Staging moves the index and nothing else, so the branch, the commit and the
  // HEAD tree are where the command found them. The index tree may differ or
  // not: staging what is already staged changes nothing, and a result saying so
  // is describing what happened.
  if (
    before.branch !== after.branch ||
    before.commit !== after.commit ||
    before.headTree !== after.headTree
  ) {
    return undefined;
  }
  return Object.freeze({ checkout, paths, before, after });
}

function switchResult(value: unknown, request: ReplGitSwitchRequest): GitSwitchResult | undefined {
  const record = members(value, [
    "checkout",
    "requestedBranch",
    "resolvedBranch",
    "requestedBase",
    "resolvedBase",
    "before",
    "after",
  ]);
  if (record === undefined) {
    return undefined;
  }
  const format = request.repository.objectFormat;
  const checkout = hostCheckoutIdentity(record["checkout"], request);
  const requestedBranch = text(record["requestedBranch"]);
  const resolvedBranch = text(record["resolvedBranch"]);
  const requestedBase = suppliedBase(record["requestedBase"]);
  const resolvedBase =
    record["resolvedBase"] === null ? null : parseGitObjectId(record["resolvedBase"], format);
  const before = parseGitCheckoutState(record["before"], format);
  const after = parseGitCheckoutState(record["after"], format);
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
  if (
    requestedBranch !== request.branch ||
    requestedBase !== request.base ||
    resolvedBranch !== request.branch ||
    after.branch !== resolvedBranch
  ) {
    return undefined;
  }
  const created = resolvedBase !== null;
  if (created && (after.commit !== resolvedBase || before.branch === after.branch)) {
    return undefined;
  }
  // Switching to the branch a checkout is already on moves nothing: no reset, no
  // reference change, and nothing staged or unstaged.
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

function commitResult(value: unknown, request: ReplGitCommitRequest): GitCommitResult | undefined {
  const record = members(value, [
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
  ]);
  if (record === undefined) {
    return undefined;
  }
  const format = request.repository.objectFormat;
  const checkout = hostCheckoutIdentity(record["checkout"], request);
  const messageSource = parseGitCommitMessageSource(record["messageSource"]);
  const messageDigest = sha256(record["messageDigest"]);
  const messageLength = count(record["messageLength"]);
  const parent = parseGitObjectId(record["parent"], format);
  const tree = parseGitObjectId(record["tree"], format);
  const commit = parseGitObjectId(record["commit"], format);
  const committedAt = count(record["committedAt"]);
  const before = parseGitCheckoutState(record["before"], format);
  const after = parseGitCheckoutState(record["after"], format);
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
  if (
    messageSource !== request.messageSource ||
    messageDigest !== request.messageDigest ||
    messageLength !== request.messageLength
  ) {
    return undefined;
  }
  // A commit of the index has exactly one parent and that parent is where the
  // checkout was; its tree is the tree the index described; and the checkout
  // ends on that commit with HEAD and index both equal to it. Committing an
  // index that already matched HEAD is the condition this operation refuses
  // rather than one it records.
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

/**
 * The checkout identity a native result carries, or `undefined`.
 *
 * The checkout path is an absolute host path, which is what the ordinary
 * performers answer with and what this feature's placement records already
 * carry. It is read as the string it is: whether it names a checkout this entry
 * registered is decided by the caller against its own private registrations,
 * never by consulting a filesystem.
 *
 * The repository name is held to the authenticated identity's, because every
 * checkout of one repository carries that repository's name and a result naming
 * another repository is not this request's.
 */
function hostCheckoutIdentity(
  value: unknown,
  request: ReplGitRequest,
): GitCheckoutIdentity | undefined {
  const record = members(value, ["repositoryName", "worktreeName", "checkoutPath"]);
  if (record === undefined) {
    return undefined;
  }
  const repositoryName = text(record["repositoryName"]);
  const worktreeName = optionalText(record["worktreeName"]);
  const checkoutPath = text(record["checkoutPath"]);
  if (
    repositoryName === undefined ||
    worktreeName === undefined ||
    checkoutPath === undefined ||
    repositoryName !== request.repository.name
  ) {
    return undefined;
  }
  return Object.freeze({ repositoryName, worktreeName, checkoutPath });
}

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
 * The base a Switch was given: `null`, or any string it was given.
 *
 * Wider than the identity members beside it, and deliberately so. A base is a
 * value the caller supplied rather than a fact this host derived, the ordinary
 * performer reads it only when it has to create a branch, and the record has to
 * carry back exactly what came in. Anything that is neither a string nor `null`
 * — a number, an object, an absent member — is a record this version did not
 * write and is refused as one.
 */
function suppliedBase(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/** A SHA-256 digest, which is one width and one case wherever one is written. */
function sha256(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate !== undefined && /^[0-9a-f]{64}$/.test(candidate) ? candidate : undefined;
}

/** A count of something, which is a whole number and never a negative one. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
