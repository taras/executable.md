/**
 * What one REPL entry records about repository work, and what names it.
 *
 * The REPL is a foreground environment: replay restores the recorded execution
 * state, and whether the live environment still matches it is the person's
 * business rather than this protocol's. So a record here says what one operation
 * was asked for and what it produced, and nothing about what the checkout
 * looked like — no inventory, no predicted transition, no frontier to compare.
 * A completed operation replays its result; the first operation with no result
 * runs live against whatever is actually there.
 *
 * Each record is read back out of an ordinary JSONL journal on a later open, so
 * nothing here is this package's own word by the time it is read. Records are
 * therefore parsed exactly: a value carrying more or fewer members than its
 * shape declares describes something other than that shape, and reading it as
 * one would accept whatever a later version — or another entry — put there.
 *
 * Two kinds of record exist, and both are ordinary durable values.
 *
 * - A **result** is written by the one durable operation that performs a local
 *   effect: the authored request, and what performing it produced. There is no
 *   record before the effect, because there is nothing for one to say.
 * - A **request** is written before a *service* is contacted, and freezes the
 *   inputs that call resolves — a branch, a commit, an origin, a destination —
 *   so a continuation asks the same question rather than re-resolving today's
 *   answer. It is not an outcome: `git_host_effect` and `issue_effect` remain
 *   the only authority on what a service did.
 *
 * Nothing operational is retained. A record holds detached JSON — never a
 * credential, a live handle, a function or a private selection token — so a
 * copied record is descriptive data and grants nothing.
 *
 * The durable type and name of both records are this feature's own and are new
 * in this protocol. The experimental intent/completion encodings that preceded
 * it are not readable here and are not migrated: a history holding them is
 * refused as one this version cannot continue, rather than reinterpreted as
 * results it never recorded.
 */

import { until } from "effection";
import type { Operation } from "effection";
import {
  fileWriteFailure,
  filesFailure,
  parseFileWriteFailure,
  parseFilesFailure,
} from "@executablemd/runtime";
import type { Json } from "@executablemd/durable-streams";
import { canonicalJson } from "@executablemd/workflow";
import { members, text } from "../composition/parse.ts";
import type {
  GitFailureReason,
  RepositoryFailureReason,
  WorktreeFailureReason,
} from "../composition/errors.ts";

/** The durable type a completed local operation's result is journaled under. */
export const REPL_REPOSITORY_RESULT = "repl_repository_result";

/** The durable type a resolved external request is journaled under. */
export const REPL_REPOSITORY_REQUEST = "repl_repository_request";

/** The version both records carry, and the only one this code reads. */
export const REPL_REPOSITORY_VERSION = 1;

/**
 * The prefix both record names begin with.
 *
 * This feature's own, and deliberately not the prefix the experimental
 * snapshot protocol used: a name is half of what identifies a durable record,
 * so an old journal's records cannot be matched by a new operation even if a
 * type happened to agree.
 */
export const REPL_REPOSITORY_PREFIX = "repl-repository";

/** The durable types the experimental snapshot protocol wrote. */
export const SUPERSEDED_RECORD_TYPES: readonly string[] = Object.freeze([
  "retained_repository_intent",
  "retained_repository_completion",
]);

/** What one recorded operation does. */
export type RetainedRepositoryOperation =
  | "repository"
  | "worktree"
  | "ambient"
  | "switch"
  | "add"
  | "commit"
  | "file-write"
  | "file-delete"
  | "dir-ensure"
  | "push"
  | "pull-request"
  | "issue";

/** Every operation this protocol has, in canonical order. */
export const RETAINED_REPOSITORY_OPERATIONS: readonly RetainedRepositoryOperation[] = Object.freeze(
  [
    "repository",
    "worktree",
    "ambient",
    "switch",
    "add",
    "commit",
    "file-write",
    "file-delete",
    "dir-ensure",
    "push",
    "pull-request",
    "issue",
  ],
);

/**
 * The entry that owns a retained effect.
 *
 * The execution and the entry together, because one execution admits entries in
 * order and each of them owns its own effects. Neither half alone identifies an
 * owner: two entries of one execution share the execution, and two executions
 * can reach the same entry key.
 */
export interface RetainedRepositoryOwnerIdentity {
  readonly executionId: string;
  readonly entryKey: string;
}

