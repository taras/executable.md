# U3 Implementor handoff — execution initialization and contextual Syntax

**Current implementation review:** Planner and Architect **PASS** at `ac466780cda608eafe974951c13c09c02b2b1cd4`; [Planner review](upstream-repository-prerequisite-u3-planner-review-ac466780.md) and [Architect review with focused evidence](upstream-repository-prerequisite-u3-architect-review-ac466780.md). A2/A3 are closed. Next is Product Owner review of this exact revision, followed by delivery, separately authorized publication and explicit merge approval; U3 is not landed. The original handoff below is the frozen planning snapshot; its partial-worktree and no-feedback statements describe that earlier preparation.

**A3 closed on 2026-10-14.** The Product Owner approved the [host Syntax setup resolution](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md). The Planner has incorporated the approved helper, private fallback ordering, symbols-only narrowing and CLI/Plan placement below. The Implementor resumes the same prepared worktree under the existing authorization. A2 remains closed; the frozen evidence is unchanged. No feedback commit or publication occurred.

Read this for the next prerequisite after landed U2. U3 gives ordinary setup one execution-owned entry point and makes live Syntax descriptions contextual while retaining completed recorded answers.

**Frozen baseline: planning completed and evidence frozen on 2026-10-14.** A2 is closed by the accepted [typed lazy Syntax resolution](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md). The Product Owner subsequently authorized U3 implementation and accepted A3's one host setup helper. Publication and merge remain separate.

## Applies to

Core's existing execution owner, public Execution/Syntax exports, protected Syntax's live observation, generated descriptive narrowing, CLI inspection and Plan/REPL/isolated ordinary host integration. This does not implement U4 metadata/identity changes, U5 generated-selection/input removal, or any #902 consumer work.

