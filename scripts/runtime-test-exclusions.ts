/**
 * Test files that do not run under a given runtime.
 *
 * Discovery covers every `*.test.ts` in the repository, so a new test joins all
 * three runtime jobs by default. Staying out of one is a deliberate act, and
 * this file is where that act is recorded and reviewed.
 *
 * `scripts/tests/runtime-exclusions.test.ts` checks that each entry is
 * structurally sound — the path exists, discovery would have found it, it is
 * listed once per runtime, and it carries a reason and an issue. It cannot show
 * that an excluded test has since become portable: nothing re-runs excluded
 * files under Node or Bun. Removing a stale entry stays a manual act, prompted
 * by fixing the linked issue or by re-measuring the corpus.
 */

export interface RuntimeExclusion {
  /** Repository-relative path, as `listTestFiles` reports it. */
  path: string;
  /** Why this file cannot run under this runtime. */
  reason: string;
  /** Where the exclusion is argued. */
  issue: string;
}

/** Issue #144 is the decision record for excluding a test from a runtime. */
const DERIVED_SCOPE = "https://github.com/taras/executable.md/issues/144";

const DENO_ONLY_TOOLING: RuntimeExclusion[] = [
  {
    path: "scripts/tests/build-npm.test.ts",
    reason:
      "subject is scripts/build-npm.ts, a dnt build that only runs under Deno; the test calls Deno.execPath()",
    issue: DERIVED_SCOPE,
  },
  {
    path: "scripts/tests/cli-npm-bin.test.ts",
    reason:
      "builds the npm package with dnt, which only runs under Deno; the test calls Deno.readTextFileSync",
    issue: DERIVED_SCOPE,
  },
];

/**
 * Node and Bun are keyed separately because they diverge — Bun imports a data:
 * URI that Node's tsx loader rejects, for one. They happen to agree today.
 */
export const exclusions: Record<string, RuntimeExclusion[]> = {
  node: DENO_ONLY_TOOLING,
  bun: DENO_ONLY_TOOLING,
};
