# Issue #367 PR 1 implementation handoff

## Commit

- Feedback commit: `e1d4b3a46c78e03ab2c13763cd2c4fff32e7e7ac`
- Previous feedback commit: `4c6a591ba8200e4fd53b885df81e434692e0b2c0` (Planner
  returned REQUEST CHANGES against it)
- Base: `a1de02645745f0a70a5e9c2c4159abaed6522ca3` (architecture amendment)
- Branch: `agent/issue-367-inspection`
- Worktree: `/private/tmp/xmd-367-pr1`
- `git merge-base --is-ancestor a1de026 HEAD` holds.

No PR is open. The branch is local; the base commit is also local and unpushed.

## Observable behavior delivered

```sh
xmd workflow status <run-id> [--json]
xmd workflow list [--status=<status>] [--json]
xmd workflow history <run-id> [--json]
```

- Human output on stdout, diagnostics on stderr, exit code describing the
  request: reading a failed run exits 0, and only a request the command cannot
  answer exits 1.
- `status --json` writes one `WorkflowLifecycleSnapshot`; `list --json` writes an
  array ordered newest `record.updatedAt` first, tie-broken by run id;
  `history --json` writes every retained entry in append order.
- Human history renders each Yield as its durable operation, associates child
  Closes with their coroutine, renders the root Close as the outcome footer, and
  states that no canonical document outcome was recorded when there is none.
- Every history entry carries `eventId`, the complete filtered event, the row's
  own `workspaceRootId`, and an optional `source`.
- Authored durable operations retain their `SourcePosition` under
  `"executablemd.source-position"`. `type` and `name` are unchanged, so replay
  matches exactly what it matched before.
- One foreign, damaged, incompatible or unparseable candidate fails all of
  `list` with its own condition and changes no candidate. So does a healthy
  database found where another run's id would put it: every read-only snapshot
  checks that the retained run id names the file it was found in.
- `cancel` and `delete` are recognized actions that report that no lifecycle
  provider answers them. Their behavior is PR 2's.

## Files changed

New:

- `packages/workflow/src/lifecycle/api.ts` — `ExecutorLease`,
  `ExecutorAcquisition`, `WorkflowLifecycleSnapshot`, `WorkflowDeletion`,
  `WorkflowLifecycleApi`, fail-closed `WorkflowLifecycle` Api.
- `packages/workflow/src/lifecycle/history.ts` — `WorkflowHistoryEntry` and the
  namespaced source parse.
- `packages/workflow/src/deno/lifecycle.ts` — read-only recognition, snapshot,
  list and history; installs `inspect`/`list`/`history` only.
- `packages/core/src/source-position.ts` — `SOURCE_POSITION_FIELD` and
  `sourceDescription()`.
- `packages/cli/src/workflow-management.ts` — management dispatch and the JSON
  and human projections.
- Three test suites (below).

Changed: `packages/workflow/{mod,deno}.ts`, `src/deno/{journal,provider,
workspace/files}.ts`, `src/storage/api.ts`; `packages/core/{mod.ts,
src/{types,scanner,expand,execute,component-api,bound-exec,eval-handler,loop,
elicit-journal,agent/journal,agent/function-components,components/Elicit}.ts}`;
`packages/testing/src/{journal,test-component,testing-component}.ts`;
`packages/web/src/{journal,WebForm}.ts`;
`packages/test-agent/src/worker/when-prompt.ts`;
`packages/cli/src/{cli,workflow,deno-workflow}.ts`; `architecture.md`;
`specs/workflow-workspace-spec.md`.

## Contract changes worth naming

- `Component.importComponent(name, position?)` takes an optional authored
  position. Existing handlers destructure `[name]` and are unaffected.
- `JournalEntry` (public, `@executablemd/workflow`) gains `workspaceRootId`.
- `ExecutableCodeBlock` and `CodeBlockContext` gain `position`.
- `WorkflowHost` gains `useLifecycle()`. Node and Bun still refuse before the
  host object exists.
