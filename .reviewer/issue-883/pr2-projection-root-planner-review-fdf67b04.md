# PR 2 projection, root wiring and recovery sequencing

REQUEST CHANGES on the cold projection at
`fdf67b0417147aef4447a56d4555133d27df85c1`.
The storage-selection wiring and path-helper changes pass their scoped review.
The control intent/outcome split is accepted.

Reviewed commits:

- `45662f81732eeed78d7a6711f8be068397d701c9`, parent
  `43d53df757bcbec6fb4af1e5060313f835e72ad2`: projection and schema split.
- `fdf67b0417147aef4447a56d4555133d27df85c1`, parent `45662f81`: root
  repository selection and test path helpers.

## Accepted choices and scope

Separating a control's acknowledged intent from its later outcome implements
the existing control intent/outcome family and the accepted interruption
behavior. It needs no architecture amendment. The unmerged format has no
released migration requirement.

The changed test helpers locate execution identifiers and entry histories in
the agreed layouts. Inspection found no weakened behavioral assertions. The
root now selects the paired repository before opening the entry session;
new-pair publication and legacy reading remain in that repository. This accepts
the storage-selection change, not the unfinished Sidekick admission gate,
upgrade integration or conversation owner.

## P1 — Cold projection does not validate canonical turn references

`sidekick/model.ts:256` counts canonical events but never reads their Prompt
facts. At line 261, a response is published into chat without establishing the
completed canonical turn it names. At line 313, any local feedback record with
a non-null turn becomes a `delivered` fact without canonical acceptance.

The existing storage contract requires validating order and references before
presenting a valid history. Its response family names an owning completed
canonical turn, and its feedback family expressly requires canonical turn
identity/acceptance rather than a local delivery claim. These are existing
section 2 and R2 requirements.

The focused pure projection probe supplies schema-valid records after a valid
publication and conversation preparation/activation:

1. A feedback marker names turn 1, while the conversation has no canonical
   Prompt events. The reading reports feedback delivered for turn 1.
2. A response names turn 1, again with no canonical Prompt events. Projection
   succeeds and publishes its reply instead of refusing the absent owner.

Both assertions fail at the reviewed revision. An empty published pair projects
successfully as the positive control. The probe is a diagnostic unit test; it
does not substitute for any fresh-process R2 case.

Resolve the owning canonical records before publishing these claims. Core
already exports `AGENT_PROMPT`, `parsePromptRecord` and `PromptRecord` through
`@executablemd/core/host`; a new Core interface or a second Prompt parser is not
needed. Keep projection pure. Do not open a Core conversation or a provider to
validate retained records, infer acceptance from an ordinal alone, or treat a
local marker as independent evidence.

No test in this commit imports `projectSidekick`, and the root does not yet call
it. The existing REPL passes therefore preserve the entry behavior but do not
establish the new cold projection's behavior.

## R2 implementation order

Deliver recovery evidence as its production boundaries become available:

| Case | Production boundary needed | Delivery point |
| --- | --- | --- |
| 1 | Real pair publication and writer handoff | Now |
| 3, 4 | Root-owned Submit reservation, admission and cold reconciliation | With section 3 |
| 2, 5, 6 | Conversation owner, response work and canonical feedback acceptance | With section 4 |

Do not defer all R2 work. Start case 1 now, then continue section 3. Cases 3 and
4 cannot be counted complete by manually appending a Submit intent and an entry
to real files: that would omit the production reservation, admission and
reconciliation path they prove. Storage fixtures can be prepared earlier, but
the accepted evidence still goes through that actual path and a subprocess
restart. The same rule applies to the owner-dependent cases. R2 remains open
until all six cases pass. The frozen criteria and final PR 2 threshold are
unchanged.

## Evidence

Independently run at `fdf67b04` in `.claude/worktrees/issue-883-pr2`:

```sh
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/repl-agent-interface.test.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section2-storage.probe.ts
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-projection-fdf67b04.probe.ts
```

The selected storage and three changed integration suites pass: 64 tests,
148 steps. The unchanged section 2 probe passes: one test, six steps.
The new projection probe fails two assertions and passes its empty-pair
control. Its first output is preserved in
[pr2-projection-fdf67b04.probe.log](pr2-projection-fdf67b04.probe.log); the
[source](pr2-projection-fdf67b04.probe.ts) is retained beside it.

The Implementor reports the other REPL suites, Node/Bun storage and lint/check
passing. This review independently ran only the focused Deno commands above.
No CI was inspected. HEAD and the clean implementation worktree remained at
`fdf67b04` throughout verification.

## Revision prompt

From `fdf67b04`, correct `projectSidekick` so published response and feedback
claims are checked against the owning canonical conversation/turn records.
Use Core's public Prompt record reader. Refuse an absent or inconsistent
completed-response owner, and never report a local delivery marker as canonical
acceptance. Preserve pure, detached, immutable projection and the accepted
intent/outcome split.

Add the two demonstrated reference regressions to the relevant Sidekick tests.
Retain the empty-pair control, and include a valid canonical-turn control so
the correction does not simply suppress all replies or delivery facts. Run the
focused affected tests and the unchanged storage probe, then return the exact
feedback SHA/parent and commands/results. Full R2 still uses the real production
paths and fresh-process boundaries; these projection checks do not replace it.

## Continuity

Foundation: accepted `43d53df7`, on Core `79d404d0`.
Reviewed head: `fdf67b0417147aef4447a56d4555133d27df85c1`.
Accepted: record split, paired root selection and path-helper adaptations.
Remaining review blocker: canonical-reference validation in the cold projector.
Next action: correct that projection and deliver R2 case 1, then section 3 with
cases 3/4, followed by section 4 with cases 2/5/6. The remaining R1–R8 and
36-frame evidence still close the complete CLI PR.
