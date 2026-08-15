# Issue #367 PR 1 implementation handoff

## Commit

- Feedback commit: `6f1876d841e5184753ce8f2f10c310b83219d68b`
- Previous feedback commits: `4c6a591` (round 1), `e1d4b3a` (round 2),
  `a665f76` (round 3), `aead98e` (round 4)
- PR: https://github.com/taras/executable.md/pull/458 (draft)
- Base: `a1de02645745f0a70a5e9c2c4159abaed6522ca3` (architecture amendment)
- Branch: `agent/issue-367-inspection`
- Worktree: `/private/tmp/xmd-367-pr1`
- `git merge-base --is-ancestor a1de026 HEAD` holds.

PR #458 is a draft based on branch `issue-367-architecture`, which is `a1de026`
pushed so the PR would have a base to target. Stacked, so main-target CI jobs do
not run.

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

## Review round 2

Requested: retained `WorkflowRunRecord` parsing should enforce the same run-id
validity as requests, reporting invalid stored data as
`WorkflowRecordMalformedError` for `workflow_run.run_id`; plus a regression that
retains an id containing NUL at that id's computed hashed filename.

Done in `a665f76`. `parseRunId` in `src/storage/record.ts` is now the single
rule; `checkRunId` wraps it in `WorkflowRequestError` and `readRunRecord` wraps
it in `WorkflowRecordMalformedError("workflow_run.run_id", …)`. The rule's
message names no host, because `DLC13` holds provider-neutral modules to that
and caught the first wording.

**Evidence the requested regression cannot prove the retained NUL rule on this
host.** WLI5c constructs the case exactly as specified and asserts the required
outcomes — the whole list fails, no healthy array, neither candidate changed.
What refuses it is the location check from round 2, not the id rule:

- SQLite retains all 14 bytes of `release\u0000shadow` (`length(CAST(id AS
  BLOB))` = 14) while `length(id)` = 7 and `node:sqlite` hands back the
  7-character string. Bound parameters truncate at the NUL as well, so the bytes
  only go in through a blob cast.
- `readRunRecord` therefore never observes a NUL-containing id, and the reader
  compares `release` against a file named for the longer string.
- Mutation-checked both ways: reverting the retained parity leaves WLI5c
  passing; removing the location check fails it.

No reachable case discriminates the parity change on this driver — an empty or
non-text retained id was already refused by the previous check. The parity is
landed as the settled contract and as protection for any reader that does
surface embedded NULs, and it is reported here rather than presented as proven.

Evidence after the correction:

- PR 1 focused command: `ok | 3 passed (24 steps) | 0 failed (27s)`
- `packages/workflow/tests/` plus the five workflow CLI suites, the CLI
  inspection suite and the core source suite:
  `ok | 40 passed (300 steps) | 0 failed (1m24s)`
- `deno task lint` exit 0, `deno task check` no errors.

## Review round 3

Requested: `status` and `history` must treat their argument as an exact opaque
run id. `manageRequest()` read `*` and `?` as forbidden wildcard syntax, so a
run created as `release-*` — an id the architecture permits and storage accepts
— could not be inspected at all.

Done in `aead98e`. The refusal is gone; every management action hands its
argument on exactly as written. Deletion's contract is untouched and was never
this check: it expands nothing, so `delete release-*` addresses the run called
`release-*` and never a set of runs. That is now stated where the code decides
it.

Regressions:

- **WFI11** starts `release-*`, `release-?` and `release-1`, then inspects each
  by `status --json` and `history --json` from a directory that is not a working
  tree — so a lookup that consulted Git or reopened the definition would fail.
  It asserts each id returns its own record, that `release-2` is absent, and
  that no execution or status line is printed.
- **WLI9** does the same through the provider with `WorkflowRunStorage` and
  `Git` handlers installed that record and throw, and asserts the recorder stays
  empty and that `list` reports all three as distinct runs.
- Mutation-checked: restoring the refusal fails WFI11 (and WFI7).

