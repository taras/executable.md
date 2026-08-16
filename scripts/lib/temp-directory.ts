import { rm } from "@effectionx/fs";
import { ensure, resource } from "effection";
import type { Operation } from "effection";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A directory this script owns, removed when its scope ends.
 *
 * Creation is synchronous so that nothing can suspend between it and the
 * `ensure` that removes it. `until()` cannot cancel the promise it waits on, so
 * an asynchronous `mkdtemp` halted mid-flight would go on to create a directory
 * after the generator had already stopped — one nothing owns and nothing
 * removes. `mkdtemp` names and creates at once, so the directory is never one
 * an earlier run left behind.
 *
 * `dir` places the directory somewhere other than the system temporary
 * directory, which a task granting write to one path alone has to do. Anything
 * else the caller wants — canonicalizing the path, populating the tree — is
 * ordinary work and belongs in an operation of its own.
 *
 * `packages/test-support` carries the same lifetime for suites; scripts do not
 * depend on test support and packages do not depend on scripts, so the
 * invariant is stated once on each side of that boundary.
 */
export function useTempDirectory(
  prefix: string,
  options: { dir?: string } = {},
): Operation<string> {
  return resource(function* (provide) {
    // oxlint-disable-next-line local/no-sync-filesystem
    const directory = mkdtempSync(join(options.dir ?? tmpdir(), prefix));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    yield* provide(directory);
  });
}
