# Planner review: message correlation and unresolved acceptance at 68547603

PASS at `68547603f280636ea4fce0a1de2ba8b76b3b3636`, parent
`87b25a40915a697a580e619072d433c9c676fec0`, branch agent/issue-883-pr2.
The SSH signature verifies G for tarasm@gmail.com and the implementation
worktree is clean. This accepts the assigned correlation amendment and
unknown-acceptance refusal. It does not declare R2 or the CLI slice complete:
creation-policy compatibility remains with the Architect.

## Accepted behavior

The person-message projection now separates its saved message ID from its
nullable turn association. retainedRequests reads the initiating message or
null-turn feedback record and subsequent records, ending at the next initiating
record in that conversation. Selection, reference and non-null feedback
acknowledgements do not start another request. Other conversations do not end
the current request. No outcome leaves the association unknown; multiple
outcomes refuse rather than selecting one.

Both the detached projection and live lookup use this boundary. turnForRequest
selects the current initiating position, and the owner removes the predicted
turn fallback. A successful prompt without an owned saved outcome refuses
publication; a failed cycle without one reports turn:null. Reference delivery
uses the associated message's actual turn before checking completed input.
Wire schemas and stored field names remain unchanged.

The unresolved-feedback guard runs before holding(), so explicit work on the
active conversation refuses before provider placement, message/reference
writes or another prompt. The independent probe and integrated R2q unknown
prove zero provider traffic and unchanged paired bytes. The completed-turn,
missing-marker control still continues. The earlier failing probe output at
87b25a40 remains the baseline; no production mutation was needed for this review.

## Frozen evidence

All nine assigned commands pass independently: 35 tests and 176 steps.
The seven-file selection contributes 27/154, the unknown probe 1/2, the
unchanged original recovery probe 1/3, and the six unchanged reviewer probes
6/17. No session.ts change occurred, so the conditional controller-consumer
command was not required. No full suite or CI result informs this verdict.

| Command | Independent result |
| --- | --- |
| `deno task test packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-recovery-contract-probe-14ee0d8e.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-metadata-delivery-probe-c5bec458.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-startup-probe-88c482b7.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-stop-join-probe-88c482b7.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-receipt-probe-f5b60c99.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts` | exit 0 |
| `deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-recovery-unknown-probe-87b25a40.test.ts` | exit 0 |

First outputs are preserved in pr2-review-68547603-*-first.log beside this
review. One initial invocation used the nonexistent filename
pr2-unknown-probe-87b25a40.test.ts; its import-error log is preserved and is
excluded from evidence. The corrected, frozen recovery-unknown probe ran
successfully. Implementor-reported check, lint and documentation results remain
separate from these independently rerun focused commands.

MC1–MC4 are present in the existing R2m2 subprocess scenario: cold reopen
retains message 1 with turn:null and no work; the next message has ID 2 and
turn 1 while message 1 stays unknown; the successor establishes orientation
through turn 1 and a third message does not repeat it; the original native-one
continuity, held assertion boundary and no-resend observations remain intact.

The R2d fixture adaptation is accepted as implemented. It inserts the actual
null-turn feedback record before turn 2 and adds person.message to the private
read assertion. Completed reply, completed turns, exact-input delivery and
unestablished assertions remain intact.

The reported old-projection control fails MC1 while ordinary R2m stays green,
satisfying the handoff's alternative mutation requirement. Removing the live
lookup bound reportedly fails no row; this is not claimed as discriminating
evidence. The handoff explicitly assigns that live boundary, same-conversation
filtering, ambiguity refusal and no-guessed-publication path to code review.
The inspected implementation supplies them. No new crash matrix is required.

## Continuity

The accepted vocabulary is carried into the feature prose and approved
message ID/turn registry entries. The Product Owner separately requests a
name interview for retainedRequests after this review. That interview is
pending; this verdict neither settles a new name nor assigns a production rename.

Latest accepted correction: 68547603. Earlier accepted increments and the
passing corrections at 87b25a40 stay closed. R2 cases 2/5/6 are not declared
complete until the separate creation-policy Architect disposition and its
finite evidence are supplied. Section 5, program binding, remaining R3/R4/R5
integration, full terminal R7 and the capture packet remain incomplete.

No production code, test fixture or implementation commit changed during
review. No push, GitHub mutation, CI inspection or memory restructuring occurred.
