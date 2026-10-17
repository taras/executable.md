# Restore the current chat's reading after visiting older chats

**Continuation, 2026-10-15:** execute this correction through
[the combined responsiveness prompt](pr2-sidekick-responsiveness-implementor-prompt.md).
The Product Owner requested that prompt after the latency diagnosis. It adds
the bounded fitting remedy and RS3–RS5 to this same continuation; the exclusion
of that remedy below is superseded. The three correctness items remain assigned.

Continue from signed clean `39c24f37fdb967c3aa90870f9b4e22e536dc0fec`,
parent `d634b28b24afa9a16a0a10ec7906c09d924c9db9`, branch agent/issue-883-pr2,
in `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Follow .agents/implementor.md and verify head/signature/tree before editing.
Preserve every ancestor; no amend, reset, rebase or unrelated main changes.

Read [the exact review](pr2-terminal-completion-planner-review-39c24f37.md),
[the chat contract](pr2-chat-flow-planner-addendum-d634b28b.md) and
[the terminal plan](pr2-terminal-completion-planner-handoff.md).
The earlier header, spelling, multiline fitting, current-tail following, TE5
and J1 corrections are accepted. Do not redo them or reopen Core/ACP,
admission, recovery, Configure, Preview or Sessions designs.

## 1. Keep current-chat scrolling independent

The current chat must return with its own following/manual reading choice
after an older read-only chat was visited and scrolled. The current shared
Sidekick offset/following flag lets older-chat scrolling disable following in
the current chat. The unchanged paired probe demonstrates the latest current
reply disappearing after Back, while visiting without scrolling works.

Correct the private viewport state and read-sidekick-turn/read-current-chat/
scroll-sidekick handling in application.ts, plus the existing prepared-frame
path in program.ts only if needed. Use the selected saved CLI chat identity
and process-local state. Ordinary private mechanics are delegated. Do not add
URL members, durable records, a second focus store or a generic scroll service.
An older chat remains selected/read-only while current work arrives; explicit
Sessions reveal still takes precedence over following.

Keep the current chat's manual position as well as its following choice when
visiting an older chat. Add one permanent paired journey in the existing CF
presentation tier: current tail → older chat → scroll older → Back still shows
the current latest row; control visits without scrolling. Extend that same
journey to a deliberate current reading before the visit and show it returns
unchanged. Use actual measured windows/visible text and existing two-chat
fixtures. No new host, journal or mutation battery is assigned.

Run unchanged:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-chat-reading-probe-39c24f37.test.ts
```

The probe checks behavior, not private viewport fields. Preserve its regression
and passing control.

## 2. Complete the already-working held Preview evidence

Promote the behavior in
[the positive mounted probe](pr2-chat-live-growth-probe-39c24f37.test.ts)
into the existing permanent CF2 presentation tier. Hold generation after enough
literal Output rows to overflow; grow another visual row with terminal.fed
unchanged; observe the latest row before a response is saved; settle and show
the final reply remains visible with both composers preserved. Reuse accepted
Preview same-item identity evidence. No new product behavior is requested.

Keep the external probe unchanged and passing:

```sh
deno task test /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-chat-live-growth-probe-39c24f37.test.ts
```

## 3. Align the two header sentences

architecture.md says the header takes no reading row and specs/repl-spec.md
says it costs the rows below nothing. The accepted headerBand reserves its
bottom edge in the engine's measured height. State that accurately and keep
the seven-row footer claim. Do not redesign header geometry.

## Focused evidence and return

Run the same nine commands assigned by the previous correction and chat-flow
addendum against the final tree, plus the two probes above. The original six
exact commands remain in the terminal plan. Preserve first outputs and report
all results honestly. The Planner's private-PTY-socket limitation and open M1
focus flake are not assigned product repairs; do not weaken assertions or
change dependencies/caches to obtain a pass.

No full suite, broad lint/check/JSR, new mutation exercise, push, GitHub write,
CI inspection or capture is added. Leave REPL_DESCRIPTION and SIDEKICK_QUIET
outside this correction as directed previously.

The separate user-requested
[latency diagnosis](pr2-latency-39c24f37-report.md) has no production changes.
This assignment does not bundle its cache/visibility remedy; retain the
diagnosis for a bounded responsiveness assignment.

Continue through this finite correction, commit promptly when its focused
evidence passes, and hand back one signed SHA with parent, branch, clean state,
commands/results, first outputs and every assertion/fixture adaptation. Stop
for review of that exact commit.

Base: 39c24f37, parent d634b28b. Produced: this prompt and its linked review.
Settled: header/spelling/fitting contracts and current-chat reading restoration.
No architecture question is pending. Next action: the correction above.
Teaching, the 36-frame packet and delivery remain separate.
