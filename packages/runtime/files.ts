/**
 * `API.Files` — the document filesystem boundary.
 *
 * A document names files with a path relative to the contextual working
 * directory, and every one of those operations arrives here. What is on the
 * other side is a provider's choice: `xmd run` installs a host adapter that
 * resolves those paths in the caller's own filesystem, and `xmd workflow`
 * installs one that resolves them in a logical filesystem owned by a database
 * transaction. Neither is named in the components that call this Api, which is
 * what lets one document mean the same thing under both.
 *
 * The operations are **semantic**, not primitive. `writeTextFile` is a whole
 * replacement — admission, resolution, target classification, parent creation,
 * and commit — rather than a sequence a caller assembles, because assembling it
 * from outside is what would let a path admitted by one provider be used by
 * another. `API.Fs` remains the low-level host surface a host adapter is built
 * on; it is not this boundary.
 *
 * `checkFilePath` is the one exception, and it is deliberately weak: pure path
 * arithmetic, no filesystem access, and nothing usable comes back — no path, no
 * handle, no authority token. `<File>`'s write form calls it to decide whether
 * its children may expand at all, and the later `writeTextFile` repeats the
 * same admission from the same authored path. A check that was skipped,
 * replaced, or answered by another provider therefore authorizes nothing.
 *
 * ## Two kinds of failure
 *
 * An ordinary filesystem condition — missing, a directory, permission denied,
 * no space — comes back as `Err(FilesError)` carrying frozen structural data.
 * The consumer reads that data and selects a sentence from a fixed vocabulary;
 * no message, errno code, resolved path, temporary path, or symlink target
 * crosses this boundary. Cancellation is neither of these: it is not caught and
 * never becomes a Result.
 *
 * A provider that is absent, that refuses an operation, or that breaks its own
 * contract is not a filesystem condition. Those **throw**, with fixed
 * diagnostics and no cause, and they end the execution rather than becoming
 * something a document renders. A run whose Files provider is missing must not
 * quietly reach the host instead.
 *
 * ## Why the data is structural
 *
 * Both the failures and the write outcome carry a plain frozen object under a
 * stable `type` tag, and every consumer recognizes them by parsing that tag
 * rather than with `instanceof`. Two copies of this package can be loaded at
 * once — a repository component resolving its own runtime beside the engine's —
 * and `instanceof` answers false across them, which would turn a provider
 * failure into an unrecognized throw exactly when it matters most.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Result } from "effection";

/** The stable discriminant on ordinary filesystem failure data. */
export const FILES_ERROR = "executablemd.runtime.files-error/v1";

/** The stable discriminant on infrastructure failure data. */
export const FILES_FATAL = "executablemd.runtime.files-fatal/v1";

/** The stable discriminant on a successful write's outcome data. */
export const FILES_WRITE_SUCCESS = "executablemd.runtime.files-write-success/v1";

/**
 * The vocabulary an ordinary failure is reported in.
 *
 * A provider maps whatever its platform produced onto one of these before
 * returning. An unmapped condition becomes `operation-failed`, which is a real
 * answer rather than a placeholder: the consumer has a sentence for it, and the
 * unmapped value itself never crosses the boundary.
 */
export type FilesReason =
  | "empty-path"
  | "absolute-path"
  | "lexical-escape"
  | "resolved-escape"
  | "missing"
  | "directory"
  | "special-file"
  | "not-directory"
  | "permission-denied"
  | "read-only"
  | "too-many-symlinks"
  | "path-too-long"
  | "no-space"
  | "quota-exhausted"
  | "cross-device"
  | "busy"
  | "too-many-open-files"
  | "directory-not-empty"
  | "invalid-pattern"
  | "operation-failed";

const REASONS: readonly FilesReason[] = [
  "empty-path",
  "absolute-path",
  "lexical-escape",
  "resolved-escape",
  "missing",
  "directory",
  "special-file",
  "not-directory",
  "permission-denied",
  "read-only",
  "too-many-symlinks",
  "path-too-long",
  "no-space",
  "quota-exhausted",
  "cross-device",
  "busy",
  "too-many-open-files",
  "directory-not-empty",
  "invalid-pattern",
  "operation-failed",
];

