/**
 * One Git-owned component's own end of the Files chain.
 *
 * `<Dir>` asks for a directory through the same public operation it always
 * has, so middleware installed around Files still sees the request and may
 * observe, narrow, refuse or delegate it. What it may not do is answer: the
 * value the chain returns is never read, and the outcome comes from the
 * terminal the narrowed request finally reached.
 *
 * This is core's pattern for authored File mutations, in this package because
 * the component is this package's. Core gains no directory callback and no
 * dependency on Git for it.
 */

import { createApi } from "@effectionx/context-api";
import { Err } from "effection";
import type { Operation, Result } from "effection";
import {
  FILES_API,
  FilesInvariantError,
  FilesProviderUnavailableError,
} from "@executablemd/runtime";
import type {
  FilePathInput,
  FilesHandler,
  FileWriteInput,
  FileWriteSuccess,
  GlobInput,
} from "@executablemd/runtime";

/** What a directory request settled as, once the terminal accepted it. */
export type DirectoryOutcome = Result<void>;

/**
 * Ask for one directory through the public chain, and answer from the terminal.
 *
 * The request reaching the terminal is the one middleware finally allowed, and
 * it is parsed there rather than trusted: whatever narrowed it is outside this
 * component.
 */
export function* routeDirectory(
  input: FilePathInput,
  ensure: (final: FilePathInput) => Operation<DirectoryOutcome>,
): Operation<DirectoryOutcome> {
  let settled: DirectoryOutcome | undefined;
  let entered = false;
  const descriptor = createApi<FilesHandler>(FILES_API, {
    ...unreachable(),
    *ensureDirectory(final: FilePathInput): Operation<Result<void>> {
      // Consumed before anything is yielded to, so an overlapping or retained
      // continuation cannot enter a second time.
      if (entered) {
        throw new FilesInvariantError("protocol");
      }
      entered = true;
      const request = pathRequest(final);
      if (request === undefined) {
        throw new FilesInvariantError("protocol");
      }
      settled = yield* ensure(request);
      return settled;
    },
  });
  try {
    yield* descriptor.operations.ensureDirectory(input);
  } finally {
    entered = true;
  }
  if (settled === undefined) {
    // Nothing accepted this request, so nothing made the directory. A
    // middleware answer is not an outcome.
    return Err(new FilesInvariantError("protocol"));
  }
  return settled;
}

/** The path this request may actually be, against the Files input contract. */
function pathRequest(value: unknown): FilePathInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, "cwd") || !Object.hasOwn(value, "path")) {
    return undefined;
  }
  const cwd = Reflect.get(value, "cwd");
  const path = Reflect.get(value, "path");
  if (typeof cwd !== "string" || typeof path !== "string") {
    return undefined;
  }
  return Object.freeze({ cwd, path });
}

/** The members of this descriptor an invocation never enters. */
function unreachable() {
  // deno-lint-ignore require-yield
  function* refuse(): Operation<never> {
    throw new FilesProviderUnavailableError();
  }
  return {
    *checkFilePath(_input: FilePathInput): Operation<Result<void>> {
      return yield* refuse();
    },
    *readTextFile(_input: FilePathInput): Operation<Result<string>> {
      return yield* refuse();
    },
    *writeTextFile(_input: FileWriteInput): Operation<Result<FileWriteSuccess>> {
      return yield* refuse();
    },
    *deleteFile(_input: FilePathInput): Operation<Result<void>> {
      return yield* refuse();
    },
    *globFiles(_input: GlobInput): Operation<Result<string[]>> {
      return yield* refuse();
    },
    *temporaryDirectory(): Operation<Result<string>> {
      return yield* refuse();
    },
  };
}
