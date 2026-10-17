# Report the command's known plugins in Sidekick Environment

Completed and accepted at `356f1b5164cc966cff92a0d5b6c5b554fc14e97d` in the
[Planner review](pr2-reads-planner-review-356f1b51.md). The instructions below
record the completed correction. Continue with planner-handoff.md's next action;
do not repeat this correction.

Correct `68d10d7dfb801baeb15af5bcc20ab60344929452`, parent
`9a9d2a041e0dfb825c7f51ef0589e83616d5f86c`, in
`.claude/worktrees/issue-883-pr2`, branch `agent/issue-883-pr2`.

The [Planner review](pr2-reads-planner-review-68d10d7d.md) records one blocker.
The read implementation, test-fixture adaptations and deferral of per-response
ceiling/submit binding to section 4's owner are otherwise accepted within this
increment. Preserve the accepted Core, admission/Pause, recovery and guide work.

## Required correction

The [accepted Environment contract](syntax-discovery-amendment.md#current-environment-inspection)
requires the host-known active entry profile/includes/plugins.
The command already knows its admitted Plugin assembly, but rootReads reports
only includes and Agent permission mode.

Retain the selected Plugin names as immutable descriptive facts when
assembleReplProfile receives that assembly, and carry them to rootReads's
Environment facts. Preserve the command's selection order and report an empty
selection explicitly as none. Supply equivalent descriptive facts in existing
test profiles as needed; preserve their behavioral assertions.

Use the command's admitted assembly as the source. Return descriptive names
without exposing the Plugin objects, installations, arbitrary argv or authority
to the read surface. Keep the existing contextual cwd/platform reads, runtime
facts, explicit unknowns and missing-host refusal.

Update the affected specification/architecture description to reflect the
reported selection. This is an existing contract correction. Section 4's owner,
response ceiling and retained feedback wiring stay for the accepted next slice.

## Finite evidence and feedback

Read and run the [reviewer probe](pr2-environment-plugins-probe-68d10d7d.test.ts)
and its [first output](pr2-environment-plugins-probe-68d10d7d.log). Its control
already passes; the known Plugin assertion fails. Integrate that representative
case into the existing read tier, using production Plugin installation/profile
assembly. Reuse the existing no-plugin profile to assert the explicit empty
selection, and retain the includes/permission/runtime control. No permutation
matrix is required.

Run from the implementation worktree:

```sh
deno test --config deno.json --allow-all /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-environment-plugins-probe-68d10d7d.test.ts
deno task test packages/cli/tests/repl-sidekick-controls.test.ts
```

If the correction changes existing profile fixture construction, run the suites
containing those fixtures: repl-journey.test.ts and repl-agent-interface.test.ts.
Run repl-history.test.ts if the issue-881 controlled-host fixture changes;
that suite reaches it through its subprocess fixture directory. Preserve their
accepted behavioral assertions.

Commit promptly when this focused evidence passes. Hand back the exact signed
SHA and parent, every focused command/result, the working-tree state, and what
remains incomplete. Full suites, lint/check, packaging and CI are not feedback
prerequisites. No push or GitHub mutation is authorized.

The exact reviewed base is 68d10d7d. Produced artifacts are this prompt, the
linked review, probe and first output, and the updated planner-handoff.md.
The remaining blocker is the missing known Plugin selection. The next
Implementor action is this correction, then return for review.
