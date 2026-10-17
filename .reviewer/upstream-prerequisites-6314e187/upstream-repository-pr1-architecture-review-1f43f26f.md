# PR 1 architecture review

**Verdict: REQUEST CHANGES** on `1f43f26fb71a802326578300f52021d9f82448e0`.

One blocking defect prevents an unfinished entry from continuing: concurrent branches can each record ambient checkout selection, but the entry-wide cache can suppress consumption of one branch's selection during replay. The journal then rejects the next local operation as divergent. This needs a bounded integration correction under the accepted positional replay contract. No new product decision or journal protocol is required.

## Review boundary

- Reviewed branch: `agent/repl-file-dir-pr1`, clean at the exact SHA above.
- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`.
- Base and current main verified read-only: `f79f6730784a7ecba7253dcd35e6e5567293876c`.
- Revert: `3159095cdc48e96914f69740b3940972fb0ce6bd`, main's second parent. The accepted pre-delivery tree is restored.
- Stack position: PR 1 of the smaller repository stack, PR #902, under #181. The PR head and base match the reviewed revision and base.
- Patch against base: 39 files, 5,737 additions and 82 deletions. The final commit changes lifecycle tests only, but this review covers the complete branch.

The governing records are the accepted [stack architecture review](upstream-repository-pr-stack-architecture-review.md), including L1, the [PR 1 handoff](upstream-repository-pr1-file-dir-implementor-handoff.md), and the [Planner review](upstream-repository-pr1-planner-review-1f43f26f.md). Repository instructions, the full architecture document, affected File/generated-access, REPL and workflow specifications, production wiring and focused tests were inspected.

Read-only inspection included concurrent PRs #890, #805 and #779 where their core, CLI or REPL contracts overlap. None supplies a missing dependency for this increment. No CI status was inspected. No implementation, commits, publication, merges or GitHub changes were made. Existing worktrees and planning artifacts remain preserved.

## Blocking finding: consume every branch's retained selection

**Priority: P1.** Location: `packages/git/src/deno/retained-repository/provider.ts:150–159`, reached from `files.ts:197–209`.

The settled invariant is E3: local results retain the existing journal's coroutine separation and ordered replay. Completed local operations return their acknowledged Results, and continuation can advance beyond the retained prefix without executing those operations again.

The live provider shares discovery, but it does not share the entire selection-recording operation. Two concurrent callers can both enter `selection()` before `selected` is assigned. Each then writes a selection at its own coroutine position. This is valid journal history.

On replay, one branch can restore selection before the other reaches its own saved selection. The second branch sees `retainedSelectionAhead()` and calls `recorder.selection()`. That method immediately returns the cached checkout at line 151, leaving its own saved selection unconsumed. The subsequent local-operation call encounters selection where it expects a local result and fails with divergence.

The journal correctly detects the mismatch. The defect is in the new provider's cache/record integration.

### Reproduced interruption

The focused probe uses ordinary supported components:

```xmd
<All>
  <Spawn>
    <File path="a.md">A</File>
    <Elicit schema={{ type: "object" }} as="answer">Continue?</Elicit>
  </Spawn>
  <Spawn>
    <File path="seed.md" />
    <File path="b.md">B</File>
    <Elicit schema={{ type: "object" }} as="answer">Continue?</Elicit>
  </Spawn>
