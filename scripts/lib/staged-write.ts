/**
 * Replace a file through a staging copy of this invocation's own.
 *
 * Two hazards, one mechanism.
 *
 * The staged name carries a UUID because the file being replaced is shared:
 * two preparations running at once, in two worktrees or two terminals, would
 * otherwise stage to the same path, and one would delete the other's file
 * mid-write.
 *
 * Cleanup waits for the staging write before removing it. `@effectionx/fs`
 * writes through a promise adapted with `until()`, and halting stops
 * *observing* that promise rather than the write behind it — so a removal
 * issued from `ensure()` races the write it is undoing, and losing that race
 * leaves the staged file on disk forever. Waiting on the write means holding
 * it, and no `@effectionx/fs` operation hands its promise back, so this module
 * calls `node:fs/promises` directly. `FileWrites` is the seam through which a
 * test drives a write that has started and not yet settled.
 *
 * The rename is what makes the replacement atomic: a reader opening the target
 * sees every old byte or every new one, never a truncated file.
 */
import { createContext, ensure, scoped, until } from "effection";
import type { Context, Operation } from "effection";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";

export type WriteFile = (path: URL, contents: string) => Promise<void>;

export const FileWrites: Context<WriteFile> = createContext<WriteFile>(
  "staged-write.file-writes",
  (path, contents) => writeFile(path, contents),
);

/** Settles when `promise` does, whether it resolves or rejects. */
function settled(promise: Promise<unknown>): Operation<void> {
  return until(promise.then(ignore, ignore));
}

function ignore(): void {}

function stagedPath(path: URL): URL {
  const name = path.pathname.split("/").pop();
  return new URL(`${name}.${crypto.randomUUID()}.staged`, path);
}

/**
 * Write `contents` over `path`, staging it beside the target first.
 *
 * The staged file belongs to this invocation on every exit path — return,
 * error, and halt — and a concurrent invocation's staging is never touched.
 */
export function* replaceThroughStaging(path: URL, contents: string): Operation<void> {
  const write = yield* FileWrites.expect();
  const staged = stagedPath(path);

  let staging: Promise<unknown> = Promise.resolve();
  yield* ensure(function* () {
    yield* settled(staging);
    yield* until(rm(staged, { force: true }));
  });

  staging = write(staged, contents);
  yield* until(staging);
  yield* until(rename(staged, path));
}

function present(path: URL): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Replace the directory `path` with exactly `files`, staged beside it.
 *
 * Two renames swap the directories, so a reader never sees a partial set. Every
 * host call is held in `pending` until it settles; teardown then reads the
 * filesystem rather than flags, because a rename this invocation stopped
 * observing may still have completed. A moved-aside previous directory returns
 * unless the complete replacement is already in place.
 */
export function replaceDirectoryThroughStaging(
  path: URL,
  files: Readonly<Record<string, string>>,
): Operation<void> {
  return scoped(function* () {
    const write = yield* FileWrites.expect();
    const name = path.pathname.split("/").pop();
    const id = crypto.randomUUID();
    const staged = new URL(`${name}.${id}.staged`, path);
    const previous = new URL(`${name}.${id}.previous`, path);

    let pending: Promise<unknown> = Promise.resolve();
    yield* ensure(function* () {
      yield* settled(pending);
      if (yield* until(present(previous))) {
        if (yield* until(present(path))) {
          yield* until(rm(previous, { recursive: true, force: true }));
        } else {
          yield* until(rename(previous, path));
        }
      }
      yield* until(rm(staged, { recursive: true, force: true }));
    });

    pending = mkdir(staged);
    yield* until(pending);
    for (const file of Object.keys(files).sort()) {
      if (!/^[A-Za-z0-9_.-]+$/.test(file)) {
        throw new Error(`Unexpected staged file name: ${file}`);
      }
      pending = write(new URL(`${name}.${id}.staged/${file}`, path), files[file]!);
      yield* until(pending);
    }
    if (yield* until(present(path))) {
      pending = rename(path, previous);
      yield* until(pending);
    }
    pending = rename(staged, path);
    yield* until(pending);
  });
}