/** The operations whose failure carries no commit outcome. */
export type FilesOperation = "check-file-path" | "read" | "glob" | "temporary-directory";

const OPERATIONS: readonly FilesOperation[] = [
  "check-file-path",
  "read",
  "glob",
  "temporary-directory",
];

/** Where a non-write operation stopped. */
export type FilesPhase =
  | "lexical"
  | "resolution"
  | "target"
  | "access"
  | "pattern"
  | "traversal"
  | "acquire";

const PHASES: readonly FilesPhase[] = [
  "lexical",
  "resolution",
  "target",
  "access",
  "pattern",
  "traversal",
  "acquire",
];

/** Where a write stopped, which is what decides what may be said about the target. */
export type FileWritePhase =
  | "lexical"
  | "resolution"
  | "target"
  | "parents"
  | "temporary"
  | "commit"
  | "cleanup"
  | "transaction";

/**
 * What is known about the target afterwards.
 *
 * `commit-unknown` is an answer rather than a missing one: a commit that threw
 * may have run or not, and no provider can tell which from where it stands.
 * What still holds in that case is that the target is one complete version.
 */
export type FileWriteTarget = "unchanged" | "commit-unknown" | "committed" | "rolled-back";

export interface FilesFailureData {
  readonly type: typeof FILES_ERROR;
  readonly operation: FilesOperation;
  readonly phase: FilesPhase;
  readonly reason: FilesReason;
}

export interface FileWriteFailureData {
  readonly type: typeof FILES_ERROR;
  readonly operation: "write";
  readonly phase: FileWritePhase;
  readonly reason?: FilesReason;
  readonly cleanup?: FilesReason;
  readonly target: FileWriteTarget;
}

export type FilesErrorData = FilesFailureData | FileWriteFailureData;

/**
 * The message every ordinary failure carries.
 *
 * Constant on purpose. A message is the part of an Error that gets printed by
 * accident, and there is nothing safe to put in this one: the authored path
 * belongs to the consumer that wrote it, and everything else belongs to the
 * platform.
 */
export const FILES_ERROR_MESSAGE = "Files operation failed";

/** An ordinary filesystem failure. What it means is in `data`, never in the message. */
export class FilesError extends Error {
  readonly data: FilesErrorData;

  constructor(data: FilesErrorData) {
    super(FILES_ERROR_MESSAGE);
    this.name = "FilesError";
    this.data = data;
  }
}

export interface FileWriteSuccess {
  readonly type: typeof FILES_WRITE_SUCCESS;
  readonly publication: "host-committed" | "transaction-staged";
}

export interface FilePathInput {
  readonly cwd: string;
  readonly path: string;
}

export interface FileWriteInput extends FilePathInput {
  readonly content: string;
}

export interface GlobInput {
  readonly cwd: string;
  readonly include: string[];
  readonly exclude: string[];
}

export interface FilesHandler {
  /**
   * Whether this authored path is admissible at all, decided from the path and
   * `cwd` alone. No filesystem access, and nothing usable comes back.
   */
  checkFilePath(input: FilePathInput): Operation<Result<void>>;
  readTextFile(input: FilePathInput): Operation<Result<string>>;
  writeTextFile(input: FileWriteInput): Operation<Result<FileWriteSuccess>>;
  /** Sorted, deduplicated, POSIX-separated paths of the regular files that match. */
  globFiles(input: GlobInput): Operation<Result<string[]>>;
  /**
   * A directory that lives as long as the acquiring scope. A resource, so the
   * caller holds it by acquisition rather than by remembering to remove it.
   */
  temporaryDirectory(): Operation<Result<string>>;
}

/** The operations a provider may refuse outright rather than fail at. */
export type FilesDeniableOperation = "temporary-directory";

