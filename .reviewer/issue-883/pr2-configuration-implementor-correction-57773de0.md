# Implementor correction: bind Apply's answer to the Apply that asked

**Closed: PASS at 81523318, 2026-10-14.**
[The review](pr2-configuration-planner-review-81523318.md) accepts the correction
and the bounded Configure/Retry slice at signed clean
`815233183c7c26cd40544347191b7ba5e1f975c3`, parent 57773de0. No correction is
currently assigned; the instructions below are the completed assignment.

Correct the remaining C-P1 Apply-report finding from signed clean
`57773de05246578da77c0f8689fbee004cbd84b4`, parent
`d4f38f6e5cc068bb655a48f1e3cf5d90c2437ea2`, branch agent/issue-883-pr2,
in `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Follow .agents/implementor.md. Verify HEAD/tree, preserve both signed commits,
and reconcile later changes without reset, amend or discard.

Read the main-checkout records:

- `.reviewer/issue-883/pr2-configuration-planner-review-57773de0.md`
- `.reviewer/issue-883/pr2-section5-configuration-planner-handoff.md`
- `.reviewer/issue-883/pr2-section5-configuration-product-decisions.md`

The existing contract is settled: success closes its own Configure selection;
failure keeps it open with its reason; a late answer cannot close or overwrite
a selection since edited, repointed or deliberately reopened. Preference Apply
and agent replacement are different operations. Old-agent preferences are not
settings to apply to the replacement, but their presence cannot make a
successful replacement's UI result disappear.

## Required work

1. Carry the originating Apply and its complete relevant selection through the
   root job/report. Distinguish preference-save completion from replacement
   completion rather than treating every answer as a model/effort save. Include
   the agent choice where it is part of what the person is applying.
2. Apply success/failure only to the still-current selection that asked for it.
   An unchanged replacement closes on success even when the prior conversation
   had a preference. A slow preference save does not close a drawer whose agent
   choice was edited while it ran. Reopen/close invalidation is about which
   selection asked, not equality of its values. Local types/factoring remain
   delegated; no public Core/ACP API, durable identity or record change.
3. Preserve physical-save completion, requested-versus-verified facts, explicit
   Stop/join, shared admission, failed-setup association and composer/takeover
   behavior. This is report ownership, not cancellation/rollback of an already
   acknowledged save or a new preference reset policy.
4. Run the new probe unchanged and promote its two regressions and ordinary
   replacement control into the existing mounted configuration tier. Its parent
   failure log supplies the discriminating broken baseline; no new mutation
   battery or settings matrix is required. Keep C-P2/C-P3/C-P4/C-E1 and their
   accepted assertions intact. Align only prose affected by this correction.

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-configure-apply-report-probe-57773de0.test.ts
```

Rerun both preserved older probes and the six frozen commands after the final
edit. Do not repeat the five reported mutations unless their connections change.
The earlier boundary probe passing is not evidence for the new Apply cases.

Preserve first failure output. The existing U2 permission intermittence recurred
in review and passed its unchanged isolated rerun; see the local flake record.
Do not alter its assertion or fold an unrelated flake repair into this commit.
Report any recurrence and unchanged rerun separately within the existing
no-GitHub-mutation limit.

Commit promptly with signing enabled once focused evidence passes. Return exact
SHA, parent, branch, signature, clean/untracked status, all commands/results,
the Apply row mapping and adaptations. Continue to that signed handback without
ending after individual files/rows; return early only for a concrete contract
conflict needing a ruling. No new product or architecture ruling is needed for
the reproduced finding.

No preview, Sessions integration, complete terminal packet, capture, push,
GitHub mutation, CI inspection or main-checkout production edit. This narrow
correction does not reopen the other closed findings or prior accepted slices.