/**
 * How that pair is spelled in a record.
 *
 * A prefix and canonical JSON of the pair, so the spelling is stable across
 * runtimes and cannot be confused with a workflow run id. Existing Git-host and
 * Issue records keep their own `runId` spelling; this is a third owner, not a
 * replacement for either.
 */
export function retainedRepositoryOwner(identity: RetainedRepositoryOwnerIdentity): string {
  return `repl:v1:${canonicalJson([identity.executionId, identity.entryKey])}`;
}

/**
 * Where in the document one effect was asked for.
 *
 * The occurrence is the engine's own invocation identity, which separates two
 * iterations of a loop and an authored element from a generated one. The source
 * is the admitted document or generated source it was written in, so a record
 * never answers for the same occurrence in a different source.
 */
export interface RetainedRepositorySite {
  readonly source: string;
  readonly occurrence: string;
}

/**
 * The operations that establish a checkout rather than change one.
 *
 * A lane's first record is one of these: a mutation written before anything
 * selected a checkout has no baseline to be held to, and admitting it would
 * mean trusting its own account of the state it started from.
 */
const SELECTIONS: ReadonlySet<string> = new Set(["repository", "worktree", "ambient"]);

/** Whether this operation establishes a checkout. */
export function establishesCheckout(operation: RetainedRepositoryOperation): boolean {
  return SELECTIONS.has(operation);
}

const SITE_MEMBERS = ["source", "occurrence"] as const;

