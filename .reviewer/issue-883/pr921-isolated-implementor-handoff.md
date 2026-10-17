# Implementor continuation: isolated replacement PR2

Read this to take over the unfinished port in the isolated worktree. Follow
`.agents/implementor.md`. This assignment implements the released replacement
PR2; the Planner makes no further production changes.

## Applies to

Sidekick responses, their conversation/provider lifecycle and saved history,
and the REPL entry/submission consumers named in IN1–IN8. The accepted scope
and evidence are unchanged. The larger diff and fixture capture add no approval
gate. This handoff authorizes continuation of the existing implementation
assignment, a signed local feedback commit and return for review. It authorizes
no publication, GitHub write, CI inspection or merge.

## Instructions and governing contracts

Read these files completely from this directory:

1. `pr890-pr921-main-integration-implementor-prompt.md`.
2. `pr890-pr921-main-integration-planner-release-d4b0e326.md`.
3. `pr890-pr921-main-integration-planner-handoff.md`, including frozen IN1–IN8.
4. `pr890-pr921-main-integration-architect-decision.md`.
5. `pr890-replacement-planner-review-85da74b9.md`.

Then read the implementation checkout's AGENTS, complete architecture and
affected specifications, plus the mandatory Effection contract. The previous
Planner's partial port is not reviewed architecture or acceptance evidence.
No extra product choice is delegated by its presence.

Work only in `/private/tmp/xmd-issue-883-pr2-isolated`, branch
`agent/issue-883-pr2-isolated`, based on accepted replacement PR1
`85da74b938434773d7faf3caa5e2ca007328fdca`. HEAD still names that base. There is
no PR2 feedback commit yet.

Leave `.claude/worktrees/issue-883-pr2`, its integration branch and conflicts
untouched. Leave the accepted PR1 worktree untouched. Preserve original
`agent/issue-883-pr2` and `pre-integration/issue-883-pr2-d4b0e326` at accepted
source C, `d4b0e326d76fa63c6ee7a97e189986bbd371243d`, and the older pre-rebase
refs. The user supplied the isolated worktree to avoid an active-writer conflict.
Do not copy changes from the other writer's working tree.

### Current state: an unfinished, unreviewed port

The Planner mistakenly began implementation before the user corrected the role.
Preserve and inspect that work; it is not a finished implementation or feedback
revision. No commit, publication or original-ref rewrite occurred.

The accepted-source delta `79d404d0..d4b0e326` was applied with `git apply
--3way` in the isolated tree, with a separate documentation application. This
carried a large part of PR2 and vocabulary migrations. Some conflicts were
resolved provisionally in working files; the index still contains 26 unmerged
paths. At the handoff read, no textual conflict markers were found in packages,
architecture or specifications, but that does not mean the resolutions are
correct or staged. `git diff --check` printed no whitespace errors. The tracked
diff against HEAD reports 183 files, 45,380 insertions and 2,806 deletions,
excluding the untracked old-chat fixture. Status has 193 entries.

Read both staged and unstaged changes before staging anything. In particular:

- PR1's `generated-xmd.ts`, `generated-root-owner.ts`, `host.ts`, held-host
  fixture and root tests were restored from the accepted base to avoid applying
  moved binding work twice. Review any necessary PR2 additions rather than
  assuming every old-file addition belongs in the port.
- Provider configuration, direct-provider conversation/session-setup,
  observing publication and Workflow adaptations were carried. Mechanical
  conflicts in conversation tests were repaired enough to run commands 1–2.
- Sidekick controls/profile now use local definitions with owner-declared
  generated URLs and an installation using existing component-answer and
  `Component.generated` contracts. Review form/schema metadata and derive the
  complete described vocabulary from those same declarations. Canonical Elicit
  is selected by name rather than a restored pinned factory.
