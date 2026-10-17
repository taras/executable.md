# Implementor correction: complete the frozen Configure/Retry contract

Reviewed at 57773de0: C-P2/C-P3/C-P4/C-E1 and model-inspection ownership are
closed. C-P1 Apply-report ownership continues in
[the narrow correction](pr2-configuration-implementor-correction-57773de0.md).
Execute that prompt from 57773de0; this document is the prior correction scope,
not an instruction to restart or reopen the closed findings.

Work from signed clean `d4f38f6e5cc068bb655a48f1e3cf5d90c2437ea2`, parent
`bb60ca35661c2988ef647cc7a456470482d06e2e`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Verify HEAD/tree and reconcile any advancement without reset or discard.
Follow .agents/implementor.md. Preserve d4f38f6e; do not amend it.

Read in the main checkout:

- `.reviewer/issue-883/pr2-configuration-planner-review-d4f38f6e.md`
- `.reviewer/issue-883/pr2-section5-configuration-planner-handoff.md`
- `.reviewer/issue-883/pr2-section5-configuration-timing-architect-decision.md`
- `.reviewer/issue-883/pr2-section5-configuration-product-decisions.md`

The verdict is REQUEST CHANGES. All six commands independently pass 191 tests /
699 steps and the old writer probe passes. Those totals do not establish the
missing boundaries. This correction restores the already frozen contract;
product and architecture decisions remain settled.

## Required corrections

1. **C-P1, model/report ownership.** offering() must not tag an old inspection's
   levels as the currently selected model's. Use the originating model and
   conversation/selection; discard superseded results instead of relabelling
   them. Opening Configure must inspect the model the initialized drawer is
   actually showing, including saved preferences. Correlate Apply reports as
   well, so a previous Apply cannot close or overwrite a newly opened/edited
   drawer. Preserve close-discard and requested-versus-verified semantics.
2. **C-P2, busy agent switch.** The mounted Stop and start new conversation
   action must call and join owner.stop() before owner.select(). Do not weaken
   the owner's busy select refusal. Hold cleanup and prove no replacement or
   successor before join, with an admitted entry still running. Add the
   applicable Stop row inside Configure and disable old-agent model/effort
   choices for a different-agent replacement. Failed setup keeps the old active
   association; switching sends no model prompt.
3. **C-P3, shared root admission.** Send/Retry must refuse before any message
   append/acknowledgement or provider work while an explicit configuration job
   owns admission. Inspect/setup/replacement must likewise respect the message
   reservation, with the accepted busy replacement taking the Stop/join path.
   A save alongside an already-admitted cycle remains permitted. Validate the
   configuration action's captured conversation before starting, not merely
   store its name in the job. No queued Send or retargeted stale Apply.
4. **C-P4, stale Retry.** After a successful later explicit message, the previous
   failed request stays in history but no longer offers or accepts Retry.
   Reject stale activation using the same eligibility read the row uses. Keep
   the exact saved-text retry, single-cycle reservation, composer preservation,
   draft-revision acknowledgement and all acceptance/integrity refusals.
5. **C-E1, assigned evidence.** Complete the missing CFG4/CFG5/CFG6/CFG8/CFG9
   observations listed in the review. In particular, Control-C without any
   admitted job is not a control for cancelling a held inspection/setup, and an
   unapplied choice is not a waiting save. Keep the successful existing Exit
   join, R1v, CFG3 pair, R7 adaptation and previously accepted assertions.

Run this preserved four-step probe from the implementation checkout:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configure-boundaries-probe-d4f38f6e.test.ts
```

Promote its existing-boundary regressions into the frozen destinations with
positive controls. For the stale-inspection row, wait for the held result's
application rather than a predicate already true before release. Reuse idle
replacement, ordinary Send and current eligible Retry as controls rather than
building a second harness. The review records why two initial probe literals
were adapted for clipping; the current probe is the preserved correction input.
If a necessary probe adaptation is found, report it before interpreting results.

CFG1–CFG9 and the six commands remain the finite acceptance threshold. The
review restores missing observations; it does not assign a new matrix. Repeat
only discriminating mutations whose changed connections require it, preserving
applied-diff confirmation and first output. Restore byte-identically. Align
architecture.md/specs/repl-spec.md with corrected behavior where their prose
currently promises protection not present in the root.

Run all six frozen commands after the final edit and rerun the unchanged writer
probe. Preserve failure output before any rerun. Commit promptly once that
focused evidence passes, signing enabled. Return exact SHA/parent/branch,
signature, clean/untracked status, all commands/results, C-P1–C-P4/C-E1 and CFG
mapping, controls and every fixture/assertion adaptation. Do not stop after
individual files or rows merely to report progress; continue to the signed
handback unless a concrete existing-contract conflict requires a ruling.

Do not add a public Core/ACP API, provider route, new record format, reset policy
or authority workaround. No preview, Sessions integration, full terminal packet,
captures, push, GitHub mutation or CI inspection. No main-checkout production
edit. The earlier acceptances remain closed and this slice remains unaccepted
until reviewed at its new signed feedback SHA.