/** The site this value describes, or `undefined`. */
export function parseRetainedRepositorySite(value: unknown): RetainedRepositorySite | undefined {
  const read = members(value, SITE_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const source = text(read["source"]);
  const occurrence = text(read["occurrence"]);
  if (source === undefined || occurrence === undefined) {
    return undefined;
  }
  return Object.freeze({ source, occurrence });
}

/** The detached JSON this value describes, or `undefined` when it describes none. */
export function detachedJson(value: unknown): Json | undefined {
  try {
    return json(value, new Set<object>());
  } catch {
    return undefined;
  }
}

/**
 * A detached, deeply frozen copy of the JSON this value describes.
 *
 * A copy rather than the value itself: whatever handed it over keeps its own
 * object, and nothing it does to that object afterwards changes what admission
 * accepted. `undefined` is the single answer for "this is not JSON", which is
 * why a member that is literally `undefined` is refused rather than dropped — a
 * shape with a missing member is not that shape with a hole in it.
 */
function json(value: unknown, ancestors: Set<object>): Json | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (ancestors.has(value)) {
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: Json[] = [];
      for (let index = 0; index < value.length; index += 1) {
        // A hole is not a member. `[1, , 3]` reads its middle element as
        // `undefined`, which JSON cannot express and this must not invent.
        if (!Object.hasOwn(value, index)) {
          return undefined;
        }
        const item = json(Reflect.get(value, index), ancestors);
        if (item === undefined) {
          return undefined;
        }
        items.push(item);
      }
      Object.freeze(items);
      return items;
    }
    const detached: Record<string, Json> = {};
    for (const key of Object.keys(value)) {
      const member = json(Reflect.get(value, key), ancestors);
      if (member === undefined) {
        return undefined;
      }
      // Defined rather than assigned: `detached[key] = …` reaches
      // `Object.prototype`'s setter for `__proto__` and drops the key on Node
      // and Bun, so a payload declaring that name would detach differently
      // depending on where it ran.
      Object.defineProperty(detached, key, {
        value: member,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(detached);
    return detached;
  } finally {
    ancestors.delete(value);
  }
}

function version(value: unknown): typeof REPL_REPOSITORY_VERSION | undefined {
  return value === REPL_REPOSITORY_VERSION ? REPL_REPOSITORY_VERSION : undefined;
}

/**
 * The operation this value names, or `undefined`.
 *
 * Found in the canonical list rather than asserted: the list is the union, so
 * finding the string in it is what proves it is one of them.
 */
function parseOperation(value: unknown): RetainedRepositoryOperation | undefined {
  return RETAINED_REPOSITORY_OPERATIONS.find((operation) => operation === value);
}

/**
 * The words a Repository refusal retains, as a complete map of its vocabulary.
 *
 * A `Record` keyed by the union rather than a list, so the compiler refuses
 * both a missing word and an invented one. A list would silently reject a
 * refusal somebody added to the vocabulary later.
 */
const REPOSITORY_REFUSALS: Readonly<Record<RepositoryFailureReason, true>> = Object.freeze({
  "invalid-locator": true,
  "authentication-unavailable": true,
  "unresolved-base": true,
  "missing-remote-default": true,
  "incompatible-reuse": true,
  "unusable-repository": true,
});

/** The words a Worktree refusal retains. */
const WORKTREE_REFUSALS: Readonly<Record<WorktreeFailureReason, true>> = Object.freeze({
  "no-repository-context": true,
  "unresolved-base": true,
  "branch-checked-out-elsewhere": true,
  "incompatible-reuse": true,
  "unusable-repository": true,
});

/** The words a Git operation's refusal retains. */
const GIT_REFUSALS: Readonly<Record<GitFailureReason, true>> = Object.freeze({
  "invalid-invocation": true,
  "invalid-branch": true,
  "unresolved-base": true,
  "branch-checked-out-elsewhere": true,
  "overwrites-local-changes": true,
  "unmatched-pathspec": true,
  "ignored-pathspec": true,
  "outside-checkout-pathspec": true,
  "invalid-pathspec-magic": true,
  "empty-index": true,
  "unnamed-branch": true,
});

/**
 * The retained result as the runtime's own Files parsers read one.
 *
 * Those parsers answer for an error carrying failure data, because that is how
 * the data reaches every other consumer. Here it has come back out of a journal
 * as plain JSON, so it is handed over the same way rather than re-implemented:
 * the vocabulary of operations, phases, reasons and write targets stays the
 * runtime's single definition of it.
 */
function filesOutcome(result: Json): Error {
  return Object.assign(new Error("Files operation failed"), { data: result });
}

/**
 * This refusal, written down the way a completion carries one.
 *
 * The forward direction of the reader below: what an operation reports when it
 * refuses, reduced to the closed words a history may retain. A Files refusal
 * keeps the data its own error carries, which is what says whether the file was
 * replaced; every other operation keeps one word from its own vocabulary, which
 * is the only part of such a refusal that means the same thing a day later.
 *
 * Nothing for a failure these vocabularies do not account for. A failure this
 * cannot write down is not a refusal this host may stand behind, and the caller
 * treats it as the uncertainty it is.
 */
export function retainedRefusalResult(
  operation: RetainedRepositoryOperation,
  error: unknown,
): Json | undefined {
  const result = refusalResult(operation, error);
  if (result === undefined || !retainedRepositoryRefusal(operation, result)) {
    return undefined;
  }
  return result;
}

/**
 * The Files error a recorded refusal stands for, rebuilt from what it kept.
 *
 * A replay has to answer the way the live run answered. For a Files operation
 * that means a failure in the closed vocabulary again, built through the same
 * constructors, so whatever reads it — the `<File>` boundary included — reads
 * the same sentence it read the first time.
 */
export function retainedRefusalFilesError(
  operation: RetainedRepositoryOperation,
  result: Json,
): Error | undefined {
  if (operation === "file-write") {
    const failure = parseFileWriteFailure(filesOutcome(result));
    if (failure === undefined) {
      return undefined;
    }
    return attempt(() =>
      fileWriteFailure({
        phase: failure.phase,
        ...(failure.reason === undefined ? {} : { reason: failure.reason }),
        ...(failure.cleanup === undefined ? {} : { cleanup: failure.cleanup }),
      }),
    );
  }
  if (operation !== "file-delete" && operation !== "dir-ensure") {
    return undefined;
  }
  const failure = parseFilesFailure(filesOutcome(result));
  if (failure === undefined) {
    return undefined;
  }
  return attempt(() =>
    filesFailure({
      operation: failure.operation,
      phase: failure.phase,
      reason: failure.reason,
    }),
  );
}

/** Nothing rather than a throw: a refusal this cannot rebuild is not one. */
function attempt(build: () => Error): Error | undefined {
  try {
    return build();
  } catch {
    return undefined;
  }
}

function refusalResult(operation: RetainedRepositoryOperation, error: unknown): Json | undefined {
  if (operation === "file-write") {
    const failure = parseFileWriteFailure(error);
    return failure === undefined ? undefined : { ...failure };
  }
  if (operation === "file-delete" || operation === "dir-ensure") {
    const failure = parseFilesFailure(error);
    return failure === undefined ? undefined : { ...failure };
  }
  const reason = text(reasonOf(error));
  return reason === undefined ? undefined : { reason };
}

/** The word a composition error carries for why it refused. */
function reasonOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "reason") : undefined;
}