Authority: the [accepted current contract](upstream-repository-reusable-interface-prerequisite.md#current-contract), [Execution initialization composition](upstream-repository-reusable-interface-prerequisite.md#accepted-execution-initialization-composition), [Syntax summary](upstream-repository-reusable-interface-prerequisite.md#accepted-syntax-boundary-summary), preserved installation-member responsibilities, and [stack U3](upstream-repository-prerequisite-stack-plan.md#u3--execution-initialization-and-contextual-syntax).

## Verified starting point

| Item | Value |
| --- | --- |
| Remote main, verified read-only on 2026-10-14 | `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec` |
| Tree | `f3562253edc8310370d5459416abe8ad23769805` |
| Landed predecessor | U2, [PR #906](https://github.com/taras/executable.md/pull/906) |
| Reviewed U2 head with the same tree | `cdcfe328f1c8ec0cd7a62329a99d17b7edd60d1e` |
| Inspected source | Exact Git archive at `/private/tmp/xmd-pr181-bench-rXAXyb/u3-planner-source` |

The U2 worktree has been removed. The Planner did not recreate or install into it. The archive has no `.git` or prepared dependency layout; it is source evidence, not an implementation/build worktree. The initial worktree/preparation instructions have now been fulfilled: the authorized U3 implementation is in `.claude/worktrees/u3-contextual-syntax`, branch `agent/upstream-u3-contextual-syntax`, at the verified predecessor with nine partial core files modified/new. Resume that prepared worktree; do not create another worktree or repeat setup merely for A3.

Open #890 remains at `79d404d04d02c3840892473b6f1b2cf540f3edd1`. Its overlap includes core `host.ts`, generated-XMD paths, architecture and the executable specification. It changes neither `execute.ts` nor `syntax-reference.ts` at the inspected head. Account for any later landed overlap; do not merge an unlanded PR to manufacture a base. The held #902 branch remains `2b475121ab76ec1147c7661c76200efd80488506` and is not this task's worktree.

Preserve the root workspace's existing modified guides, AGENTS.md and architecture.md, its untracked agent-writing/reviewer files and greeting.md, and every existing branch/worktree. Root local main is older than the landed base; do not implement in it or reset it.

## Smallest useful behavior

A command host installs middleware once. Canonical core invokes it afresh in each execution's existing owned scope:

```ts
import { Execution } from "@executablemd/core/api";
import { useHostFiles } from "@executablemd/runtime";

yield* Execution.around({
  *init(_args, next) {
    yield* useHostFiles();
    yield* next();
  },
});
```

This supplies an explicit provider; a no-op initializer invents none. Other setup functions compose through the same middleware. A recorder allocated there belongs to that execution, ordinary children inherit it, and two executing entries receive distinct state. The example adds no CLI flag, XMD component, installation array, entry key or receipt.

Live bare `<Syntax />` asks the contextual text property; its default renders effective contextual symbols. Named Syntax asks the documentation operation and reports availability using those effective symbols. Middleware may change these descriptions without enabling or disabling executable components. The final returned text is journaled, and completed replay calls no live descriptive provider.

## Source findings and implementation boundaries

### 1. Add Execution.init in the existing owner

Add `init(): Operation<void>` to `ExecutionApi` in `packages/core/src/execute.ts`, keeping `execute` and `document` unchanged. The public descriptor's init default is no-op; its execute/document defaults continue to refuse noncanonical invocation. Export the same Execution descriptor and needed request/API types through `core/api.ts`, preserving existing root exports. Do not introduce a second public Execution Api/name or weaken its private terminals.

`runInvocation()` already creates the owner task and scoped invocation, joins its teardown, and exposes the authoritative handle. `invoke()` runs inside that scope. Use it rather than a new task, resource owner, request brand or setup protocol.

Preserve early trusted-input capture: initial root bindings are parsed/copied before the owner; `invoke()` copies admissions, preparations, bundles, harness installers, identity/structural declarations, provider/install callbacks and the existing generated evaluation profile before untrusted callbacks can mutate them. These are trusted input retention, not contextual dependency lookup. Keep generated implementation and canonical-import revocation armed before installed code runs.

The intended insertion point is in `invoke()` after those copies/lifetime guards and before the captured provider/ordinary installation callback loop and `capturedDocumentation()`. Invoke and await `Execution.operations.init()` once there. Preserve the callbacks' relative order and all subsequent owning-feature steps. Init middleware establishes its scope state, then delegates `yield* next()`; no count receipt or authentic request is added to init.

After init, existing host assembly and documentation capture complete before public `Execution.execute`. The generated profile's later sealing, registry/bundle/declaration resolution and `Execution.document` retain their existing owners. U5 moves generated selection/declaration retention to its final pre-policy location; U3 must not implement that later increment prematurely.

Initializer failure prevents policy, root import and body. Failure/cancellation joins partially acquired resource teardown before settling/rejecting through the existing pre-handle/handle paths. Completed handle observation starts no new initialization. A fresh continuation execution establishes fresh live scope state while completed durable operations restore without replaying local work.

### 2. Add the accepted contextual Syntax API

Target `packages/core/src/syntax-api.ts`, exported with `SyntaxApi` and `SyntaxSymbols` through `core/api.ts` and the root entrypoint. The accepted interface remains:

```ts
interface SyntaxApi {
  readonly symbols: Operation<SyntaxSymbols>;
  readonly text: Operation<string>;
  documentation(names: readonly string[]): Operation<string>;
}
```

Use the stable descriptor name `executablemd.core.syntax` across loaded copies. The caller yields `Syntax.operations.symbols` / `.text` without parentheses, and `Syntax.operations.documentation(names)` as a method. Construct it with `createApi<SyntaxApi>` and export exactly `Api<SyntaxApi>`. Defaults are reusable Operations; `call(generatorFactory)` creates fresh generator work for each read and is not a Promise conversion. Do not store a single consumable generator instance as a default. Property middleware and its `next()` return Operations, including synthetic answers. Apply the accepted A2 resolution and typed proof without casts, differently typed descriptors, dependency changes or adapters. No public catalog property, generated-admission reader or second declaration registry is approved.

Reuse `syntax-reference.ts`, `inspect.ts`, `syntax-markdown.ts`, the captured documentation contributions and the existing selection/index helpers. Default symbols is lazy and describes the current default root/lexical vocabulary. Default text reads the effective contextual symbols and uses `renderSyntaxMarkdown()`. Default named documentation selects metadata/long-form text from the enclosing catalog and reads effective symbols once for availability. It does not parse text. Preserve full-origin identity comparison, canonical selection order and unknown-name refusal.

Preserve SYN49's one root-symbol resolution for a named occurrence. The private reference/catalog owner resolves its authoring basis once and reads effective contextual symbols once for availability. Its ordinary root provider reuses that occurrence's basis, rather than independently inspecting a moving root again. Keep this request-local reuse inside the owning reference with ordinary Context/scoped APIs, as demonstrated by the accepted probe. Two occurrences resolve independently. Synthetic symbols or named-documentation middleware that does not delegate performs no default inspection. No eager execution-wide cache, public catalog, generic request-cache API, authorization flag or scope instrumentation is introduced; unused TypeScript stays origin-only and unloaded.

Private references may remain as carriers of captured catalog/provenance needed by core. They must no longer bypass ordinary contextual dispatch for the live descriptive answer. The execution-derived reference is the API's private fallback, not inner middleware that shadows an enclosing host profile. The accepted `useSyntax(source)` helper installs symbols/documentation providers at `min`. Generated narrowing overrides symbols only and retains the enclosing named-documentation owner. A scoped description override restores on exit and never changes generated admission.

### 3. Keep Syntax's authenticated body and durable boundary

In `components/Syntax.ts`, keep the protected definition, claimant/site validation, invocation schema/form checks, output/capture behavior and `syntax_symbols` operation. Move the bare/named API dispatch inside the existing durable live callback. Do not consult symbols/text/documentation on completed restoration or record intermediate/default text before middleware returns.

Retain the successful `{ symbols: string }` / safe `{ refused: non-empty string }` protocol, hostile reader, publication-before-interpretation and secret gate. Only canonical named-selection refusal receives the existing safe classification. Provider/middleware failures, malformed history, durability/secret rejection and cancellation remain terminal. A component looking up descriptions cannot admit a generated name, grant Files permission or replace the protected component.

Update `components/Evaluate.ts` and the descriptive seam in `generated-xmd.ts` so paired producer and generated body use contextual narrowing. Preserve the different producer's operational permission, selected generated forms, composition Json, enclosing named documentation, one-profile rule, static request ceilings and protected routing/lifetime. Descriptive middleware may claim a prohibited component is available; preflight must still refuse it before effects. A filter may hide an admitted component; it remains admitted.

### 4. Integrate the existing host paths without a forwarding API

Trace `cli.ts:runDocument`, `repl/session.ts:runEntry` and `testing-host.ts:runProfileChild`, all of which reach `executeInstalled()` and therefore the same new core initialization point. Register command-host initialization middleware through ordinary owning package setup; do not add an init function, repository callback, entry id or receipt to runXmd or ReplExecutionProfile.

An isolated ordinary child inherits no parent middleware. Its current assembly installs cwd first, reinstalls chosen Plugin values through `installPlugins(nestedRunProfile(...))`, and explicitly installs its host Files/Service/Repository behavior. Preserve that explicit assembly. Initialization middleware supplied by the chosen host/plugins must be installed there after cwd assembly and invoked by the child's canonical execution; an arbitrary parent handler must not leak into it. Keep existing released host-installer ownership; do not redesign every operational host service or move command-lived Agent/session resources into an execution.

REPL's `agent.owning(key)`, lifecycle installation, inherited root bindings and per-entry journal view keep their current lifetimes. Init adds execution-local state below that existing entry owner; it must not allocate one recorder for the whole REPL command or reacquire the entry attachment. Preserve expansion stepping and teardown ordering.

For descriptive delivery, remove `ExecutionInstallation.symbols`, its provider collection/count refusal in `invoke()` and its argument through `executeDocument()`/`rootSyntaxReference()`. Export the accepted `useSyntax(source: () => Operation<SyntaxSymbols>): Operation<void>` helper from `@executablemd/core/host`. It snapshots existing scoped documentation contributions and binds core's private reference to the lazy source, installing ordinary symbols/documentation providers without reading that source. Core alone converts its own canonical unknown-name selection into the private safe refusal; provider failures remain terminal and the refusal class stays private.

Migrate `cli/src/plan.ts` and `cli/src/plan-writer-profile.ts`, plus the corresponding Syntax/Plan fixtures, through that helper. Private CLI command-profile setup enters the target run's declarative bootstraps, captures registry/declaration inputs and calls `useSyntax` while the same assembly's documentation contributions remain in scope. Its source lazily inspects those captured target inputs; do not bootstrap only inside a temporary symbols callback that loses documentation before setup captures it. In the bounded `runPlanCommandDocument()` scope, install this target-run descriptive setup before `executeInstalled()`. Named metadata must not fall back to the restricted authoring execution's catalog. Effective contextual symbols still determines availability.

An ordinary private host source callback with an immediate consumer may remain; no new execution installation member replaces `symbols`. Direct command fixtures install their own lazy source through the helper. Embedded Plan keeps its enclosing descriptive profile. Remove the unused `SyntaxSymbolsProvider` host export/type when its consumers are migrated. Replace the former descriptive-provider count fixture with composition evidence; the separate generated-evaluation one-profile rule remains. No blanket migration of other installation members is authorized.

CLI `syntax.ts` uses the same command-profile assembly and `useSyntax` setup in its bounded inspection scope, without running Execution.init or operational package setup merely to print syntax. `syntax --json` reads structured symbols; Markdown reads contextual text; named inspection uses contextual documentation. Keep declarative `useCommandComponents()` separate from providers, leases and native Agent behavior. Plan validation remains structural and independent of a customized description.

The landed Plan trusted-read amendment remains intact: no Scope observer, ancestry map or read grant returns. The default Files provider still belongs to the host. Deno/Node/Bun/compiled startup and provider absence remain as shipped.

### 5. Preserve unrelated contributions and update the contract

Keep Workflow/Git journal admissions, retained-run validation, paired bundle/run contributions, durable preparations and external-effect callbacks in their owning feature paths. Init establishes live dependencies; prepare remains journaled work after retained-history validation and before public document policy/root import. Completed recorded output remains passive. Structural declarations stay paired with their handlers; invocation-bound Test harness delivery and expiry remain unchanged.

Update architecture's execution lifecycle and Syntax descriptive boundary; executable §5.3.1, generated descriptive narrowing wording, execution protocol/lifecycle §§8–9 and relevant EP/SYN/SY/NEX/PI evidence. Workflow §§3–4 change only if ordering prose needs precision. Keep current SyntaxSymbols version/schema and recorded-answer compatibility. Remove prose claiming no document middleware can change a live Syntax description, while preserving canonical name/implementation protection and admission authority.

## Explicit exclusions

No Component.generated property, declaration generated metadata, URL identities, `answer(definition)` migration, read/write table removal, Workspace input removal, static request-inventory removal, Fetch-timeout change, new generated vocabulary or one-profile-rule removal. These belong to U4/U5. No #902 recording, lease, repository selector or forwarding-removal implementation occurs here. A3 permits only the one descriptive host setup helper above. No new runtime dependency, dependency upgrade, adapter, generic context-restoration API, invocation hook, installation collection, permission wrapper or public catalog property is included. A2 uses installed context-api 0.6.0.

## Frozen acceptance and evidence matrix

Rows U3-1–U3-12 and the commands below are the finite feedback threshold. They include A2's accepted types, reusable defaults and private per-occurrence ownership. Reuse existing evidence where it already discriminates the behavior. The Implementor returns a gap that prevents proving a row; it does not expand acceptance independently. A new blocker requires a demonstrated failure of a frozen criterion or an explicit architecture amendment with a distinct structural consequence.

| Row | Discriminating evidence | Placement |
| --- | --- | --- |
| U3-1 | No-op init, same root/API descriptor, one core dispatch per fresh execution and no reinitialization when a completed handle is observed again. | New `core/tests/execution-init.test.ts`; execution-protocol |
| U3-2 | Init-installed ordinary dependency/marker is visible to trusted assembly/documentation capture and public execute policy; init cannot alter previously retained admissions/declarations/profile inputs. | New init file; existing capture/admission tests |
| U3-3 | Failure and deterministic cancellation during init prevent policy/root/body and wait for acquired cleanup; concurrent executions keep fresh independent state, ordinary descendants inherit, later sibling does not leak. | New init file; EP23–25/28 reuse |
| U3-4 | No-op init supplies no Files provider. Explicit host init supplies one. Root, two REPL entry executions and isolated host=run child each execute setup in the correct owned scope; child reinstalls chosen host/plugin middleware and does not inherit an unrelated parent handler. | Files-fatal; CLI testing-execution-host/repl-execution/plugin-host |
| U3-5 | Exact public Operation-valued types; repeated reads use reusable lazy defaults; a suspending symbols transform affects default text and named availability; text-only transform leaves symbols/named lookup alone; synthetic symbols/named answers skip default inspection; sibling restores. | New `core/tests/syntax-api.test.ts`; Syntax component |
| U3-6 | Each named occurrence resolves its authoring basis once and effective symbols once; two occurrences resolve independently; metadata/availability agree. Requested enclosing components remain documentable when unavailable under generated selection. Unused TypeScript is not loaded. | SYN49, syntax-catalog, named Syntax/Plan |
| U3-7 | Final bare and named middleware text is recorded; completed/partial Syntax restoration trips no live text/symbol/catalog lookup. Safe named refusal restores; provider throw and publication/secret/cancellation stay terminal. | Syntax component and existing journal cases |
| U3-8 | Generated producer/body get scoped names/forms and restore the enclosing view. Descriptive additions cannot admit a forbidden name/form; descriptive filtering does not disable an admitted component. | Evaluate/component/profile/generated-XMD; existing alias controls |
| U3-9 | Protected Syntax name/import/loaded-copy refusals and invocation identity stay effective despite freely customizable live description. | Syntax component/loaded-copy and Evaluate loaded-copy |
| U3-10 | CLI JSON/Markdown/named output and Plan target-run documentation reuse the effective construction; Plan structural validation remains unchanged. | syntax-cli; Plan component/command-document; plugin API |
| U3-11 | Workflow run/bundle admission, durable prepare, completed replay and journal ordering remain intact; no unrelated callback is flattened or migrated. | workflow-run, workflow-run-journal, workflow-component-bundle |
| U3-12 | Source/compiled ordinary startup and Plan information/documentation journey carry the new public API. Removed descriptive inputs have no dead consumers. | build/docs, compiled Plan/plugin, dead-code inventory |

Use representative controls, not every component/runtime combination. Reuse the existing middleware ordering and U2 operation/replay evidence. The accepted [typecheck](u3-syntax-operation-property-probe-check.log) and [runtime proof](u3-syntax-operation-property-probe-run-env.log) establish feasibility, not product acceptance. U3-5 uses a real suspending provider/transform and repeated reads of the production descriptor. U3-6 asserts lookup counts at the owning source; U3-7 installs providers that fail if replay consults them. Those observations make bypassed dispatch, a consumed default, duplicate root inspection and live replay lookup distinguishable without adding a test matrix of runtimes and components.

## Frozen focused feedback commands

After implementation authorization, prepare a fresh isolated worktree once with `deno task setup`. Run a known regression first when fixing a failure, then the following bounded groups. No full local suite is required by this handoff:

```sh
deno task test packages/core/tests/execution-init.test.ts packages/core/tests/execution-protocol.test.ts packages/core/tests/files-fatal.test.ts packages/core/tests/workflow-component-bundle.test.ts
deno task test packages/core/tests/syntax-api.test.ts packages/core/tests/syntax-component.test.ts packages/core/tests/syntax-catalog.test.ts packages/core/tests/syntax-loaded-copy.test.ts packages/core/tests/evaluate-component.test.ts packages/core/tests/evaluate-loaded-copy.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/generated-xmd.test.ts
deno task test packages/cli/tests/testing-execution-host.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-agent-journey.test.ts packages/cli/tests/syntax-cli.test.ts packages/cli/tests/plan-component.test.ts packages/cli/tests/plan-command-document.test.ts packages/cli/tests/plugin-host.test.ts packages/core/tests/plugin-api.test.ts
deno task test packages/workflow/tests/workflow-run.test.ts packages/workflow/tests/workflow-run-journal.test.ts
pnpm exec tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 packages/core/tests/execution-init.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/execution-protocol.test.ts packages/core/tests/syntax-component.test.ts
bun test --timeout=300000 packages/core/tests/execution-init.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/execution-protocol.test.ts packages/core/tests/syntax-component.test.ts
deno task lint:dead-code
deno task build
deno task test scripts/tests/plan-component-compiled.test.ts scripts/tests/plugin-compiled.test.ts
```

Only `execution-init.test.ts` and `syntax-api.test.ts` are new files; all other selected paths exist at the verified base. Respect the runtime-exclusion manifest, including Deno-owned loaded-copy/Workflow journal tests. Use the prepared Deno cache when source-CLI subprocess tests isolate HOME. Build before compiled evidence; builds install nothing. There is no dependency or setup change. This API amendment adds no dependency-layout/composability verification requirement.

Return the exact signed feedback SHA, actual base/tree/clean status, every focused command and result, first failing/control output and row map. Commit promptly once selected evidence passes. Full lint/typecheck/runtime suites and required CI remain delivery checks unless an applicable repository rule or demonstrated selection gap requires earlier evidence. CI is not Planner feedback evidence.

## Common mistakes

Do not put init in `Execution.execute` middleware after dependency capture, create another execution owner, or invoke it once per document element. Do not move durable preparation ahead of retained-history admission or convert it into ordinary initialization.

Do not implement value-property providers with casts that hide an Operation behind a string/SyntaxSymbols type. Do not make a synthetic descriptive answer trigger eager inspection, perform two moving root lookups for one named occurrence, journal default text before middleware, or use a description as admission authority.

Do not rely on parent middleware in isolated children, make REPL setup state session-wide, reinstall its Agent attachment inside init, or add repository-function forwarding to solve host reachability. Do not restore Plan's retired grant machinery.

## Continuity and next action

Exact base: `9c4f4f9a66e25c1c396c0e65c72d35dff722c5ec`, tree `f3562253edc8310370d5459416abe8ad23769805`. Continuity artifacts: this handoff, [planning closure](upstream-repository-prerequisite-u3-planner-status.md), [accepted A2 resolution](upstream-repository-prerequisite-u3-syntax-architecture-resolution.md), [accepted A3 resolution](upstream-repository-prerequisite-u3-plan-named-lookup-architecture-resolution.md), their linked proofs, historical requests and exact source archive.

Settled: Execution.init's name/default/delegation/owner, typed lazy descriptive properties and recorded replay, host isolation, Plan trusted reads, preserved installation-feature ownership and U4/U5 exclusions. **A2 and A3 are closed by accepted architecture resolutions.** The initial Planner preparation and these Architect amendments changed artifacts only; the Implementor's separately authorized partial source remains in its prepared worktree. Feasibility probes are recorded in the resolutions and do not replace production feedback evidence.

Unresolved architecture blockers: none. Next: with the bounded A3 amendment incorporated and frozen rows/commands preserved, Implementor resumes the same prepared worktree under the existing authorization, completes the bounded implementation, runs the frozen evidence and promptly returns a signed feedback commit. No repeated implementation authorization is required. Architect/Product Owner implementation review, delivery verification, publication and merge remain separate. U4 waits for landed U3; #902 remains held through U3–U5 and removal of consumer forwarding.
