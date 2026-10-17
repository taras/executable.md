# U4 Planner implementation review — eef612ed

**PASS** for `eef612edcf86dd2416b2cb3dbbdd85dcb4e3e9d4`. The twelve frozen U4 criteria and selected evidence pass. All feedback blockers are closed. This is a Planner implementation verdict for this exact revision; it does not approve publication or merge, or stand in for Architect/Product Owner review.

## Reviewed revision

| Item | Verified value |
| --- | --- |
| SHA | `eef612edcf86dd2416b2cb3dbbdd85dcb4e3e9d4` |
| Tree | `38b43cff89640a293fbbd338f4bcb5046cec8dd7` |
| Parent | `695bc5b2f15180b5a5096bfa51a20b690cce1cbd` |
| Base | `6314e187dc89c3e0f2b393b60d6f5963f847a881` |
| Signature | `G` |
| Branch | `agent/upstream-u4-generated-owners` |
| Worktree | `.claude/worktrees/u4-generated-owners`, clean |
| Revision diff | 3 files, +182 / −36 |
| Complete slice against base | 44 files, +3705 / −2883 |

Authority: the immutable [frozen U4 handoff](../upstream-prerequisites-6314e187/upstream-repository-prerequisite-u4-implementor-handoff.md) and accepted prerequisite contract. Earlier reviews at [2824855c](../upstream-u4-review-2824855c/planner-review.md) and [695bc5b2](../upstream-u4-review-695bc5b2/planner-review.md) remain historical findings; this revision closes them. The frozen matrix and commands were not expanded or edited.

## Correction and acceptance

Direct observation and mutation selection now retain an owned reading of each definition and its validated generated metadata. That same retained value supplies forms, URLs, policy and the invoked definition. The local map is scoped to this existing selection operation and keyed by the original definition object, so File's two forms still share one retained definition and genuinely different definitions remain ambiguous. The function crosses by reference; dispatcher/protected routing and Json composition retain their existing paths. There is no new public API or independent identity/lifetime owner.

Registration's owned validated metadata, strict provider forms validation, deep-frozen fixed owners and the independently loaded provider positive evidence remain as reviewed in the preceding round. The fixed current record marker and per-form URL/effect schema fit the accepted U4 boundary. The old generated representations have no compatibility readers or migration; no stored data is changed. U5 selection/property/input removal remains outside this slice.

The retained probes now demonstrate:

- The original valid control runs with one current URL admission.
- Invalid direct identity and unaccepted form refuse before admission/body.
- Malformed provider forms refuse publication before generated work.
- Registration's alternating identity is read once and retains the accepted URL.
- Direct pinned read and paired write each read the identity accessor once, invoke the body once, and retain the accepted read/write URL without error.

The new GXC2c rows and retained red control distinguish this last correction from a check that discards its result. Restoring check-then-reread fails both new rows while the static validation cases remain green. No additional permutation is needed to close the frozen retention criterion.

## Frozen row map

| Row | Reviewed evidence |
| --- | --- |
| U4-1 | GOM1 validation/atomic registration/accessor rows; GXC2c static and retained-read rows; shared canonical forms validation |
| U4-2 | GOM2 exact shipped owner table, EP21/EP22/EL1, fixed filesystem, Json composition and Evaluate absence |
| U4-3 | CIV/PA retained definition comparisons, GOM3 deep freezing, registration's admitted value and both direct alternating-read cases |
| U4-4 | Single-argument provider answer, CIV publication/copy/substitution tests, malformed provider forms and ordinary unidentified authored answers |
| U4-5 | FE15/CIV25 request return/failure/cancellation, stale-window refusal and body lifetime |
| U4-6 | PA10c reuse, overlapping owners and alternating-answer defenses |
| U4-7 | FE14/U4-7 dynamically loaded provider publishes and runs its own answer; existing foreign protected/fixed refusals |
| U4-8 | EP18 one dual-form resolution, EP19 wrong/unoffered forms/effects, GXC2b/GXC3 ambiguity and retained direct definition sharing |
| U4-9 | Current URL record round-trip/passive restoration, same URL with updated implementation, changed terms and closed old/malformed-record refusal tables |
| U4-10 | GX18/GX18b–d/GX10, Evaluate occurrence isolation and Workflow generated order/replay evidence |
| U4-11 | CLI Workflow host selection, core Dir metadata, shared operation Permissions/request ceilings, Workflow/Git integration |
| U4-12 | Build/docs, compiled Plan/plugin, init/contextual Syntax, Workflow run/journal/bundle and dead-code inventory |

