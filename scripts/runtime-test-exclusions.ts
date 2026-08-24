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

/** The runtimes the repository's test corpus runs under. */
export type Runtime = "deno" | "node" | "bun";

/** Every supported runtime, in the order reports and measurements visit them. */
export const RUNTIMES: readonly Runtime[] = ["deno", "node", "bun"];

/** `value` as a supported runtime, or `undefined` when it names none. */
export function parseRuntime(value: string): Runtime | undefined {
  return RUNTIMES.find((runtime) => runtime === value);
}

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
      "imports scripts/verify-clean.ts for the interference proof's ordering, and that module reaches for Deno.env and Deno.execPath at import time; the ordering it asserts is host-neutral but the module carrying it is not",
    issue: "https://github.com/taras/executable.md/issues/279",
  },
  {
    path: "scripts/tests/verify-adapter.test.ts",
    reason:
      "drives the Deno half of `deno task verify` — spool handles through Deno.openSync, real child processes through Deno.execPath(), and a fingerprint built on Deno.lstatSync/readLinkSync; the coordinator it serves is covered portably by verify-coordinator.test.ts",
    issue: "https://github.com/taras/executable.md/issues/279",
  },
  {
    path: "scripts/tests/shard-execution.test.ts",
    reason:
      "runs a shard against a temporary Deno workspace through real `deno test` children, and kills one mid-run to prove the process group goes with it; Bun's job installs no Deno at all, and the ordering and argument-vector half of the same contract is scripts/tests/runtime-tests.test.ts",
    issue: "https://github.com/taras/executable.md/issues/280",
  },
  {
    path: "scripts/tests/measure-test-weights.test.ts",
    reason:
      "runs `deno task weights:measure` itself through Deno.execPath() with an environment of its own, to prove the command refuses incomplete provenance before it starts a test process; the portable half — the weights parser, the environment refusal and the measurement operation — is scripts/tests/test-weights.test.ts",
    issue: "https://github.com/taras/executable.md/issues/280",
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
    path: "packages/workflow/tests/ambient-authentication.test.ts",
    reason:
      "drives the Deno host adapter's HTTP credential acquisition against a real node:sqlite WorkflowRun database, a real `git` subprocess and a provider-owned helper the Deno source assembly launches; the adapter, the store and the helper are all the Deno one by design",
    issue: "https://github.com/taras/executable.md/issues/522",
  },
  {
    path: "packages/workflow/tests/public-entrypoint.test.ts",
    reason:
      "imports the Deno entrypoint to inventory what it publishes, which reaches the node:sqlite run store on load, and spawns a Deno subprocess to attempt the exploit; both the surface under test and the probe are Deno's",
    issue: "https://github.com/taras/executable.md/issues/522",
  },
  {
    path: "packages/workflow/tests/credential-helper.test.ts",
    reason:
      "runs the provider-owned credential helper through the Deno source launcher and drives `git credential fill` against isolated fixture homes; the helper mode is dispatched by the Deno entrypoints and has no Node or Bun assembly yet",
    issue: "https://github.com/taras/executable.md/issues/522",
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
    path: "packages/workflow/tests/git-push.test.ts",
    reason:
      "drives <Git.Push> against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter, a real local bare remote and a real `git` subprocess that observes and pushes; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/370",
  },
  {
    path: "packages/workflow/tests/git-push-durability.test.ts",
    reason:
      "replays and cancels a push against a real node:sqlite WorkflowRun database, halts a real blocked `git` child and imports a physical copy of the Api module through the Deno module loader; both the store and the subprocess are the Deno adapter's",
    issue: "https://github.com/taras/executable.md/issues/370",
  },
  {
    path: "packages/workflow/tests/git-push-crash.test.ts",
    reason:
      "kills a real Deno child with SIGKILL after native Git updated the remote and before the result was appended, then reads the recovered node:sqlite WorkflowRun database it leaves behind; the child runs under the Deno executable and node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/370",
  },
  {
    path: "packages/workflow/tests/pull-request.test.ts",
    reason:
      "drives <PullRequest> against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter, a real local bare remote and a real `git` subprocess; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/295",
  },
  {
    path: "packages/workflow/tests/pull-request-read.test.ts",
    reason:
      "drives the three evidence reads against a real node:sqlite WorkflowRun database, the Deno DOFS Workspace adapter and a real `git` subprocess, and replays one from the retained journal; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/576",
  },
  {
    path: "packages/workflow/tests/pull-request-durability.test.ts",
    reason:
      "replays, damages and cancels a pull request against a real node:sqlite WorkflowRun database and the Deno DOFS Workspace adapter; both the store and the Git subprocess are the Deno adapter's",
    issue: "https://github.com/taras/executable.md/issues/295",
  },
  {
    path: "packages/workflow/tests/pull-request-crash.test.ts",
    reason:
      "kills a real Deno child with SIGKILL after GitHub answered 201 and before the result was appended, then reads the recovered node:sqlite WorkflowRun database it leaves behind; the child runs under the Deno executable and node:sqlite remains behind --experimental-sqlite on Node 22",
    issue: "https://github.com/taras/executable.md/issues/295",
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
    path: "packages/workflow/tests/workflow-agent-sessions.test.ts",
    reason:
      "WSL5 deletes real node:sqlite run databases through the Deno lifecycle adapter, which takes the run's advisory lock through Deno.FsFile — a lock this host refuses to take under any other runtime. The sidecar primitives the rest of the tier covers are ordinary filesystem work and would run anywhere; they are not separable from the deletion case without splitting the retention contract across two files",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/cli/tests/workflow-agent-sessions.test.ts",
    reason:
      "runs a document with two same-named <Session> sites against a real node:sqlite WorkflowRun database, with the run's Workspace attached and the mapping table read back across attachments; the store and the DOFS Workspace under it are both the Deno adapter's",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/workflow/tests/generated-agent-component.test.ts",
    reason:
      "drives `<Evaluate>` against a real node:sqlite WorkflowRun database and the Deno DOFS Workspace adapter, because what is under test is that the stated ceiling is the run's own roots; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/367",
  },
  {
    path: "packages/cli/tests/workflow-agent.test.ts",
    reason:
      "runs the representative observation-loop document against a real node:sqlite WorkflowRun database with the run's Workspace attached, substituting only the agent process; the store and the DOFS Workspace under it are both the Deno adapter's",
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
    path: "packages/workflow/tests/workflow-checkpoint.test.ts",
    reason:
      "settles and inspects a real node:sqlite run database through the Deno lifecycle adapter, which takes the run's advisory lock through the Deno runtime; the one portable case here — that ordinary execution still reaches core's `<Elicit>` and its journal — needs no workflow run at all and is the same contract elicit-component.test.ts covers on every runtime",
    issue: "https://github.com/taras/executable.md/issues/301",
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
    path: "packages/cli/tests/workflow-fork.test.ts",
    reason:
      "drives `xmd workflow fork` against a real node:sqlite run store, killing a child mid-commit and reading the run database it leaves; the command only exists on the Deno entrypoints, and the provider-neutral half — forkability and fork selection — runs on every runtime as packages/workflow/tests/workflow-fork.test.ts",
    issue: "https://github.com/taras/executable.md/issues/368",
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
    path: "packages/acp/tests/session-route.test.ts",
    reason:
      "the subject is the durable construction-route store: create-once publication by hard link, mode 0700/0600, a flushed staging file, and one real two-process race through Deno child processes. The store is built only where `Deno.link`, `Deno.open().sync()` and those APIs exist, and the strict reader and memory-store parity it shares with every runtime are asserted in the same file's parser cases, which the Deno suite runs",
    issue: "https://github.com/taras/executable.md/issues/519",
  },
  {
    path: "scripts/tests/acpx-vendor.test.ts",
    reason:
      "AV9 and AV10 ask `deno info` for the release compile's module graph through process.execPath, so under Node or Bun the probe is not the Deno one and reports nothing about the graph the binary is built from; the portable half — inventory, digests, exact delta, licence and the single relative import — is asserted by the same file's other cases, which the Deno suite runs",
    issue: "https://github.com/taras/executable.md/issues/561",
  },
  {
    path: "packages/runtime/tests/executable-observer.test.ts",
    reason:
      "the subject is the Deno executable observer, which reads the real process environment through Deno.env, resolves and canonicalizes against the host filesystem, and asks the exact observed path for its version through Deno.Command; the provider-neutral half — what a binding contains, how two bindings compare and what a mismatch refuses — runs on every runtime through packages/acp/tests/native-launch.test.ts",
    issue: "https://github.com/taras/executable.md/issues/561",
  },
  {
    path: "packages/runtime/tests/agent-session-coordinator.test.ts",
    reason:
      "the subject is the Deno agent-session coordinator: a non-blocking advisory lock through Deno.FsFile.tryLock, raced against real Deno child processes that are killed mid-ownership to leave a tombstone. Both the lock primitive and the children are Deno's; the provider-neutral half of the same contract — owner kinds, contention, quiescence and the record shape — runs on every runtime through packages/acp/tests/native-launch.test.ts and packages/cli/tests/agent-session-coordinator.test.ts",
    issue: "https://github.com/taras/executable.md/issues/517",
  },
  {
    path: "packages/cli/tests/workflow-installation.test.ts",
    reason:
      "opens a real node:sqlite run store through @executablemd/workflow/deno to drive runWorkflow() directly; Bun has no node:sqlite at all and Node 22 keeps it behind --experimental-sqlite",
    issue: "https://github.com/taras/executable.md/issues/366",
  },
];