/**
 * Which contract a provider broke.
 *
 * `authority` — the identity authorizing access is stale, foreign, or gone.
 * `savepoint` — a nested transaction could not be rolled back or released.
 * `protocol` — a handler threw, or returned data no consumer can trust.
 * `teardown` — cleanup failed while the scope was already unwinding.
 */
export type FilesInvariantCategory = "authority" | "savepoint" | "protocol" | "teardown";

const INVARIANT_CATEGORIES: readonly FilesInvariantCategory[] = [
  "authority",
  "savepoint",
  "protocol",
  "teardown",
];

/**
 * Infrastructure failure data.
 *
 * Three kinds, each with fixed fields and nothing derived from the condition
 * that produced it. A category is control data for a consumer deciding what to
 * fence, not text: no diagnostic interpolates it.
 */
export type FilesFatalData =
  | { readonly type: typeof FILES_FATAL; readonly kind: "provider-unavailable" }
  | {
      readonly type: typeof FILES_FATAL;
      readonly kind: "operation-denied";
      readonly operation: FilesDeniableOperation;
    }
  | {
      readonly type: typeof FILES_FATAL;
      readonly kind: "invariant";
      readonly category: FilesInvariantCategory;
    };

export const FILES_PROVIDER_UNAVAILABLE_MESSAGE = "Files provider is not installed";
export const FILES_OPERATION_DENIED_MESSAGE = "Files provider does not support temporary-directory";
export const FILES_INVARIANT_MESSAGE = "Files provider invariant failed";

/** No Files provider is installed, and there is no host to fall back to. */
export class FilesProviderUnavailableError extends Error {
  readonly data: FilesFatalData;

  constructor() {
    super(FILES_PROVIDER_UNAVAILABLE_MESSAGE);
    this.name = "FilesProviderUnavailableError";
    this.data = Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" });
  }
}

/** The installed provider does not implement this operation at all. */
export class FilesOperationDeniedError extends Error {
  readonly data: FilesFatalData;

  constructor(operation: FilesDeniableOperation) {
    super(FILES_OPERATION_DENIED_MESSAGE);
    this.name = "FilesOperationDeniedError";
    const denied = deniableOperation(operation);
    if (denied === undefined) {
      throw new FilesInvariantError("protocol");
    }
    this.data = Object.freeze({ type: FILES_FATAL, kind: "operation-denied", operation: denied });
  }
}

/** A provider broke its own contract. */
export class FilesInvariantError extends Error {
  readonly data: FilesFatalData;

  constructor(category: FilesInvariantCategory) {
    super(FILES_INVARIANT_MESSAGE);
    this.name = "FilesInvariantError";
    const parsed = invariantCategory(category);
    if (parsed === undefined) {
      throw new Error(FILES_INVARIANT_MESSAGE);
    }
    this.data = Object.freeze({ type: FILES_FATAL, kind: "invariant", category: parsed });
  }
}

/** An infrastructure failure, recognized structurally rather than by class. */
export interface FilesFatalFailure extends Error {
  readonly data: FilesFatalData;
}

/**
 * Everything below reads values it did not create.
 *
 * A thrown value is whatever a provider threw, and a provider is as free to
 * hand back a Proxy with a throwing `get` trap, an accessor that fails, or an
 * object whose key enumeration explodes as it is to hand back a plain record.
 * These parsers run from `fatalCause`, which every generic catch in the engine
 * consults — so one of them throwing would replace the failure being classified
 * with a failure *about classifying it*, at the exact moment the engine is
 * deciding whether the execution may continue.
 *
 * So reading is total: every access that can fail goes through a helper that
 * answers `undefined` instead, and each exported parser is additionally wrapped
 * so that a shape nobody anticipated is simply not recognized.
 */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether this is an Error, without trusting its prototype chain. */
function isError(value: unknown): value is Error {
  return attempt(() => value instanceof Error) === true;
}

/** One property, read through a trap that may refuse or fail. */
function property(target: object, name: string): unknown {
  return attempt(() => Reflect.get(target, name));
}

