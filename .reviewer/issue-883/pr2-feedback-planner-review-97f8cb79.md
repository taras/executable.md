# Planner review: feedback increment at 97f8cb79

REQUEST CHANGES at `97f8cb794752bc89047cea13d618aba8bce28be2`, parent
`94acc66c8feb4f89c0d6d4d6b1ca8b5432390be6`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the implementation
worktree is clean. Section 4's first owner increment remains accepted at 94acc66c.
This feedback increment is not accepted.

## P1: four accepted controls never deliver their results

The accepted feedback list in [remaining-architecture.md](remaining-architecture.md)
part 2 includes Bindings, EntryInput, Submit and EntryOutput. The
[syntax-discovery amendment](syntax-discovery-amendment.md) extends that list
with guide chapters and Environment; it does not withdraw the original members.
Read/write admission classes do not decide feedback designation.

`controls.ts`'s DESIGNATED set contains only REPL.Syntax, REPL.Environment and
Guide.*. `feedback.ts:188` drops every other retained control outcome. With no
remaining result or root failure, sealedFeedback returns undefined and the
exchange ends. A Bindings read, a successful fill/Submit and an EntryOutput read
each send only one provider turn in the real owner path. The entry still runs
once, but the agent never receives its completion/read instruction. Output-only
chat correctly hides the body, so the agent cannot discover those results there.

The new prepare/Submit assertion requiring one turn and zero feedback records
asserts the opposite of the accepted contract. Its reported mutation control
therefore protects an incorrect premise. Correct that assertion; do not treat
this as a new product choice or intercept ordinary component returns.

Adding names to DESIGNATED alone is insufficient. The current formatter reads
only observed, falling back to JSON null. EntryInput records no observed value;
Submit retains a terminal status rather than its complete agent-facing receipt;
EntryOutput retains a structured snapshot rather than its rendered window.
Derive the accepted values from their retained facts: Entry input updated.; the
exact entry's completion and read instruction; and the pinned, fenced output
window. Bindings remains the detached map. A failed admitted entry remains an
entry outcome, distinct from refusing admission. Several results retain invocation
order, short component headings and safe fences for JSON values.

## P2: a Submit refused before reservation has no correction turn

A reply containing only REPL.Submit with an empty draft renders the ordinary
refusal but sends no next turn. `submitForSidekick` correctly returns before
writing a reservation/control pair. The delegated control renders that Result
failure as body text; the root itself succeeds. Neither designatedResults nor
the root-failure branch supplies feedback. With no Output region, this attempt
is invisible to both the next provider turn and person-facing chat.

The existing contract requires admission refusals to return their reason for
automatic correction. Preserve the accepted admission boundary: a busy or
otherwise unavailable request does not queue, reserve a slot, fabricate an
entry, or write a reservation attempt. Carry the known refusal to the owner and
retain its feedback before sending the next turn. The existing feedback family
can record that message without claiming a reserved or admitted entry. Keep one
root-owned pair for an actual reserved Submit, and keep fatal failures raised.

## Behavior retained from this increment

The per-response loop, response-local ceiling/journal and joined evaluation are
consistent with the frozen plan. Guide and Environment feedback uses retained
outcomes in admission order. The ordinary root-failure correction preserves
earlier effects and actual partial Output. An unfinished provider turn ends the
exchange and leaves a readable Incomplete attempt. Output-only chat fixes the
fallback-body disclosure. These parts should be preserved.

The delivery marker pair is claimed before the next prompt and established
against its completed canonical input afterwards. The chapter row proves
identical text on markers [null, 2] and established delivery. This review does
not claim R2 case 6 or the other deferred interruption boundaries complete.

## Independently rerun evidence

All commands ran from `.claude/worktrees/issue-883-pr2` at the reviewed SHA.

| Command | Result |
| --- | --- |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-owner-failure-probe-e3aaa61e.test.ts | 1 test, 3 steps; passes |
| deno task test packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-history.test.ts | 23 tests, 117 steps; passes |
| deno task test packages/cli/tests/repl-sidekick-output.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-journey.test.ts | 38 tests, 146 steps; passes |
| deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-feedback-contract-probe-97f8cb79.test.ts | Guide control passes; four regression steps fail |

The reported commands independently pass 62 tests/266 steps. Logs are
`pr2-feedback-review-97f8cb79-{probe,feedback,consumers}.log`.
The [new probe](pr2-feedback-contract-probe-97f8cb79.test.ts) reuses the production
owner/session/repository/profile harness. Its [first output](pr2-feedback-contract-probe-97f8cb79-first.log)
is preserved. Bindings, fill/Submit, EntryOutput and refused Submit each fail on
the missing second prompt, while the Guide control succeeds. The successful
Submit row first verifies the real entry and its actual output; the EntryOutput
row first runs and joins a real entry. The refusal row verifies no entry exists.
No production mutation was used to reproduce these failures.

## Continuity and next action

Exact reviewed head is 97f8cb79; latest accepted owner base remains 94acc66c.
Produced artifacts are this review, the
[correction prompt](pr2-feedback-implementor-prompt.md), the probe, preserved
output, passing focused logs and updated planner-handoff.md. P1 and P2 are
existing-contract failures, not new acceptance permutations or architecture
decisions. Correct them and hand back a signed feedback commit before proceeding.

Stop, Sidekick-owned Elicit, configuration, metadata refresh, program binding,
R2 cases 2/5/6 and section 5 remain incomplete. Earlier accepted slices and
R2 cases 1/3/4 remain closed. No terminal rerun, full suite, CI inspection or
GitHub mutation informs this verdict or is authorized by it.
