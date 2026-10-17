# Open flake record: REPL lifecycle L2 observes enter before the question

Status: open, cause unfixed. Classification: flake. This local record preserves
the implementation-feedback evidence; no GitHub issue or CI run was created
under this task's no-GitHub-mutation authorization.

## Recurrence at ab681d4a, 2026-10-15

The same two-file command failed on signed clean
ab681d4acd824665188f2c6ab9997eecbbf178e0, parent 5ce2e2d2. L2 at the unchanged
line 130 expected Elicit:active:question and observed Elicit:enter. First output
is [preserved here](pr2-sessions-review-ab681d4a-lifecycle-first.log): 5 tests /
38 steps passed, 1 test / 1 step failed.

With no source, fixture, assertion, dependency or environment change, the
[isolated rerun](pr2-sessions-review-ab681d4a-l2-isolated-rerun.log) passes
1 test / 8 steps; the
[original two-file rerun](pr2-sessions-review-ab681d4a-lifecycle-rerun.log)
passes 6 tests / 39 steps. This correction changes tests and two fixtures only,
with no lifecycle/session/Elicit implementation change. The cause remains
unfixed and this flake stays open. No GitHub mutation or unrelated repair was
made.


## Recurrence at 5ce2e2d2, 2026-10-15

The same two-file command failed on signed clean
5ce2e2d2ca7d4236ff9ceec224cc99dcf365f299, parent 4ee4f448. L2 at the unchanged
line 130 expected Elicit:active:question and observed Elicit:enter. First output
is [preserved here](pr2-sessions-review-5ce2e2d2-lifecycle-first.log): 5 tests /
38 steps passed, 1 test / 1 step failed.

With no source, fixture, assertion, dependency or environment change, the
[isolated lifecycle rerun](pr2-sessions-review-5ce2e2d2-lifecycle-isolated-rerun.log)
passes 1 test / 8 steps; the
[complete two-file rerun](pr2-sessions-review-5ce2e2d2-lifecycle-rerun.log)
passes 6 tests / 39 steps. The Sessions correction changes no lifecycle/session/
Elicit implementation. This recurrence does not identify or fix the cause;
the flake remains open. No GitHub mutation or unrelated repair was made.

## Original observation

Exact revision: `10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`, parent
`f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`, signed G, clean worktree on
agent/issue-883-pr2. Runtime: Deno 2.9.7 stable, aarch64-apple-darwin;
V8 15.0.245.2-rusty; TypeScript 6.0.3. Local review on 2026-10-14.

The first invocation was:

```sh
deno task test packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

L2, “an element waiting on a question says so, and stops when it is answered”,
failed at repl-lifecycle.test.ts:130. It expected `["Elicit:active:question"]`
but observed `["Elicit:enter:"]`. The selection reported 5 tests / 38 steps
passed, 1 test / 1 step failed. Full first output is retained at
[lifecycle-first.log](pr2-preview-review-10b17a40-lifecycle-first.log).

On that same revision, without any source, assertion, fixture, dependency or
environment change:

```sh
deno task test packages/cli/tests/repl-lifecycle.test.ts
```

passes 1 test / 8 steps in
[the isolated rerun](pr2-preview-review-10b17a40-lifecycle-isolated-rerun.log).
The original two-file command then passes 6 tests / 39 steps in
[the complete unchanged rerun](pr2-preview-review-10b17a40-lifecycle-rerun.log).

The test file is unchanged by the reviewed correction. It samples lifecycle
after five sleep(0) yields; the failed sample is an earlier lifecycle phase.
That identifies the readiness assumption to investigate, not a proven cause
or an authorized fix. The Preview correction changes no session, lifecycle or
Elicit implementation. No assertion was weakened and no code was changed for
the reruns.

The green reruns establish intermittence and restore this command's health;
they do not replace the first failure or close this record. A separate repair
needs a cause and discriminating regression evidence. It is not added to the
bounded Preview assignment. This is distinct from the existing U2 flake and the
npm permission limitation in workflow adapter installation.