/**
 * Whether this result is a refusal `operation` is allowed to retain unchanged
 * state for.
 *
 * Positively parsed, never inferred from disagreeing with the frozen evidence:
 * a different valid success is evidence disagreement, and reading it as a
 * refusal would let a write that happened be retained as one that did not.
 *
 * A file write is held to more than a well-formed failure. Its data says what
 * became of the target, and only `unchanged` and `rolled-back` are states
 * nothing was left in — `commit-unknown` is the runtime's word for not knowing,
 * which is exactly what cannot be retained as proof that nothing changed.
 *
 * A delete and a directory ensure are held to the operation their failure names.
 * One parser answers for every non-write Files operation, so a well-formed
 * failure is not on its own a failure of the operation standing here.
 *
 * An operation with no closed local refusal vocabulary retains none. Ambient
 * selection and the three external operations fail the run or complete through
 * their own existing records instead, and a managed-placement refusal arrives
 * with the provider that owns those words.
 */
export function retainedRepositoryRefusal(
  operation: RetainedRepositoryOperation,
  result: Json,
): boolean {
  if (operation === "file-write") {
    const failure = parseFileWriteFailure(filesOutcome(result));
    if (failure === undefined) {
      return false;
    }
    return failure.target === "unchanged" || failure.target === "rolled-back";
  }
  if (operation === "file-delete" || operation === "dir-ensure") {
    const failure = parseFilesFailure(filesOutcome(result));
    if (failure === undefined) {
      return false;
    }
    // The parser recognizes every non-write Files operation, so the word it
    // read has to be this operation's own. A read that was refused says
    // nothing about whether the delete beside it refused.
    return failure.operation === (operation === "file-delete" ? "delete" : "ensure-directory");
  }
  if (operation === "repository") {
    return refusedWith(result, REPOSITORY_REFUSALS);
  }
  if (operation === "worktree") {
    return refusedWith(result, WORKTREE_REFUSALS);
  }
  if (operation === "switch" || operation === "add" || operation === "commit") {
    return refusedWith(result, GIT_REFUSALS);
  }
  return false;
}

/**
 * Whether this result is one word from `vocabulary`, and nothing else.
 *
 * The word is the only part of one of these refusals that is safe to retain:
 * the sentence beside it is written for the person reading the document, and
 * the component that produced it deliberately keeps everything the platform
 * said out of both.
 */
function refusedWith(result: Json, vocabulary: Readonly<Record<string, true>>): boolean {
  const read = members(result, ["reason"]);
  if (read === undefined) {
    return false;
  }
  const reason = text(read["reason"]);
  return reason !== undefined && Object.hasOwn(vocabulary, reason);
}

/**
 * What one authored request asks, as a stable name.
 *
 * The owner and the site are in it, so the same text written at two occurrences
 * — two iterations of one loop, or the same line in two entries — asks two
 * different questions. What preparation resolved is not in it: a resumed
 * operation compares what the document asked with what the record saved, and
 * then uses the saved resolution.
 */
