import { ensure, type Operation } from "effection";
import { rm } from "@effectionx/fs";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The directory has to exist before the destructor that removes it is
 * registered, and nothing may suspend in between: a halt landing in that gap
 * leaves the directory behind with no one left to remove it.
 */
export function* scratch(prefix: string): Operation<string> {
  // oxlint-disable-next-line local/no-sync-filesystem
  const directory = mkdtempSync(join(tmpdir(), prefix));
  yield* ensure(function* () {
    yield* rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** The suppression above covers its own line and nothing else. */
export function seed(directory: string): Uint8Array {
  return readFileSync(join(directory, "seed"));
}