- `checkRunId` and `authorizedRoot` are exported from the Deno storage provider
  so the lifecycle adapter applies the same rules rather than a second copy.

## Evidence run

The plan's PR 1 feedback command:

```sh
deno task test \
  packages/workflow/tests/workflow-lifecycle-inspection.test.ts \
  packages/cli/tests/workflow-inspection.test.ts \
  packages/core/tests/journal-source-position.test.ts
```

`ok | 3 passed (22 steps) | 0 failed (30s)`

The existing suites the change touches:

```sh
deno task test \
  packages/cli/tests/workflow-cli.test.ts \
  packages/cli/tests/workflow-installation.test.ts \
  packages/cli/tests/workflow-host.test.ts \
  packages/workflow/tests/workflow-run-journal.test.ts
```

`ok | 11 passed (65 steps) | 0 failed (43s)`

Because the source audit changes the description of nearly every authored
durable operation, affected-test selection is not sufficient, so the whole Deno
suite was run as well:

```sh
deno task test
```

`ok | 487 passed (3527 steps) | 0 failed (7m13s)`

Also run, both clean: `deno task lint` (exit 0), `deno task check` (no errors),
and `pnpm exec tsc --project tsconfig.node.json --noEmit` (exit 0). The full
suite predates the last two commits' worth of test additions and doc polish; the
focused suites above were re-run after them.

## Frozen matrix coverage

| ID | Where |
| --- | --- |
| A1 | WFI7, WFI8, WFC8, WFH1–3 |
| A2 | WLI3, WLI8 (storage and Git spies, byte/row/mode fingerprint), WFI5, WFI10 |
| A3 | WLI1, WLI4, WFI1, WFI2 |
| A4 | WLI5, WLI5b, WFI6 |
| A5 | WLI6, WFI3 |
| A6 | JSP1–JSP4, WLI6, WLI7, WFI3 |
| A15 | full Deno suite; WFC1–WFC12 unchanged |

A7–A14 belong to PR 2 and PR 3.

## Deviations and observations

- The `--status` filter is applied by the CLI over `list()`, because the
  architecture's `list()` takes no argument. WFI2 covers it.
- WFI4 removes the root Close row directly to produce the retained shape a
  suspended or interrupted run has. Neither status is reachable from this
  slice's commands, and the alternative was leaving the partial-history footer
  untested.
- The fail-closed lifecycle message says no provider *answers* that operation
  rather than that none is configured, because the Deno provider installs the
  three read-only operations and not the other three. Reworded so it is true in
  both cases.
- `specs/workflow-workspace-spec.md` §4.2's human-history example used
  illustrative `E14`/`V7` identifiers. It now shows the retained identifiers,
  shortened, because the shipped command prints those.

## Review round 1

Planner returned `REQUEST CHANGES` against `4c6a591`: `list()` accepted a valid
workflow database stored under the wrong hashed filename, so a copied run came
back as a healthy duplicate.

Fixed in `e1d4b3a`. The identity-against-location check moved into
`withSnapshot`, so it runs for every candidate rather than only where a caller
supplied an id to compare against, and reports
`WorkflowRunLocationMismatchError` — a subclass of `WorkflowRunIdMismatchError`,
so the condition a caller matches on is unchanged while the sentence is true
from this direction. `WLI5b` constructs the case; with the check removed it
reports two runs, which is how the regression was shown to discriminate.

Evidence after the fix:

- PR 1 focused command: `ok | 3 passed (23 steps) | 0 failed (32s)`
- `packages/workflow/tests/` plus `workflow-cli`, `workflow-installation`,
  `workflow-host`, `workflow-crash`, `workflow-retention`:
  `ok | 38 passed (285 steps) | 0 failed (1m6s)`
- `deno task lint` exit 0, `deno task check` no errors.

## Next action

Planner review of `e1d4b3a46c78e03ab2c13763cd2c4fff32e7e7ac` against the frozen
plan. PR 2 (executor authority, atomic lifecycle, cancellation, deletion) starts
from this commit.
