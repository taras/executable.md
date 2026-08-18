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
    path: "scripts/tests/readme-targets.test.ts",
    reason:
      "runs the repository's own README through the source CLI with Deno.execPath() and a temporary `deno` shim; the subject is this Deno task graph, and the portable target mechanism is covered by Tier CT",
    issue: "https://github.com/taras/executable.md/issues/414",
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
  {
    path: "packages/core/tests/loaded-copy-files.test.ts",
    reason:
      "builds the second copy of the runtime's Files module with `deno bundle`, which is Deno's; the structural recognition it proves is runtime-neutral and is also covered by fatal-cause.test.ts under all three",
    issue: DERIVED_SCOPE,
  },
  {
    path: "packages/workflow/tests/workspace-effect-transaction.test.ts",
    reason:
      "proves Deno-private atomic Workspace coordination against the authoritative node:sqlite and DOFS adapter; node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/365",
  },
  {
    path: "packages/workflow/tests/workspace-effect-loaded-copy.test.ts",
    reason:
      "creates and imports a physical temporary copy of the Workspace modules through Deno.makeTempDir and the Deno module loader",
    issue: "https://github.com/taras/executable.md/issues/365",
  },
  {
    path: "packages/workflow/tests/workspace-crash-recovery.test.ts",
    reason:
      "kills real Deno child processes with SIGKILL and reads the recovered node:sqlite WorkflowRun database they leave behind; the children run under the Deno executable and node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/365",
  },
  {
    path: "packages/workflow/tests/repository-components.test.ts",
    reason:
      "drives <Repository> and <Dir> against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter and a real `git` subprocess; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/293",
  },
  {
    path: "packages/workflow/tests/repository-storage.test.ts",
    reason:
      "clones local bare repositories with a real `git` into the Deno DOFS Workspace and reads the retained node:sqlite rows back; the provider is the Deno one by design",
    issue: "https://github.com/taras/executable.md/issues/293",
  },
  {
    path: "packages/workflow/tests/repository-replay.test.ts",
    reason:
      "replays a partial node:sqlite WorkflowRun after deleting the remote and every host materialization, and halts a real blocked `git` child; both the store and the subprocess are the Deno adapter's",
    issue: "https://github.com/taras/executable.md/issues/293",
  },
  {
    path: "packages/workflow/tests/repository-materialization.test.ts",
    reason:
      "exports retained checkouts to host directories and links their roots at external clones, against a real node:sqlite WorkflowRun database",
    issue: "https://github.com/taras/executable.md/issues/293",
  },
  {
    path: "packages/workflow/tests/materialization.test.ts",
    reason:
      "drives <Repository>, <Worktree> and <Dir> against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter and a real `git` subprocess; node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/293",
  },
  {
    path: "packages/workflow/tests/worktree-replay.test.ts",
    reason:
      "substitutes a Worktree's retained checkout through the Deno DOFS Workspace and reads it back with a real `git`; node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/293",
  },
  {
    path: "packages/workflow/tests/git-add.test.ts",
    reason:
      "drives <Git.Add> against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter and a real `git` subprocess, and imports a physical copy of the Api module through the Deno module loader; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-add-durability.test.ts",
    reason:
      "replays and cancels a staging against a real node:sqlite WorkflowRun database and halts a real blocked `git` child; both the store and the subprocess are the Deno adapter's",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-add-crash.test.ts",
    reason:
      "kills a real Deno child with SIGKILL mid-staging and reads the recovered node:sqlite WorkflowRun database it leaves behind; the child runs under the Deno executable and node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-commit.test.ts",
    reason:
      "drives <Git.Commit> against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter and a real `git` subprocess that receives its message on standard input; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-commit-durability.test.ts",
    reason:
      "replays and cancels a commit against a real node:sqlite WorkflowRun database and halts a real blocked `git` child; both the store and the subprocess are the Deno adapter's",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-commit-crash.test.ts",
    reason:
      "kills a real Deno child with SIGKILL mid-commit and reads the recovered node:sqlite WorkflowRun database it leaves behind; the child runs under the Deno executable and node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-switch.test.ts",
    reason:
      "drives <Git.Switch> against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter and a real `git` subprocess, and imports a physical copy of the Api module through the Deno module loader; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-switch-durability.test.ts",
    reason:
      "replays and cancels a switch against a real node:sqlite WorkflowRun database and halts a real blocked `git` child; both the store and the subprocess are the Deno adapter's",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/git-switch-crash.test.ts",
    reason:
      "kills a real Deno child with SIGKILL mid-switch and reads the recovered node:sqlite WorkflowRun database it leaves behind; the child runs under the Deno executable and node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/294",
  },
  {
    path: "packages/workflow/tests/repository-control-plane.test.ts",
    reason:
      "writes Git administration a real `git` then reads, through the Deno DOFS Workspace adapter; node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/293",
  },
  {
    path: "packages/workflow/tests/workspace-files.test.ts",
    reason:
      "drives <File> and <Glob> against a real node:sqlite WorkflowRun database through the Deno DOFS Workspace adapter; node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/366",
  },
  {
    path: "packages/cli/tests/workflow-cli.test.ts",
    reason:
      "drives `xmd workflow start` and `resume` against a real node:sqlite run store, which only the Deno entrypoints open; under Node and Bun the command refuses, and workflow-host.test.ts asserts that refusal on every runtime",
    issue: "https://github.com/taras/executable.md/issues/366",
  },
  {
    path: "packages/cli/tests/workflow-crash.test.ts",
    reason:
      "kills a real `xmd workflow start` child with SIGKILL and reads the recovered node:sqlite run database it leaves behind; the command only exists on the Deno entrypoints",
    issue: "https://github.com/taras/executable.md/issues/366",
  },
  {
    path: "packages/cli/tests/workflow-retention.test.ts",
    reason:
      "reads what `xmd workflow start` retained from its node:sqlite run store, which only the Deno entrypoints open; the portable half of the same contract is packages/cli/tests/process-retention.test.ts",
    issue: "https://github.com/taras/executable.md/issues/366",
  },
  {
    path: "packages/workflow/tests/workflow-lifecycle-control.test.ts",
    reason:
      "cancels and deletes real node:sqlite run databases through the Deno lifecycle adapter and its advisory lock; node:sqlite remains behind --experimental-sqlite on Node 22 and Bun has none",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/workflow/tests/workflow-suspension.test.ts",
    reason:
      "publishes and replays durable suspension requests against a real node:sqlite run database through the Deno lifecycle adapter; node:sqlite remains behind --experimental-sqlite on Node 22 and Bun has none",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/workflow/tests/workflow-suspension-answer.test.ts",
    reason:
      "delivers and spends typed answers against a real node:sqlite run database, taking the Deno lifecycle adapter's advisory lock and planting SQLite triggers in the run file; node:sqlite remains behind --experimental-sqlite on Node 22 and Bun has none",
    issue: "https://github.com/taras/executable.md/issues/300",
  },
  {
    path: "packages/cli/tests/workflow-suspension.test.ts",
    reason:
      "suspends and resumes a real run store through `runWorkflow()`, reading the node:sqlite database it settles; the workflow commands only exist on the Deno entrypoints, and workflow-host.test.ts asserts their refusal on every runtime",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/cli/tests/workflow-lifecycle-control.test.ts",
    reason:
      "drives `xmd workflow cancel` and `delete` against a real node:sqlite run store, which only the Deno entrypoints open; under Node and Bun the command refuses, and workflow-host.test.ts asserts that refusal on every runtime",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/workflow/tests/workflow-lifecycle-authority.test.ts",
    reason:
      "takes a real advisory lock through Deno.FsFile.tryLockSync and races it against a second Deno process; the lock primitive and the run store it guards are both Deno's",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/workflow/tests/workflow-lifecycle-inspection.test.ts",
    reason:
      "opens the Deno lifecycle adapter's read-only node:sqlite snapshots and reads run databases directly to compare them; node:sqlite remains behind --experimental-sqlite on Node 22 and Bun has none",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/cli/tests/workflow-inspection.test.ts",
    reason:
      "drives `xmd workflow status`, `list` and `history` against a real node:sqlite run store, which only the Deno entrypoints open; under Node and Bun the command refuses, and workflow-host.test.ts asserts that refusal on every runtime",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/cli/tests/workflow-fetch.test.ts",
    reason:
      "kills a real `xmd workflow start` child and reads the node:sqlite run store it left behind; the workflow commands exist only on the Deno entrypoints, and the portable half of the same Fetch retention contract is packages/cli/tests/fetch-cli.test.ts",
    issue: "https://github.com/taras/executable.md/issues/456",
  },
  {
    path: "packages/cli/tests/workflow-installation.test.ts",
    reason:
      "opens a real node:sqlite run store through @executablemd/workflow/deno to drive runWorkflow() directly; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/366",
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
