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
  FilesInvariantError,
  parseFileWriteFailure,
  parseFileWriteSuccess,
} from "@executablemd/runtime";
import type {
  FilePathInput,
  FileWriteFailureData,
  FileWriteInput,
  FileWriteSuccess,
  GlobInput,
} from "@executablemd/runtime";
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

export function checkFilePath(input: FilePathInput): Operation<Result<void>> {
  return invokeFiles(Files.operations.checkFilePath(input));
}

export function readFileText(input: FilePathInput): Operation<Result<string>> {
  return invokeFiles(Files.operations.readTextFile(input));
}

export function writeFileText(input: FileWriteInput): Operation<Result<FileWriteSuccess>> {
  return invokeFiles(Files.operations.writeTextFile(input));
}

export function globFiles(input: GlobInput): Operation<Result<string[]>> {
  return invokeFiles(Files.operations.globFiles(input));
}

export function temporaryDirectory(): Operation<Result<string>> {
  return invokeFiles(Files.operations.temporaryDirectory());
}

/**
 * What a write reported, or a fatal failure if it reported nothing readable.
 *
 * A write is the one operation whose result makes a claim about the world: the
 * file was replaced, or it was not, or nobody can tell. Data that does not
 * validate leaves no safe sentence to print — every candidate asserts one of
 * those three — so a provider that cannot describe what it did is treated as
 * one that may not have done it. `undefined` is not a possible return.
 */
export function writeReport(result: Result<FileWriteSuccess>): FileWriteFailureData | undefined {
  if (result.ok) {
    if (parseFileWriteSuccess(result.value) === undefined) {
      throw new FilesInvariantError("protocol");
    }
    return undefined;
  }
  const failure = parseFileWriteFailure(result.error);
  if (failure === undefined) {
    throw new FilesInvariantError("protocol");
  }
  return failure;
}
