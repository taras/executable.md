# Restack and deliver the two accepted Sidekick PRs

**Latest delivery continuation: #890 merged; #921 at 7e7ffd27.**
[Current handoff](pr921-delivery-continuation-7e7ffd27.md) records reported main
merge SHA 98cd350b08082d57c711b450973257fab6bb8973 and locally verified signed
PR2 head 7e7ffd27f819073ccb02994dab8ff50bf075a4e7. The L2 repair changes only
test readiness; no new product/architecture work is assigned. CI is reported
running and #921 still draft. The Implementor updates #935's repair evidence,
marks #921 ready, obtains its actual main-target verdict, and arranges the
normal protected human/approved merge. Do not merge #890 again or restart the
rebase. Earlier state inventories below are historical where superseded.

**Current delivery state, 2026-10-16: published; merge execution blocked.**
[Planning return](pr890-pr921-delivery-planner-return-c10a2062.md) records local
PR1 dbc0fc92 and PR2 c10a2062, signed with no tracked owner changes. The
Implementor reports both exact published heads fully green. Rebase/publication
are complete; do not restart them. Resolve the reported automatic-review merge
denial through the authorized approval/human process, then deliver #890 first,
retarget/ready #921, obtain its own main-target verdict, and merge it through
protection. No product/architecture correction is assigned. The Planner remains
planning/review only; execution belongs to the existing Implementor.

Earlier inventories and starting steps below are historical where superseded
by this delivery return. Do not repeat completed work.

**Delivery is already underway; no new notice correction, 2026-10-16.**
[Focused recheck](pr921-control-only-recheck-planner-return-fd62f65f.md): the
accepted silent-reply patch is preserved exactly at signed f3424f67; mounted
presentation/journey tests pass 30 tests / 110 steps on owner head fd62f65f.
Observed local PR1 is dbc0fc92 and PR2 is fd62f65f, already restacked. These are
observations of in-progress owner work, not new delivery acceptance. The same
Implementor continues existing verification and corrections; preserve the dirty
worktree and do not restart the completed rebase or duplicate the notice commit.
#932/#933/#931 remain separate; REPL.EntryTrace is proposed and Entry 22's cause
is unproven. The Planner performs planning/review only.

The source heads and start steps below record the original release. Use the
current owner observation above for continuity; do not repeat completed steps.

**Released now from accepted c2536dd0, 2026-10-16.** All three final
presentation corrections have passed review: padding 6ca23952, silent replies
2ac3cb28 and Configure exits c2536dd0. The
[Configure review](pr921-configure-exit-planner-review-c2536dd0.md) independently
passes 93 tests / 285 steps. No presentation start gate remains.

Follow `.agents/implementor.md`. The existing designated Implementor now
rebases the accepted replacement branches bottom-up onto freshly verified main,
updates the existing #890/#921 and completes their delivery gates. Include all
seven PR2 commits through exact signed
`c2536dd0494d0744d9af851c9bd60dd06f607e32`.
PR1's source remains `85da74b938434773d7faf3caa5e2ca007328fdca`.
Do not repeat a completed correction or port the original stack again.
The [short continuation](pr890-pr921-final-delivery-continuation-c2536dd0.md)
provides the immediate starting instructions.

## Scope and exact inventory

This release supersedes earlier prohibitions on rebase, publication and CI
inspection for these two PRs. It does not authorize unrelated ref/worktree
cleanup, dependency upgrades, rewriting user histories or bypassing protection.
The existing designated Implementor is the sole writer of both owner worktrees.

| Item | Recorded inventory; recheck remote state at delivery start |
| --- | --- |
| Last verified remote main, via GitHub API | `4702890c94ffb566605f0410779ef5372e8074f0` |
| Last verified local origin/main | same `4702890c` |
| Accepted PR1 replacement | `agent/issue-883-pr1-main-integration`, `85da74b938434773d7faf3caa5e2ca007328fdca`, clean |
| PR1 replacement's original main base | `986948eabd070c0ae7354c2a0db8df7feed63621` |
| Accepted PR2 replacement | `agent/issue-883-pr2-main-integration`, `c2536dd0494d0744d9af851c9bd60dd06f607e32` |
| PR2 owner worktree, rechecked for this review | `.claude/worktrees/issue-883-pr2`, clean at c2536dd0 |
| PR1 owner worktree | `.claude/worktrees/issue-883-pr1` |
| Published PR #890 | open, head `agent/issue-883-pr1` at `79d404d04d02c3840892473b6f1b2cf540f3edd1`, base main |
| Published PR #921 | draft, head `agent/issue-883-pr2` at `940249af47159a3bbd960b8ca8df3f10bb53811c`, base `agent/issue-883-pr1` |

