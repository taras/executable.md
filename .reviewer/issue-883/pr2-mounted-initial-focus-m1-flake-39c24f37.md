# Open flake record: mounted M1 samples initial Draft focus

Status: open; cause unfixed. Classification: flake. This local record preserves
feedback evidence under the task's no-GitHub-mutation authorization. No GitHub
issue or CI run was created.

Exact revision: 39c24f37fdb967c3aa90870f9b4e22e536dc0fec, parent d634b28b,
signed G on agent/issue-883-pr2, clean worktree. Local Planner review,
2026-10-15, Deno.

The original terminal-completion command 4 reported M1's initial
focusedField(terminal, DRAFT_PROMPT) false at
packages/cli/tests/repl-sidekick-presentation.test.ts:148. Its first complete
output is preserved in
[command-4-first.log](pr2-terminal-review-39c24f37-command-4-first.log).
The same command also had the separate private tmux-socket limitation.

Without source, fixture, assertion, dependency or environment changes, the
[isolated unchanged M1 tier](pr2-terminal-review-39c24f37-m1-isolated-rerun.log)
passes 1 test / 2 steps:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts --filter 'one Sidekick per command'
```

The [original command 4 rerun](pr2-terminal-review-39c24f37-command-4-rerun.log)
also passes M1 unchanged. It finishes 46 tests / 170 steps passed, with only
the two separate real-PTY steps failing on unavailable private tmux sockets.
This supplies the full-selection recurrence comparison; it does not establish
or repair the M1 cause.

The first assertion samples focus immediately after the fixture returns a drawn
screen. That identifies the readiness assumption to investigate, not a proven
cause or an authorized repair. The correction adds frame fitting work; this
record does not claim whether it caused the recurrence or exposed an earlier
assumption. A passing unchanged run proves intermittence and does not close the
record. This is distinct from L2, U2 and the private tmux-socket limitation.

No assertion was weakened and no product, dependency or cache repair was made
for the rerun. Delivery still requires a cause and regression evidence before
this flake can be closed.
