/**
 * Test files that do not run under a given runtime.
 *
 * Discovery covers `tests/` beneath each workspace member plus `scripts/tests/`,
 * so a new test file there joins all three runtime jobs by default. Staying out
 * of one is a deliberate act, and this file is where that act is recorded and
 * reviewed.
 *
 * `scripts/tests/runtime-exclusions.test.ts` checks that each entry is
 * structurally sound — the path exists, discovery would have found it, it is
 * listed once per runtime, and it carries a reason and an issue. It cannot show
 * that an excluded test has since become portable: nothing re-runs excluded
 * files under Node or Bun. Removing a stale entry stays a manual act, prompted
 * by fixing the linked issue or by re-measuring the corpus.
 */

export interface RuntimeExclusion {
  path: string;
  reason: string;
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
  {
    path: "scripts/tests/cloudflare-dofs-vendor.test.ts",
    reason:
      "runs the no-network vendored-source verifier under the Deno executable against altered temporary snapshots",
    issue: "https://github.com/taras/executable.md/issues/365",
  },
  {
    path: "scripts/tests/build-web-client.test.ts",
    reason:
      "subject is scripts/build-web-client.ts, which runs `deno bundle` and calls Deno.execPath()/makeTempFile — Deno-only",
    issue: DERIVED_SCOPE,
  },
  {
    path: "scripts/tests/prepared-state.test.ts",
    reason:
      "fingerprints a prepared tree and a Deno cache through Deno.readDirSync/lstatSync and asks `deno info` where the caches are — Deno-only",
    issue: DERIVED_SCOPE,
  },
  {
    path: "scripts/tests/release-targets.test.ts",
    reason:
      "reads the release workflow beside the mapping module and asserts Deno task/compile argv; the subject is Deno's own release tooling",
    issue: DERIVED_SCOPE,
  },
  {
    path: "scripts/tests/verify-clean.test.ts",
    reason:
      "imports scripts/verify-clean.ts for the site proof's ordering, and that module reaches for Deno.env and Deno.execPath at import time; the ordering it asserts is host-neutral but the module carrying it is not",
    issue: "https://github.com/taras/executable.md/issues/279",
  },
  {
    path: "scripts/tests/verify-adapter.test.ts",
    reason:
      "drives the Deno half of `deno task verify` — spool handles through Deno.openSync, real child processes through Deno.execPath(), and a fingerprint built on Deno.lstatSync/readLinkSync; the coordinator it serves is covered portably by verify-coordinator.test.ts",
    issue: "https://github.com/taras/executable.md/issues/279",
  },
  {
    path: "scripts/tests/frozen-entry.test.ts",
    reason:
      "runs `deno task` against a copy of the working tree with Deno.execPath(); the tasks under test are Deno's",
    issue: DERIVED_SCOPE,
  },
  {
    path: "scripts/tests/publish-workflow-generator.test.ts",
    reason:
      "runs scripts/gen-publish-workflow.md through the xmd CLI with Deno.execPath(); the document is executed by Deno only",
    issue: DERIVED_SCOPE,
  },
  {
    path: "packages/workflow/tests/workflow-run-storage.test.ts",
    reason:
      "the subject is the Deno workflow-run storage adapter, which opens `node:sqlite` — available unflagged under Deno, and behind --experimental-sqlite on Node 22. The provider-neutral contracts it sits on are covered portably by workflow-definition.test.ts",
    issue: DERIVED_SCOPE,
  },
  {
    path: "packages/workflow/tests/workflow-run-journal.test.ts",
    reason:
      "the same Deno storage adapter, plus a restart proof that relaunches the run under the Deno executable; `node:sqlite` is behind --experimental-sqlite on Node 22",
    issue: DERIVED_SCOPE,
  },
  {
    path: "packages/workflow/tests/workspace-root.test.ts",
    reason:
      "exercises the Deno-private authoritative DOFS/SQLite adapter through node:sqlite, which remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/365",
  },
  {
    path: "packages/workflow/tests/workspace-root-restoration.test.ts",
    reason:
      "restores and corrupts real Deno-owned node:sqlite WorkflowRun databases; the provider mechanics are intentionally runtime-specific",
    issue: "https://github.com/taras/executable.md/issues/365",
  },
  {
    path: "packages/workflow/tests/workspace-transaction.test.ts",
    reason:
      "exercises Deno-private node:sqlite transaction identities and real SQLite savepoint failure behavior; node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/365",
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