## Focused commands and results

The Implementor's retained logs support the ten frozen commands at this feedback tree:

```sh
deno task test packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/fixed-filesystem-components.test.ts packages/core/tests/evaluation-profile.test.ts
deno task test packages/core/tests/evaluate-component.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/shared-operation-permissions.test.ts
deno task test packages/core/tests/syntax-loaded-copy.test.ts packages/core/tests/evaluate-loaded-copy.test.ts packages/core/tests/execution-init.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/syntax-component.test.ts
deno task test packages/workflow/tests/generated-observations.test.ts packages/workflow/tests/generated-agent-component.test.ts packages/workflow/tests/workflow-run.test.ts packages/workflow/tests/workflow-run-journal.test.ts packages/core/tests/workflow-component-bundle.test.ts
deno task test packages/cli/tests/evaluate-workflow.test.ts packages/cli/tests/plan-component.test.ts packages/cli/tests/plan-command-document.test.ts packages/cli/tests/syntax-cli.test.ts packages/git/tests/repository-components.test.ts
pnpm exec tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts
bun test --timeout=300000 packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts
deno task lint:dead-code
deno task build
deno task test scripts/tests/plan-component-compiled.test.ts scripts/tests/plugin-compiled.test.ts
```

| Evidence | Result |
| --- | --- |
| Deno group 1 | 25 passed / 147 steps / 0 failed |
| Deno group 2 | 36 passed / 333 steps / 0 failed |
| Deno group 3 | 14 passed / 83 steps / 0 failed |
| Deno group 4 | 21 passed / 131 steps / 0 failed |
| Deno group 5 | 19 passed / 140 steps / 0 failed |
| Node | 311 passed / 0 failed |
| Bun | 311 passed / 0 failed |
| Dead-code inventory | exit 0 |
| Build, including documentation | exit 0 |
| Compiled Plan/plugin | 6 passed / 15 steps / 0 failed |

Logs are preserved in `implementor-logs/`. The user also reports clean lint and typecheck; those additional delivery-oriented checks are not conditions on this verdict.

Planner independently ran from the exact clean worktree:

```sh
deno task test packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/syntax-loaded-copy.test.ts
```

Result: **26 passed / 223 steps / 0 failed**, exit 0. [Focused log](focused.log).

Planner also reran both external probes with `deno run --allow-all --frozen --config deno.json`, exit 0 each. [Original probe source](original-probe.mjs) and [current output](original-probe.log); [direct retained-read source](pinned-read-probe.mjs) and [current output](pinned-read-probe.log). Their absolute module imports identify the reviewed worktree. The earlier review directories preserve the before-fix observations. [Discriminating control output](implementor-logs/u4-control-r4.log) records the restored-defect failure.

No production source, tests, dependency, Git branch or immutable preservation artifact was modified by this review. Worktree remained clean. No CI, main-health or delivery state was inspected. No publication or cleanup was performed.

## Continuity and next action

Planner review is closed at the exact SHA above with no feedback blocker. Next: Architect implementation review and Product Owner review of this revision, then separately authorized delivery, publication and merge. The implementation is reported unpushed and no PR has been opened; this review performs no remote mutation.

U4 is not landed. U5 waits for landed U4; #902 stays held through U4–U5 and removal of consumer-owned forwarding. Preserve U3/#902 worktrees, preservation refs and the immutable prerequisite archive. A later change returns to Planner only if it materially changes the reviewed contract.
