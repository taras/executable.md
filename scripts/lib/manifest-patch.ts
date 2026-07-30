/**
 * A temporary edit to a file on disk that survives cancellation.
 *
 * `ensure()` alone does not make a temporary edit safe. `@effectionx/fs`'s
 * `writeTextFile` adapts a promise with `until()`, and `until()` only stops
 * *observing* that promise when the surrounding scope is halted — the write
 * behind it keeps running. A restore issued from `ensure()` therefore races the
 * patch it is undoing, and losing that race leaves the patch on disk
 * permanently.
 *
 * Cleanup has to wait for the in-flight write before restoring, and waiting on
 * it means holding it. No `@effectionx/fs` operation hands its promise back, so
 * this module calls `node:fs/promises` directly; it is the only place in the
 * build that does, and `WriteFile` is the seam through which a test drives a
 * write that has started and not yet settled.
 */
import { createContext, ensure, until } from "effection";
import type { Context, Operation } from "effection";
import { writeFile } from "node:fs/promises";

export type WriteFile = (path: URL, contents: string) => Promise<void>;

export const FileWrites: Context<WriteFile> = createContext<WriteFile>(
  "manifest-patch.file-writes",
  (path, contents) => writeFile(path, contents),
);

/** Settles when `promise` does, whether it resolves or rejects. */
function settled(promise: Promise<unknown>): Operation<void> {
  return until(promise.then(ignore, ignore));
}

function ignore(): void {}

/**
 * Replace `path`'s contents with `replacement` for the rest of the current
 * scope, then put `original` back.
 *
 * The restore runs on every exit path — return, error, and halt — and on the
 * halt path it first waits for the patching write to settle, so the bytes that
 * land last are always `original`.
 */
export function* patchUntilExit(path: URL, original: string, replacement: string): Operation<void> {
  const write = yield* FileWrites.expect();

  let patching: Promise<unknown> = Promise.resolve();
  yield* ensure(function* () {
    yield* settled(patching);
    yield* until(write(path, original));
  });

  patching = write(path, replacement);
  yield* until(patching);
}
