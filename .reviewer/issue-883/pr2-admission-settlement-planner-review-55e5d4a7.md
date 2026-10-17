# Planner review: admission-gate increment 3 at 55e5d4a7

PASS at `55e5d4a710a6b3bb79e0fff4a205f145ef73df53`, parent
`32bbd7ccdf222c12f850176dc27210d0980d5e04`, branch `agent/issue-883-pr2`.
HEAD matches, the signature verifies G for tarasm@gmail.com, and the
implementation worktree is clean. The writer-settlement finding is closed.
Increment 3 and fresh-process R2 cases 3/4 are accepted. Increment 2 and P1/A1
remain closed.

## The corrected boundary

`ReplSession.admits()` reads the same ending, running-entry and unsettled-history
refusals as `submit()`, without proposing work or starting preflight. It adds no
second admission decision. A busy Submit returns that refusal before waiting,
reserving or writing intent, so it does not become queued work.

For a request that may proceed, `submitForSidekick()` waits on the actual
`MovableWriter.settled()`, asks the session again, then synchronously reads the
ordinal and takes the root reservation. It binds the file's acknowledged bytes
under that reservation before acknowledging intent. Submission still performs
its own readiness and actual-start checks.

Taking the reservation after the settlement wait is acceptable: readiness is
rechecked after that suspension, and reading the ordinal and taking the slot
have no suspension between them. A competing root reservation is refused by
the existing gate. The reservation remains held through binding and intent;
no competing submission can start during those reads. No extra admission owner
or public Core interface is introduced.

The recovery phase passes the real writer to this operation. Cold reconciliation
still needs only the file path and remains free of writes and provider work.
The exact-byte binding, strict Submit payload, prefix-first refusal and ordinary
suffix behavior accepted at 32bbd7cc are preserved. Specification and architecture
text now distinguish writer acknowledgement from append-only growth.

## Frozen evidence

R2l holds a prior entry's admitting append inside the production filesystem
host. The writer is genuinely in flight. A Sidekick Submit returns the session's
busy refusal while that append remains held, and the chat file gains no intent
or outcome. After release and joined completion, an explicit new ask succeeds.
Its intent binds exactly the acknowledged preceding prefix, with ordinal 1 and
entry-2; the file subsequently grows beyond that prefix.

This supplies the requested held-append regression and settled-prefix control.
The source uses the existing real settlement primitive; no extra scheduling,
runtime or interruption permutations are required. The Implementor reports that
restoring the reviewed ordering fails R2l alone while R2i/R2j/R2k and the unchanged
history control remain green. This review did not mutate production to repeat
that control.

The archived reviewer probe was copied to
[the current-signature version](pr2-admission-prefix-settlement-probe-55e5d4a7.test.ts).
Only its private input plumbing changed: the session supplies `admits()` and the
request supplies `writer: pair.stream`. Its assertions and synchronization are
unchanged. Both its held-append row and settled-prior control pass; the busy
refusal returns before the held append needs releasing.

## Independently rerun commands

All commands ran from `.claude/worktrees/issue-883-pr2` at the exact reviewed SHA.

| Command (`deno task test` with these files) | Result |
| --- | --- |
| packages/cli/tests/repl-journey.test.ts | 39 tests, 71 steps |
| packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-sidekick-controls.test.ts | 45 tests, 172 steps |
| packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-output.test.ts | 13 tests, 64 steps |
| packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts | 19 tests, 54 steps |
| packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-agent-interface.test.ts packages/cli/tests/repl-forms.test.ts | 30 tests, 126 steps |

The four frozen commands total 116 tests/361 steps. The session-consumer selection
adds 30 tests/126 steps because session.ts changed: 146 tests/487 steps overall,
zero failures. Logs are beside this review as
`pr2-admission-settlement-review-55e5d4a7-{journey,entries,storage,layout,controller}.log`.

The additional probe command passes one test/two steps:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-admission-prefix-settlement-probe-55e5d4a7.test.ts
```

[Probe output](pr2-admission-prefix-settlement-probe-55e5d4a7.log) is preserved.
No full suite, CI result or GitHub action informs this verdict.

## Continuity and next action

Accepted base is 55e5d4a7. This review and planner-handoff.md record acceptance;
the settlement correction prompt is complete. R2 cases 1/3/4 are accepted;
R2 remains open until section 4 supplies cases 2/5/6.

Continue the remaining section 3 work under the frozen plan: CLI-owned guide and
bootstrap assets with trusted reads, EntryOutput/Bindings wiring, and binding
the response profile and controls to the root. The admission helper's recovery
evidence does not claim a complete Sidekick response cycle or complete R3.
Section 4's conversation owner and section 5's flags, terminal integration,
R5–R8 and 36-frame packet remain incomplete. The complete CLI PR is not yet
ready for delivery. No production edit, implementation commit, push, GitHub
mutation or memory compaction was performed by this review.