GitHub API confirmed main is 15 commits ahead of 986948ea. An SSH ls-remote
attempt failed at DNS resolution; `gh api` and PR reads succeeded. This is not
evidence of a signing failure. Use a working transport without changing global
Git configuration or dependencies.

## Preserve the accepted sources before restacking

The delivery source includes body/title padding, header-gap colors, navigation
surfaces, sidebar width 36 at both profiles, silent-success suppression with
failure/context visibility, and Configure's shared close semantics and scrolling
labels. Earlier instructions to park UI work or deliver an earlier cut are
superseded. No width choice or presentation feedback gate remains.

Before changing either branch:

1. Recheck both heads and clean status. The designated Implementor remains the
   sole writer; do not start a second session or touch the isolated PR2 worktree.
2. Preserve all accepted commits, earlier patches and first outputs. The three
   presentation slices are complete; do not replay or remove them.
3. Create fresh preservation refs for PR1 85da74b9 and PR2 c2536dd0, retaining
   27da762b, 6ca23952 and 2ac3cb28 as reachable ancestors. Preserve original
   branches and existing safety refs. Verify names or use distinct ones; never
   overwrite a preservation ref.
4. Leave the dirty root main checkout and its unrelated instructions and
   architecture work alone. It is not a documentation conflict-resolution
   source. Do not clean, delete ignored state, stash or discard unrelated files.

## Restack bottom-up

Recheck remote main immediately before starting and record the full target SHA.
Use 4702890c if it is still current; if it advanced, fetch the actual head and
record the change. Do not rebase against a stale local main checkout.

1. Rebase PR1 replacement's two commits (fdcef428, 85da74b9), whose old base is
   986948ea, onto the verified current main. Keep commits signed. The accepted
   Core contracts remain authoritative: marker-4 fragments, marker-5 roots,
   captured selection/Syntax provenance, bound root ownership, failure Result
   classifications and root sequence partition. Preserve the new main's work.
2. Verify PR1 as below and record its new signed head. Do not combine the two PRs
   or move Sidekick/UI work into PR1.
3. Rebase PR2 replacement's seven commits (5a3d32bd, ed202610, 7613cddf,
   27da762b, 6ca23952, 2ac3cb28, c2536dd0) from old PR1 85da74b9 onto the
   new PR1 head.
   Carry their final accepted behavior and all reviewed evidence. Do not replay
   the original 73-commit stack or
   cherry-pick its already replaced Core implementation.
4. Resolve ordinary conflicts in the owning worktree, including documentation,
   by preserving both main's implemented behavior and the accepted Sidekick
   contracts. Use `range-diff`, final diffs and tests to account for each change.
   An actual public-contract, persistence, capability or lifecycle conflict
   returns for an Architect ruling; do not invent a combined record shape.

Main's 15-commit range changes REPL program/session, runtime entrypoints,
repository/issue composition and PTY consumers. This is the concrete integration
boundary. It does not change dependency manifests or lockfiles relative to
986948ea. Do not install again merely to run tests; if preparation inputs do
change on a newer target, use the repository's one `deno task setup` procedure
and preserve frozen lockfiles.

## Focused integration evidence

Run all five PR1 and all seven PR2 selections under **Focused commands and
preparation** in
[the integration plan](pr890-pr921-main-integration-planner-handoff.md).
Those exact lists remain the finite Core/ACP/Sidekick compatibility selection.
Retain the old-writer IN5 fixture and its receipt; do not regenerate it with
the new writer. Retain the two-live-owner control evidence.

On restacked PR2, also run these explicit consumers of main's moved repository
and runtime-entrypoint boundaries:

```sh
deno task test packages/cli/tests/repl-boundaries.test.ts packages/cli/tests/repl-repositories.test.ts packages/cli/tests/repl-repositories-pty.test.ts packages/cli/tests/repl-issues.test.ts packages/cli/tests/repl-issues-pty.test.ts packages/cli/tests/run-composition.test.ts packages/cli/tests/testing-execution-host.test.ts packages/cli/tests/testing-execution-host-native.test.ts
```

These files are supplied by current main; do not omit them because the old PR2
worktree did not contain them. Required CI owns compiled consumers and runtime
exclusion/discovery checks too. If the target legitimately renames a file,
record the exact successor rather than silently dropping its behavior.