Also in this commit: `issue-367-pr1-implementation-handoff.md` is untracked
again. An earlier `git add -A` had committed this working artifact into the
branch; it is no longer in the PR's diff.

Evidence after the correction:

- PR 1 focused command: `ok | 3 passed (26 steps) | 0 failed (33s)`
- Workflow CLI suites (`workflow-cli`, `workflow-installation`, `workflow-host`,
  `workflow-crash`, `workflow-retention`): `ok | 5 passed (24 steps) | 0 failed (44s)`
- `packages/workflow/tests/`: `ok | 33 passed (263 steps) | 0 failed (12s)`
- `deno task lint` exit 0, `deno task check` no errors.

## Review round 4

Requested: make `history release-*` uniquely attributable to that exact run.

Done in `6f1876d`. `retainedRun` now stamps the run id into the events it
appends, so two runs of the fixture differ by what they retain rather than only
by assigned ids. WLI9 reads `release-*`'s rows straight out of its own file
through a read-only connection outside the provider, and compares event ids,
events and Workspace roots whole; it then shows those ids and events are neither
neighbour's, and that `release-?` and `release-1` each read back as themselves
on the same terms.

Workspace roots are compared against the independent read rather than across
runs: three runs that never mutated a Workspace share the one empty root, so a
root attributes nothing here. That is stated in the test rather than asserted
falsely.

Mutation: redirecting `release-*`'s history to `release-?` fails WLI9. Under the
same mutation the previous `toHaveLength(3)` passed, because the neighbour holds
three rows too — which is what made it non-discriminating.

Preserved unchanged: the exact `status` assertions for all three ids, the
absent-run check for `release-2`, the no-expansion `delete` grammar (WFI7), and
the `WorkflowRunStorage`/`Git` spies asserting nothing was reached.

Evidence after the correction:

- PR 1 focused command: `ok | 3 passed (26 steps) | 0 failed (50s)`
- Workflow CLI suites (`workflow-cli`, `workflow-installation`, `workflow-host`,
  `workflow-crash`, `workflow-retention`): `ok | 5 passed (24 steps) | 0 failed (1m3s)`
- `packages/workflow/tests/`: `ok | 33 passed (263 steps) | 0 failed (15s)`
- `deno task lint` exit 0, `deno task check` no errors.

## Delivery to main

PR #458 merged into the stack branch `issue-367-architecture`, not into `main`.
Delivery therefore needed its own step:

1. `issue-367-architecture` rebased onto `origin/main` (`de6d835`), replaying the
   amendment plus #458's five commits linearly rather than carrying the merge.
   One conflict: an import line in `packages/core/src/execute.ts`, where `main`
   had added `raise` beside the import this branch extends.
2. `deno task verify` on the rebased tree found two failures the stacked CI had
   never been able to show, both fixed in `5fdc4f9`:
   - `workflow-lifecycle-inspection.test.ts` and `workflow-inspection.test.ts`
     were missing from `scripts/runtime-test-exclusions.ts`, so `test-node` and
     `test-bun` discovered and failed on suites that open `node:sqlite`.
   - `journal-source-position.test.ts` installed no eval compiler. Under the old
     behavior the failure was printed into the text root and the run finished,
     so the suite read a source position off an event that recorded a failure.
     `main`'s text-root settlement makes the same document fail outright.
3. Second `deno task verify`: all nine commands ok, tracked tree unchanged —
   `vendor`, `lint`, `check`, `test` (654.8s), `check:jsr`, `tsc`, `test:node`
   (3203 pass), `test:bun` (3203 pass), `docs`.
4. Branch force-updated `ce3462c` → `5fdc4f9` and
   [PR #460](https://github.com/taras/executable.md/pull/460) opened to `main`.

`composability` does not run on a pull request — CI runs it on `main` only — so
it is a post-merge check. `deno task verify` locally is the same battery minus
that harness's clean-clone step.

## Next action

Merge [PR #460](https://github.com/taras/executable.md/pull/460) once its
required checks pass. PR 2 (executor authority, atomic lifecycle, cancellation,
deletion) then starts from the resulting `main` head — not from `6f1876d`.
