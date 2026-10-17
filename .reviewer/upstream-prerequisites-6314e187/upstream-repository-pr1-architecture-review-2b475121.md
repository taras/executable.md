# PR 1 Architect review at 2b475121

The completed changes introduce no new structural defect found by this review. The concurrent replay blocker from `1f43f26f` is corrected. S1 remains an architecture hold: the accepted removal of repository-function forwarding has no approved replacement route. This report does not issue an architecture PASS for the complete amended PR 1 or accept the remaining transport as the final design.

The Product Owner rejected delivering PR #902 with the forwarding retained. The accepted order is a separate prerequisite PR establishing a reusable interface, followed by refactoring #902 to consume it. The interface contract remains to be reviewed. The earlier deferral proposal below is preserved as rejected history and is not the current next action.

## Exact revision and authority

- Reviewed head: `2b475121ab76ec1147c7661c76200efd80488506`.
- Base and current remote main: `f79f6730784a7ecba7253dcd35e6e5567293876c`, independently rechecked through the GitHub API.
- Main's recorded revert: `3159095cdc48e96914f69740b3940972fb0ce6bd`, tree `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`.
- Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`, branch `agent/repl-file-dir-pr1`; clean before and after review commands.
- Draft PR #902 points to the reviewed head and base. No CI was inspected.
- Stack position: PR 1, ambient-checkout File/Dir recording. Managed repositories, local Git replay and external publication remain later increments.

The accepted scoped-setup amendment in [the earlier Architect record](upstream-repository-pr1-architecture-review-1f43f26f.md#subsequent-accepted-amendment-scoped-repository-setup), the finite E1–E10 handoff and L1 govern. The [Planner review](upstream-repository-pr1-planner-review-2b475121.md) accepts the completed subset and explicitly leaves S1 open. Its missing-lint-receipt observation is superseded by the supplemental receipt inspected here.

The review follows `.agents/architect.md`, the three product/architecture rulebooks and the agent-writing guide. The previously reviewed architecture baseline and affected specifications were carried forward with their exact revision changes inspected. Existing journal ordering, generated permissions, L1 and external reconciliation are not reopened. Open PRs #890, #805 and #779 remain overlapping evaluation/REPL work; none supplies the missing preparation route. This revision changes no core execution-capture contract and depends on none of those unmerged changes.

## Implementation assessment

| Settled boundary | Exact-revision assessment |
| --- | --- |
| Fresh state in the executing scope | `runEntry` calls setup after the Agent attachment and before `executeInstalled`. Native preparation creates a fresh recorder; its lazy discovery, Git session and lease use the entry scope. Ordinary and isolated-child setup creates independent ordinary provider state. |
| Generated-file permission ceiling | `packages/git/src/deno/retained-repository/installer.ts:58` accepts installations and returns prepared installations. Its map wraps only an existing `evaluation.files` value, retains the stated permission tables and other members, and leaves an installation without captured access unchanged. The separate Files return and session-specific profile rewrite are gone. |
| Entry isolation | `repl/session.ts:980` passes the entry's `EntrySegmentStream` to canonical execution. Local records, names, fingerprints and admissions contain no extra execution/entry owner label. E7 independently passed: identical requests in separate entries have equal names but each entry performs its own write. Structural/version/request validation remains. |
| Concurrent replay | `retained-repository/provider.ts:139` remembers selection per durable coroutine while sharing live discovery. The genuine interrupted-prefix probe passes at this head: both saved branch selections are consumed, completed writes are skipped and the new suffix runs. |
| Completed and interrupted local work | `files.ts:190` checks retained routing and results before live path resolution, discovery and lease acquisition. Existing local tests pass for completed results with changed/deleted checkout contents, unacknowledged work, nested recording, ordinary refusals and fatal persistence/provider failures. |
| Ordinary middleware and absence | Existing Files continuations remain callable without metadata mutation. Direct answers and transformed delegation retain their ordinary Results. A host without setup passes installations through and records no local operations; it still requires the ordinary Files provider. No new contextual installation API is exported. |
| Passive history and teardown | Settled history does not call setup. Entry-owned lazy resources remain outside completed replay and retain existing joined teardown ordering. L1 lease/helper behavior is unchanged by this correction. |
| Runtime-to-execution availability | Open at S1. The ordinary functions still travel through `runXmd`, dispatch and profile/session/settings fields. This is the declared excluded work, not a completed removal. |

The changes from `56723fe3` span 29 files, with 579 additions and 673 deletions. The cumulative PR spans 43 files, with 5,846 additions and 158 deletions. These are diff counts, not a review allowance. No additional machinery is required by the findings above.

## Independent focused evidence

Commands ran from the exact worktree above. Full output is preserved beside this report.

```bash
deno task test packages/git/tests/retained-repository-local.test.ts packages/git/tests/retained-repository-records.test.ts packages/cli/tests/repl-repositories.test.ts packages/cli/tests/run-profile.test.ts packages/cli/tests/run-composition-nested.test.ts packages/git/tests/api-entrypoint.test.ts
```

[First output](architect-pr1-2b475121-focused.log): exit 1. Six tests / 52 steps passed. The isolated-child suite's six steps failed because subprocesses given a fixture-owned `HOME` looked for dependencies outside the prepared Deno cache and npm DNS resolution failed. This output is preserved; it is not reported as a successful whole command or a product replay failure.

```bash
DENO_DIR=/Users/tarasmankovski/Library/Caches/deno deno task test packages/cli/tests/run-composition-nested.test.ts
```

[Cache-selected rerun](architect-pr1-2b475121-nested-cache.log): exit 0, one test / six steps. The directory is the existing cache reported by `deno info --json`; no dependency installation, source change or test change was made. The rerun proves isolated-child cwd, independent leases and parent/sibling publication isolation under the prepared environment.

```bash
deno test --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/architect-pr1-concurrent-selection-live-prefix-setup.test.ts
```

[Interrupted-prefix output](architect-pr1-2b475121-prefix.log): exit 0, one test / one step. The captured history contains two routing records on `root.0` and `root.1`, two completed local mutations and no Close. Continuation performs only `sentinel.md`. The two `rev-parse` commands belong to discovery for that new suffix; completed branch replay performs no discovery. The original failing probe and historical evidence remain preserved.

## Reported evidence and corrections

The supplemental [R5 receipt](/private/tmp/claude-501/-Users-tarasmankovski-Repositories-taras-executable-md/6ed03464-691d-401e-9493-c23923a83995/scratchpad/pr1-r5-command-receipt.txt) now records the corrections explicitly: F3 is 41 tests / 171 steps and Node has 18 passes. It preserves the earlier formatting failure and appends `deno task lint` exit 0 and `deno task check` exit 0 at `2b475121`. Those results were read, not independently rerun here, and do not stand in for delivery verification.

The receipt's source/compiled journey and benchmark evidence remains implementation-reported. The five equal 30-operation / 1,024-byte samples report medians of 74.0 ms ordinary, 134.5 ms live entry and 39.1 ms completed continuation. Continuation records zero writes, deletes, ensures, Git calls and lease acquisitions. No new performance threshold or evidence matrix is introduced.

## S1 assessment: the missing route

Scope ownership is settled. An ordinary function called in the existing entry scope creates entry-local state and has the right teardown lifetime. The unresolved fact is how shared execution modules obtain a native function after its arguments and profile/settings fields are removed.

The existing ordinary contract is sufficient:

```ts
type RepositorySetup = (
  installations: readonly ExecutionInstallation[],
) => Operation<readonly ExecutionInstallation[]>;
```

The call must remain before canonical execution:

```ts
const prepared = yield* setup(installed);
const execution = yield* executeInstalled(options, prepared, initialization);
```

This is an illustration of the accepted function contract, not a new proposed API. No setup operation, extra owner, lifecycle factory or mode field is needed.

The inspected boundaries do not supply a replacement route:

| Existing boundary | What it actually provides | S1 consequence |
| --- | --- | --- |
| `deno.ts` / `compiled.ts` and `deno-repositories.ts` | Native setup imports and credential-helper assembly | The functions are available here. Calling them once at command startup would create the wrong lifetime; forwarding currently makes them available at each executing scope. |
| `deno-repl.ts:21` and `repl/host.ts` | REPL storage primitives and terminal assembly | This host has no execution/preparation member. Adding one changes its boundary; it is not reuse of an existing operation. |
| `cli.ts:1446` and `repl/session.ts:978` | Installation assembly followed by canonical execution | These shared modules cannot statically import the current Deno graph without changing unsupported-runtime startup. |
| `testing-host.ts` | An ordinary run assembled inside an isolated child | Parent middleware does not reach this scope. Its existing settings explicitly carry the ordinary setup function. |
| Core `Execution.execute` middleware | Policy around an already captured execution request | `execute.ts:3584` prepares evaluation before installation callbacks and before this middleware. It cannot return new captured access through the current request contract. |
| Plugin installation | Command-scoped contributions of declarations, admissions and expansion | The current Plugin contract has no per-execution installation-preparation callback. Extending it would be another interface change. |

No inspected existing boundary meets all the accepted constraints after forwarding disappears. Introducing a setup Context/API would reverse the explicit decision against an installation API. Mutating `next`, deferring changes to captured permission data or importing native code into shared modules is not a substitute. Moving execution assembly or extending an existing host contract needs a separate concrete boundary proposal.

I treated transport removal as a smaller integration change than this source trace supports. It cannot honestly be handed to the Implementor as routine deletion with all decisions already settled.

## Historical proposal: explicit deferral, rejected

The system-boundary interview is triggered by the proposed change to how runtime behavior reaches execution. The inventory has three execution paths: ordinary documents, REPL entries and isolated ordinary children. Their state ownership, setup signature, generated ceiling and absence behavior are already accepted. The current interview reviews only whether transport removal remains a prerequisite of PR 1; it approves no replacement interface members.

**Recommendation:** defer transport removal to a separate architecture change and retain the explicit ordinary-function route in PR 1. This changes one earlier requirement and therefore needs Product Owner acceptance. It does not restore the removed owner label, separate Files result or factory-return protocol, and it introduces no new API. Each call still prepares fresh state in the correct existing scope.

If accepted, the Planner can remove S1 from this increment's required scope, describe the retained route accurately and preserve the removal as separately held work. The complete PR 1 review can then close against that explicitly amended scope. Delivery verification, Product Owner review and explicit merge approval remain separate.

If rejected, S1 stays blocking PR 1. The next Architect task is a concrete execution-assembly boundary interview before the Planner writes its remaining handoff. No Implementor chooses the route and no new API is implicitly approved. Choosing this option does not reopen the completed replay or record-format work.

**Product Owner answer:** rejected deferring removal until after PR 1. Build the reusable interface in a separate prerequisite PR, then refactor PR #902.

## Continuity and authorization

The original replay defect is closed at this exact revision. No new implementation revision is requested by the completed-subset findings. S1 is not resolved by this report, renamed into a different API or silently dropped. The accepted record, stack plan, handoff and historical implementation remain preserved.

Next actor: Architect designs the prerequisite's reusable interface through the required boundary interview. The Planner then prepares the prerequisite and consumer handoffs from its accepted contract. PR #902 remains held until it consumes that interface and removes the forwarding. No implementation, commits, publication, GitHub edits, CI inspection, merge or PR 2 work occurred. Only architecture records and independent command logs were written.

## Accepted prerequisite order

The Product Owner directed: “we should first create a new Pr to turn it into a reusable interface and then refactor this PR”.

1. Establish the reviewed reusable interface in a separate prerequisite PR against main. It must be useful and coherent independently of the REPL File/Dir feature.
2. Refactor PR #902 to consume the accepted interface and remove repository-function forwarding through `runXmd`, dispatch/profile/program/session and isolated-child settings.
3. Review each exact implementation revision independently. Product Owner review, delivery verification and explicit merge approval remain separate for each PR.

This accepts dependency order, not an interface signature, package placement, contextual operation or implementation. It does not revive a repository installation API or authorize an empty GitHub PR. The existing #902 worktree stays preserved at `2b475121ab76ec1147c7661c76200efd80488506`; no code changes are needed to record this decision.

The next interview begins with the reusable boundary's responsibility. The Architect recommends reviewing preparation of a document execution before canonical core captures its installations, with ordinary runs, REPL entries and isolated children as the three concrete consumers. That responsibility and its eventual interface are proposals until accepted. Existing trusted permission capture, normal scope ownership, runtime import separation and unsupported-host behavior remain constraints on the proposal.