- `sidekick/owner.ts` has a provisional `activeControls` association. Captured
  request/journal delegates read that association; evaluation carries only
  `{ id, source, allow }`. Verify conversation-local ownership, joined cleanup,
  failure/cancellation and revocation against IN6. Do not accept this code merely
  because existing tests pass. Setup-time capture must not freeze REPL facts or
  share a response journal between chats.
- Some conflicting imports and local UI helpers were merged manually. The
  production assembly typechecked, but HI1 now fails in command 4. Trace the
  accepted historical submission correction rather than redesigning it.
- Documentation conflicts provisionally favored the accepted base in overlapping
  blocks while carrying other additions. Reconcile the final architecture and
  specs deliberately; obsolete table-taking inputs and legacy authorization
  prose must not survive as the current contract.
- New code and copied code have not received final formatting/code-rule review.
  Audit changed surfaces for casts, unnecessary comments, obsolete imports,
  leaked legacy APIs and accidental unrelated hunks.

Useful preserved port inputs are `/private/tmp/xmd-issue-883-pr2-port.patch`,
`/private/tmp/xmd-pr2-docs.patch` and `/private/tmp/xmd-pr2-docs-apply.log`.
The patch is historical input, not the desired final diff. The temporary edit
scripts are not required tools or architectural instructions.

### Preparation and IN5 checkpoint

Setup completed in the isolated worktree. First attempt failed on sandbox DNS;
`/private/tmp/xmd-issue-883-pr2-isolated-setup-first.log` preserves it. The
network-enabled retry succeeded and ended `ready`:
`/private/tmp/xmd-issue-883-pr2-isolated-setup-network.log`. No dependency or
lock update was assigned. Verify lockfiles remain unchanged. Do not reinstall
for ordinary checks or copy node_modules from the other writer's tree.

IN5's actual pre-integration fixture already existed before this port. Its
writer receipt is `in5-old-chat-d4b0e326/RECEIPT.md` beside this handoff. C's
signature verified as good. Rechecked fixture hashes:

- sidekick.jsonl: 20 records, 25,327 bytes,
  `333c901fd223788b366d4ebd363c67da090e9254e060b29c96de5db77c07f400`.
- entries.jsonl: empty,
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

The receipt records production recovery subprocesses at C, test-authored source
and transport, a completed response, an interrupted response with an actual
settled EntryInput control, two marker-2 roots and native conversation
`native-old`. No user's saved chat was used. The port copies that fixture and
receipt into the untracked directory
`packages/cli/tests/fixtures/repl/issue-883/old-chat-C/`.

A new IN5 test was appended to `repl-sidekick-recovery.test.ts`. Its first run
failed typechecking due to a helper scoped inside another describe block; that
was changed to JSON.stringify. The second run reaches continuation but fails
because the subprocess reports `failure: null` while the test expects
undefined. This is the observed failure, not proof that the remaining assertions
pass. Inspect the fixture reporting contract, correct the assertion without
weakening it, and finish IN5: cold opening changes neither file and prompts
nobody; explicit new work preserves native identity/configuration, old facts
and controls, does not replay a suffix, and writes marker 5 beyond old sequences.
The current test stops before proving all of that.

### Available command results

These results came from a changing dirty worktree, not a stable final revision.
Commands 4–7 ran concurrently, and the IN5 test was added after command 5 began.
Thus command 5's pass does not cover the appended IN5 test. Preserve first
outputs; rerun affected commands on the completed candidate. All seven named
commands have finished according to their log summaries.

| Command | Latest observed result | Log in /private/tmp |
| --- | --- | --- |
| 1 | PASS: 48 tests, 269 steps | xmd-pr2-command-1-third.log |
| 2 | PASS: 29 tests, 224 steps | xmd-pr2-command-2-second.log |
| 3 | PASS: 11 tests, 114 steps, network-enabled run | xmd-pr2-command-3-network.log |
| 4 | FAIL: 34 passed tests/126 steps, 1 failed test/2 steps | xmd-pr2-command-4-first.log |
| 5 | PASS: 30 tests, 163 steps, before new IN5 coverage | xmd-pr2-command-5-first.log |
| 6 | FAIL: 88 passed tests/263 steps, 2 failed tests/steps | xmd-pr2-command-6-first.log |
| 7 | PASS: 42 tests, 184 steps | xmd-pr2-command-7-first.log |
| IN5 alone | FAIL: 0 passed, 1 failed test/step | xmd-pr2-IN5-second.log |