export function* retainedRepositoryRequestFingerprint(request: {
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  readonly selection: Json;
  readonly request: Json;
}): Operation<string> {
  const encoded = new TextEncoder().encode(
    canonicalJson({
      owner: request.owner,
      site: { source: request.site.source, occurrence: request.site.occurrence },
      operation: request.operation,
      selection: request.selection,
      request: request.request,
    }),
  );
  const digest = yield* until(crypto.subtle.digest("SHA-256", encoded));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The name one record is identified by, which is half of its identity. */
export function replRepositoryRecordName(record: {
  readonly phase: "result" | "request";
  readonly owner: string;
  readonly fingerprint: string;
  readonly operation: RetainedRepositoryOperation;
}): string {
  return canonicalJson([
    REPL_REPOSITORY_PREFIX,
    record.phase,
    record.owner,
    record.fingerprint,
    record.operation,
  ]);
}

/**
 * What one completed local operation left behind.
 *
 * The request is the authored one — what the document asked for — and the
 * result is what performing it produced, in the operation's own ordinary
 * vocabulary. `selection` is the small logical fact a descendant needs to be
 * routed correctly on a later open: which checkout this operation's content
 * belongs to. It is a path and a shared Git directory, not a capability and not
 * a state to verify.
 */
export interface ReplRepositoryResult {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  /** The digest of owner, site, operation and authored request. */
  readonly fingerprint: string;
  /** What the document asked for. */
  readonly request: Json;
  /** What performing it produced, or the refusal it is allowed to retain. */
  readonly result: Json;
}

/**
 * The logical target a completed selection's own result carries.
 *
 * A selection answers with the checkout its content belongs to and the shared
 * Git directory that checkout administers, so a later open routes this entry's
 * descendants to the same place by reading the result it already has. It is a
 * path, not a capability: it is checked against the entry's own trusted
 * identity and placement rather than treated as permission.
 */
export interface ReplRepositorySelection {
  /** The checkout content inside this selection is written in. */
  readonly checkout: string;
  /** The shared Git directory that checkout administers. */
  readonly common: string;
}

/**
 * The inputs one external call was resolved to, frozen before it is made.
 *
 * Written so a continuation asks the service the same question: the branch and
 * commit a push names, the repository a pull request belongs to, the issue a
 * tracker is asked about. Reading today's HEAD again would be asking a
 * different question and calling the answer a resume.
 */
export interface ReplRepositoryRequest {
  readonly version: typeof REPL_REPOSITORY_VERSION;
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  readonly fingerprint: string;
  /** What the document asked for, which is what names this record. */
  readonly request: Json;
  /**
   * The inputs that call was resolved to, which a continuation reuses.
   *
   * Separate from the authored request because the two are different facts: the
   * document asked to push, and *this* branch at *this* commit to *that*
   * destination is what asking resolved to on the day it was asked. Reading
   * today's answer instead would be asking a new question and calling it a
   * resume.
   */
  readonly resolved: Json;
}

const RESULT_MEMBERS = [
  "version",
  "owner",
  "site",
  "operation",
  "fingerprint",
  "request",
  "result",
] as const;

const REQUEST_MEMBERS = [
  "version",
  "owner",
  "site",
  "operation",
  "fingerprint",
  "request",
  "resolved",
] as const;

/** This result as the journal holds it. */
export function replRepositoryResultJson(result: ReplRepositoryResult): Json {
  return {
    version: result.version,
    owner: result.owner,
    site: { source: result.site.source, occurrence: result.site.occurrence },
    operation: result.operation,
    fingerprint: result.fingerprint,
    request: result.request,
    result: result.result,
  };
}

/** This request as the journal holds it. */
export function replRepositoryRequestJson(request: ReplRepositoryRequest): Json {
  return {
    version: request.version,
    owner: request.owner,
    site: { source: request.site.source, occurrence: request.site.occurrence },
    operation: request.operation,
    fingerprint: request.fingerprint,
    request: request.request,
    resolved: request.resolved,
  };
}

/** The result this value describes, or `undefined`. */
export function parseReplRepositoryResult(value: unknown): ReplRepositoryResult | undefined {
  const read = members(value, RESULT_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const held = version(read["version"]);
  const owner = text(read["owner"]);
  const site = parseRetainedRepositorySite(read["site"]);
  const operation = parseOperation(read["operation"]);
  const fingerprint = text(read["fingerprint"]);
  const request = detachedJson(read["request"]);
  const outcome = detachedJson(read["result"]);
  if (
    held === undefined ||
    owner === undefined ||
    site === undefined ||
    operation === undefined ||
    fingerprint === undefined ||
    request === undefined ||
    outcome === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    version: held,
    owner,
    site,
    operation,
    fingerprint,
    request,
    result: outcome,
  });
}

/** The request this value describes, or `undefined`. */
export function parseReplRepositoryRequest(value: unknown): ReplRepositoryRequest | undefined {
  const read = members(value, REQUEST_MEMBERS);
  if (read === undefined) {
    return undefined;
  }
  const held = version(read["version"]);
  const owner = text(read["owner"]);
  const site = parseRetainedRepositorySite(read["site"]);
  const operation = parseOperation(read["operation"]);
  const fingerprint = text(read["fingerprint"]);
  const request = detachedJson(read["request"]);
  const resolved = detachedJson(read["resolved"]);
  if (
    held === undefined ||
    owner === undefined ||
    site === undefined ||
    operation === undefined ||
    fingerprint === undefined ||
    request === undefined ||
    resolved === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ version: held, owner, site, operation, fingerprint, request, resolved });
}
