# Planner review: feedback corrections at f5b60c99

REQUEST CHANGES at `f5b60c9957e7cc08ef0748e7144425d4b9921ee2`, parent
`97f8cb794752bc89047cea13d618aba8bce28be2`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. The original designation omission and missing pre-reservation
refusal feedback are fixed. Two requirements of the assigned receipt correction
remain unmet; the feedback increment is not accepted yet.

## Corrected boundaries

One DESIGNATED set now drives both responseSurface and feedback. Bindings,
EntryInput, Submit and EntryOutput join the existing reference/help results;
canonical Syntax remains admitted with ordinary render/capture and no feedback.
The four original regression steps and Guide control pass unchanged.

Successful values come from their own retained facts: the detached binding map,
the fixed draft acknowledgement, the Submit intent's entry plus terminal outcome,
and the EntryOutput snapshot rendered through the shared window formatter.
The successful Submit runs one entry and delivers its completion/read receipt
without echoing source/output. The corrected journey preserves the single pair,
draft clearing, completed-turn ownership and ordering assertions.

An ordinary Submit refusal before reservation reaches the next turn without
writing a control pair or claiming an entry. The owner carries its reason and
position into the sealed feedback, whose existing claim precedes the provider
prompt. This preserves admission ordering, prompt busy refusal and the accepted
reserved-Submit pair. The clearer empty-draft sentence preserves the existing
journey assertions. Original review P2 is closed.

The loop, Output-only chat, canonical delivery proof and authoritative fatal
paths remain intact. No accepted admission or Core boundary is reopened.

## R1: a failed admitted entry is labeled an admission refusal

`designatedResults` derives outcome="failed" directly from the control's
retained Result. An actual entry failure also has that Result, even though its
intent reserved an entry and its observed terminal status establishes that the
entry ran. `submitted` correctly renders the entry receipt, but sealedFeedback
then prefixes every failed Submit with REPL.Submit refused.

The real-owner probe admits and runs one entry whose eval throws. The model
has entry-1 with terminal status err, the draft is cleared, and the next turn
receives:

```text
## REPL.Submit

REPL.Submit refused: Entry entry-1 failed.
It failed: entry failed on purpose
Read what it printed with <REPL.EntryOutput entry="entry-1" limit={4096} />.
```

This contradicts the accepted distinction: a refusal admits nothing and leaves
the draft available, while this entry already ran and failed. The receipt
requirement was explicit in the previous correction prompt and
[remaining-architecture.md](remaining-architecture.md) part 2. Preserve the
retained failed Result; classify the derived terminal receipt separately from
an admission refusal so the agent receives the actual entry outcome without
the false refusal prefix. Genuine refusals must continue saying refused.

## R2: JSON values under headings have no data fence

Bindings alone correctly remains directly parseable JSON. In a mixed batch,
sealedFeedback emits the same JSON text under a heading without fencing it.
The accepted multi-result presentation explicitly requires fenced JSON and a
fence longer than any content run. This was also explicit in the correction
prompt, rather than a new formatting preference.

The probe first runs a real entry publishing note="a literal ``` run", then
requests Bindings and Environment. Their headings are in the correct order,
and the actual detached map is present, but its section is an unfenced object.
Preserve the distinction between JSON values and canonical reference text when
formatting the batch. Fence the JSON section adequately; leave the single raw
JSON result and canonical Markdown/reference formatting unchanged.

## Independently rerun evidence

All commands ran from `.claude/worktrees/issue-883-pr2` at the reviewed SHA.

| Command | Result |
| --- | --- |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts | 1 test, 5 steps; passes unchanged |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts | 1 test, 3 steps; passes unchanged |
| deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts | 23 tests, 120 steps; passes |
| deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts | 38 tests, 146 steps; passes |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-receipt-probe-f5b60c99.test.ts | Empty-draft refusal control passes; two regression steps fail |

The four assigned commands pass 63 tests/274 steps. Logs are
`pr2-feedback-review-f5b60c99-{contract,owner,feedback,consumers}.log`.
The [receipt probe](pr2-feedback-receipt-probe-f5b60c99.test.ts) and its
[first output](pr2-feedback-receipt-probe-f5b60c99-first.log) preserve the two
remaining failures. It uses the same production owner/session/repository/profile
harness, with only the provider scripted. Positive observations establish the
failed entry's actual terminal and the published JSON value before the respective
negative assertions fail. No production mutation was used in review.

## Continuity and next action

Exact reviewed head is f5b60c99; latest fully accepted owner increment remains
94acc66c. Original P2 is closed, and P1's designation/successful-control delivery
is corrected; its entry-outcome distinction and multi-result JSON presentation
remain incomplete. These are existing requirements, not new product decisions,
architecture choices or a new permutation matrix.

Produced artifacts are this review, the
[remaining correction prompt](pr2-feedback-receipts-implementor-prompt.md),
the receipt probe/first output, passing focused logs and updated planner-handoff.md.
Preserve the correction and hand back a signed revision fixing R1/R2 before
continuing. Stop, Sidekick Elicit, configuration, metadata refresh, program
binding, R2 interruption cases 2/5/6 and section 5 remain incomplete. Earlier
accepted slices and interruption cases 1/3/4 stay closed. This review changes no
production code and grants no push, GitHub or CI authorization.
