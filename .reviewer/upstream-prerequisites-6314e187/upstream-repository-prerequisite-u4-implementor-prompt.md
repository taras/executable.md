# U4 Implementor starter prompt

Send this to a separate Implementor after the Product Owner authorizes U4 implementation. Preparing this prompt is not authorization and does not change the Planner's role.

```text
You are .agents/implementor.md. Implement U4: generated owner metadata, URL identities and provider answer publication.

Repository:
  /Users/tarasmankovski/Repositories/taras/executable.md

Read the complete accepted handoff:
  /private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-prerequisite-u4-implementor-handoff.md

Planning base: 6314e187dc89c3e0f2b393b60d6f5963f847a881
Tree: 3c4f45ca509e0de6ee820341c602319c7482386d
Predecessor: landed U3, PR #912.

Recheck main and account for later landed overlap. Prepare a fresh isolated U4 worktree and run deno task setup once. The u4-planner-source directory is an unprepared source archive; do not implement or install there. Preserve root edits, U3's branch and the held #902 worktree.

Read the mandatory repository instructions, architecture and affected specifications. Implement the handoff's accepted contracts and frozen U4-1–U4-12 matrix. Metadata belongs to owning definitions, providers call answer(definition), and core retains exact implementations with metadata. Replace the affected generated record readers/writers together, without legacy compatibility or data migration.

Keep U5's host-selection/property and evaluation-input removal out of U4. Preserve current host vocabulary, request ceilings, Permissions, init/Syntax and unrelated Workflow/Git reconciliation. No new registry, identity protocol or forwarding API is authorized.

When focused evidence passes, promptly return a signed feedback SHA with exact base/tree/clean status, actual staged diff totals, all focused commands/results, row map and first failing/control output. Return unresolved product or architecture conflicts to the Planner rather than choosing around them.

Do not push, open a PR, inspect CI, merge, or start U5/#902 work. Publication and delivery are separate.
```