/**
 * A suite whose subject is the compiled binary, which no test shard builds.
 *
 * The test jobs run source. `dist/xmd` exists only where something compiled it,
 * and the `smoke` job is the one that does — deliberately, through the README's
 * own Build target — so that is where a suite driving the binary belongs. This
 * one ran in the Deno shards until now only because a Deno-only build test
 * happened to sort into the same shard and left `dist/xmd` behind as a side
 * effect. That is not a dependency any partition preserves: adding a single
 * test file anywhere re-weights the corpus and can separate the two, which is
 * exactly what happened.
 */
const COMPILED_BINARY: RuntimeExclusion[] = [
  {
    path: "scripts/tests/component-form-dispatch.test.ts",
    reason:
      "drives the compiled `dist/xmd`, which only `deno compile` produces and which no test shard builds — the subject is the binary's two loaded copies of core, a shape no Node or Bun run can build or exercise, and one the Deno shards saw only while an unrelated Deno-only build test happened to share a shard and leave the binary behind. The `smoke` job builds through README.md#Build and runs it there, beside the other suites whose subject is the binary",
    issue: "https://github.com/taras/executable.md/issues/567",
  },
];

/**
 * Node and Bun are keyed separately because they diverge — Bun imports a data:
 * URI that Node's tsx loader rejects, for one. They happen to agree today.
 *
 * Deno is keyed too, and until now its list was empty: every runtime derives
 * its corpus through the same subtraction, so the runtime that excludes nothing
 * had to say so rather than be absent. An absent key reads as an unmeasured
 * runtime, which is what the weights and the partition must never see. Deno now
 * excludes one file, for a reason that is not portability at all — the shards
 * run source, and that suite's subject is the compiled binary.
 */
export const exclusions: Record<Runtime, RuntimeExclusion[]> = {
  deno: COMPILED_BINARY,
  node: [...DENO_ONLY_TOOLING, ...COMPILED_BINARY],
  bun: [...DENO_ONLY_TOOLING, ...COMPILED_BINARY],
};
