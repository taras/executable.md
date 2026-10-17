# Streamed Preview review: PASS at 10b17a40

PV-P1 and PV-E1 are closed. The bounded streamed-Preview slice is accepted
against the frozen PV1–PV5 matrix and completed Architect ruling. No Preview
correction remains assigned. Configure/Retry and all prior accepted slices stay
closed; this is implementation feedback, not merge readiness.

## Exact revision

- SHA: `10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`.
- Parent: `f8b4e035382e22cf0f19b743dcb3b26f3bd4cc02`, preserved.
- Branch: agent/issue-883-pr2, signature G, signer tarasm@gmail.com.
- Implementation worktree: `.claude/worktrees/issue-883-pr2`.
- Clean with no untracked files; six files, +184/−67.

HEAD, parent, signature and clean status were independently checked, including
after the focused runs. The governing records are
[the final correction](pr2-preview-implementor-correction-f8b4e035.md),
[the frozen plan](pr2-section5-preview-planner-handoff.md) and
[the Architect ruling](pr2-section5-preview-architect-decision.md).
The original collision and completed evidence from the
[previous review](pr2-preview-planner-review-f8b4e035.md) remain closed.

## Closed ownership and evidence findings

interrupted() now changes the saved-turn association only when the failure
path supplies an actual turn. Cleanup supplies none and preserves the existing
association. The composition always keys the live item by its registered
response and uses that same key for the saved attempt it actually became in
this process. The saved account supplies failure, Retry and literal text; the
live counterpart is not drawn beside it. Cold readers retain the distinct
saved-turn identity, without inventing a response name or durable mapping.

The unchanged single-item probe captures real owner facts before generation
settles and after the caller and cleanup join. Both arms pass:

```text
failure: response:1 Preview -> response:1 saved Incomplete, exactly one row
success: response:1 Preview -> response:1 reply, exactly one row
```

Both are permanent owner-tier rows using the production sidekickChatRows().
The failed arm also checks the saved failure, Retry association and text.
The earlier artificial live snapshot built from a future response record is
removed. The existing mounted row still proves real generation/evaluation and
acknowledged screen behavior. This implements the accepted finite composition
evidence without adding a debug API, fixture or node framework.

The unchanged original correlation probe also passes both arms, preserving the
real response:2 / saved turn:1 divergence, earlier reply and failed successor.
The repaired identity does not reintroduce the original DUPLICATE_ID collision.

PV5's held-cleanup sibling now samples whether the first prompt has returned,
twice while cleanup is still held, alongside no-Prompt-publication assertions.
The outer test checks `[false, false]` and then true after release. This proves
the prompt's own failure return waits for cleanup, rather than relying only on
callback order or later resource teardown. Existing authoritative failure,
refused successor, unchanged provider traffic and audit/checkpoint control
assertions remain intact.

The new identity/cleanup prose matches these implemented transitions. No
history rewrite, new record, renderer relaxation, public Core/provider change,
authority channel or fixture adaptation is introduced by this correction.
The prior wake-control substitution and three mutation results remain accepted;
their connections did not change and no new mutation battery was required.

## Independent focused evidence

All ten frozen commands and both preserved probes ran at this exact SHA. Each
linked first-output log records its complete invocation. The only repeated
commands were the unchanged lifecycle checks after the L2 failure below.

| Selection | First result | Output |
| --- | --- | --- |
| Core canonical/ordinary consumers | 33 tests / 205 steps, green | [core](pr2-preview-review-10b17a40-core-first.log) |
| Pure preview / disclosure corpus | 7 / 81, green | [policy](pr2-preview-review-10b17a40-policy-first.log) |
| ACP conversation / loaded copy | 4 / 11, green | [ACP](pr2-preview-review-10b17a40-acp-first.log) |
| Workflow checkpoints / CLI hosts | 1 / 29 passed; 3 tests / 1 step failed in this environment | [workflow](pr2-preview-review-10b17a40-workflow-first.log) |
| Mounted Sidekick / owner lifecycle | 22 / 83, green | [mounted](pr2-preview-review-10b17a40-mounted-first.log) |
| Entries / history / controls / output | 51 / 201, green | [entries](pr2-preview-review-10b17a40-entries-first.log) |
| Storage / recovery / configuration | 16 / 89, green | [recovery](pr2-preview-review-10b17a40-recovery-first.log) |
| Ordinary journeys / agent interface / forms | 71 / 185, green | [journey](pr2-preview-review-10b17a40-journey-first.log) |
| Route / layout / source reading | 28 / 130, green | [layout](pr2-preview-review-10b17a40-layout-first.log) |
| Execution / lifecycle | 5 / 38 passed; L2 failed, 1 test / 1 step | [lifecycle](pr2-preview-review-10b17a40-lifecycle-first.log) |
| Unchanged original correlation probe | 1 / 2, green | [correlation](pr2-preview-review-10b17a40-correlation-probe-first.log) |
| Unchanged single-item probe | 1 / 2, green | [single item](pr2-preview-review-10b17a40-single-item-probe-first.log) |

L2 expected Elicit:active:question but observed Elicit:enter at the unchanged
repl-lifecycle.test.ts:130 assertion. Its unchanged isolated rerun passes
1 test / 8 steps in [this log](pr2-preview-review-10b17a40-lifecycle-isolated-rerun.log).
The original full selection then passes 6 / 39 unchanged in
[the full rerun](pr2-preview-review-10b17a40-lifecycle-rerun.log).
The initial failure is preserved in a dedicated
[open local flake record](pr2-repl-lifecycle-l2-flake-10b17a40.md). No source,
assertion, fixture, dependency or environment change was made for the reruns.
Its cause remains unfixed; the green reruns do not close it. U2 did not recur.

Nine selections finish independently green, **238 tests / 1026 steps**, plus
**two unchanged probes / four steps**. That does not mean all first runs passed.
The workflow selection retains the known review-environment npm EPERM under
`/Users/tarasmankovski/.npm/_cacache/tmp` while installing embedded adapters.
The checkpoint publisher and preceding ordinary workflow rows run successfully;
no cache, dependency or production/test workaround was attempted.

For command 4, the Implementor's reported exact-revision pass supplies the
complete focused result: 4 tests / 33 steps. Its reported ten-command total is
242 tests / 1057 steps, all green, plus both probes and check = 0. The Planner
did not independently obtain that all-green workflow result or repeat check.
The permission limitation is recorded, not treated as a Preview production
finding or a condition on this feedback PASS. No full suite, CI, packaging,
capture or delivery result is used.

## Disposition and continuity

Accept the bounded streamed-Preview slice at
`10b17a40fb07eb2fe623c9b4e4a5259d0501fe9a`. PV1–PV5 and the two correction
findings are closed. Hold the clean signed head for the next Planner assignment;
no correction is currently assigned to the Implementor.

Sidekick Sessions integration, remaining complete terminal R5–R8 acceptance,
the 36-frame packet and delivery stay deferred. The separate L2 and U2 flake
records are open; no unrelated repair is folded into Preview acceptance.

Produced artifacts are this review, the L2 local record and updated readiness/
handoff pointers. No implementation edit, commit, push, GitHub mutation, CI
inspection or capture was made by the Planner.
