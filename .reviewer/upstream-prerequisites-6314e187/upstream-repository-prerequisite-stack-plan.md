# Plan: shared execution and operation interfaces

**Current landed status:** U1, U2 and U3 are landed. [U3's merge receipt](upstream-repository-prerequisite-u3-landed.md) verifies PR #912, main `6314e187dc89c3e0f2b393b60d6f5963f847a881` and tree `3c4f45ca509e0de6ee820341c602319c7482386d`. A2/A3 are closed and carried by U3. The [U4 Implementor handoff](upstream-repository-prerequisite-u4-implementor-handoff.md) is finalized against that predecessor, with twelve frozen evidence rows and focused commands. U4 implementation requires separate authorization and a separate Implementor. U5 and #902 remain held as specified below. The initial base and estimates below are historical planning context.

Make File, File.Delete and Dir mean the same thing in every host, then let authored and generated documents use the same scoped operations. Five useful upstream PRs provide the reusable boundaries required by the held #902 consumer. This document plans those PRs; it authorizes no implementation or publication.

## Applies to

This Planner owns U1–U5 in core, runtime, CLI, Git declaration assembly and Workflow integration. The previous Planner owns #902, its ten evidence rows and all later repository selection, Git, publication and Issue work. Their artifacts and worktree remain intact.

```text
U1 fixed filesystem components, Dir in core
 -> U2 Permissions and shared contextual Files/Fetch
    -> U3 execution initialization and contextual Syntax
       -> U4 declaration metadata, URL identities, provider answers
          -> U5 contextual generated selection, remove old inputs
             -> previous Planner rebases and refactors #902
                -> later repository stack
```

All five upstream PRs land before consumer delivery. Each PR leaves ordinary execution, Workflow and supported runtime startup usable. Existing paths survive until their replacement PR; no temporary public bridge or incompatible writer/reader split is introduced.

## Authority and verified base

The [accepted prerequisite](upstream-repository-reusable-interface-prerequisite.md), especially Current contract and its accepted member/product/grouping amendments, governs. Earlier interview proposals are historical. The [current stack review amendment](upstream-repository-pr-stack-architecture-review.md#current-prerequisite-amendment) and [consumer review at 2b475121](upstream-repository-pr1-architecture-review-2b475121.md) establish ownership and the held consumer boundary. Interface, product-verification and grouping interviews are complete.

Repository instructions are `AGENTS.md`, `.agents/planner.md`, `.agents/agent-writing.md`, `.agents/architecture-rules.md`, `.agents/product-interface.md`, `architecture.md`, the affected specifications below, and [Effection v4 AGENTS](https://github.com/thefrontside/effection/blob/v4/AGENTS.md). The retained-REPL amendment in `/private/tmp/xmd-retained-repl-repositories/architecture.md` supplies historical product evidence; its recovery and forwarding mechanisms are not implementation authority.

Planning inspection on 2026-10-12 established:

| Source | Exact revision and meaning |
| --- | --- |
| Remote `taras/executable.md` main | `f79f6730784a7ecba7253dcd35e6e5567293876c`, resolved read-only through GitHub connector `github_fetch_commit` with `commit_sha: "main"`. [Commit](https://github.com/taras/executable.md/commit/f79f6730784a7ecba7253dcd35e6e5567293876c). |
| Root local main | `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`, tree `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`, identical committed tree to that remote baseline. |
| Consumer | `.claude/worktrees/pr1-file-dir`, clean `agent/repl-file-dir-pr1` at `2b475121ab76ec1147c7661c76200efd80488506`. |
| Historical implementation | `/private/tmp/xmd-retained-repl-repositories`, `559f446dbba97b33042e512fd3c018b9a0f64a47`; #899 was reverted by `3159095cdc48e96914f69740b3940972fb0ce6bd`. |

SSH `git ls-remote` could not resolve `ssh.github.com`; the connector supplied the remote revision instead. This is a point-in-time source lookup, not a main-health, CI, PR-status or mergeability verdict. No fetch or checkout occurred. Recheck remote main before creating an implementation worktree and compare changed boundaries if it advances. U2–U5 handoffs use their actual landed predecessors, never these hypothetical future revisions.

Preserve the root's pre-existing changes to `AGENTS.md`, `architecture.md`, `.agents/architecture-rules.md`, `.agents/product-interface.md`, and untracked `.agents/agent-writing.md`, `.reviewer/`, `greeting.md`. Working architecture/instruction amendments inform this plan but are not silently copied into another branch. Preserve the three previous-Planner artifacts named in the initiating handoff. No installs, product tests, implementation changes, commits or GitHub mutations are part of this planning pass.

## Source findings that determine the split

Paths below are relative to `/Users/tarasmankovski/Repositories/taras/executable.md`.

| Current boundary | Evidence and consequence |
| --- | --- |
| Canonical component selection | `core/src/components/{select,protected,component-resolution}.ts` selects protected names before host/author tiers and verifies the final answer against a privately retained definition. Today only Syntax/Evaluate use this tier. U1 extends the existing boundary to three ordinary filesystem definitions. |
| Ordinary forms and providers | `core/src/components/{File,FileDelete}.ts`, `core/src/invocation-identity.ts`, `runtime/{files,host-files}.ts` already separate authenticated form dispatch, component output and semantic provider operations. Keep those responsibilities. |
| Dir ownership | `git/src/composition/components/Dir.ts` imports only core/runtime/Effection contracts. `composition/{definitions,installation}.ts` supplies its duplicate owning definition/registration. Moving the body needs no Git service. |
| Selection consumers | `core/src/{inspect,component-documentation,execute,execution-declarations}.ts`, `components/{bundle,declared-markdown,registration,registry}.ts`, CLI `workflow-bundle.ts` and `syntax.ts` must agree about fixed names, origins, forms and documentation. |
| Duplicate generated I/O | `core/src/{evaluation-profile,fragment-capabilities}.ts` captures separate Files/Fetch operations; CLI `evaluation-profile.ts` creates a second host handler; Workflow `deno/workspace/evaluate.ts` creates separate Files/Fetch adapters. U2 removes those transports rather than wrapping dispatch a second way. |
| Execution lifecycle | `core/src/execute.ts` owns the task in `runInvocation`, captures trusted contributions in `invoke`, installs providers and calls public policy. Generated provider sealing currently happens later in `executeDocument`. U3 adds initialization in the owned scope; U5 completes pre-policy selection/implementation capture. |
| Syntax | `core/src/{syntax-reference,syntax-markdown,syntax-admitted,inspect}.ts` already supplies lazy descriptions; `components/Syntax.ts` retains final rendered text through `syntax_symbols`. U3 exposes contextual composition while retaining that journal boundary. |
| Provider provenance | `core/src/{component-answers,components/component-resolution}.ts` already bounds a synchronous answer request to an active provider/import window and retains the definition. U4 carries owner metadata through this path, replacing `claim(definition, identity)` with `answer(definition)`. |
| Generated schema | `core/src/generated-xmd.ts` contains versioned/legacy identity readers, policy writers/readers, static request ceilings and generic Workspace comparisons. U4 changes affected identity writers/readers together; U5 removes remaining policy inputs. |
| Host reachability | CLI `cli.ts`, `repl-{profile,assembly}.ts`, `repl/expansion.ts`, `plan.ts`, `testing-host.ts`, `workflow.ts` assemble different hosts. `runProfileChild` explicitly reinstalls behavior in an isolated scope. Deno/Node/Bun/compiled entrypoints retain runtime-specific assembly. |
| Unrelated durable ownership | Workflow `bundle.ts`, `run.ts`, `deno/workspace/{files,effect,restore}.ts` and Git `identities.ts` own history validation, preparation, transactions and external identity/reconciliation. Their mixed callbacks remain in their owning paths. |

The omitted `packages/` prefix in this table is for readability. No ownership is inferred from a reverted patch.

## Contract after U5

These members are additions/changes alongside existing API members:

```ts
interface ExecutionApi { init(): Operation<void>; }
interface ComponentApi {
  readonly generated: Readonly<Record<string, readonly InvocationForm[]>> | undefined;
}
interface PermissionsApi {
  fetch(input: string, init?: FetchInit): boolean;
  files(operation: "read" | "write"): boolean;
}
interface SyntaxApi {
  readonly symbols: Operation<SyntaxSymbols>;
  readonly text: Operation<string>;
  documentation(names: readonly string[]): Operation<string>;
}
interface ComponentDeclaration {
  readonly generated?: Readonly<Partial<Record<InvocationForm, GeneratedForm>>>;
}
interface GeneratedForm { readonly identity: string; readonly effect: "read" | "write"; }
interface ComponentAnswerRequest {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
  answer(definition: ImportedDefinition): ImportedDefinition;
}
```

Publish consumer contextual APIs and their types through package `/api` entrypoints: Permissions in runtime; Execution, Syntax and Component additions in core. Keep construction/installation infrastructure on the existing host boundary and definition contracts with their owning feature. Preserve existing root exports where applicable. Use stable namespaced names for new shared APIs and plain structural metadata across loaded copies. Context-api already lifts value properties and booleans: `yield* Component.operations.generated`, `yield* Syntax.operations.symbols`, `yield* Permissions.operations.files("read")`. No library upgrade or new context-api feature is required.

The final execution order is:

```text
existing execution task/scope and teardown ownership
 -> retain trusted owner contributions in their supported order
 -> live Execution.init, awaited inside that scope
 -> authoritative contextual reads and completed host assembly
 -> validate final generated selection; resolve selected names once
 -> privately retain selected forms, metadata and exact implementations
 -> public execution policy
 -> trusted retained-history admission before reuse/replay
 -> existing durable preparation/document policy/root/body path
 -> joined teardown before settlement
```

This diagram specifies relative obligations, not a new callback pipeline. Keep each existing history reader's validation before its own publication/use. No new historyChecks, restoration property, setup arrays, IDs, entry tokens or receipts are added. Public policy can continue its supported execution transformations but cannot replace or widen the already captured generated selection. Completed result reuse still applies trusted history admission. Initialization establishes live scope state; it does not inspect/recover checkout history or perform a completed local operation again.

Operation permission is decided by the terminal that performs I/O, after contextual middleware transformations. Defaults allow; restrictions return false or delegate unchanged arguments at the default maximum middleware order so a child true answer cannot bypass an ancestor restriction. Siblings regain the enclosing policy. Supported Files reads are readText/glob; writes include replacement, deletion, directory creation and temporary acquisition. Pure path checking authorizes nothing. Preserve File's lexical check before children; authorization belongs to its eventual write. Synthetic answers with no I/O perform no transport check. A replacement provider that performs I/O has the same obligation.

Files denial is an ordinary `Err` carrying sanitized permission-denied data, not provider-fatal refusal. Fetch denial fails the operation without request/response binding. Keep containment and native host ceilings in providers. Permission checks are scoped operation policy, not a native-runtime sandbox. Acquired cleanup retains acquisition ownership even if a descendant later refuses writes; cleanup is not a fresh document deletion or rollback. Cancellation remains cancellation, never a Result.

File/File.Delete/Dir bodies are fixed; ordinary Files middleware still transforms, answers, delegates and refuses. Syntax describes live contextual availability, while generated admission uses captured owner metadata. Generated selection is names/forms only; default undefined disables evaluation before the producer runs, but an explicitly empty/malformed value fails setup. Ordinary host fallback applies only to undefined. Multiple middleware handlers compose one final value; no automatic union or old profile-count failure remains.

URLs under `https://executable.md/` replace the affected generated identities without revisions or version selectors. Retain definition and metadata together through existing provider provenance. Source position is diagnostic only; copied URLs confer no authority. Keep unsupported generated definition kinds refused. One current affected schema replaces older generated identity readers/aliases/migrations; do not delete data or alter unrelated Workflow database/snapshot versions.

Completed local effects return their recorded result without live permissions, physical repetition, inventory, prediction or restoration. Unacknowledged local work can retry against the current environment/policy. Positional and nested journaling, actual Workflow snapshots/restoration/forks and external Git-host/Issue reconciliation remain owned by their existing features.

## U1 — fixed File, File.Delete and Dir

Outcome: a core host with Files and no Git Plugin creates/enters a directory, writes/reads/deletes a file and ignores same-name local definitions. Operation middleware remains observable.

Change/move/remove:

- Move `packages/git/src/composition/components/Dir.ts` to `packages/core/src/components/Dir.ts`, changing its imports to core internals. Preserve the paired `FormDeclaration`, path arithmetic, sanitized refusal, ensure-before-content and invocation-scoped cwd. Remove the old body; no forwarding file or public body alias.
- Give File/File.Delete/Dir one internal core-owned ordinary definition source, planned as `core/src/components/fixed-filesystem.ts`. Construct it from the existing form declarations, props and owning documentation. Extend `protected.ts` selection/name verification to include these ordinary definitions alongside the existing execution-built Syntax/Evaluate definitions. Keep special identity/site machinery limited to components that already need it.
- Remove File/File.Delete ownership from the replaceable default registry. Preserve `CORE_COMPONENT_NAMES` as the default-registry set; enumerate fixed names through `PROTECTED_COMPONENT_NAMES`. Update affected set consumers rather than duplicating ownership or changing unrelated defaults.
- In `execute.ts`, materialize fixed ordinary definitions in the protected path, issue/verify them through `CanonicalImports`/`ProtectedImports`, and invoke their ordinary form dispatchers. Do not build filesystem-specific claimants, sites, factories or private continuation APIs. Existing canonical final-descriptor retention decides what runs.
- Update `select.ts`, `inspect.ts`, declaration/bundle/registration validation and `component-documentation.ts` as required by that shared table. CLI `workflow-bundle.ts` must reject protected names after they leave the default set. All competing host claims refuse through existing admission machinery; repository candidates lose selection without loading their implementations.
- Remove Git's `dirDefinition`, form imports and Dir registration from `composition/{definitions,installation}.ts`. Twelve Git-owned registrations plus core-owned Dir preserve the author's existing vocabulary. Keep the existing `gitDirectoryEntry()` identity-only helper and its existing representation until U4/U5 replace that boundary; it is not another body or a new bridge API.
- Update `generated-xmd.ts` pinned File/Delete definition lookups and test harnesses that reach `CORE_REGISTRY` directly to the sole fixed definition source. Keep current generated selection, identities, private capability performers and journal shape in U1. Moving Dir does not admit it to the ordinary generated vocabulary or a generic Workflow profile that omitted it.
- Move Dir long-form documentation from Git `composition/components.md` into core `components/components.md`; update package/module prose and module-partition/provider-neutrality assertions for the actual move. Read `.agents/component-descriptions.md` before changing rendered descriptions.

Normal/failure/cancellation: existing read/write/delete Results and printed errors remain; File checks its path before children, File.Delete is self-closing only, Dir is paired only. A refused ensure begins no children or cwd binding. Successful ensure persists through later failure/cancellation; cwd always restores and Repository selection is unchanged. There is no new replay behavior or host-provider fallback.

Specifications: amend `architecture.md` component ownership/resolution descriptions; `specs/executable-mdx-spec.md` §§1.2, 5.3, 5.6, 6.13, 6.13.1 and CR/SY tiers; `workflow-workspace-spec.md` §§2.1, 6.3, 8.4 and affected vocabulary statements. Move the general Dir contract into the core specification at a stable new subsection, retaining Workflow-specific transaction and logical-path details in §§6.3/10.1. Existing generated identity wording describes the still-shipped identity until U4. Do not state later APIs as implemented in U1.

Focused evidence is frozen as U1-1 through U1-9 in the [U1 handoff](upstream-repository-prerequisite-u1-implementor-handoff.md#frozen-evidence). The core-host journey, competing claim/refusal checks, final-answer verification, authenticated forms, cwd failure/cancellation, inspection/docs and existing generated/host integration are finite requirements. That handoff names the exact focused commands and feedback commit contract. Estimated diff: 0.7–1.8k additions plus deletions, including both sides of the move, tests and docs; source-informed and uncertain, not a target.

## U2 — permissions and shared Files/Fetch

Depends on landed U1. Outcome: a read-only child permits authored/generated/direct contextual reads, refuses writes without target changes and restores sibling write allowance. Actual transformed requests reach one terminal policy boundary.

Change `runtime/files.ts`, `host-files.ts`, `apis.ts`, `api.ts`, `mod.ts`; add a runtime-owned `permissions.ts` API. Apply permission within host semantic operations before their first actual I/O, using the final contextual arguments, and before network transport starts. Preserve pure lexical checking and acquisition-owned temporary cleanup. Workflow `deno/workspace/files.ts` checks inside the live effect performer so completed replay does not ask policy again; preserve effect transaction/savepoint/root/journal ownership in `effect.ts`. Workflow-owned denial uses ordinary Files data and its existing transaction semantics.

Change core `fragment-capabilities.ts`, `evaluation-profile.ts`, generated operation execution and Fetch helpers to invoke ordinary core bodies/contextual Files/Fetch. Remove `FragmentFileAccess`/`FragmentFetchAccess` transport injection and duplicate file/dir/fetch bodies and cursor when their consumers are replaced. Preserve canonical preflight/form capture and useful response normalization, source descriptions and journal helpers. CLI `evaluation-profile.ts` loses `ordinaryFiles`; Workflow `deno/workspace/evaluate.ts` loses `workspaceFiles`/`fetchAccess`. Every shipped host switches in this PR. Remaining selection/identity/Workspace inputs remain until U4/U5, accurately described.

Keep default Files absence fatal, current error sanitization, return contracts, timeout resolution and abort/response lifetime. Do not widen terminal host URL/method/header restrictions when deleting adapters. No pre-dispatch permission wrapper, Files effect factory or secondary provider registry replaces those transports. Ancestor restriction composition and a replacement I/O provider's responsibility belong in public Permissions documentation.

Specification edits: executable §§1.2, 5.3.2–3, 6.11, 6.13–14, 6.18 and HF/FF/FE/WGAC/FR/FT evidence; Workflow §10 and workspace §§6.3, 8.4, 9–10. Describe live policy separately from completed replay.

Stack-level evidence: child false/descendant true cannot widen; sibling restore; File child read before refused write; authored/generated/direct operation parity; transformed URL and write payload; synthetic response no transport; normal denial/no binding; temp cleanup/cancellation under restriction; Workflow rollback/refusal and completed replay without provider/policy. Starting files: runtime `host-files.test.ts`, `fetch.test.ts`; core `file-component.test.ts`, `files-fatal.test.ts`, `fetch-component.test.ts`, `generated-xmd.test.ts`, `generated-composition.test.ts`; Workflow `workspace-files.test.ts`, `workspace-effect-transaction.test.ts`; CLI `workflow-fetch.test.ts`, `evaluate-workflow.test.ts`. Freeze exact commands and representative cases against U1 before handing off. Estimated diff 1.5–3.5k; removing duplicate bodies supplies much of it.

## U3 — execution initialization and contextual Syntax

Depends on landed U2. Outcome: ordinary setup runs inside each execution's existing scope, before contextual dependencies/public execution policy; Syntax middleware composes live descriptions and completed Syntax restores its recorded final text.

Change core `execute.ts` and `core/api.ts`/existing root exports for `Execution.init`; add core `syntax-api.ts`, exported with types through `/api`. Await init once inside `invoke`'s existing owner, before authoritative contextual dependency capture. Preserve early copying of trusted installation/admission/preparation/harness data and existing history validation order. Existing installation callbacks stay where their owners need them; do not migrate all members or introduce an extra generic callback phase. Default init is no-op, host handler installs ordinary package functions then delegates unchanged `next`.

Install Syntax defaults from the existing root/lexical references and catalog. `text` reads effective contextual `symbols` and renders them; named docs use the enclosing catalog and mark effective availability, including requested components unavailable to the generated selection. Generated scope narrowing uses ordinary middleware. Update `components/Syntax.ts` to dispatch those operations inside its existing durable live callback; keep completed `syntax_symbols` replay independent of live lookup. Keep origin-only `.ts` inspection lazy. CLI `syntax.ts`, Plan validation/generation and generated Syntax all describe the same effective selection without making descriptions admission authority.

Trace and update CLI `cli.ts`, `repl-profile.ts`, `repl-assembly.ts`, `repl/expansion.ts`, `plan.ts`, `testing-host.ts` and the runtime entrypoints for initializer reachability. Isolated `host="run"` children explicitly install the chosen host's init middleware in their own scope after cwd/environment assembly; they inherit no parent handlers. No new repository forwarding is added. Existing forwarding in the held consumer is removed by its owner after U5; do not modify that branch here.

Failure/cancellation: initializer failure prevents policy/root/body and settles only after acquired teardown finishes. Concurrent executions get distinct state; ordinary nested scopes inherit it. A cancelled initializer unwinds partially acquired resources. A completed replay may establish ordinary live scope state but does not repeat completed local operations or Syntax lookup. No Files default is invented by no-op init.

Specification edits: executable execution-protocol/lifecycle sections, §§5.3.1 and inspection/reference rules; architecture setup/capture/Syntax; Workflow §§3–4 only where ordering descriptions need precision. Keep Workflow run/bundle and Git journal-read callbacks, completed-output behavior, structural and test-harness contracts unchanged.

Stack-level evidence: one init per execution, visibility before authoritative reads/policy, init failure and cancellation joined teardown, concurrency/fresh state, no-provider default, isolated child fresh setup, default text/effective symbols/named docs consistency, scoped narrowing/restoration, unused `.ts` never loaded, completed Syntax no lookup. Starting files: core `execution-protocol.test.ts`, `syntax-{component,catalog,loaded-copy}.test.ts`, `workflow-component-bundle.test.ts`; CLI `testing-execution-host.test.ts`, `syntax-cli.test.ts`, `plan-component.test.ts`, `repl-execution.test.ts`; Workflow `workflow-run.test.ts`, `workflow-run-journal.test.ts`. The [final U3 handoff](upstream-repository-prerequisite-u3-implementor-handoff.md#frozen-acceptance-and-evidence-matrix) freezes the matrix and focused commands against landed U2, including the accepted A2 property types, reusable defaults and private per-occurrence reuse. Estimated diff 1–2.5k remains an estimate, not an acceptance limit.

## U4 — generated owner metadata and URL identities

The [final U4 handoff](upstream-repository-prerequisite-u4-implementor-handoff.md) freezes U4-1–U4-12, exact focused commands, shipped owner URLs and the U4/U5 boundary against landed U3. [Planning closure](upstream-repository-prerequisite-u4-planner-status.md) records source verification and authorization status.

Depends on landed U3. Outcome: each generated form describes its own identity/effect on the definition that actually runs. Providers publish that definition once through the existing live request.

Change core `types.ts`, `components/{registration,registry,protected,fixed-filesystem,component-resolution}.ts`, `execution-declarations.ts` and actual resolved definition retention for optional per-form `generated`. Include validation, cloning/retention and comparison of metadata so a changed definition cannot preserve authority accidentally. Built-in owning declarations supply the metadata; host registration and supported provider definitions carry it through ordinary paths. Do not admit unsupported definition kinds or automatically select metadata-bearing components.

Change `component-answers.ts`, private request/window handling, exports and every provider fixture (including `tests/support/answer-provider.ts`) to synchronous `answer(definition)`. Remove the separate identity argument. Use the existing provider installation/current-resolution/closed-request binding; keep exact function plus retained descriptor/metadata together. A return, throw or cancellation closes the request. Repeated/loaded-copy providers retain their supported behavior; position never authenticates a component. Ordinary unidentified middleware answers remain valid outside generated admission.

Change `generated-xmd.ts`, `evaluation-profile.ts`, retained identity/policy/admission writers and readers, core built-in builders and CLI/Workflow/Git directory helper consumers together. Assign distinct owner URLs to distinct File forms and accepted form metadata. Remove affected origin/key/revision and legacy string identity representations/readers/aliases. No version/revision suffix, migration or parallel schema remains at this generated boundary. Existing host read/write selection survives only as a name/form selection derived from actual owner metadata; eliminate duplicated contracts, not the host choice. U5 removes the remaining builders when unused.

Leave unrelated Git-host/Issue records, Workflow snapshot/database versions and stored data untouched. Current affected generated records refuse unreadable/older identities safely; no data deletion or conversion occurs. Preserve admission order, exact implementation binding and nested effect ordering.

Specification edits: executable generated admission/public provider/declaration contracts and FE/GXC/GX/WGAC tiers; workspace §§6.3/8.4/9 for affected identity/schema wording; architecture identity/metadata/provider publication. Rewrite current contracts, without historical compatibility prose implying support.

Stack-level evidence: distinct per-form read/write metadata, invalid URL/form/effect refusal, actual selected implementation/metadata captured together, copied URL no independent authority, mismatched returned answer, use after request close, repeated same provider and independently loaded copy, all affected current records round-trip and reject old schema, unsupported kinds stay refused, generated nested order stable. Starting files: core `evaluation-profile.test.ts`, `evaluate-component.test.ts`, `generated-xmd.test.ts`, provider lifetime/loaded-copy suites discovered on the actual predecessor, `component-registration.test.ts`; Workflow `generated-observations.test.ts`, `generated-agent-component.test.ts`; CLI `evaluate-workflow.test.ts`. Estimated diff 2–4.5k, with high schema/fixture uncertainty.

## U5 — contextual generated selection and removal of old inputs

Depends on landed U4. Outcome: hosts compose one names/forms property, core captures it before policy, and live operations use current permissions/configuration without generic checkout recovery.

Change `component-api.ts` and its owned descriptor variants/defaults/exports for `generated`. Default undefined; read the final property once after init/host assembly. Resolve each selected name once through actual canonical resolution, validate every requested form against owner metadata and retain exact definitions plus metadata before public execution policy. Move the necessary private generated preparation/sealing from later `executeDocument` into that existing pre-policy assembly; keep authored resolution and document policy on their supported paths. A later registry/import/selection replacement cannot widen the captured result. Malformed/missing forms and defined empty selection fail setup before producer/body; absence remains Evaluate's no-profile refusal before producer.

CLI `evaluation-profile.ts` becomes ordinary host property middleware: delegate, then default only if undefined. Remove `statesEvaluation` and `TWO_PROFILES`; multiple handlers compose normally, without count receipts or union. Update `cli.ts`, REPL, Plan, `testing-host.ts` and Workflow `workspace/evaluate.ts`/`cli/workflow.ts` assembly in the same PR. Ordinary selection remains File both forms, File.Delete self-closing, Glob and Syntax self-closing, Elicit paired; no Dir or Fetch. Workflow keeps its previously chosen Dir and optional Fetch availability. Pure Json/language composition stays available as before; metadata introduces no new selectable pure effect class.

Remove remaining `FragmentEvaluationInput` full read/write contract tables/builders and `ExecutionInstallation.evaluation` only after all shipped consumers use the property. Remove unused legacy exports from core host/Git/Workflow. Keep installation bundles, provider registration, durable preparation, structural expansion and harness contributions. Do not broaden the installation migration.

Remove frozen generated fetchTimeout; resolve timeout through contextual Config at the ordinary live Fetch route. Delete generic Workspace snapshot collection/membership comparisons and static exact request inventories/preflight authorization in `generated-xmd.ts` and remaining host adapters. Preflight still validates language, names, forms, props and allowed effect classes before effects. Runtime Permissions authorizes each actual transformed request. Keep host-specific destination/method/header ceilings in the terminal performing I/O. Keep normalization/journal helpers with real consumers.

Actual Workflow storage/restoration/forks and effect/root/journal transactions remain. Completed local replay does no policy/provider/inventory work; unrecorded work can fail under current restrictions. Preserve external reconciliation and journal positions; deleting a generic evaluator Workspace input does not delete a Workflow feature.

Specification edits: remove old profile inputs/count/error/capability transport/static request/Workspace ceiling claims from executable §§5.3.2–3 and related FE/GXC/GX/WGAC evidence; workspace §8.4 and replay §9; update architecture/host API/CLI descriptions to shipped property composition. Preserve actual workspace storage and restoration contracts.

Stack-level evidence: undefined/empty/malformed and missing owner/form cases; ordinary default preserves custom defined choice and fails defined empty; multiple middleware permitted without automatic union; capture precedes policy and later replacement cannot widen; ordinary/Workflow vocabulary exactly preserved; effective Config timeout; transformed request runtime policy; completed replay bypasses live provider/permission/Workspace inventory; untaken branches/form checks and nested journal order stay valid. Starting files: core generated/evaluate/profile and Syntax suites; CLI `evaluate-component.test.ts`, `evaluate-workflow.test.ts`, `workflow-fetch.test.ts`, `testing-execution-host.test.ts`, `plan-component.test.ts`, `repl-execution.test.ts`; Workflow generated observation/run/journal tests. Estimated diff 1.5–3.5k, high uncertainty around removal and fixture migration.

## Evidence ownership and review sequence

U1's finite matrix is frozen now in its handoff. U2–U5 have stack-level scenarios above, not speculative full Implementor prompts. After each predecessor lands, this Planner compares actual source and revisions, resolves any concrete conflict with the Architect and freezes the next bounded handoff. Additional permutations are not automatic acceptance requirements; a new blocking case must demonstrate a failed settled criterion or a distinct structural consequence.

Cross-stack allocation:

| Product outcome | Upstream owner | Consumer integration owner |
| --- | --- | --- |
| No-Git fixed filesystem components, Files transformations, cwd restoration | U1 | Existing consumer rebase compatibility only |
| Scope restrictions across authored/generated/direct operations; actual transformed I/O and synthetic answers | U2 | One recorder on the shared route |
| Init freshness, failure/teardown, isolated assembly; contextual/recorded Syntax | U3 | Entry recorder installed through init |
| Metadata, provider provenance/current schema | U4 | Rebased consumer uses current schema |
| Selection validation/composition, vocabulary, timeout and generic-input removal | U5 | No old generated-access wrapper |
| Reopen first binding while disk stays second; new entry reads second, source and compiled | Upstream supplies reusable interfaces | Previous Planner's consumer evidence |
| Deterministic interruption before/after durable result | Preserve operation/journal boundary | Previous Planner's consumer evidence |
| Paired ordinary/fresh-entry File read/write/delete/Dir cost, unrelated content and completed reopen | No evaluator inventory added | Previous Planner's consumer evidence |

No numeric cost budget or broad benchmark is introduced. The [integration note](upstream-repository-prerequisite-consumer-integration-note.md) tells the previous Planner which contracts affect their ten rows without replacing or reallocating them.

For every eventual increment, use known regressions/explicit integration files first, otherwise AGENTS affected-test selection. Once the frozen focused commands pass, create a stable feedback commit promptly and return its exact SHA and every command/result. Fix focused failures before committing. Architect implementation review and Product Owner review inspect that revision; feedback does not wait for lint/typecheck/full suites/CI merely for confidence.

Delivery is separate: required checks/branch protection and explicit merge approval govern. CI owns exhaustive Deno/Node/Bun shard matrices; run full suites locally only under AGENTS exceptions. Keep every command noninterfering; setup is the only installation route, build/check must not mutate dependencies/lock/tracked inputs. Use `verify:clean` after a committed dependency-state-affecting change as required; U1 adds no dependency or release change. Changes to generated artifacts follow their existing producer/byte verification procedure. Record a first failure before retry; an unchanged revision that passes a retry requires the prescribed flake issue through separately authorized issue work. Measuring new corpus weights belongs to the existing runner workflow at delivery, never hand-editing weights.

## Risks, recovery and continuity

No unresolved architecture blocker was found. The significant integration risks are a registry-only caller missing fixed names (U1), denial misplaced outside live durable performers (U2), initialization/capture or isolated-child setup happening too late (U3/U5), and a schema/provider fixture left on an old identity (U4). The assigned evidence distinguishes these boundaries. Estimates include additions/deletions/tests/docs and both move sides; they are not approvals. If the actual patch cannot be reviewed as its stated outcome, return a concrete further split to the Architect rather than forcing it under a number.

Do not reuse checkout recovery, filesystem-specific sites/factories/identity routing, continuation metadata, duplicate generated transports or new setup/history APIs from the historical implementation. Preserve ordinary bodies/providers, canonical retained-answer verification, owned lifecycle/error machinery, lazy Syntax renderers and journal operations. Never mutate `next`.

Exact planning base: remote `f79f6730784a7ecba7253dcd35e6e5567293876c`, inspected local `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`, identical tree `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`; point-in-time connector lookup, no CI verdict. Artifacts: this plan, [bounded U1 handoff](upstream-repository-prerequisite-u1-implementor-handoff.md), [consumer integration note](upstream-repository-prerequisite-consumer-integration-note.md), all under `/private/tmp/xmd-pr181-bench-rXAXyb/`. Interfaces, product journeys and U1–U5 order are settled; no blocker remains. U1 is ready for the next review/implementation authorization. The next authorized action is review of these planning artifacts; an Implementor starts only after separate authorization, then rechecks main and works in a new isolated checkout.
