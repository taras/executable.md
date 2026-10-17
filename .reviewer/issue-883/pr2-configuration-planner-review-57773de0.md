# Configure/Retry correction review: REQUEST CHANGES at 57773de0

C-P2, C-P3, C-P4 and C-E1 are closed. C-P1's model-inspection correction passes,
but its Apply-report correction is incomplete: a successful agent replacement
can leave Configure open, and an old save can close a drawer whose agent choice
has since been edited. Correct that report ownership only. The frozen product
and architecture decisions do not need another interview.

## Exact revision

- Reviewed: `57773de05246578da77c0f8689fbee004cbd84b4`.
- Parent: `d4f38f6e5cc068bb655a48f1e3cf5d90c2437ea2`, preserved.
- Branch agent/issue-883-pr2, signature G, signer tarasm@gmail.com.
- Worktree clean with no untracked files; 11 files, +1144/−98.
- Latest fully accepted prerequisite remains bb60ca35.

No implementation edit, commit, push, GitHub mutation, CI inspection or capture
was made by the Planner. The governing records are
[the frozen plan](pr2-section5-configuration-planner-handoff.md),
[the correction](pr2-configuration-implementor-correction-d4f38f6e.md),
[the timing ruling](pr2-section5-configuration-timing-architect-decision.md)
and [the product decisions](pr2-section5-configuration-product-decisions.md).

## Closed findings and evidence

The preserved d4f38f6e mounted boundary probe passes unchanged, 1 test / 4 steps,
with all four markers corrected. The unchanged writer probe passes 1 / 2.
Their first logs are pr2-configuration-review-57773de0-boundary-probe-first.log
and pr2-configuration-review-57773de0-writer-probe-first.log.

- C-P1 inspection: efforts carry the requested model and are withheld after a
  different selection. Open Configure asks for its saved, initialized model.
  The corrected permanent stale row waits for the held report to arrive.
- C-P2: busy replacement stops and joins before select(), with held cancellation
  and independent admitted-entry evidence. Configure owns a visible Stop and
  withholds old-agent choices when replacement is selected.
- C-P3: occupied() now protects message admission and the explicit job slot in
  both directions, preserving the busy-save exception. A save cannot take an
  inspection/replacement's slot. Admission checks the named conversation.
- C-P4: later answered explicit work retires old Retry eligibility without
  deleting the attempt. Both the preserved probe and permanent transition pass.
- C-E1: required busy replacement, process-produced unknown acceptance, scrolling,
  question preservation, explicit narrow typing, queued-save ordering and
  shutdown/held-inspection observations are present. CFG8's mounted rows live in
  configuration.test.ts rather than storage.test.ts. That is accepted: they use
  the real root path and the same frozen command covers them. Generic R1v still
  supplies writer-level cancellation/ordering controls.

The reported fixture changes are confined to the existing mounted harness:
dataRoot for process-produced reopen, module-scoped SUBMITS, exact-name editing
and visible refusal prefixes. No second host, projection or journal was added.
The root-level busy-refusal assertion changes its diagnostic owner while keeping
its no-provider-work claim. These adaptations are accepted.

## Remaining C-P1: the report does not name the Apply it answers

application.ts applied(), lines 2472–2503, compares only conversation,
model and effort. program.ts's replacement callback, line 2324, sends
`{ model: undefined, effort: undefined }` regardless of the drawer's prior saved
preference. It supplies no agent choice or originating drawer selection.

Two mounted observations reproduce this existing contract violation:

1. Save model=fast, reopen Configure, choose another agent and Apply. The new
   conversation is genuinely activated, but the success is ignored because the
   old drawer still holds model=fast while the replacement report names no model.
   Configure stays open. The exact same replacement with no prior preference
   closes correctly as its positive control.
2. Hold a real preference append after Apply, then edit the agent name before
   releasing it. Model/effort still match the old save. Its success closes the
   drawer and discards the new agent choice. The original correction required a
   late Apply to leave an edited/reopened drawer alone; that is still unmet.

```text
replacement: { preference: true,  activated: true, drawerStillOpen: true  }
replacement: { preference: false, activated: true, drawerStillOpen: false }
laterAgentEdit: { saved: true, drawerStillOpen: false }
```

The new [Apply report probe](pr2-configure-apply-report-probe-57773de0.test.ts)
runs against the reviewed source. First output is preserved in
pr2-configure-apply-report-probe-57773de0-first.log: two regressions fail and the
ordinary replacement control passes. The activation record and held append
establish readiness; bounded waits observe the consequent UI result.

These are not settings permutations added to acceptance. The same report shape
is being used for two different operations, and it omits an editable choice that
already belongs to its originating Apply. Bind the outcome to that operation
and still-current drawer selection. A deliberate reopen must not become the
old Apply merely because its scalar values happen to match.

## Independent focused commands and U2

All six frozen selections ran against this exact revision; full first output
is retained as pr2-configuration-review-57773de0-<selection>-first.log.

| Selection | First result |
| --- | --- |
| mounted | 20 tests / 72 steps, green |
| entries | 51 / 201, green |
| recovery/configuration | 16 / 86, green |
| journey/interface/agent-journey/forms | 70 / 184 passed; U2 failed, 1 test / 1 step |
| layout | 28 / 130, green |
| execution/lifecycle | 6 / 39, green |

U2 failed at the existing assertion that the separate build turn is visible,
repl-agent-interface.test.ts:1524. That test file is unchanged. The unchanged
isolated rerun passes 14 / 40; its output is
pr2-configuration-review-57773de0-agent-interface-rerun.log. The complete
selection also passes unchanged, 71 / 185, in
pr2-configuration-review-57773de0-journey-rerun.log. The final green selections
cover **192 tests / 713 steps**; they do not replace the first failure.
[The existing local flake record](pr2-mounted-permission-u2-flake-a438905f.md)
now includes this recurrence. Its cause remains unfixed. This is separate from
the deterministic Apply failure, and no U2 fix or assertion change is assigned.

The Implementor's check = 0 and five discriminating mutations are reported;
the Planner did not repeat those mutations or check. No broader runtime/CI
evidence is used. Focused validation remains separate from delivery.

## Disposition

Execute [the narrow Apply correction](pr2-configuration-implementor-correction-57773de0.md)
from this signed head, preserving it. Keep C-P2/C-P3/C-P4/C-E1 and the writer
corrections closed. Return one signed correction with the six final focused
commands and preserved probes. The bounded Configure/Retry slice remains
unaccepted until C-P1's Apply behavior passes. Deferred features and delivery
remain unopened.
