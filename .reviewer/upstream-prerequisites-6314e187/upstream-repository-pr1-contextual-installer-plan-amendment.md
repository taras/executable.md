# PR 1 scoped-setup planning amendment

The [PR 1 handoff](upstream-repository-pr1-file-dir-implementor-handoff.md) now incorporates ordinary setup functions inside each existing execution scope. The contextual installation API is withdrawn. One concrete integration decision, S1, is returned to the Architect; this is not a decision-complete implementation handoff until that route is recorded.

## Authority and exact revision

The accepted [scoped-setup amendment and Planner prompt](upstream-repository-pr1-architecture-review-1f43f26f.md#subsequent-accepted-amendment-scoped-repository-setup) governs. Its original replay finding remains preserved. Current implementation is clean at `56723fe372ef26db24183d651a055d8eff6b538d`, branch `agent/repl-file-dir-pr1`, worktree `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`. That revision already contains the coroutine replay correction; scoped setup and owner-label removal are not implemented there.

Exact base `f79f6730784a7ecba7253dcd35e6e5567293876c` was rechecked read-only with:

```bash
gh api repos/taras/executable.md/branches/main --jq '{sha: .commit.sha, tree: .commit.commit.tree.sha, parents: [.commit.parents[].sha]}'
```

It returned tree `4790d98d737af9b4b64c1f11d38cfaf991b3cd46` and second parent/revert `3159095cdc48e96914f69740b3940972fb0ce6bd`. No CI was inspected and no GitHub state changed.

## Settled amendment

- Setup is an ordinary function taking existing readonly execution installations and returning prepared readonly installations. Existing `Repository.around()`, `Git.around()` and `Files.around()` provide middleware. Add no installation API or `Repository.install()` operation.
- The already known command selects behavior. Call setup inside each existing executing run/entry scope before `executeInstalled`; each call creates fresh local state. Acquisitions remain lazy and end with that scope. No extra scope/factory lifecycle is needed.
- Remove repository factory forwarding through `runXmd`, dispatch/profile/program/session. Native imports remain in runtime adapters. Hosts without setup pass installations through and create no recording or repository resources. Isolated ordinary children perform their own ordinary setup.
- REPL setup prepares authored recording and wraps only supplied captured access, preserving all permission tables and unrelated installations. Remove the separate Files result and session-specific repository profile transformation.
- Remove the extra record-owner label and setup execution/entry identity arguments. Entry isolation belongs to `EntrySegmentStream`; structural/version/request matching, session history/routing and external identities remain intact.
- Preserve per-coroutine selection memoization, shared lazy discovery and the real unfinished-prefix regression at the current SHA. Keep L1, foreground File/Dir scope, generated ceiling, passive history and joined teardown settled.

## S1 returned to the Architect

The handoff supplies exact-revision source evidence for the integration gap. Native setup exists in `deno-repositories.ts`, reached by Deno/compiled entrypoints. Shared `runDocument`, `runEntry` and isolated `runProfileChild` receive it only through arguments/options that the accepted amendment removes. Existing `installRepl` composes storage/terminal behavior, not an entry-execution seam. Core captures evaluation before installation callbacks, so wrapping generated access later in `install()` does not satisfy the accepted preparation contract.

Name the existing composition boundary and exact module mapping that makes the ordinary setup function available at those call sites without the removed forwarding. If execution assembly or an existing host contract must move/change, the Architect must approve that mapping. Do not introduce another contextual installation API or silently invent cross-package routing. Lifetime is already resolved; S1 concerns module availability only.

## Finite evidence and preservation

E1–E10 retain their finite behavior scope. E7 remains the accepted replacement proving isolation through segments rather than redundant owner labels. E3 retains the actual concurrent unfinished-prefix replay regression. Setup terminology replaces installer terminology; no new scheduling matrix, performance threshold or behavior criterion is added. Focused F1–F6 commands, feedback-commit requirements and separate delivery/review gates remain in the handoff. No runtime evidence is claimed for this planning-only amendment.

The previous handoff, previous contextual-installer amendment, stack plan and current Architect record were copied to `planner-scoped-setup-amendment-56723fe3/` before editing, with SHA-256 hashes in `before-state.json`. Earlier archives remain preserved. The stack plan and authoritative Architect report remain unchanged; this amendment supersedes the withdrawn contextual-API proposal in the earlier planning text. Historical implementation and existing dirty root files are preserved.

## Next action and authorization

Next actor: Architect, resolve S1; then Planner completes the assembly trace. Implementation remains separately authorized. After that authorization and focused evidence, the Implementor returns a feedback commit with exact SHA/base and every command/result. Architect review of that exact revision, Product Owner review and explicit merge approval remain separate gates. No implementation, commits, publication, PR changes, merge or PR 2 work occurred or is authorized by this amendment.
