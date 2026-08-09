/**
 * The engine's one door to `API.Files`.
 *
 * Every document filesystem operation a component performs goes through here,
 * because the contract has a part no component can enforce on its own: a
 * provider is allowed to *fail*, and it is not allowed to *throw*. An ordinary
 * filesystem condition comes back as `Err` with structural data; anything that
 * throws is an installation or provider-contract failure and must end the
 * execution rather than become something a document renders.
 *
 * Deciding that in one place is what makes the rule hold. A component that
 * caught a throw would have to guess whether the thing it caught was safe to
 * report, and an error's class is no evidence about its message — which is
 * exactly the guess `<File>` and `<Glob>` already refuse to make about the
 * platform.
 *
 * This lives in core rather than in the runtime package because the ordering
 * below reaches durability failures, which belong to `@executablemd/durable-
 * streams`. Core already depends on both; the runtime must not acquire a
 * dependency on durable-streams to answer a question only the engine asks.
 */

import {
  Files,
  FilesError,
  filesFailure,
  FilesInvariantError,
  fileWriteFailure,
  parseFileWriteFailure,
  parseFileWriteSuccess,
  parseFilesFailure,
} from "@executablemd/runtime";
import type {
  FilePathInput,
  FilesOperation,
  FilesPhase,
  FileWriteFailureData,
  FileWriteInput,
  GlobInput,
} from "@executablemd/runtime";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { durabilityFailure, filesFatalFailure } from "./errors.ts";

/**
 * Perform one provider call, converting an illegal throw into a failure the
 * engine already knows how to fence.
 *
 * The search order is the one thing here that is not obvious. A provider call
 * can happen underneath work that has *already* failed — a durability failure
 * unwinding through a component's teardown, or a Files failure from a nested
 * operation — and the first failure is the one that describes what went wrong.
 * Replacing it with a fresh invariant would report the symptom and lose the
 * cause, and for a durability failure it would also lose the identity that
 * #394's fail-stop records as "the first error".
 *
 * So: an existing durability failure is rethrown as it stands, then an existing
 * Files infrastructure failure, and only something that is neither becomes a new
 * `protocol` invariant. That last one carries no cause, message, errno text, or
 * host value — a handler that threw an arbitrary object is precisely the case
 * where nothing it produced can be trusted.
 *
 * Cancellation does not arrive here. Halting resumes a generator through
 * `return()` rather than by throwing, so no `catch` in Effection converts a
 * cancellation into a failure.
 */
export function* invokeFiles<T>(call: Operation<T>): Operation<T> {
  try {
    return yield* call;
  } catch (error) {
    throw (
      durabilityFailure(error) ?? filesFatalFailure(error) ?? new FilesInvariantError("protocol")
    );
  }
}

/**
 * Whether a member is there at all, or `undefined` when asking threw.
 *
 * Asked separately from reading it, because absence and unreadability are
 * different answers and only one of them is ever legitimate. A `has` trap can
 * refuse the question, which is why even this is total.
 */
function present(target: unknown, name: string): boolean | undefined {
  if (typeof target !== "object" || target === null) {
    return undefined;
  }
  try {
    return Reflect.has(target, name);
  } catch {
    return undefined;
  }
}

/**
 * A member of a value the engine did not create, or `undefined` when it is
 * absent or reading it threw.
 *
 * A `Result` is only conventionally a `Result`: what a provider actually
 * returned is an arbitrary runtime value, and reading `ok` on a Proxy that
 * refuses can throw. The type says otherwise, which is exactly why the check
 * belongs here — the signature is a claim about the provider, not a guarantee.
 *
 * The value comes back boxed so that a member which really is `undefined` is
 * distinguishable from one that could not be read. Collapsing those is how a
 * container that never described its outcome gets mistaken for one that
 * described an empty one.
 */
function read(target: unknown, name: string): { readonly value: unknown } | undefined {
  if (present(target, name) !== true) {
    return undefined;
  }
  try {
    return { value: Reflect.get(Object(target), name) };
  } catch {
    return undefined;
  }
}

/**
 * How a `Result` settled, or `undefined` when it will not say.
 *
 * A value that does not describe its own outcome cannot be reported as either
 * one, so `undefined` here is a provider-contract failure rather than a result.
 */
function settlement(result: unknown): boolean | undefined {
  const ok = read(result, "ok");
  return typeof ok?.value === "boolean" ? ok.value : undefined;
}

/**
 * The generic failure a non-write operation falls back to.
 *
 * Built fresh from this operation's own identity rather than from anything the
 * provider returned, so the sentence a document reads is the one the vocabulary
 * already has for "the filesystem operation failed" — and nothing the provider
 * put in its place travels with it.
 */
function generic(operation: FilesOperation, phase: FilesPhase): FilesError {
  return filesFailure({ operation, phase, reason: "operation-failed" });
}

/**
 * The failure half of a non-write outcome, rebuilt from validated parts.
 *
 * The two unreadable cases are not the same as the unrecognized one. A
 * container whose `error` is absent or refuses to be read never described what
 * went wrong, and there is nothing to report — that is a provider-contract
 * failure. An `error` that reads fine but carries data the vocabulary does not
 * recognize *did* describe a failure, just not one this version knows: the
 * generic sentence covers it and the document carries on.
 */