Earlier outputs are retained as `xmd-pr2-command-1-first.log`,
`xmd-pr2-command-1-second.log`, `xmd-pr2-command-2-first.log`,
`xmd-pr2-command-3-first.log` and `xmd-pr2-IN5-first.log`. Commands 1–2 first
failed parsing/typechecking while port conflicts were being repaired. Command 3
first failed because the sandbox denied the existing adapter fixture's npm cache
write and related subprocess work; its outside-sandbox retry passed. Do not
classify these fixed/setup failures as flakes.

Command 4 fails both HI1 arms in `repl-sidekick-presentation.test.ts:4319`:
expected two seeded entries, observed only entry-1. This is not covered by the
EH1/UI10 exception. Fix it and rerun command 4 plus affected evidence. No root
cause has been established.

Command 6 exhibits exactly the recorded baseline truncations: EH1 expects
`No entry output recorded at this checkpoint.` and receives
`No entry output recorded at this`; UI10 expects guidance ending
`Tab/Shift+Tab move` and receives `Tab/Shift+Tab `. The release excludes only
these same observations from feedback acceptance. Report the command red;
do not skip, weaken, repair or silently retry these tests into acceptance.
The separate follow-up remains necessary before delivery/merge.

### Next actions

1. Verify the isolated branch/base and take ownership of its existing dirty
   state. Inspect the entire staged/unstaged port and current governing docs.
2. Complete conflict reconciliation, production capture/association review,
   documentation alignment and IN1–IN8 evidence. Resolve the index only after
   reviewing each path. Fix HI1 and finish the actual old-writer IN5 test.
3. Run the seven frozen commands below, preserving first failures and actual
   exits. Return any concrete contract conflict; do not expand scope or evidence.
4. Once the released threshold is satisfied, create the signed local feedback
   commit promptly. Return SHA, parent, base, tree, signature verification,
   all seven exact commands/results, IN1–IN8 mapping, moved-hunk allocation,
   fixture adaptations, first failures and remaining EH1/UI10 disposition.
   Stop for review before publication.

## Exact frozen PR2 commands

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-function-components.test.ts packages/core/tests/agent-session-launch.test.ts packages/core/tests/agent-session-setup.test.ts
deno task test packages/acp/tests/provider.test.ts packages/acp/tests/native-launch.test.ts packages/acp/tests/host-conversation.test.ts packages/acp/tests/loaded-copy.test.ts
deno task test packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/secret-detection.test.ts packages/workflow/tests/workflow-agent-checkpoints.test.ts packages/cli/tests/workflow-agent.test.ts packages/cli/tests/workflow-agent-sessions.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
deno task test packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-agent-execution.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-forms.test.ts
deno task test packages/cli/tests/repl-route.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-lifecycle.test.ts
```

## Continuity

Exact base and current HEAD: `85da74b938434773d7faf3caa5e2ca007328fdca`.
Accepted source C: `d4b0e326d76fa63c6ee7a97e189986bbd371243d`.
Worktree: `/private/tmp/xmd-issue-883-pr2-isolated`.
Branch: `agent/issue-883-pr2-isolated`.
Produced artifact: this handoff. Settled decisions: the linked released scope,
Architect boundary and frozen IN1–IN8/seven-command threshold. Remaining work:
unreviewed dirty port/index resolutions, HI1, complete IN5, final evidence and
signed feedback commit. No new product or architecture conflict is established.
Next Implementor action: inspect and complete the preserved isolated port.
