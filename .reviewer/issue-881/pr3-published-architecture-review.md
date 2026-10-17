# PR 3 architecture review — #887

**PASS** on `a9905f3cb93970206f06468164a7aa9021ad87d5`.
The recorded-order History rail preserves the accepted navigation, retained
identity, inspection and measured-frame boundaries. No architecture blockers
remain at this commit.

## Reviewed boundary

Reviewed [PR #887](https://github.com/taras/executable.md/pull/887) on 2026-10-10
against main `9fe494d78d1b2f65d8efb12fffae5ea68da6c17b`. Its exact parent is
`525415f739fc0dc0be530fa1528ea5830689af88`. The PR head and base were checked
again during verification and remain unchanged.

#885 and #886 have merged. Main's #886 squash tree is byte-identical to
`ecca5c459b77bed653bcdeab5efd4f9ab656bb2e`, the accepted PR 2 correction.
The published PR 3 tree differs from accepted Planner feedback
`05ba70d567cb80be4bfdea67e7ae0267376e2376` only in the three previously reviewed
PR 2 files: the lifecycle test cleanup, component failure reconciliation and its
regressions. All PR 3 implementation bytes match the accepted feedback.

The actual tree delta against current main contains 20 files. The branch still
has the earlier stack ancestry; the hosting service's merge-base file listing
includes predecessor changes. This review uses the current main tree and
explicit predecessor comparisons to distinguish the slices.

#889 depends on this exact #887 head and changes overlapping private REPL
fitting/application code. It is subsequent work, not a dependency or part of
this verdict. The separate #805 session-rendering proof retains its test-only
boundary. No newer reference feature enters the original #881 contract.

Authority: [pr3-history-contract.md](pr3-history-contract.md),
[pr3-planner-handoff.md](pr3-planner-handoff.md), and
[pr3-implementation-handoff.md](pr3-implementation-handoff.md), including the
recorded pause-evidence correction. The seven structural checks remain frozen.

## Structural findings

1. **Retained identity and one snapshot.** `session.reading(at)` builds the
   full validated model and selected prefix from one acknowledged-array slice.
   Its cached Result narrows the pair together. The root carries that reading
   through resolution, measurement, paint and resize; it does not fetch fresh
   navigation after a suspending size read. Later malformed records refuse
   earlier readings too. The admitted-session refusal path wakes the root and
   selects the refused view, which has an empty model and navigation.

2. **Inspection reachability.** Navigation copies and freezes only marker and
   kind. Generic drawer wording derives checkpoint and entry ordinals from
   that thin list rather than future labels or payloads. Head state is consumed
   by the band. Other panes retain the prefix model and historical live-overlay
   suppression; the historical action row receives no new execution controls.

3. **Execution ownership.** Head derivation uses full retained entry/outcome
   facts plus the actual session-owned liveness and expansion controller.
   Retained outcome with owned teardown remains SETTLING; success, failure and
   cancellation become neutral SETTLED after release. Missing outcome without
   owned work is UNFINISHED. The existing entry finalizers, submission slot,
   cancellation and fatal-precedence correction retain their owners. The band
   supplies no execution capability.

4. **Persistence and reconstruction.** History adds no durable event, sidecar,
   timestamp, protocol, source load or provider call. Settled cold inspection
   projects retained facts and uses the same grouping. Existing unfinished-run
   resumption remains a separate session policy.

5. **Root and child flow.** The root resolves exact marker selection. Immutable
   navigation passes through the application view to History composition;
   drawer actions carry their original marker back up. The full model remains
   private to projection, and neither band, drawer nor renderer acquires a
   Journal, session or controller handle.

6. **Measurement and mounted targets.** The engine measures caption widths
   before rail allocation. Grouping changes visual membership and placement,
   never checkpoint identity. Every checkpoint retains its own drawer action.
   The prepared rail supplies inert text/roles through existing frame assembly;
   it mounts no actions or pointer targets. Drawer windows and absent narrow
   outlets retain measured admission and mounted-tree ownership. Resize
   preparation reuses the resolved reading and revalidates terminal size before
   reconciliation; Freedom retains focus.

7. **Resources and concurrency.** Rebuilds use the existing session/controller
   wakes. History introduces no production host reader, polling loop, frame
   subscription or observer owner. Existing scope-owned input/frame lifetimes
   and session teardown remain intact. The controlled teardown fixture holds a
   real installation's cleanup rather than fabricating a head state.

The architecture and REPL specification changes describe the explicit History
navigation exception and preserved prefix restrictions. No new architecture
decision or amendment is needed.

## Independent focused evidence

Prepared an isolated detached worktree at the exact reviewed head with
`deno task setup`, then ran both unchanged frozen commands:

```sh
deno task test packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-model.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-composition.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-journey.test.ts
# exit 0 — 99 tests / 312 steps
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-agent-journey.test.ts
# exit 0 — 19 tests / 111 steps
git diff --check 9fe494d7 a9905f3c
# exit 0
git diff --exit-code ecca5c459b77bed653bcdeab5efd4f9ab656bb2e 9fe494d78d1b2f65d8efb12fffae5ea68da6c17b
# exit 0 — accepted predecessor tree matches main
```

Total: **118 tests / 423 steps**, all passing. Saved outputs:
[History and root journeys](evidence/pr887-architecture-focused.log) and
[source/forms/Agent regressions](evidence/pr887-architecture-regressions.log).
The isolated checkout `/private/tmp/xmd-pr887-architecture-review` remains clean.

The focused cases exercise same-category grouped selection with distinct
prefixes, full navigation beside earlier content, malformed later records before
and after admission, actual session head/cleanup, mounted window/resize behavior
and settled cold reconstruction without provider/source activity.

[Planner acceptance](pr3-planner-acceptance.md) supplies the independent visual
review of all 77 pairs, five control records and actual live selection/teardown
evidence. Its documented source-equivalence and corrected wide grouping counts
remain attached to their actual revisions. This review neither recaptured the
gallery nor reclassified earlier captures as captures from the published head.
Product appearance and ordinary evidence sufficiency remain Planner feedback.

No production changes, GitHub review publication or CI inspection were performed.

## Continuity

PR 3 architecture review is complete at `a9905f3c`. The original three parity
slices now have architecture acceptance at their recorded revisions. This
review performs no merge, closes no issue and does not cover dependent #889.
The delivery and publication boundaries remain separate from this architecture
verdict.
