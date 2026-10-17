# Submission identity review — REQUEST CHANGES

Reviewed f83e35549dcddad0791f9492b8cdfe56dd7b4bf1, parent
940249af47159a3bbd960b8ca8df3f10bb53811c, on agent/issue-883-pr2.
Signature G / tarasm@gmail.com; the implementation worktree is clean.

The production correction satisfies the intended data-flow change. Two bounded
test/evidence corrections remain before this becomes accepted integration base
C. Neither requires changing the production behavior.

## Production assessment

The Sidekick adapter reads reading(undefined) when submitForSidekick asks for
entries, after writer.settled() and the second readiness check. Its Result is
propagated before take(); there is no suspension between the read/count and
reservation. Prefix measurement and intent publication retain their ordering.

Cold reconciliation now receives all acknowledged entries and propagates an
unreadable reading through the existing admission block. The person's Run
uses the same acknowledged basis. Session.model and frozen display semantics
are unchanged. Receipts and output-read targets still use submission.entry and
its task-bound join. No provider, record format or alternate identity authority
changed.

HI1's actual intent and feedback assertions, HI2's failed receipt and HI3's
frozen/live journey support these changes. The acknowledged limitation of HI3
is appropriate: its private ordinal is established by source review, not by a
new inspection API. The existing refusal and actual-start boundaries remain.

## HI-P1 — parse the new recovery evidence

repl-sidekick-recovery.test.ts:1906 and :2010 add
`JSON.parse(line) as DurableEvent` in frozenLocation() and mountedEntries().
These new assertions bypass the repository's explicit parse-to-infer rule at
the boundary the evidence reads. Earlier casts elsewhere do not authorize new
ones.

Use the existing exported parseEntryRecords(body) from sidekick/history.ts,
which validates each durable event and returns DurableEvent[]. Feed that typed
result to projectRepl. Do not replace the casts with another unchecked helper,
assertion or locally duplicated parser. This changes test input reading only.

## HI-E1 — establish the promised cold boundaries

The new HI4/HI5 rows reach the correct production cold adapter and discriminate
its opening-prefix bug, but several assertions do not establish their comments
or the frozen evidence:

- Before/after cold opening compares chat record kinds and entry keys. Neither
  proves that both files stayed byte-identical, as HI4/HI5 require.
- The final no-repeat assertion counts FIRST, the first prior source. The
  reservation's actual source is the phase's `Reserved body.\n`; counting the
  earlier source does not establish that this reserved work stayed absent or
  occurred once. Read that source from the actual retained Submit intent rather
  than duplicating the phase's constant.
- The finding and ordinary entry are read after both complete. That proves
  their existence, not that the finding was acknowledged before new admission.

Strengthen these existing two rows, without adding a new product journey:

1. Snapshot exact entries.jsonl and sidekick.jsonl bytes before mounting and
   compare after the cold opening, before any explicit mutating action.
2. Read the actual reservation's entry/source and assert its source occurs once
   in the admitted arm and zero times in the absent arm, before and after the
   ordinary successor. Retain the correct successor id/source assertions.
3. Use the existing append instrumentation or operation gate to observe the
   retained finding before the ordinary entry's admission is allowed to land.
   Assert the finding's actual outcome/observed entry, then release and assert
   the successor. A Promise append already handed to the filesystem is not a
   cancellable before-admission gate.
4. Keep cold provider inactivity observable through the existing fake runtime,
   ensure/session and turn counters, rather than a turn count alone. Reading
   creates no provider work. Keep the current real subprocess-produced history.

No production test hook, new writer, second projection or extra scenario is
required. Existing head-opening R2i/R2j and changed-history R2k remain controls.

## Independent verification

All three assigned commands ran once at the reviewed head. Their complete first
outputs are preserved:

| Command from the HI handoff | Result | Output |
| --- | --- | --- |
| 1 — mounted Sidekick / journey / lifecycle | exit 0; 35 tests / 128 steps | [first log](pr921-historical-identity-review-f83e3554-command-1-first.log) |
| 2 — recovery / controls | exit 0; 14 / 72 | [first log](pr921-historical-identity-review-f83e3554-command-2-first.log) |
| 3 — entries / history / ordinary journey | exit 1; 64 tests / 164 steps passed, EH1 and UI10 failed | [first log](pr921-historical-identity-review-f83e3554-command-3-first.log) |

The Implementor's supplied 940249af baseline was inspected: the same EH1 and
UI10 failures, with the same truncated labels, occur before this correction.
The affected entry tests and fitting/application code are unchanged by this
commit. No old checkout was modified or rerun by this review. The failure is
pre-existing relative to f83e3554, not established as predating #921.

Those two rows remain an open branch-level test/fitting follow-up. They are not
assigned to this evidence correction, and command 3 is not reported as green.
Their exact onset and whether the product or test preparation needs correction
require a separate bounded assessment. No speculative bisection, expectation
weakening, GitHub issue or production repair is authorized here.

The reported check result is Implementor evidence and was not repeated. No full
lint, runtime suite, CI, publication or dependency action was performed.

## Correction and next action

Execute [the evidence correction prompt](pr921-historical-identity-evidence-correction-prompt-f83e3554.md).
Preserve f83e3554 and its parent; return one signed successor. Only the existing
recovery tests need change for HI-P1/HI-E1. Run the handoff's command 2 against
the final correction. Commands 1 and 3 need not be repeated if their source
boundaries remain untouched; retain the exact results above, including red
command 3. This is the Planner's explicit proportional amendment to feedback
verification, not an implicit waiver of the branch's failing tests.

Integration remains queued. C is not accepted at f83e3554 yet. The production
finding needs no further design; finish this small evidence correction before
the integration release. Keep #922, B–D and other agent feedback separate.
No production, implementation-worktree, branch or remote state was changed by
this review.
