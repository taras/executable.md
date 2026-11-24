# PR1488: intermittent Exit failures in run45489356108

Use this handoff to track the unresolved intermittent failures before coordinator publication or Actions reruns. No behavior or assertions changed.

Repository: taras/executable.md, worktree history-scroll-order; PR1488.
Branch head/base:47cefc0a86f0b4b1daeb6a487fe4d143d8dc4cad.
Tested merge:b085b2a7dae975f05912ab4774b3cda72143c7ec; parents bd49bd6003c9efdd850749ac5a51a5a232c8e4fb and branch head above.

## Whole-log findings

Original .log files remain unchanged beside this report. ANSI-stripped .plain.txt copies preserve the complete logs, not just error matches. Each contains one actual failing case:

- Deno4/22, job138783178674: `deno run --allow-all --frozen scripts/runtime-tests.ts deno 4/22`. First actual error at plain line3668: E8 “an accepted create this end never learned of is adopted, not repeated”, timeout in repl-issues-journey.ts321 after the second process clicks Exit. It has adopted the issue and is waiting for an answer; no failing server/body assertion. First failure context3665–3688.
- Deno10/22, job138783178713: `deno run --allow-all --frozen scripts/runtime-tests.ts deno 10/22`. First actual error at plain line3715: E1 “a selected Worktree's Add and Commit answer again on reopening”, timeout in repl-files-journey.ts901 after the third process clicks Exit. Commit output is visible and Ready for Entry3; no failing Git assertion. First failure context3712–3735.

The publish-workflow error text earlier in each log is echoed shell source, not a failed check. No download/setup error caused these CI failures.

## Unchanged-revision reproduction

Focused command on branch, macOS/tmux:
`deno task test packages/cli/tests/repl-issues-pty.test.ts packages/cli/tests/repl-repositories-pty.test.ts`
PASS2tests7steps58s, local-first.log. No edits before or after this run.

Exact merge source archived with:
`git archive --format=tar b085b2a7dae975f05912ab4774b3cda72143c7ec -o /tmp/pr1488-tested-merge.tar`
Isolated Docker container pr1488-linux-x64, node22.23.4-bookworm, linux/amd64; Deno2.9.5 x86_64-unknown-linux-gnu, util-linux script2.38.1, no tmux. Standard `deno task setup` completed with verified producer hashes; x64-setup.log, exit0. No host dependency state changed.

Inside /repo at exact merge:
`deno task test packages/cli/tests/repl-issues-pty.test.ts packages/cli/tests/repl-repositories-pty.test.ts`
PASS2tests7steps1m50s; x64-first.log and x64-first.exit0. E8 adoption and E1 Add/Commit both pass. This exercises Linux script's visible-screen replay and exit-status buffer separately, without copying prepared artifacts or bypassing preflight.

The preliminary ARM64 Linux preparation could not verify its producer hash; logs linux-setup-first.log, linux-setup-second.log and linux-merge-setup.log retain that environment limitation. It is unrelated to CI's successfully prepared x86_64 jobs. Final reproduction used x86_64 and standard preparation successfully.

## Classification and next action

CI failed and the focused regressions passed at the identical tested merge, same Deno version and Linux architecture, with no source correction. These are intermittent test failures; their cause remains unresolved. Local container versus hosted runner, util-linux version, timing and shard contention remain possible differences. The failing full shards were not rerun locally; focused imported regressions were used per AGENTS test-selection order. A passing focused run does not prove shard health or a fix.

Related existing open flake issue: https://github.com/taras/executable.md/issues/1007 — repl-repositories-pty intermittent failure. Its earlier raw-byte diagnosis concerned Deno progress clears inside frames, already suppressed by --quiet. These logs show missed Exit completion; they do not establish that old cause. Do not close1007 or claim its cause is confirmed. Existing issue body saved in issue1007.json. Searches found no dedicated issue-adoption missed-Exit issue.

Coordinator: attach this failure/pass evidence to dedicated flake tracking (1007 if maintaining the common symptom, otherwise a linked issue), preserve the original job logs, and obtain raw PTY bytes plus pre-click screen/coordinates and decoded hit-map event when a failure next occurs. No retryable infrastructure condition was demonstrated for the two CI jobs. Publishing and Actions reruns remain coordinator-owned. No production or test changes are justified yet.

Artifacts: original logs, stripped logs, local-first.log, x64-tools.log, x64-setup.log, x64-first.log, all preliminary preparation diagnostics beside this report. Containers remain available for follow-up: pr1488-linux-x64 (/repo exact merge, prepared), pr1488-linux-tools (ARM64 failed preparation). No remote writes performed.
