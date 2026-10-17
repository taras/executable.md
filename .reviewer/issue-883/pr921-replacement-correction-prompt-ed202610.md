# Observe two live Sidekick owners

Follow .agents/implementor.md. Continue in .claude/worktrees/issue-883-pr2 on
agent/issue-883-pr2-main-integration from signed clean
ed20261025ed66da1fe473785a189e8a458af865. Preserve that commit, 5a3d32bd and the
accepted PR1 parent. Leave the PR1 worktree, original branches, safety refs and
the other writer's isolated worktree untouched.

Read [the exact-SHA review](pr921-replacement-planner-review-ed202610.md).
Only R3m's two-live-owner observation remains. R-P1, R-E2, the stream
observation and the other IN6 rows are closed; do not implement them again.
The architecture and finite matrix have not changed.

Replace or complement R3m with one representative real-owner journey:

1. Acquire two Sidekick owners through the existing real owner/conversation
   fixture (useHarness in the journey suite is appropriate). Establish both
   conversations and keep both owners alive before testing their control reads.
   Their turns need not overlap; their owned conversation lifetimes must.
2. Give their owned request handles observably different answers or real REPL
   facts. Send identical authored control source through both actual owners
   after both conversations are established, before releasing either owner.
3. Assert each answer and retained control record belongs to its own
   conversation, with no call or record transferred to the other. Use existing
   owned lifetimes and explicit readiness if needed, then join their teardown.

The current reply() helper evaluates, releases its gate, joins its document and
ends its scope before returning. Calling it twice with yield* therefore tests
successive captures, not two live captures. It also bypasses Sidekick owner
assembly, so keeping only these HostExecutions alive would still miss that
assigned boundary. Retain its useful sequential capture observation if desired,
but remove its misleading two-live-owner description. Preserve all other rows'
assertions and behavior. No sleeps as readiness evidence, invented cast, global
test state or production inspection API.

Run frozen command 4 for the journey-suite observation:

```sh
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
```

If you also change the controls row, run frozen command 5:

```sh
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
```

Command 1 and the other unaffected selections need not repeat. No extra
mutation battery, full check/lint/JSR, dependency setup or CI is required. If you find
an actual production defect, preserve its first failure and return the concrete
boundary before expanding this assignment.

Once the file passes, promptly return one signed successor with exact
SHA/parent/tree/signature, command/result and a short account of how both held
owner/conversation lifetimes are observed. Stop for review before publication. EH1/UI10, queued UI
changes, Parse #922, teaching, captures and delivery remain separate. No amend,
reset, rebase, push, GitHub write, CI inspection or user-history repair.
