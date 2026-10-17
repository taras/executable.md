# U5 Architect review — PASS

**PASS** on PR #920 at `326afc60b323f0adc3064b12cdc22588353ed83f`. The implementation satisfies the settled U5 architecture. No structural blocker remains.

## Reviewed boundary

| Item | Verified value |
| --- | --- |
| Head | `326afc60b323f0adc3064b12cdc22588353ed83f` |
| Tree | `340267e6dfd327551f0da6067f52e5da58c965ed` |
| Immediate parent | `dcd9cde33e8e57f789a860ce8685651ffaf9eca2` |
| Base / merge-base | `3a1fade9246db937e11da6cdadc4751ec924be97`, landed U4 (#919) |
| Signature | `G` |
| Branch | `agent/upstream-u5-generated-selection` |
| Worktree | `.claude/worktrees/u5-generated-selection`, clean before and after verification |
| Cumulative change | Four commits; 71 files, +4779/−4893 |

GitHub still reports this exact head and base at closure; remote main is also `3a1fade9`. The merged U1–U4 dependencies and overlapping open #890 were checked. #890 remains separate. The authority is the [frozen U5 handoff](../upstream-u5-handoff-3a1fade9/upstream-repository-prerequisite-u5-implementor-handoff.md), with twelve unchanged acceptance rows and twelve unchanged command definitions. The [Planner PASS](../upstream-u5-review-86c10507/planner-review.md) applies to `86c10507`; this review also inspects the three subsequent commits.

## Structural assessment

| Boundary | Conclusion |
| --- | --- |
| Selection and capture, U5-1–U5-3 | `Component.generated` is an ordinary value property with shared undefined defaults. Core owns the validated name/form copy, resolves each selected name once after init/install and before public policy, and retains the authentic definition and metadata together. Invalid selections yield no partial allowance. |
| Publication and execution authority, U5-2/U5-3/U5-10 | Canonical answers are published at the innermost point that produces them. Provider answers retain their exact request/window publication rules. Later middleware, registrations and selection changes cannot substitute the captured implementation. Form dispatch and private protected routing travel with it. Lifetime revocation is armed before initialization and capture; cancellation joins teardown and closes requests. |
| Host composition, U5-4/U5-5 | Ordinary defaults delegate and fill only undefined. REPL entries install that fallback in each execution scope; isolated children assemble their own setup. Workflow supplies its own vocabulary. Fetch membership and the live restriction derive from the same owned request-list reading. Plan's accepted ordinary Files/Permissions boundary remains; no Scope hooks or read grants return. |
| Language and live effects, U5-6–U5-8 | Owner metadata derives read/write membership. Whole-fragment preflight and Json composition remain. Actual Files/Fetch performers use current scoped Permissions; Fetch resolves current Config. Dynamic destinations are admitted as data and checked at transport. Earlier committed effects survive a later runtime refusal; completed local effects restore without another live provider call or evaluator inventory. |
| History, U5-9/U5-11 | Marker 4 is one closed current schema. Classes and name/form/URL/kind/effect rows reconcile exactly. Workspace/request inventories are removed, old/extra-member shapes refuse, and same-URL updated implementations preserve U4's continuation rule. Admission and nested effects remain in the owning expansion's durable sequence. |
| Public surfaces and scope, U5-11/U5-12 | Old host tables, evaluation installation fields and public evaluator builders are removed. Internal evaluator projections remain internal. Workflow roots, transactions, journal associations and storage remain owned by Workflow. No dependency, release or consumer-forwarding change is introduced. |

The post-Planner changes are coherent with those boundaries:

- Completed Workflow replay and fork preflight explicitly answer with no generated selection in their existing owner, suppressing an enclosing command fallback without attaching live providers. They add no execution owner or durable phase.
- Sorting uses the available ES2022 operation without changing canonical name order.
- Repository function modules can state the existing per-form `generated` metadata. The loader validates and retains it through `admitGeneratedForms()`, and core's Glob/Fetch/Elicit registrations reuse their implementation module's declaration. This supports actual-definition resolution without making Markdown or structural answers admissible. An absent declaration still offers nothing; an exported URL supplies no publication authority or permission.

## Independent focused evidence at this head

All final commands below exit 0. These are architecture feedback checks, not an exhaustive delivery claim.

```sh
deno task test packages/core/tests/generated-selection.test.ts packages/core/tests/execution-init.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts
# 26 passed / 160 steps

deno task test packages/core/tests/evaluate-component.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts
# 34 passed / 287 steps

deno task test packages/core/tests/shared-operation-permissions.test.ts packages/core/tests/fetch-component.test.ts packages/core/tests/syntax-loaded-copy.test.ts packages/core/tests/evaluate-loaded-copy.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/syntax-component.test.ts packages/runtime/tests/fetch.test.ts packages/runtime/tests/permissions.test.ts
# 28 passed / 171 steps

deno task test packages/workflow/tests/generated-observations.test.ts packages/workflow/tests/workflow-run.test.ts packages/workflow/tests/workflow-run-journal.test.ts packages/workflow/tests/workflow-run-storage.test.ts packages/cli/tests/evaluate-workflow.test.ts
# 22 passed / 157 steps

deno task test packages/cli/tests/workflow-installation.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/testing-execution-host.test.ts
# 11 passed / 61 steps

pnpm exec tsx --test packages/core/tests/generated-selection.test.ts
# 28 passed, 0 failed

bun test packages/core/tests/generated-selection.test.ts
# 28 passed, 0 failed
```

The full outputs are retained under `/private/tmp/xmd-pr181-bench-rXAXyb/pr920-326afc60-*.log`: `selection`, `admission`, `live-policy`, `workflow-loopback`, `hosts-loopback`, `selection-node-ipc` and `selection-bun` contain the passing runs. Initial `workflow` and `hosts` runs retain the sandbox's `listen EACCES` failures; initial `selection-node` retains tsx's local IPC `listen EPERM` failure before tests started. Repeating those commands with the required socket access passes. The execution conditions changed; these are not unexplained intermittent product failures.

Earlier frozen-command receipts remain attributed to their recorded revisions. This review does not claim their build, compiled, lint, documentation or full six-file Node/Bun commands were repeated at `326afc60`.

## Non-blocking documentation observation

`specs/executable-mdx-spec.md` still has an old final paragraph in §5.3.2 that lists Workspace roots and requests as retained comparison terms. Tier GX also retains descriptions for removed root-loss/per-entry-inventory cases. Those references should be aligned with the current selection-only contract already stated in the same section and implemented by marker 4. This is documentation cleanup, not an architecture blocker or an expansion of the frozen evidence matrix.

## Continuity

Architect verdict: **PASS** at the exact SHA above. Product Owner review of this revision and delivery verification/explicit merge approval remain separate. #902 remains held until U5 lands and the consumer removes its forwarding and proves its own integration rows.

No production source, user edits, branch, preservation ref or immutable authority archive was changed. No CI was inspected. No GitHub feedback, push or merge was performed. This review record is the only repository artifact added by the review; focused outputs are outside the checkout.