Capture each first failure before retrying. Identical-revision intermittent
failures follow the repository flake rule; a rerun does not erase the failure.

## Delivery failures and local gates

The EH1/UI10 truncation exception applied to integration **feedback only**.
Reproduce both in `repl-entries.test.ts` on the restacked branch. If they remain
red, fix the actual presentation/whole-content boundary and rerun that file
plus the affected presentation/journey selections. Reach exact text through
real wrapping/scrolling when necessary; do not weaken assertions to cut strings
or stale cells. Preserve first outputs and explain the correction. A genuinely
new product choice returns with a concrete conflict instead of a hidden change.

For each final PR head, run:

```sh
deno task lint
deno task check
deno task check:jsr
deno task validate:docs
```

JSR must end in `Success Dry run complete`. Fix delivery failures and rerun
the failed command and affected tests. Keep fixes signed and scoped. Do not
produce unsigned feedback revisions or alter the configured signing key to
work around 1Password. If signing refuses, preserve the staged tree and report
the actual blocker; retrying the identical commit after recovery is permitted.

Full Deno/Node/Bun suites belong to required CI. Run them locally only under
the repository's documented full-suite conditions, not a second time for
confidence. Dependency/build-state changes require the specialized committed-
HEAD `verify:clean` proof before push. No such change is currently planned.

Separate unfamiliar-agent teaching and the 36-frame comparison packet remain
deferred follow-ups under this feature freeze. Do not describe scripted tests
as proof that an unfamiliar agent learned XMD or claim a capture packet exists.
Required build/site/runtime/JSR/protection gates are not deferred.

## Publish the replacements through the existing PRs

The request authorizes updating #890 and #921 and investigating their delivery
CI. Do not open duplicate replacement PRs. Keep original local source branches
and safety refs intact; publish the new replacement heads to the existing
remote PR branch names using explicit refspecs.

Read both remote branch SHAs immediately before publication. Use explicit
`--force-with-lease=refs/heads/<branch>:<observed-SHA>` for each replaced remote
ref, never bare `--force` or an inferred stale tracking lease. If either lease
fails, inspect the newly published work and reconcile it before retrying.

Update PR descriptions around the final implementation and exact evidence,
including PR1's main target, PR2's dependency, the restack and deferred scope.
Use a body file with actual newlines. Preserve existing human review discussion;
do not claim old reviews apply to material new corrections. Use the normal
protected review workflow and do not request administrative bypasses.

PR2 stays stacked on PR1 until PR1 merges. Inspect required checks for exact
published heads and fix attributable failures. A main-target-only workflow
skipped on stacked PR2 is not passing evidence for PR2. Observe main-health
rules; never apply a repair exception label merely to deliver a feature.

Merge bottom-up through the repository's normal protected workflow only when
the exact head has all required checks and reviews. Re-read the head before
merging and refuse a mismatch. After PR1 merges, use its actual main merge SHA
to restack PR2 if necessary, preserving only PR2's own delta; do not replay
PR1 after a squash merge. Retarget #921 to main, republish with an explicit
lease if rewritten, and obtain its own complete main-target CI verdict before
its merge. Any material reconciliation receives its affected focused checks.

Do not mark delivery complete while a required check/review is missing or
while a branch still contains a known failing delivery test. If an external
required review blocks merge, report the exact PR/head and missing requirement
with all authorized preparation and verification completed.

## Final handback and continuity

Record original heads, target main, all three included presentation successors and preservation refs,
new signed PR1/PR2 SHAs, range-diff/conflict summary, every command/result,
EH1/UI10 disposition, exact PR URLs, required check/run links and merge SHAs
when merged. Identify any remaining gate precisely. Confirm the approved UI
corrections are included and unrelated root/isolated worktrees were not changed.

Current accepted sources: PR1 85da74b9 and PR2 c2536dd0. All three final
presentation corrections are complete and accepted. Last verified target:
4702890c, to recheck at restack. Produced: this released delivery handoff and
[the continuation](pr890-pr921-final-delivery-continuation-c2536dd0.md).
Next action: the designated Implementor preserves the accepted sources and
rebases PR1 onto current main, verifies it, then rebases PR2 onto the new PR1
head and completes publication/protected delivery. No feedback gate remains.
The integration architecture and prior acceptances remain the contracts;
rewritten SHAs receive fresh evidence at the delivery boundaries. Further UI
features, History stacking, conversation labels, the narrow question follow-up,
Parse #922, teaching and captures stay outside this delivery.