/** How many own enumerable keys, when the object will say. */
function keyCount(value: object): number | undefined {
  return attempt(() => Object.keys(value).length);
}

function isFrozen(value: object): boolean {
  return attempt(() => Object.isFrozen(value)) === true;
}

function dataOf(error: unknown): Record<string, unknown> | undefined {
  if (!isError(error)) {
    return undefined;
  }
  const data = property(error, "data");
  return isRecord(data) ? data : undefined;
}

/** The one diagnostic each kind of infrastructure failure carries. */
const FATAL_DIAGNOSTICS: ReadonlyMap<string, string> = new Map([
  ["provider-unavailable", FILES_PROVIDER_UNAVAILABLE_MESSAGE],
  ["operation-denied", FILES_OPERATION_DENIED_MESSAGE],
  ["invariant", FILES_INVARIANT_MESSAGE],
]);

/** The one class name each kind of infrastructure failure carries. */
const FATAL_NAMES: ReadonlyMap<string, string> = new Map([
  ["provider-unavailable", "FilesProviderUnavailableError"],
  ["operation-denied", "FilesOperationDeniedError"],
  ["invariant", "FilesInvariantError"],
]);

/**
 * Everything a constructor here puts on the Error itself, and nothing else.
 *
 * `message` and `stack` are non-enumerable own properties of every Error, so
 * what remains enumerable is exactly what a constructor assigned. Anything more
 * is payload the contract does not describe — and since recognition hands the
 * object onward by identity, payload travels with it.
 */
const FATAL_MEMBERS: readonly string[] = ["data", "name"];

/**
 * Whether the Error carries only the members its constructor assigns.
 *
 * Symbols are checked as well as string keys: a symbol-keyed enumerable
 * property survives spreading and appears in `Object.assign`'d copies, so
 * leaving it unexamined would let a path ride along through exactly the
 * mechanisms a consumer uses to inspect a failure.
 */
function hasOnlyContractMembers(error: Error): boolean {
  const keys = attempt(() => [...Object.keys(error)].sort());
  if (keys === undefined || keys.length !== FATAL_MEMBERS.length) {
    return false;
  }
  if (!keys.every((key, index) => key === FATAL_MEMBERS[index])) {
    return false;
  }
  const payload = attempt(() =>
    Object.getOwnPropertySymbols(error).filter(
      (symbol) => Object.getOwnPropertyDescriptor(error, symbol)?.enumerable === true,
    ),
  );
  return payload !== undefined && payload.length === 0;
}

function reasonOf(value: unknown): FilesReason | undefined {
  return REASONS.find((reason) => reason === value);
}

function operationOf(value: unknown): FilesOperation | undefined {
  return OPERATIONS.find((operation) => operation === value);
}

function phaseOf(value: unknown): FilesPhase | undefined {
  return PHASES.find((phase) => phase === value);
}

/**
 * The vocabularies, for a provider that reads a failure back out of storage.
 *
 * A transaction-bound provider retains what it refused rather than a serialized
 * error, so restoring one means turning stored text back into the vocabulary.
 * Parsing it here is what keeps one list of reasons and phases: a provider that
 * declared its own copy would be a second list to keep in agreement with this.
 */
export function parseFilesReason(value: unknown): FilesReason | undefined {
  return reasonOf(value);
}

export function parseFilesPhase(value: unknown): FilesPhase | undefined {
  return phaseOf(value);
}

export function parseFileWritePhase(value: unknown): FileWritePhase | undefined {
  return writePhaseOf(value)?.[0];
}

function invariantCategory(value: unknown): FilesInvariantCategory | undefined {
  return INVARIANT_CATEGORIES.find((category) => category === value);
}

function deniableOperation(value: unknown): FilesDeniableOperation | undefined {
  return value === "temporary-directory" ? "temporary-directory" : undefined;
}

/**
 * The infrastructure failure data this Error carries, if it carries valid data.
 *
 * Every field is checked, the member count with them, and that the object is
 * frozen: extra keys are not the shape this contract describes, and a mutable
 * one is not the shape a constructor here produces. Accepting either would let
 * a provider smuggle a path or a message through under a recognized tag.
 */
