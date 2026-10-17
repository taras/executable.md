# Submission identity correction — PASS

**PASS** at d4b0e326d76fa63c6ee7a97e189986bbd371243d, parent
f83e35549dcddad0791f9492b8cdfe56dd7b4bf1. Signature G / tarasm@gmail.com;
agent/issue-883-pr2 is clean. This closes Task J and the HI-P1/HI-E1 findings.
It accepts the submission correction, not the full PR or delivery battery.

The accepted integration source **C** is now
d4b0e326d76fa63c6ee7a97e189986bbd371243d. All earlier reviewed ancestors remain.
Nothing was pushed or rebased by this review.

## Findings closed

HI-P1: both new entry readers use the existing parseEntryRecords() validator
before projectRepl(). Neither new DurableEvent cast remains. The deliberate
malformed fixtures outside this correction are unchanged; no replacement
parser or assertion was introduced.

HI-E1: the existing admitted/absent recovery rows now compare both files across
the cold opening, before any mutating action. They read the retained reservation
and assert entry-3/ordinal 2, then count its actual source on opening, while the
successor is held and after settlement: once in the admitted arm and zero in
the absent arm.

The existing operationGate holds the first successor append to entries.jsonl
before physical writing. At its observed start, the control resolution is
already on disk with the required outcome and observed entry; the entry keys
are still exactly those present on opening. Releasing the gate permits the
distinct ordinary successor, with only one retained finding afterwards. This
establishes acknowledgement before admission, not just eventual existence.

Cold session, prompt and turn counters stay empty and agent startup remains
false. The real subprocess histories, historical route, production cold adapter
and head/changed-history controls remain in use. No new host, writer, inspection
API or production change was added.

The production assessment from
[f83e3554's review](pr921-historical-identity-planner-review-f83e3554.md)
stands: all three root uses read the acknowledged history; the Sidekick count
is read at the settled boundary without suspension before taking the slot;
unreadable readings refuse; receipt/read targets retain the actual task-bound
handle. Frozen presentation and existing admission/recovery ordering remain.

## Independent focused verification

Run once against the exact reviewed commit:

```sh
deno task test packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-controls.test.ts
```

**Exit 0; 14 tests / 72 steps passed, zero failures.**
[Complete first output](pr921-historical-identity-review-d4b0e326-command-2-first.log).
There was no rerun or discarded failure.

As explicitly assigned by the evidence correction prompt, original commands 1
and 3 were not repeated for this one-test-file change. Their independent
f83e3554 results remain accurately attributed: command 1 passed 35/128;
command 3 passed 64/164 and failed EH1/UI10. The Implementor's check result is
reported evidence and was not repeated. No CI, broad suite, dependency action
or mutation battery was run for this review.

## Remaining scope and next action

EH1/UI10 remain a separate branch-level test/fitting assessment. The inspected
940249af baseline has those same failures; their exact onset is unestablished,
so this review does not claim they predate #921 or report command 3 as green.
They are not waived for merge or silently absorbed into this correction.

The [combined integration plan](pr890-pr921-main-integration-planner-handoff.md)
can now name C exactly. Its Planner release still records the current target,
owner-worktree coordination and explicit disposition of the known baseline
failures. This PASS alone moves no branch and publishes nothing.

B–D's product questions, Parse #922, new binding publication or agent-result
inspection, teaching, captures and delivery retain their separate scopes.
No additional submission-identity work is assigned. Produced artifact: this
review and updated readiness records. Next owner: Planner finalizes the next
bounded assignment using accepted C, preserving both worktrees and old refs.
