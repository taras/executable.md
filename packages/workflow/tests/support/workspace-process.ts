/**
 * What the crash and restart processes and the test that drives them agree on.
 *
 * The helpers below are imported by a child process and by the suite that
 * launches it, so this module starts nothing: a child's `main()` lives in the
 * child's own file, and importing a constant from it would run the child
 * inside the test.
 */

import type { Operation } from "effection";
import type { DenoWorkspaceFilesystem } from "../../src/deno/workspace/filesystem.ts";

/** The mutation the killed process performs, and never publishes. */
export const CRASH_PATH = "/crash.txt";
export const CRASH_CONTENT = "bytes that must never be published";
export const CRASH_EFFECT = "crash-before-commit";

/** The baseline the crash runs against, committed before the child starts. */
export const BASELINE_PATH = "/baseline.txt";
export const BASELINE_CONTENT = "committed baseline bytes";
export const NESTED_PATH = "/kept/nested.txt";
export const NESTED_CONTENT = "nested baseline bytes";
export const BASELINE_EFFECT = "baseline";
export const BASELINE_CLOCK = 1_750_000_000_000;

/** The two committed effects of the restart proof, and what the first retains. */
export const SEED_CLOCK = 10_000;
export const REVISE_CLOCK = 20_000;
export const HISTORICAL_PATH = "/tree/file.txt";
export const HISTORICAL_CONTENT = "historical bytes";

/** A SQLite count, which arrives as a `bigint` from a read that asked for one. */
export function count(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

/** Everything the Workspace holds, as one comparable value. */
export function* readTree(
  filesystem: DenoWorkspaceFilesystem,
  directory: string,
): Operation<Record<string, unknown>> {
  const tree: Record<string, unknown> = {};
  for (const entry of yield* filesystem.readdir(directory)) {
    const path = directory === "/" ? `/${entry.name}` : `${directory}/${entry.name}`;
    const stat = yield* filesystem.lstat(path);
    if (entry.kind === "directory") {
      tree[path] = { kind: "directory", mode: stat.mode, mtime: stat.mtime };
      Object.assign(tree, yield* readTree(filesystem, path));
    } else if (entry.kind === "symlink") {
      tree[path] = { kind: "symlink", target: yield* filesystem.readlink(path) };
    } else {
      tree[path] = {
        kind: "file",
        mode: stat.mode,
        mtime: stat.mtime,
        size: stat.size,
        content: yield* filesystem.readTextFile(path),
      };
    }
  }
  return tree;
}

/** One line of JSON on standard output is the whole protocol with the parent. */
export function report(value: unknown): void {
  console.log(JSON.stringify(value));
}
