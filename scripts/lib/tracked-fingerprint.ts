/**
 * Every tracked path of a worktree, by content, mode, symlink target, or
 * absence.
 *
 * The index is the source of what "tracked" means — `git ls-files --stage`, not
 * a walk — so a file the worktree has and the index does not is invisible here,
 * and one the index has and the worktree does not is `absent` rather than
 * missing. Both are what a comparison of "did anything move" needs.
 *
 * This is the Deno half of the fingerprint, and lives beside the portable
 * `tracked.ts` rather than inside it: `lstat`, `readlink` and running `git`
 * belong on the host side of the boundary `tsconfig.node.json` draws. Two
 * callers need it — the interference proof in `verify.ts`, and the clean
 * harness in `verify-clean.ts`, which compares the same paths around a probe
 * that may have failed.
 */
import { sleep, until } from "effection";
import type { Operation } from "effection";
import { lstat } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { scoped } from "effection";
import type { Stats } from "node:fs";
import { readlink } from "node:fs/promises";
import { join } from "node:path";

import { digest, FileReads, YIELD_EVERY } from "./prepared-state.ts";
import type { ReadFile } from "./prepared-state.ts";
import { parseStageRecords, UnsupportedEntryError } from "./tracked.ts";
import type { TrackedEntry, TrackedState } from "./tracked.ts";

/** A missing entry, as `node:fs` reports one. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function* index(at: string): Operation<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  return yield* scoped(function* () {
    const process = yield* exec("git", { arguments: ["ls-files", "--stage", "-z"], cwd: at });
    yield* process.around({
      *stdout([bytes]) {
        chunks.push(decoder.decode(bytes, { stream: true }));
      },
      *stderr() {},
    });
    const status = yield* process.join();
    if (status.code !== 0) {
      throw new Error(`\`git ls-files --stage\` in ${at} exited ${status.code}`);
    }
    return chunks.join("");
  });
}

export function* describeEntry(at: string, path: string, read: ReadFile): Operation<TrackedEntry> {
  const absolute = join(at, path);
  let info: Stats;
  try {
    info = yield* lstat(absolute);
  } catch (error) {
    if (isNotFound(error)) {
      return { kind: "absent" };
    }
    throw error;
  }
  if (info.isDirectory()) {
    throw new UnsupportedEntryError(
      `${path} is a directory, which this fingerprint cannot describe`,
    );
  }
  if (info.isSymbolicLink()) {
    return { kind: "symlink", target: yield* until(readlink(absolute)) };
  }
  return {
    kind: "file",
    digest: digest(yield* read(absolute)),
    executable: ((info.mode ?? 0) & 0o111) !== 0,
  };
}

export function* trackedState(at: string): Operation<TrackedState> {
  const read = yield* FileReads.expect();
  const records = parseStageRecords(yield* index(at));
  const entries = new Map<string, TrackedEntry>();
  for (const [position, record] of records.entries()) {
    entries.set(record.path, yield* describeEntry(at, record.path, read));
    if (position % YIELD_EVERY === YIELD_EVERY - 1) {
      yield* sleep(0);
    }
  }
  return entries;
}