</All>
<File path="sentinel.md">new suffix</File>
```

`seed.md` exists before execution. Both branches finish their writes and enter an elicitation handler that waits. The probe copies the actual stream prefix at that point, then halts and joins the live task. No events are removed or reordered. The prefix contains two successful selection records and two successful local records, with no coroutine close events.

Continuing that unchanged prefix with answers available produces:

```text
Divergence at root.1[2]: expected repl_repository_selection(...), got repl_repository_local(...file-write...)
```

No replay write occurs, but the new `sentinel.md` operation is unreachable. That prevents the intended run from resuming, a structural consequence expressly covered by architecture review.

The initial simplified probe removed close events from a finished run. The decisive probe above replaces that fixture with an actual interrupted prefix. Earlier probe construction errors are preserved separately and are not evidence against the implementation.

Probe and complete failure output:

- [Executable probe](architect-pr1-concurrent-selection-live-prefix.test.ts).
- [Failure log](architect-pr1-concurrent-selection-live-prefix.log).

Command, run from the exact worktree:

```bash
deno test --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/architect-pr1-concurrent-selection-live-prefix.test.ts
```

Result: exit 1; one test/step fails on the expected successful-continuation assertion. This is a deterministic data-flow failure in the exercised run, not a request for exhaustive scheduling permutations.

### Required correction

Consume a selection standing at the current coroutine's retained position even when another branch has already populated the entry cache. Keep live discovery shared and completed replay free of filesystem, Git discovery, lease acquisition and mutation work. Preserve positional matching and entry ownership.

This belongs in PR 1: it is caused by the new ambient-selection cache and directly prevents the File continuation delivered by this increment. It restores frozen E3 rather than adding an acceptance boundary. Do not introduce source coordinates, an effect-site parameter, continuation metadata, a private completion protocol or another durable identity scheme.

## Other reviewed boundaries

The implementation follows the accepted smaller direction in these areas:

- Authored mutations use an entry-installed outer Files recorder; generated writes/deletes use captured access through the existing evaluation-profile boundary. Live middleware can answer, transform, delegate or refuse. The old invocation descriptor, private inspect/answer route, pass-through layer and next-first provider fallback are absent.
- The entry factory is installed by Deno/compiled entrypoints and invoked under the executing entry's owner and segment. Passive views do not construct it. Node/Bun retain ordinary File/Dir behavior.
- Local record admission binds history to the host-derived entry owner. Generated permissions and generated Dir exclusion remain under the existing tables.
- Completed local replay is checked before live routing. New work uses live behavior; interrupted unacknowledged work can run again. No checkout inventory or restoration is introduced.
- L1 reuses the native advisory lock. Lazy lease acquisition belongs to the entry, contention occurs outside local result recording, and teardown joins work before releasing resources. No process-global ownership registry is added.
- The shared Workflow advisory helper now registers cleanup before acquisition, closes refused descriptors promptly, and releases held descriptors once. Ordinary managed-slot policy remains unchanged.
- Managed Repository/Worktree selection, local Git, publication and Issues remain outside this increment. Existing external reconciliation is not redesigned.

These conform to the accepted feature decisions and architecture rules 2, 3 and 22. No new system-boundary interview or Product Owner decision is needed to correct the finding. Never mutate `next` or attach metadata to it.

## Focused evidence

Independently executed on the exact reviewed revision:

```bash
deno task test packages/git/tests/retained-repository-local.test.ts packages/git/tests/retained-repository-lifecycle.test.ts packages/workflow/tests/workflow-lifecycle-authority.test.ts
```

Result: exit 0, four tests / 37 steps. This includes the existing concurrent equal-write example, local replay/interruption/refusal cases, entry leases, child cancellation, observed descriptor closure, and existing workflow lifecycle authority. The simpler concurrent-write case passes; the preceding finding explains why that does not cover the cache consuming records at different branch positions.

The machine-written `pr1-r3-command-receipt.txt` named by the Planner was read. It reports F1 at 14 tests / 86 steps, the workflow command at two tests / 11 steps, and successful lint/typecheck. Those are reported results except for the independently executed subset above. Its embedded old-helper probe demonstrates the old fixture defect, not a defect in this revision.

Unaffected F2–F6 evidence is reused from `e5f095bfe8ccd3b6aca80fd486fffd265267876c`. The earlier machine receipt does not survive; source/compiled journeys and the broader unaffected groups are previously reported passing evidence, not independently rerun evidence for this review. That provenance limitation is recorded separately from the reproduced blocker and does not itself require repeating unaffected tests.

The accepted bounded cost evidence reports five equal 30-operation / 1,024-byte samples: ordinary median 82.2 ms, live entry 150.4 ms and completed continuation 39.3 ms, with zero continuation mutations, Git calls or lease acquisitions. No performance budget is inferred.

| Frozen row | Review assessment |
| --- | --- |
| E1 Public source/compiled continuation | Wiring and journey assertions inspected; unchanged reported passing evidence reused. |
| E2 Composed answers/refusals | Source inspected and local suite independently passes. |
| E3 Positional association/composition | **Blocked by the reproduced selection-cache divergence.** Existing simpler cases pass. |
| E4 Replay before live environment work | Source inspected and local suite independently passes. |
| E5 Persistence/interruption | Source inspected and local suite independently passes. |
| E6 Generated capture/ceiling | Capture wiring and focused integration assertions inspected; reported evidence reused. |
| E7 Entry ownership/passive history | Admission, factory lifetime and view guards inspected; reported evidence reused. |
| E8 Lease/resource lifetime | Exact lifecycle and workflow suites independently pass. |
| E9 Ordinary behavior/runtime partition | Runtime wiring, ordinary provider extraction and partition assertions inspected; reported evidence reused. |
| E10 Bounded cost | Accepted bounded comparison retained; no new threshold. |

## Revision prompt

Read this prompt to correct PR 1's replay integration and return an exact feedback revision for review. It applies to Deno source and compiled REPL entry continuation.

Work from `1f43f26fb71a802326578300f52021d9f82448e0` on `agent/repl-file-dir-pr1`, base `f79f6730784a7ecba7253dcd35e6e5567293876c`, in the existing implementation worktree. Preserve unrelated changes, historical evidence and earlier reviews. This prompt is review feedback; implementation and commit actions require the user's applicable authorization. It authorizes no publication, GitHub mutation or merge.

The settled contract requires each coroutine to consume its retained operations in journal order. The Architect reproduced failure with the attached live-prefix probe: two concurrent branches each record ambient selection; one branch reads `seed.md` before its write; both stop at Elicit after completed writes. On continuation the entry-wide cache at `provider.ts:151` skips the second branch's retained selection. The next local operation fails with journal divergence, preventing the suffix from executing.

Correct that cache/record interaction. A retained selection at the current cursor must be consumed despite an already populated cache. Preserve shared live discovery, entry ownership, ordinary middleware Results, generated capture and permissions, and completed replay without native work. Keep the existing journal coroutine/position model. Do not mutate `next`, add an effect-site API, redesign the journal or reopen L1.

Add one discriminating regression in the existing local suite, using the attached probe as evidence. Capture a real unfinished prefix while both branches await answers, then halt/join and continue it unchanged. Assert both completed mutations return from history without invoking live providers, both questions can be answered, and the new suffix runs once. Keep existing equal-request concurrency and repeat-continuation evidence intact. Do not broaden this into a scheduling matrix.

Run the local regression suite and the existing structured-concurrency suite first:

```bash
deno task test packages/git/tests/retained-repository-local.test.ts packages/durable-streams/tests/structured-concurrency.test.ts
```

Run any further focused evidence affected by the actual correction. If resource ownership or lease code changes, include the existing lifecycle and workflow authority regressions; otherwise reuse their unchanged passing evidence. Preserve the first failure output. Return the exact feedback SHA, base, changed files, commands and results for Architect review. Do not begin PR 2 or rewrite the settled plan as a new design.

## Continuity

There is one architecture blocker and no unresolved Product Owner design decision. The next action is the bounded PR 1 correction above, followed by exact-revision Architect review. This report does not alter Planner acceptance or its frozen scope. Product Owner review and explicit merge approval remain separate requirements. No feedback was published to GitHub.

## Subsequent accepted amendment: scoped repository setup

Repository setup uses ordinary functions that install middleware on the existing operation APIs. The Product Owner withdrew the proposed contextual installation operation: add neither `Repository.install()` nor a separate `RepositoryInstaller`, `RepositoryProvider` or `RepositorySetup` contextual API. `Repository.around()`, `Git.around()` and `Files.around()` already install the behavior that execution uses. Installation itself needs no middleware seam.

The command is already known and selects the corresponding setup. Ordinary runs retain their ordinary provider behavior; the REPL uses local-result recording for this File/Dir increment. Add no execution-kind field and infer no mode from the presence of a journal. Native implementations remain in runtime adapters, outside shared CLI imports. Remove repository factory forwarding through `runXmd`, command dispatch, REPL profile, program and session options.

### Lifetime: call setup in the executing scope

Call the selected setup function inside each executing run or entry's scope. The existing REPL entry task supplies that scope; no additional lifecycle protocol or factory API is needed. Each call creates fresh provider state in ordinary local variables. Middleware and lazily acquired resources belong to that scope and end when it ends. A command may span many entries, so command selection chooses the behavior while each entry's setup call creates its state.

Keep teardown ordering: execution and native work stop and join before the entry's held resources release and its slot becomes available. Isolated ordinary run children call ordinary setup in their own scope and share no parent selection, leases or publication evidence. Passive history views never call entry setup. Setup itself performs no checkout discovery, lease acquisition or mutation; those remain lazy work for a live operation.

### Entry isolation: use the existing stream

The Product Owner accepted removing the extra REPL record-owner label and setup's `executionId`/`entryKey` parameters. Each execution receives its own `EntrySegmentStream`; the journal matches operations by coroutine and ordered position. The repository recorder adds no second entry identity. The session retains the execution id and entry key for its existing history, routing and lifecycle responsibilities.

Remove the redundant owner label from this increment's ambient-selection and local-mutation records, their names/fingerprints, and their owner-comparison admission logic. Keep structural parsing, supported-version checks and request matching. Do not move the label into context or replace it with another identifier. External-effect identities and reconciliation remain unchanged.

This explicitly amends E7's ownership mechanism: prove that entries receive separate stream segments and cannot replay each other's records through the normal host path. Remove expectations requiring different repository owner labels or different local names solely because identical requests occur in different entries, and retire the feature-specific foreign-owner rejection requirement. Existing segment tests supply the isolation evidence; ordinary positional/request matching still applies within each segment. The structural consequence is which entry's history execution can replay; `EntrySegmentStream` owns that boundary. No journal redesign or broader evidence matrix is requested.

### Execution installations and generated access

Retain the accepted setup input/output shape as an ordinary function contract: take the existing readonly execution installations and return the prepared readonly installations. Keep the existing `executeInstalled()` boundary. The ordinary setup installs its existing contextual repository operations and returns the input installations unchanged. REPL setup prepares authored mutation recording and wraps the generated-file access already supplied by the command. It preserves the permission tables and unrelated installations. There is no separate generated `files` return value or repository-specific profile transformation in the REPL session.

This setup is called before document execution, inside its executing scope. It does not add a public permission lookup, mutable execution registry, source-site parameter or continuation metadata. Never mutate `next` or attach metadata to it.

### Hosts without repository support

Preserve the accepted pass-through behavior without inventing an installation API: on a host supplying no repository setup, use the original execution installations and acquire no repository resources. File/Dir operations require and use the ordinary Files provider. Repository and Git operations retain their own existing missing-provider errors. This preserves Node/Bun behavior and supplies no native fallback.

### Continuity

These accepted decisions supersede the earlier contextual-installer proposal, its proposed names and the temporary explicit identity arguments. They are local feature decisions, not new general rules. No Product Owner decision remains about the installation method, entry lifetime, extra local identity, generated access or unsupported-host behavior. The original exact-revision verdict and concurrent replay reproducer remain valid.

The Planner must map the actual runtime-to-command composition and the concrete setup call inside each executing scope. It must show how the setup is available at that call while preserving runtime imports and removing factory forwarding; a scope determines lifetime, not module availability. Reuse existing composition boundaries. A new public or cross-package setup-routing mechanism would need Architect review rather than being silently substituted for the withdrawn API. This is an integration trace to include in planning, not a request for another lifecycle abstraction.

The original defect revision prompt remains historical feedback. The accepted amendment also applies to the next handoff. The existing stack plan, Implementor handoff, exact-revision Planner report and implementation remain preserved. No implementation, commits, publication or GitHub changes were authorized by this amendment.

### Planner amendment prompt

Read this to prepare the bounded PR 1 revision handoff after the accepted scoped-setup interview. It applies to ordinary run and Deno source/compiled REPL setup, with Node/Bun preservation. This is planning feedback, not implementation, commit, publication or merge authorization.

Use reviewed revision `1f43f26fb71a802326578300f52021d9f82448e0`, base `f79f6730784a7ecba7253dcd35e6e5567293876c`, the preserved PR 1 handoff and this report as starting evidence. Recheck the current base read-only before preparing a handoff. Preserve historical code, evidence and earlier reviews.

Prepare the plan amendment and next Implementor handoff around these accepted outcomes:

1. Ordinary functions install middleware on existing repository, Git and Files operation APIs. Introduce no contextual installation API and add no `install` member to `Repository`. The command selects setup using its already known command. Native runtime imports stay outside shared CLI code; add no mode field or journal-based mode inference.
2. Remove repository factory forwarding through `runXmd` and dispatch/profile/session. Trace the concrete runtime-to-command composition and call the selected setup function inside each executing run or entry's scope. The existing entry scope suffices: fresh local state per call, lazy acquisitions owned by that scope, and normal teardown. Preserve ordinary setup for isolated run children.
3. Keep ordinary behavior intact. Setup takes existing execution installations and returns prepared installations for canonical core. REPL setup adds authored recording and wraps the existing captured file access while preserving permission tables. Remove the separate generated-file result and session-specific repository assembly. Hosts without repository setup use the original installations and create no resources or recording.
4. Remove this feature's redundant record-owner label, setup execution/entry identity inputs and owner comparison. Preserve stream isolation, journal position/coroutine association, structural record parsing and request matching. Apply the explicit E7 amendment above; do not redesign the journal or weaken external reconciliation.
5. Correct the reproduced concurrent selection replay defect using the real unfinished-prefix probe and one discriminating regression. Keep completed replay free of live discovery, leases and mutations.

Identify the exact modules that stay, change or go, and the focused evidence affected by these changes. Retain E1–E10's finite scope except for the explicit E7 replacement. Cover changed ordinary/REPL assembly, generated capture, isolated child behavior, source/compiled continuation and concurrent replay with existing focused tests where possible. Reuse unaffected lifecycle/L1 evidence unless the correction changes those boundaries. Introduce no performance threshold or exhaustive scheduling matrix.

Keep L1, the File/Dir-only increment, generated permissions, passive history and external reconciliation settled. Do not begin PR 2 or retain a redundant mechanism solely because the reviewed branch contains it. The next implementation returns an exact feedback revision for Architect review, followed by Product Owner review and explicit merge approval. Planner acceptance substitutes for none of those gates.