function failure(result: unknown, operation: FilesOperation, phase: FilesPhase): Result<never> {
  const reported = read(result, "error");
  if (reported === undefined) {
    throw new FilesInvariantError("protocol");
  }
  const data = parseFilesFailure(reported.value);
  if (data === undefined || data.operation !== operation) {
    return Err(generic(operation, phase));
  }
  return Err(filesFailure({ operation: data.operation, phase: data.phase, reason: data.reason }));
}

/**
 * One non-write operation whose success carries a payload, with its whole
 * outcome rebuilt from validated parts.
 *
 * Nothing a provider returned reaches a component: not the container, not the
 * error object, not the payload. By the time `<File>` or `<Glob>` reads
 * `result.error` it is reading an object this module made.
 */
function* outcome<T>(
  call: Operation<unknown>,
  contract: {
    operation: FilesOperation;
    phase: FilesPhase;
    payload: (value: unknown) => { readonly value: T } | undefined;
  },
): Operation<Result<T>> {
  const result = yield* invokeFiles(call);
  const settled = settlement(result);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (!settled) {
    return failure(result, contract.operation, contract.phase);
  }
  const carried = read(result, "value");
  if (carried === undefined) {
    throw new FilesInvariantError("protocol");
  }
  const payload = contract.payload(carried.value);
  if (payload === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return Ok(payload.value);
}

function text(value: unknown): { readonly value: string } | undefined {
  return typeof value === "string" ? { value } : undefined;
}

/**
 * A search result, copied out of whatever the provider handed back.
 *
 * Every step of the copy is provider-controlled: iterator lookup, `length`, and
 * each element are all trappable, so the walk is by index through the same
 * total reader rather than by `for…of`. `undefined` from any of them is a
 * refusal to describe the result, which the caller turns into one fixed
 * invariant.
 *
 * The array itself is rebuilt rather than passed along. A provider could return
 * something array-shaped whose elements are accessors, or one it goes on
 * mutating afterwards — and a document binds this value.
 */
function paths(value: unknown): { readonly value: string[] } | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const length = read(value, "length");
  if (typeof length?.value !== "number" || !Number.isInteger(length.value) || length.value < 0) {
    return undefined;
  }
  const copied: string[] = [];
  for (let index = 0; index < length.value; index++) {
    const entry = read(value, String(index));
    if (typeof entry?.value !== "string") {
      return undefined;
    }
    copied.push(entry.value);
  }
  return { value: copied };
}

/**
 * Whether this authored path is admissible, with nothing usable coming back.
 *
 * The success carries no payload, and Effection spells that as its shared
 * `Unit` — `{ ok: true }`, with no `value` member at all. So an **absent**
 * `value` is the ordinary successful answer here, and this is the one operation
 * where that is true. What is still refused is a `value` that cannot be read,
 * and one that is present but is something other than `undefined`: the first
 * means the container never described its outcome, and the second means it
 * described one this operation does not have.
 */
export function* checkFilePath(input: FilePathInput): Operation<Result<void>> {
  const result = yield* invokeFiles(Files.operations.checkFilePath(input));
  const settled = settlement(result);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (!settled) {
    return failure(result, "check-file-path", "lexical");
  }
  const carried = present(result, "value");
  if (carried === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (carried) {
    // Present, so it has to be readable *and* be the absent payload. Asking
    // only whether the value is `undefined` would let a member that refused to
    // be read pass as one that read as nothing.
    const value = read(result, "value");
    if (value === undefined || value.value !== undefined) {
      throw new FilesInvariantError("protocol");
    }
  }
  return Ok(undefined);
}

export function readFileText(input: FilePathInput): Operation<Result<string>> {
  return outcome(Files.operations.readTextFile(input), {
    operation: "read",
    phase: "access",
    payload: text,
  });
}

export function globFiles(input: GlobInput): Operation<Result<string[]>> {
  return outcome(Files.operations.globFiles(input), {
    operation: "glob",
    phase: "traversal",
    payload: paths,
  });
}

export function temporaryDirectory(): Operation<Result<string>> {
  return outcome(Files.operations.temporaryDirectory(), {
    operation: "temporary-directory",
    phase: "acquire",
    payload: text,
  });
}

/**
 * What a write reported, or nothing when it succeeded.
 *
 * A write is the one operation whose outcome makes a claim about the world: the
 * file was replaced, or it was not, or nobody can tell. Every sentence a
 * consumer could print asserts one of those, so an outcome that does not
 * validate leaves none of them available — and a provider that cannot describe
 * what it did is treated as one that may not have done it. Both a malformed
 * success and a malformed failure are therefore fatal, and so is a container
 * that will not say which it is.
 *
 * The data that comes back is rebuilt from validated parts, like every other
 * outcome here.
 */
export function* writeFileText(input: FileWriteInput): Operation<FileWriteFailureData | undefined> {
  const result = yield* invokeFiles(Files.operations.writeTextFile(input));
  const settled = settlement(result);
  if (settled === undefined) {
    throw new FilesInvariantError("protocol");
  }
  if (settled) {
    const carried = read(result, "value");
    if (carried === undefined || parseFileWriteSuccess(carried.value) === undefined) {
      throw new FilesInvariantError("protocol");
    }
    return undefined;
  }
  const reported = read(result, "error");
  if (reported === undefined) {
    throw new FilesInvariantError("protocol");
  }
  const data = parseFileWriteFailure(reported.value);
  if (data === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return parseFileWriteFailure(
    fileWriteFailure({ phase: data.phase, reason: data.reason, cleanup: data.cleanup }),
  );
}
