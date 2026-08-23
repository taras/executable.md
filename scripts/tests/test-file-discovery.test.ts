/**
 * Discovery is the one place the corpus comes from, and every runtime's shard
 * assignment is a partition of what it returns. A test file discovery cannot
 * see is therefore a test that runs nowhere — not under one runtime, but under
 * none — and nothing else in the repository would notice.
 *
 * So this walks the whole repository with Deno's own documented test-file
 * pattern and holds the two results to each other. It prunes what is outside
 * the repository's source: Git's own state and any nested checkout, installed
 * dependencies, generated and vendored trees, build output, and the
 * deliberately malformed fixtures.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { each } from "effection";
import type { Operation } from "effection";
import { walk } from "@effectionx/fs";
import type { WalkEntry } from "@effectionx/fs";

import { listTestFiles } from "../lib/test-files.ts";

const ROOT = new URL("../../", import.meta.url);

/**
 * What `deno test` discovers with no path arguments: `*.test.*`, `*_test.*`,
 * and a bare `test.*`, in each of the extensions it runs.
 */
const DENO_TEST_FILE = /(?:^|\/)(?:test|.+[._]test)\.(?:js|mjs|ts|mts|jsx|tsx)$/;

/** Trees that belong to a tool rather than to this repository's source. */
const OUTSIDE_NAMES = new Set([".git", "node_modules", "npm", ".xmd-eval", "dist", "_fresh"]);

/** Trees this repository owns but does not author. */
const OUTSIDE_PATHS = new Set([
  "scripts/tests/fixtures",
  "packages/web/generated",
  "packages/workflow/vendor",
  "site/vendor",
]);

function* entriesOf(directory: URL): Operation<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  for (const entry of yield* each(walk(directory, { maxDepth: 0 }))) {
    entries.push(entry);
    yield* each.next();
  }
  return entries;
}

/**
 * Every path matching Deno's pattern beneath `relative`, pruning as it goes.
 *
 * `@effectionx/fs`'s own `skip` filters results without pruning traversal, so a
 * whole-repository walk through it would descend into `node_modules` and `.git`
 * to discard what it found there. Recursing by hand is what keeps this cheap.
 */
function* walkTestFiles(root: URL, relative: string, found: string[]): Operation<void> {
  const entries = yield* entriesOf(relative === "" ? root : new URL(`${relative}/`, root));

  // A directory carrying its own `.git` is another checkout — a worktree, a
  // clone a test left behind — and its tests are that repository's, not this
  // one's.
  if (relative !== "" && entries.some((entry) => entry.name === ".git")) {
    return;
  }

  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory) {
      if (!OUTSIDE_NAMES.has(entry.name) && !OUTSIDE_PATHS.has(path)) {
        yield* walkTestFiles(root, path, found);
      }
    } else if (entry.isFile && DENO_TEST_FILE.test(entry.name)) {
      found.push(path);
    }
  }
}

function* repositoryTestFiles(): Operation<string[]> {
  const found: string[] = [];
  yield* walkTestFiles(ROOT, "", found);
  return found.sort();
}

describe("the discovered corpus against the whole repository", () => {
  it("matches Deno's test-file pattern exactly", function* () {
    const walked = yield* repositoryTestFiles();
    const discovered = yield* listTestFiles(ROOT);

    // A walk that pruned too much would agree with discovery by finding
    // nothing, so it has to have found the corpus first.
    expect(walked).toContain("scripts/tests/test-file-discovery.test.ts");
    expect(walked.length).toBeGreaterThan(100);

    expect(walked).toEqual(discovered);
  });

  /**
   * Named separately from the equality above, because this is the direction
   * that matters: a file the walk found and discovery did not is a test no
   * runtime would ever run.
   */
  it("leaves no test file outside discovery's result", function* () {
    const discovered = new Set(yield* listTestFiles(ROOT));
    const stranded = (yield* repositoryTestFiles()).filter((file) => !discovered.has(file));

    expect(stranded).toEqual([]);
  });

  it("recognizes every spelling Deno runs", function* () {
    for (const name of ["a.test.ts", "a_test.ts", "test.ts", "a.test.tsx", "a.test.mjs"]) {
      expect(DENO_TEST_FILE.test(name)).toBe(true);
    }
    for (const name of ["tests.ts", "atest.ts", "test.md", "a.test.json", "contest.ts"]) {
      expect(DENO_TEST_FILE.test(name)).toBe(false);
    }
  });
});