export function parseFilesFatal(error: unknown): FilesFatalData | undefined {
  return attempt(() => {
    const data = dataOf(error);
    if (data === undefined || property(data, "type") !== FILES_FATAL || !isFrozen(data)) {
      return undefined;
    }
    const members = keyCount(data);
    const kind = property(data, "kind");
    if (kind === "provider-unavailable" && members === 2) {
      return Object.freeze({ type: FILES_FATAL, kind: "provider-unavailable" });
    }
    if (kind === "operation-denied" && members === 3) {
      const operation = deniableOperation(property(data, "operation"));
      if (operation !== undefined) {
        return Object.freeze({ type: FILES_FATAL, kind: "operation-denied", operation });
      }
    }
    if (kind === "invariant" && members === 3) {
      const category = invariantCategory(property(data, "category"));
      if (category !== undefined) {
        return Object.freeze({ type: FILES_FATAL, kind: "invariant", category });
      }
    }
    return undefined;
  });
}

/**
 * Whether this failure satisfies the whole public infrastructure-failure
 * contract, not merely the tag.
 *
 * Recognition decides two different things at once, and the second is why this
 * is stricter than `parseFilesFatal`. A recognized failure is **rethrown by
 * identity** — the object that was thrown is the object a fail-stop records —
 * so recognizing one is a decision to let that exact object travel onward. An
 * Error that carries the right data but also a raw platform message, or a cause
 * chain holding an errno and a path, would then carry all of that past the
 * boundary the reason vocabulary exists to hold.
 *
 * So the whole object has to match what a constructor here produces: the fixed
 * name and diagnostic for its kind, frozen structural data with exactly the
 * fields the kind describes, no cause, and no other enumerable member — string
 * or symbol. Anything else is a candidate that fails the contract, and
 * `invokeFiles` replaces it with a fresh invariant rather than preserving it.
 *
 * Structural throughout, so a failure constructed by a separately loaded copy
 * of this package is recognized on exactly the same terms as one constructed
 * here — `instanceof` answers false across two copies, which is the case this
 * has to survive. That is also why the `name` is checked rather than the class:
 * a second copy's constructor is a different function producing the same name.
 */
export function isFilesFatal(error: unknown): error is FilesFatalFailure {
  return (
    attempt(() => {
      const data = parseFilesFatal(error);
      if (data === undefined || !isError(error)) {
        return false;
      }
      if (property(error, "name") !== FATAL_NAMES.get(data.kind)) {
        return false;
      }
      if (property(error, "message") !== FATAL_DIAGNOSTICS.get(data.kind)) {
        return false;
      }
      if (property(error, "cause") !== undefined) {
        return false;
      }
      return hasOnlyContractMembers(error);
    }) === true
  );
}

/**
 * The infrastructure failure this one is, by identity.
 *
 * The original object comes back rather than a replacement, because a fail-stop
 * that records "the first error" has to record the one that was thrown.
 */
export function asFilesFatal(error: unknown): FilesFatalFailure | undefined {
  return isFilesFatal(error) ? error : undefined;
}

/**
 * What a write phase is allowed to say, which is the whole validity rule.
 *
 * The phase decides the target claim: nothing selects `committed` except a
 * cleanup that failed after the commit returned, and nothing claims
 * `commit-unknown` except a commit that threw. Keeping the table here rather
 * than at each construction site makes an invalid combination unconstructable
 * instead of merely unwritten.
 */
interface WritePhaseRule {
  readonly target: FileWriteTarget;
  readonly reason: "required" | "absent";
  readonly cleanup: "required" | "optional" | "absent";
}

const WRITE_PHASES: ReadonlyMap<FileWritePhase, WritePhaseRule> = new Map<
  FileWritePhase,
  WritePhaseRule
