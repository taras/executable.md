import { each } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, toPath, walk } from "@effectionx/fs";
import { listWorkspacePaths } from "./workspace.ts";
import { exclusions } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";

const EXTRA_MEMBERS = ["scripts"];

interface RootManifest {
  workspace: string[];
}

function parseWorkspace(source: string): RootManifest {
  return JSON.parse(source);
}

/**
 * Every test file in the repository, as sorted repository-relative POSIX paths.
 *
 * Discovery covers `tests/` beneath each workspace member and `scripts/tests/`,
 * and nothing else. Walking those concrete directories rather than the
 * repository root is what keeps nested worktrees, `site`, and the deliberately
 * malformed `scripts/tests/fixtures` out without naming any of them.
 */
export function* listTestFiles(root: URL): Operation<string[]> {
  const { workspace } = parseWorkspace(yield* readTextFile(new URL("deno.json", root)));
  const members = [...(yield* listWorkspacePaths(workspace, root)), ...EXTRA_MEMBERS];

  const files: string[] = [];
  for (const member of members) {
    const tests = new URL(`${member}/tests/`, root);
    if (!(yield* exists(tests))) {
      continue;
    }
    for (const entry of yield* each(
      walk(tests, { includeDirs: false, match: [/\.test\.ts$/], skip: [/node_modules/] }),
    )) {
      files.push(`${member}/tests/${within(toPath(tests), entry.path)}`);
      yield* each.next();
    }
  }
  return files.sort();
}

/**
 * The test files `runtime` runs: everything discovery finds, minus that
 * runtime's recorded exclusions, still sorted.
 *
 * This is the one derivation all three runtimes share. Reading discovery and
 * the manifest separately at each call site is how a runtime comes to run a
 * corpus nobody weighed or partitioned.
 */
export function* applicableTestFiles(runtime: Runtime, root: URL): Operation<string[]> {
  const skip = new Set(exclusions[runtime].map((entry) => entry.path));
  return (yield* listTestFiles(root)).filter((file) => !skip.has(file));
}

function posix(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * `path` relative to `directory`, as POSIX.
 *
 * Compares filesystem paths rather than a URL pathname: on Windows those
 * disagree — `/C:/repo/tests/` against `C:\repo\tests\file.ts` — and a naive
 * match yields an absolute path while claiming to be repository-relative.
 * Anything outside `directory` is a discovery bug, so it throws rather than
 * silently returning an absolute path.
 */
function within(directory: string, path: string): string {
  const base = posix(directory).replace(/\/*$/, "/");
  const target = posix(path);
  if (!target.startsWith(base)) {
    throw new Error(`walked ${target}, which is outside ${base}`);
  }
  return target.slice(base.length);
}

/** Exported for the boundary tests; `listTestFiles` is the supported entry. */
export const relativeWithin = within;
