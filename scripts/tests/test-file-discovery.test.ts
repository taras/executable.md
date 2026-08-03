import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { each } from "effection";
import { toPath, walk } from "@effectionx/fs";

import { listTestFiles } from "../lib/test-files.ts";

const repoRoot = new URL("../../", import.meta.url);

/** What `deno test` discovers when it is given a directory. */
const DENO_TEST_GLOB = /(?:^|\/)(?:[^/]*[_.])?test\.(?:js|mjs|ts|mts|jsx|tsx)$/;

/** Directories that hold no repository source: dependencies, build output, checkouts. */
const SKIP = [/node_modules/, /\.git\//, /\/dist\//, /\/npm\//, /\.claude\/worktrees\//];

/**
 * One discovery, or none.
 *
 * CI hands explicit file lists to all three runners, so `listTestFiles` decides
 * the corpus and Deno's own directory walk is no longer consulted anywhere.
 * That is only safe while the two would agree — a test file outside the walked
 * directories would run under Deno's discovery and under nothing here, which is
 * the coverage drift the shared corpus exists to prevent.
 */
describe("test discovery", () => {
  it("finds every file in the repository that Deno's test glob would", function* () {
    const discovered = new Set(yield* listTestFiles(repoRoot));
    const root = toPath(repoRoot);

    const missed: string[] = [];
    for (const entry of yield* each(walk(repoRoot, { includeDirs: false, skip: SKIP }))) {
      const relative = toPath(entry.path).slice(root.length);
      if (DENO_TEST_GLOB.test(relative) && !discovered.has(relative)) {
        missed.push(relative);
      }
      yield* each.next();
    }

    expect(missed).toEqual([]);
  });
});