>([
  ["lexical", { target: "unchanged", reason: "required", cleanup: "absent" }],
  ["resolution", { target: "unchanged", reason: "required", cleanup: "absent" }],
  ["target", { target: "unchanged", reason: "required", cleanup: "absent" }],
  ["parents", { target: "unchanged", reason: "required", cleanup: "absent" }],
  ["temporary", { target: "unchanged", reason: "required", cleanup: "optional" }],
  ["commit", { target: "commit-unknown", reason: "required", cleanup: "optional" }],
  ["cleanup", { target: "committed", reason: "absent", cleanup: "required" }],
  ["transaction", { target: "rolled-back", reason: "required", cleanup: "absent" }],
]);

function writePhaseOf(value: unknown): [FileWritePhase, WritePhaseRule] | undefined {
  for (const entry of WRITE_PHASES) {
    if (entry[0] === value) {
      return entry;
    }
  }
  return undefined;
}

function violatesRule(
  rule: WritePhaseRule,
  reason: FilesReason | undefined,
  cleanup: FilesReason | undefined,
): boolean {
  if (rule.reason === "required" && reason === undefined) {
    return true;
  }
  if (rule.reason === "absent" && reason !== undefined) {
    return true;
  }
  if (rule.cleanup === "required" && cleanup === undefined) {
    return true;
  }
  return rule.cleanup === "absent" && cleanup !== undefined;
}

function writeData(
  phase: FileWritePhase,
  rule: WritePhaseRule,
  reason: FilesReason | undefined,
  cleanup: FilesReason | undefined,
): FileWriteFailureData {
  return Object.freeze({
    type: FILES_ERROR,
    operation: "write",
    phase,
    target: rule.target,
    ...(reason === undefined ? {} : { reason }),
    ...(cleanup === undefined ? {} : { cleanup }),
  });
}

