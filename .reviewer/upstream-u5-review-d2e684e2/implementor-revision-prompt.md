# U5 revision prompt — three frozen-criterion failures

Continue as `.agents/implementor.md` in the existing authorized U5 worktree. This is a bounded correction to feedback SHA `d2e684e2264092373c2f42a2070541ea4303d818`, tree `49031af37a3b54e30d4de032fd75576512159b71`, base `3a1fade9246db937e11da6cdadc4751ec924be97`. Do not rebase or alter the settled U5 scope.

## Applies to

The three reproduced failures in the [Planner review](planner-review.md), under the [frozen handoff](../upstream-u5-handoff-3a1fade9/upstream-repository-prerequisite-u5-implementor-handoff.md). The attached [probe source](probes.ts) and [output](integration-probes.log) are review evidence, not production code to copy wholesale.

## Instructions

Reproduce first, then correct these three items:

1. **R1 / U5-2 — keep ordinary authored imports on settled options.** Assembly currently retains the original `options.includes` reference and executeDocument uses it instead of the terminal's detached accepted options. The existing `deno task test packages/core/tests/execution-protocol.test.ts` fails EP26 with `Cannot resolve component: Accepted (searched: )`. Restore EP26 unchanged; prove a policy's legitimate `withOptions()` includes replacement still changes ordinary authored imports. Keep the generated selection/definitions captured before policy and immutable; do not move capture or mint identities twice. Preserve descriptive behavior affected by authored search paths through the existing fallback.
2. **R2 / U5-7 — compare all actual Workflow request headers.** The production helper lowercases names into a Map and silently overwrites case collisions. Under a bound of `x-bound: admitted`, transforming headers to `{ "X-Bound": "EXTRA", "x-bound": "admitted" }` passes policy and sends `EXTRA, admitted`. Refuse ambiguous duplicate names in host bounds and outgoing requests, preserving U2's fail-closed rule, full method/destination/header bounds, captured immutable data and terminal ordering. Add a committed regression through production `useWorkflowGenerated`, canonical Evaluate and the real Fetch terminal: unchanged headers succeed; the transformed request reaches no server. Keep the removed generic inventories removed. Correct WGX9 so it changes the original bound and attempts another request while that same installed policy is still live; the current second run supplies a fresh bound and never observes the edit.
3. **R3 / U5-4 — compose the ordinary REPL fallback.** Session assembly unconditionally answers with its ordinary map, hiding a plugin/host selection installed by a captured callback. In the probe an empty custom selection is read/refused without that default but is never read and the entry succeeds when the ordinary map is supplied. Use delegate-first, undefined-only middleware in each live entry scope. Add real REPL evidence for a defined custom selection and defined empty refusal, retaining the ordinary default control and fresh-entry behavior. Do not add another selection input collector or restore `ExecutionInstallation.evaluation`.

Canonical name order within the existing class/form ordering is accepted. Innermost publication and the restored safe request-refusal classification are accepted. EL5/EL7's new premises are accepted. Do not undo those changes or redesign the capture boundary.

## Evidence and feedback

Keep the original frozen matrix. Fold the three focused regressions into their stated rows and retain every first failing output before editing. Run the existing execution-protocol suite as the regression command for R1, the affected real REPL/Workflow suites and the frozen focused commands against the final tree. Demonstrate that each new regression fails against the reviewed defect and passes after correction; no unrelated controls or acceptance permutations are requested.

Once the focused evidence is green, create a signed feedback commit promptly. Return exact SHA/tree/base, cumulative diff including new files, clean worktree, row map, commands/results and the discriminating before/after evidence. Full lint/check/runtime corpora and CI are not extra feedback prerequisites. Leave publication, PR creation, CI inspection, merge, preservation refs, other worktrees and #902 untouched.

## Read next

Return the new revision to the Planner. A materially new authority or lifecycle boundary goes to the Architect before implementation; these corrections need no new public protocol.
