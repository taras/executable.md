import { rm } from "@effectionx/fs";
import { ensure, resource } from "effection";
import type { Operation } from "effection";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A directory of this scope's own, removed when the scope ends.
 *
 * Creation is synchronous so that nothing can suspend between it and the
 * `ensure` that removes it. `until()` cannot cancel the promise it waits on, so
 * an asynchronous `mkdtemp` halted mid-flight would go on to create a directory
 * after the generator had already stopped — one nothing owns and nothing
 * removes. `mkdtemp` names and creates at once, so the directory is never one
 * an earlier run left behind.
 *
 * Suites take their scratch space from here rather than each acquiring one of
 * their own, so the invariant is stated once and the removal cannot be
 * forgotten in a suite that returns early.
 */
export function useTempDirectory(prefix: string): Operation<string> {
  return resource(function* (provide) {
    // oxlint-disable-next-line local/no-sync-filesystem
    const directory = mkdtempSync(join(tmpdir(), prefix));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    yield* provide(directory);
  });
}