/** Build an ordinary non-write failure. */
export function filesFailure(input: {
  operation: FilesOperation;
  phase: FilesPhase;
  reason: FilesReason;
}): FilesError {
  const operation = operationOf(input.operation);
  const phase = phaseOf(input.phase);
  const reason = reasonOf(input.reason);
  if (operation === undefined || phase === undefined || reason === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return new FilesError(Object.freeze({ type: FILES_ERROR, operation, phase, reason }));
}

/**
 * Build a write failure, refusing any combination a consumer could not read.
 *
 * A write's report is the only place a document learns what became of a file it
 * asked to replace, so an invalid combination is a provider bug rather than a
 * value to pass along and interpret later.
 */
export function fileWriteFailure(input: {
  phase: FileWritePhase;
  reason?: FilesReason;
  cleanup?: FilesReason;
}): FilesError {
  const found = writePhaseOf(input.phase);
  if (found === undefined) {
    throw new FilesInvariantError("protocol");
  }
  const [phase, rule] = found;

  const reason = input.reason === undefined ? undefined : reasonOf(input.reason);
  const cleanup = input.cleanup === undefined ? undefined : reasonOf(input.cleanup);
  if (
    (input.reason !== undefined && reason === undefined) ||
    (input.cleanup !== undefined && cleanup === undefined)
  ) {
    throw new FilesInvariantError("protocol");
  }
  if (violatesRule(rule, reason, cleanup)) {
    throw new FilesInvariantError("protocol");
  }

  return new FilesError(writeData(phase, rule, reason, cleanup));
}

/**
 * The non-write failure data this error carries, if it carries valid data.
 *
 * Malformed data is not fatal here — the consumer already has a sentence for
 * "the operation failed" and nothing about a target is at stake — so this
 * simply declines to recognize it.
 */
export function parseFilesFailure(error: unknown): FilesFailureData | undefined {
  return attempt(() => {
    const data = dataOf(error);
    if (data === undefined || property(data, "type") !== FILES_ERROR || keyCount(data) !== 4) {
      return undefined;
    }
    const operation = operationOf(property(data, "operation"));
    const phase = phaseOf(property(data, "phase"));
    const reason = reasonOf(property(data, "reason"));
    if (operation === undefined || phase === undefined || reason === undefined) {
      return undefined;
    }
    return Object.freeze({ type: FILES_ERROR, operation, phase, reason });
  });
}

/**
 * The write failure data this error carries, if it carries valid data.
 *
 * Unlike a non-write failure, malformed data here has no safe reading: every
 * sentence a consumer could print makes a claim about whether the file was
 * replaced. A caller treats `undefined` from a write as a protocol invariant
 * rather than inventing a commit state.
 */
export function parseFileWriteFailure(error: unknown): FileWriteFailureData | undefined {
  return attempt(() => {
    const data = dataOf(error);
    if (
      data === undefined ||
      property(data, "type") !== FILES_ERROR ||
      property(data, "operation") !== "write"
    ) {
      return undefined;
    }
    const found = writePhaseOf(property(data, "phase"));
    if (found === undefined) {
      return undefined;
    }
    const [phase, rule] = found;
    if (property(data, "target") !== rule.target) {
      return undefined;
    }

    const declared = property(data, "reason");
    const declaredCleanup = property(data, "cleanup");
    const reason = declared === undefined ? undefined : reasonOf(declared);
    const cleanup = declaredCleanup === undefined ? undefined : reasonOf(declaredCleanup);
    if (
      (declared !== undefined && reason === undefined) ||
      (declaredCleanup !== undefined && cleanup === undefined) ||
      violatesRule(rule, reason, cleanup)
    ) {
      return undefined;
    }

    const members = 4 + (reason === undefined ? 0 : 1) + (cleanup === undefined ? 0 : 1);
    if (keyCount(data) !== members) {
      return undefined;
    }

    return writeData(phase, rule, reason, cleanup);
  });
}

/** A successful write's outcome. */
export function fileWriteSuccess(publication: FileWriteSuccess["publication"]): FileWriteSuccess {
  const parsed = parseFileWriteSuccess({ type: FILES_WRITE_SUCCESS, publication });
  if (parsed === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return parsed;
}

/**
 * The write outcome this value is, if it is a valid one.
 *
 * A malformed success is as untrustworthy as a malformed failure: a provider
 * that cannot describe what it did may not have done it, so a caller treats
 * `undefined` here as a protocol invariant too.
 */
export function parseFileWriteSuccess(value: unknown): FileWriteSuccess | undefined {
  return attempt(() => {
    if (
      !isRecord(value) ||
      property(value, "type") !== FILES_WRITE_SUCCESS ||
      keyCount(value) !== 2
    ) {
      return undefined;
    }
    const publication = property(value, "publication");
    if (publication === "host-committed") {
      return Object.freeze({ type: FILES_WRITE_SUCCESS, publication: "host-committed" });
    }
    if (publication === "transaction-staged") {
      return Object.freeze({ type: FILES_WRITE_SUCCESS, publication: "transaction-staged" });
    }
    return undefined;
  });
}

/**
 * The document filesystem Api.
 *
 * The terminal handler throws for every operation, including `checkFilePath`.
 * A default that reached the host would make an uninstalled provider
 * indistinguishable from an installed one, and the whole point of the boundary
 * is that a workflow run cannot silently touch the caller's filesystem.
 */
export const Files: Api<FilesHandler> = createApi<FilesHandler>("executablemd.runtime.files", {
  // deno-lint-ignore require-yield
  *checkFilePath(_input: FilePathInput): Operation<Result<void>> {
    throw new FilesProviderUnavailableError();
  },
  // deno-lint-ignore require-yield
  *readTextFile(_input: FilePathInput): Operation<Result<string>> {
    throw new FilesProviderUnavailableError();
  },
  // deno-lint-ignore require-yield
  *writeTextFile(_input: FileWriteInput): Operation<Result<FileWriteSuccess>> {
    throw new FilesProviderUnavailableError();
  },
  // deno-lint-ignore require-yield
  *globFiles(_input: GlobInput): Operation<Result<string[]>> {
    throw new FilesProviderUnavailableError();
  },
  // deno-lint-ignore require-yield
  *temporaryDirectory(): Operation<Result<string>> {
    throw new FilesProviderUnavailableError();
  },
});
