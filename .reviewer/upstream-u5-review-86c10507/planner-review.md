# U5 Planner review — PASS

**PASS** on `86c10507afba2d166065f76ec41c754e63ebff1e`. The frozen U5 criteria are satisfied. R1–R4 are closed; no Planner feedback blocker remains. This verdict applies to this exact feedback revision and is separate from architecture/product review and delivery.

## Exact revision

| Item | Verified value |
| --- | --- |
| Feedback SHA | `86c10507afba2d166065f76ec41c754e63ebff1e` |
| Tree | `f67ea2d90f10453d354267d6add2c1894c12b7bb` |
| Parent/base | `3a1fade9246db937e11da6cdadc4751ec924be97` |
| Signature | `G` |
| Branch | `agent/upstream-u5-generated-selection` |
| Worktree | `.claude/worktrees/u5-generated-selection`, clean before and after review |
| Cumulative diff | 64 files, +4571/-4875 |
| Delta against `2f105ed7` | Two files, +64/-5: Workflow selection/bound setup and its regression suite |

The revision amends the previous feedback commit. Local Git objects establish the exact trees and delta; this review does not transfer the verdict to a future amended or rebased SHA. No production source, branch, worktree or preservation ref was changed by review, and no CI or publication action was performed.

Authority: [frozen U5 handoff](../upstream-u5-handoff-3a1fade9/upstream-repository-prerequisite-u5-implementor-handoff.md), twelve rows U5-1–U5-12, with the bounded [R1–R3 correction](../upstream-u5-review-d2e684e2/planner-review.md) and [R4 correction](../upstream-u5-review-2f105ed7/planner-review.md). The acceptance matrix has not expanded.

## R4 closed: selection and runtime bound retain one reading

`useWorkflowGenerated()` reads `options.requests` into the existing owned bound capture and reads the component extensions once. Its private `selected(components, bounded)` helper derives implicit Fetch membership from `bounds.length`, the same captured value used by the runtime Permissions restriction. The installer no longer sends the original options back through a second request-list reading.

The exported `workflowGeneratedSelection(options)` keeps its signature. Explicit component extensions and normal contextual composition remain. No public protocol, inventory or preflight request authorization was added; the policy remains at the live Permissions boundary.

The retained real Evaluate/Fetch probe now emits:

```text
{"changes":false,"reads":1,"failure":"The HTTP request is not permitted in this scope.","received":[]}
{"changes":true,"reads":1,"failure":"a generated fragment names a component this host did not admit.","received":[]}
```

The stable bounded control still refuses an unlisted destination at the terminal. The accessor-backed input retains its first empty reading, offers no implicit Fetch, refuses by name and sends nothing. [Probe source](bound-reading-probe.ts) and [independent output](bound-reading-probe.log) are preserved.

Committed WGX15 exercises the production helper, canonical public Evaluate and a real loopback server. It asserts zero requests, admission refusal, no Fetch effect and exactly one option read. Its retained before-fix output fails on the performed request, `GET /not-admitted`, rather than only on a counter. Existing WGX7/WGX13 retain the successful non-empty controls. This is discriminating evidence for the frozen U5-5/U5-7 boundary.

## Prior findings remain closed

- R1: authored resolution and descriptive fallback use the detached settled paths, while generated capture owns its pre-policy path copy. EP26 remains unchanged; the supported includes-replacement and no-widening assertions remain intact.
- R2: full-header comparison refuses ambiguous case collisions on both sides. WGX13 uses the actual production policy and transport, and WGX9 mutates a bound within the same live installed scope.
- R3: the REPL uses delegate-first, undefined-only fallback in each entry. Custom narrower and empty selections remain visible to core; an empty one refuses setup.

The two-file final delta changes none of those fixes. Accepted canonical name ordering within class/form order, innermost publication, generated-request refusal normalization and the EL5/EL7 premise changes remain intact.

## Frozen criteria and evidence disposition

| Criteria | Disposition |
| --- | --- |
| U5-1–U5-3: property, whole validation, pre-policy capture and retained actual definitions | Accepted from the complete source review and prior matrix; R1's settled authored path correction remains intact. |
| U5-4: host fallback and execution scope | Accepted with real REPL/custom/empty and isolated host evidence; R3 remains intact. |
| U5-5/U5-7: Workflow vocabulary, live Config/Permissions and exact bounds | Accepted with the corrected single-reading helper, committed WGX15, real terminal controls and affected Workflow commands at this revision. |
| U5-6: owner effects, whole-fragment language/form validation and narrowed descriptions | Accepted; unaffected by the final delta. |
| U5-8–U5-11: replay, current schema, lifecycle and removal of old inputs | Accepted from reviewed source and frozen evidence; affected Workflow storage/journal/effect suites pass after the final change. |
| U5-12: portable/compiled consumers and documentation | Accepted from prior full focused matrix, the inspected bounded delta and current affected evidence. Delivery remains separate. |

## Focused verification

Independently run at the exact reviewed SHA:

```sh
deno task test packages/workflow/tests/generated-observations.test.ts
deno run --allow-all --frozen --node-modules-dir=manual --config deno.json - < /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/upstream-u5-review-2f105ed7/bound-reading-probe.ts
```

The second command ran from the implementation worktree with output retained here; loopback execution used the approved host boundary. Results: Workflow suite **3 passed/15 steps**, and the probe's two cases each read once with zero requests. [Suite output](workflow-regressions.log) is retained.

The Implementor's current affected receipts were inspected and preserved in `implementor-receipts/`:

| Command | Current result |
| --- | --- |
| Workflow generated-observations regression | 3 passed/15 steps |
| Frozen command 5: CLI evaluate-workflow and six Workflow suites | 30 passed/224 steps |
| Frozen command 6: workflow-fetch and workflow-agent | 2 passed/19 steps |
| Prior review's execution-protocol/generated-selection/REPL command | 13 passed/127 steps |
| Check and lint | Reported exit 0; terminal output inspected |

The before-fix probe and red WGX15 output are copied alongside the after-fix logs. The [previous exact-revision review](../upstream-u5-review-2f105ed7/planner-review.md) preserves the full twelve-command receipt baseline, including Node/Bun, build, compiled consumers and docs. Those commands were run at `2f105ed7`; the affected commands above were rerun after the final two-file correction. This PASS does not claim that every earlier command was rerun at `86c10507`, nor require an exhaustive battery merely for feedback confidence.

## Continuity and next action

Planner verdict: **PASS** at `86c10507afba2d166065f76ec41c754e63ebff1e`, tree `f67ea2d90f10453d354267d6add2c1894c12b7bb`, base `3a1fade9246db937e11da6cdadc4751ec924be97`. No unresolved Planner blocker remains. Artifacts and durable receipts are in `.reviewer/upstream-u5-review-86c10507/`.

Next: Architect implementation review and Product Owner review of this exact revision, followed separately by delivery verification and assigned publication/merge actions. A later change returns here only if it materially changes the accepted plan. U5 is not yet landed, and this review authorizes no push, PR, CI inspection, merge or cleanup. #902 stays held until U5 lands; its consumer owner then rebases, removes forwarding and proves the separate integration evidence.
