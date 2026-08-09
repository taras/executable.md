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
 * Read a member of a value the engine did not create.
 *
 * A `Result` is only conventionally a `Result`: what a provider actually
 * returned is an arbitrary runtime value, and reading `ok` on a Proxy that
 * refuses can throw. The type says otherwise, which is exactly why the check
 * belongs here — the signature is a claim about the provider, not a guarantee.
 */
function property(target: unknown, name: string): unknown {
  if (typeof target !== "object" || target === null) {
    return undefined;
  }
  try {
    return Reflect.get(target, name);
  } catch {
    return undefined;
  }
}

/**
 * Whether this really is a settled `Result`, and which way it settled.
 *
 * `undefined` means it is neither, which is a provider-contract failure rather
 * than an outcome: a value that will not say whether it succeeded cannot be
 * reported as either.
 */
function settlement(result: unknown): boolean | undefined {
  const ok = property(result, "ok");
  return typeof ok === "boolean" ? ok : undefined;
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
 * One non-write operation, with its whole outcome rebuilt from validated parts.
 *
 * Nothing a provider returned reaches a component: not the container, not the
 * error object, not the payload. A success is re-checked against the operation's
 * own payload contract and a failure is re-constructed from parsed data, so by
 * the time `<File>` or `<Glob>` reads `result.error` it is reading an object
 * this module made.
 *
 * A malformed *failure* is not fatal — the vocabulary already has a sentence for
 * an operation that failed for an unrecognized reason, and nothing about a
 * target is at stake — so it becomes the generic one and the document carries
 * on. A malformed *success* is fatal: a provider claiming an outcome it cannot
 * describe has not established the outcome.
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
  if (settled) {
    const payload = contract.payload(property(result, "value"));
    if (payload === undefined) {
      throw new FilesInvariantError("protocol");
    }
    return Ok(payload.value);
  }
  const data = parseFilesFailure(property(result, "error"));
  if (data === undefined || data.operation !== contract.operation) {
    return Err(generic(contract.operation, contract.phase));
  }
  return Err(filesFailure({ operation: data.operation, phase: data.phase, reason: data.reason }));
}

function nothing(value: unknown): { readonly value: void } | undefined {
  return value === undefined ? { value: undefined } : undefined;
}

function text(value: unknown): { readonly value: string } | undefined {
  return typeof value === "string" ? { value } : undefined;
}

/**
 * A search result, copied out of whatever the provider handed back.
 *
 * The array itself is rebuilt rather than passed along: a provider could return
 * something array-like whose elements are accessors, or one it goes on mutating
 * after the fact, and a document binds this value.
 */
function paths(value: unknown): { readonly value: string[] } | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const copied: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    copied.push(entry);
  }
  return { value: copied };
}

export function checkFilePath(input: FilePathInput): Operation<Result<void>> {
  return outcome(Files.operations.checkFilePath(input), {
    operation: "check-file-path",
    phase: "lexical",
    payload: nothing,
  });
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
    if (parseFileWriteSuccess(property(result, "value")) === undefined) {
      throw new FilesInvariantError("protocol");
    }
    return undefined;
  }
  const data = parseFileWriteFailure(property(result, "error"));
  if (data === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return parseFileWriteFailure(
    fileWriteFailure({ phase: data.phase, reason: data.reason, cleanup: data.cleanup }),
  );
}
