# U5 Implementor handoff — contextual generated selection

Read this after U4 has landed and U5 implementation has been separately authorized. It
freezes the last upstream prerequisite for #902: hosts select generated component names
and forms through `Component.generated`; core captures their actual definitions before
execution policy runs. Files and Fetch continue through their ordinary contextual
providers and live Permissions.

## Applies to

Core execution and protected Evaluate, ordinary CLI runs, REPL entries, isolated
`host="run"` children, Plan writers and Workflow hosts. This handoff authorizes planning
only. Use a **new Implementor session**, starting with `.agents/implementor.md`, for
authorized implementation. This session remains Planner.

Planning base: `3a1fade9246db937e11da6cdadc4751ec924be97`, tree
`b92762664a24d7b5636b08c98d96907a614d76f0`. GitHub main and merged PR #919 were read on
2026-10-15; main still names this commit. [U4's landed
receipt](upstream-repository-prerequisite-u4-landed-receipt.md) distinguishes the
published head from the earlier reviewed feedback revision. Recheck main for later
landed overlap before choosing the implementation base.

### Authority and reading order

1. Read the implementation checkout's `AGENTS.md`, `.agents/implementor.md`, `.agents/agent-writing.md`, the mandatory Effection instructions and `architecture.md` fully. Read the affected specifications below.
2. Read the [accepted current contract](../upstream-prerequisites-6314e187/upstream-repository-reusable-interface-prerequisite.md#current-contract), then [U5's stack boundary](../upstream-prerequisites-6314e187/upstream-repository-prerequisite-stack-plan.md#u5--contextual-generated-selection-and-removal-of-old-inputs).
3. Use this handoff's instructions, evidence and commands. The earlier interview sections preserve history; the Current contract and accepted amendments govern.
4. Read the [consumer integration note](../upstream-prerequisites-6314e187/upstream-repository-prerequisite-consumer-integration-note.md). U5 supplies the reusable interface. The previous consumer Planner owns #902's later rebase, recorder integration and forwarding removal.

The [exact source archive](source/) is evidence, without Git metadata, dependencies or
setup. Do not build or implement there. The sibling preservation archive
`../upstream-prerequisites-6314e187/` is immutable.

## Instructions

### 1. Establish an isolated implementation checkout

After authorization, recheck remote main and report later overlap. Create a fresh U5
branch and worktree from the reverified base, then run `deno task setup` once there. Run
it again only if dependency changes require it; none are planned. Use the implementation
checkout's instructions rather than the old root checkout's task definitions.

Keep the root checkout's user edits, U3 and U4 worktrees, the held #902 worktree,
preservation refs and immutable archive untouched. Do not reuse `source/` as a worktree.
PR #890 remains open at `79d404d04d02c3840892473b6f1b2cf540f3edd1`; it is named overlap,
not a dependency. No CI inspection, push, PR, merge or cleanup is assigned by this
handoff.

### 2. Add the contextual selection

Add this member alongside ComponentApi's existing members:

```ts
readonly generated:
  | Readonly<Record<string, readonly InvocationForm[]>>
  | undefined;
```

It is a plain value property. Consumers yield `Component.operations.generated` without
parentheses. It is **not** an Operation-valued property like Syntax's lazy members. The
installed context-api already supports this shape; no dependency or adapter is needed.

The default is `undefined`. Include it in `COMPONENT_DEFAULTS` and every owned Component
descriptor through the existing shared defaults. Update explicit descriptor fixtures and
exports as required. Do not add a second Context, setter API, selection collector or
registration channel.

Read the final contextual answer once after initialization and captured installation
callbacks have assembled the host, and before public `Execution.execute`. Copy and
freeze the name map and each forms array. Validate the entire selection before resolving
it:

- `undefined` preserves absence. A document with no Evaluate may run; an Evaluate refuses before its producer runs.
- A defined selection must contain at least one name. Every value is a non-empty, duplicate-free array containing only `self-closing` and/or `paired`.
- Malformed maps, names or form lists refuse setup. Do not repair, filter, merge or replace an invalid selection with a default.
- Resolve each selected name once, even when it selects both forms or its forms belong to different effects. Missing names, unsupported definition kinds, and forms not offered by the owning definition's generated metadata refuse setup.
- No member of an invalid batch becomes an executable partial selection. No public execution policy, root import, paired producer, fragment body or generated admission runs after a setup refusal.

Use ordinary component-name validation and U4's canonical form/metadata validators. Do
not introduce a second parser. Treat caller-owned properties as inputs: take one reading
into owned data, validate that reading and retain it. A validated metadata copy that is
discarded before rereading the caller's object does not satisfy capture.

### 3. Capture actual implementations before execution policy

Use the existing invocation-owned scope and canonical import machinery. The required
order is:

```text
capture the unchanged trusted installation contributions
  -> arm existing owners' teardown
  -> Execution.init
  -> captured component-provider and ordinary installation callbacks
  -> establish canonical registry/bundle/declaration/protected resolution
  -> read and validate Component.generated once
  -> resolve each selected name once and retain its implementation and metadata
  -> public Execution.execute policy
  -> existing history validation, durable preparation and document execution
  -> joined teardown before invocation completion
```

At this base, `invoke()` already initializes and assembles before public policy, but the
canonical component assembly and profile sealing are inside `executeDocument()` after
policy. Move the minimum component assembly needed for selection into the existing
invocation owner and reuse its result for authored execution. This includes
bundle/declaration admission, execution-built identities, protected definitions and
canonical answer verification. Install any schema compiler required by that admission in
its existing owning scope. Do not create a second set of protected/private identities or
a second initialization phase.

Preserve public policy's supported document-request changes and canonical request
settlement. A policy may still modify/refuse its document request. Its later registry,
import or selection replacement cannot replace or widen the already captured generated
allowance. Selection resolves against the host environment established before that
policy, including its search paths. Ordinary authored resolution remains contextual
where it is contextual today.

Resolve through the complete ordinary `Component.importComponent` chain and the existing
canonical terminal. Legitimate core defaults, fixed definitions and host registrations
are canonical answers; they do not require a separate host provider to publish them
again. Existing component-answer providers still publish through their registrar and
exact live request/window. A middleware replacement that has no authentic publication
remains refused. Preserve request closure on return, failure and cancellation, provider
isolation and loaded-copy composition. A URL or origin string supplies no authority.

All selected names use this resolution path, including File, File.Delete, Dir, Glob,
Fetch, Elicit and protected Syntax when selected. Do not preserve a separate
capability-selection arm. Evaluate offers no generated form and cannot admit itself.
Unsupported Markdown/structural answers are refused; do not add a new repository
module-export convention to make them admissible.

This changes the old pinned exception for replaceable names: selecting Glob, Fetch or
Elicit resolves the actual host answer. If a replacement offers no generated metadata
for the selected form, setup refuses, even when the eventual fragment would not use that
name. Do not silently fall back to core's default implementation. File, File.Delete and
Dir remain fixed under U1.

Retain the callable, schemas, forms, generated metadata and descriptive provenance from
the same accepted answer. One selected name holds one implementation. U4's owned-copy
and single-read rules remain in force, including accessor inputs, nested schema data and
form metadata. Reuse `admitGeneratedForms`, the existing answer retention and
`invocation-forms.ts`. Preserve the actual form dispatcher and execution-private
protected routing with the captured definition. Generated imports may be observed,
delegated or refused; later handlers cannot replace or mutate the retained
implementation.

Arm revocation before the captured operations can escape. Failure or cancellation during
selection closes answer windows and the existing execution owners. A captured
implementation refuses after its execution ends; another execution cannot revive it.
Keep the current distinction between pre-handle setup failure and a post-handle
completion Result, including joined teardown and fatal-error precedence. Do not
introduce a module-global registry, public routing object, new durable owner or new
history phase.

### 4. Derive Evaluate's allowance from owner metadata

Internally project the captured forms into read/write entries using each form's owning
`effect` and URL. Hosts supply no read/write contract tables, schemas, descriptions,
operations, identities or dispatchers through the selection. Internal projections used
by preflight are allowed; they are not another host input.

Keep `allow` as the existing non-empty, duplicate-free subset of `read`/`write`,
defaulting to read. It narrows the captured forms and grants no missing class. File's
two forms share one definition and keep distinct read/write identities. Keep Json's
existing always-on pure composition path and structural language; add no selectable pure
effect class.

Use the same retained definitions for preflight, narrowed producer/fragment Syntax,
ordinary form dispatch and invocation. Preserve enclosing named documentation, protected
Syntax routing and the producer's own operational permissions. A producer's imports or
registrations cannot enlarge the fragment's allowance. No selected name is resolved
again at fragment invocation.

Whole-fragment preflight still checks language, names, forms, props and effect classes
before the first generated effect, including untaken branches. Keep existing local
declarative data expressions and binding scope. Dynamic request destinations expressed
by that language are valid inputs. Do not add new expression syntax, arbitrary
JavaScript, a static Permissions pass or an all-or-nothing runtime effect guarantee.

### 5. Compose host defaults through ordinary middleware

Change `packages/cli/src/evaluation-profile.ts` into ordinary Component property
middleware. Delegate first; provide the ordinary selection only when the delegated
answer is `undefined`. A defined answer, including an empty or malformed one, is
preserved for core to validate. Multiple handlers compose normally. There is no
provider-count rule, automatic union or installation-array inspection.

The ordinary selection is exactly:

```ts
{
  File: ["self-closing", "paired"],
  "File.Delete": ["self-closing"],
  Glob: ["self-closing"],
  Syntax: ["self-closing"],
  Elicit: ["paired"],
}
```

This is a name/form selection; definitions, contracts and effects are derived by core.
Dir and Fetch stay absent from the ordinary default. A custom defined selection is not
augmented with these names.

Install the middleware in the scope that will execute the document. Migrate all shipped
paths together:

| Host | Current assembly to change | Required boundary |
| --- | --- | --- |
| Ordinary CLI | `cli.ts::runDocument`, `evaluation-profile.ts` | Host setup precedes capture; plugin/custom selections remain effective. |
| REPL | `repl-profile.ts`, `repl-assembly.ts` and entry assembly consumers | Every entry gets fresh capture in its execution scope; do not install into a profile-construction scope that has already ended. |
| Isolated ordinary children | `testing-host.ts::runProfileChild` | Explicit child assembly after cwd/environment setup; parent middleware is not inherited. |
| Plan writer | `plan-writer-profile.ts` and affected harnesses | Install the ordinary selection in the bounded writer scope; keep target-run descriptive Syntax separate. |
| Workflow | `workflow/src/deno/workspace/evaluate.ts`, `cli/src/workflow.ts`, live attachment assembly | Preserve Workflow's explicit selection and optional runtime Fetch policy; ordinary fallback must not supplement it. |

Workflow's generic selection remains File self-closing/paired and File.Delete
self-closing. The CLI workflow adds Dir paired in its existing chosen position; a
generic host that did not choose Dir does not gain it. Fetch self-closing is added only
when that host chooses its existing non-empty request allowance. Host extensions select
their registered/provider-backed names and forms through the property, not separate
read/write entries. Workflow does not automatically gain ordinary Glob, Syntax or
Elicit.

Replace the exported Workflow profile builder and its options that return full contract
tables with ordinary host setup/property middleware at the existing assembly boundary.
Remove its database argument used only for the evaluator snapshot. A local setup helper
is ordinary mechanics, not a new aggregate dependency object or public capture protocol.
Keep optional Fetch destination policy in the owner that performs live work. Do not
install into a caller scope that ends before execution.

Completed Workflow root replay continues through the existing completed branch, without
attaching Workspace, Agent or operational providers. Do not force live workflow setup
just to obtain a selection for work that completed replay will not perform. Preserve
Node/Bun startup and their existing provider absence; do not create a filesystem, Git or
Workflow provider as part of this migration.

Trusted Plan information reads continue through the ordinary Files chain and current
Permissions, as the accepted U2 amendment requires. Mutation/native refusals stay. Do
not restore Plan scope hooks, ancestry maps or read grants.

### 6. Remove evaluator inventories; authorize actual live operations

Delete `FragmentEvaluationInput`, `ExecutionInstallation.evaluation`,
`statesEvaluation`, `TWO_PROFILES`, the capability constructors/transports and unused
legacy exports. Migrate core/CLI/Workflow/Git consumers and test helpers in this slice;
leave no old input adapter or second public table-taking evaluation channel. The
internal evaluator may retain the data structures needed to perform a captured
selection. In particular, the Workflow `generated-observations.ts` wrapper is only
consumed by tests at this base: replace its tests with real captured Evaluate
integration and remove the obsolete wrapper rather than preserving its policy input
under a new name.

Remove generated `fetchTimeout` capture. The ordinary Fetch live route resolves
contextual Config and honors the existing explicit timeout rules. Do not alter shared
normalization helpers with authored consumers or runtime adapters' transport ownership.

Remove generic Workspace snapshot collection, workspaceRoots/selectedRoot evaluator
inputs, basis serialization, root-membership comparison and evaluator-only
`workspaceRootSelection` if no consumers remain. Do not delete actual Workflow roots,
storage validation, filesystem transactions, restoration, forks or journal-root
associations.

Remove exact request inventories from generic evaluator inputs, preflight and retained
admission comparison. Host-specific destination/method/header bounds remain **live
terminal policies**, checking the actual request after middleware transformation and
immediately before transport. U2's full-header comparison and immutable bound capture
remain required where that host still uses an exact allowlist. A host may state such a
runtime allowlist; it is not a generic evaluator inventory or replay input. Do not
compare a caller-mutated bound object against itself, and do not let one selected
entry's policy authorize another's request.

Runtime Permissions still intersects with narrower enclosing restrictions. Synthetic
answers performing no I/O do not require transport authorization. Files checks stay
inside live provider/performer boundaries; Fetch checks stay immediately before
transport. A completed local durable effect restores its recorded result without
entering its live I/O callback, asking Permissions or inventorying/validating/restoring
the filesystem. An unacknowledged operation may retry and meet today's restrictions.
Fresh execution initialization and selection capture may still run; they must not be
confused with reperforming a recorded local operation.

A live request denial may happen after an earlier effect committed. Preserve that
earlier effect and its journal record. Whole-fragment language admission is not a
rollback promise for later runtime authorization.

### 7. Keep one current retained schema and migrate documentation

Advance the existing generated record marker from 3 to 4 for the changed closed shape.
Writers and readers change together. Remove Workspace/request inventory members; refuse
old, unknown and extra-member records rather than partially reading them or installing a
compatibility reader. Do not version identity URLs.

Keep stable selected name/form/owner-URL/effect reconciliation, exact
selected-class/order comparisons and source retention. Selected effects follow the
existing component-answer representation now that their definitions all come through
canonical resolution; Json keeps its existing composition representation. A change to an
admitted URL/form/effect still refuses continuation. Replacing an implementation while
keeping the same owner URL may resume under that owner's current implementation, as U4
permits. Runtime destination policy and Config timeout are live concerns, not retained
selection equality terms.

Preserve admission before nested generated effects, inline authored journal order,
replayed refusals, sanitized pre-admission diagnostics and the existing secret gate. No
`historyChecks`, `restoreContext`, continuation receipt or split of mixed journal
callbacks is introduced.

Update `specs/executable-mdx-spec.md` §§5.3.2–5.3.3 and affected FE/EP/GXC/GX evidence,
`specs/workflow-workspace-spec.md` §8.4 and §9, and architecture's generated-XMD, host
setup, Syntax and REPL descriptions. Remove old pinned-replaceable-name, two-profile,
frozen timeout, static request and Workspace basis descriptions. Keep actual
storage/restoration contracts and lazy inspection behavior. Update public entrypoints
and module documentation. Read `.agents/component-descriptions.md` before changing any
rendered component description. Use present tense and the current prose rules.

## Example

An authorized host can select only File reads by installing Component property
middleware in execution setup. Core resolves File once before public execution policy. A
later policy that supplies a broader property or imports a different body changes
neither the captured vocabulary nor the fixed File implementation.

A fragment containing `<File path="notes.md" as="note" /><Json value={{ note }} />` can
then read and render through the installed Files provider. A paired File in that same
read-only selection refuses preflight. A runtime Files restriction can still refuse the
admitted read. An ordinary CLI host supplies the default map above when no custom
selection exists.

## Common mistake

Checking an input object and then reading it again to retain it reopens U4's accessor
defect. Retain the validated owned reading itself, and derive documentation, dispatch
and journal identities from it.

Checking every possible request in preflight would recreate the removed inventory.
Validate the fragment's language up front; authorize each actual transformed request at
the live I/O terminal. Preserve earlier committed work if a later request is refused.

## Frozen acceptance and evidence

These twelve rows are the finite feedback threshold. Reuse and adapt existing rows whose
premises change; do not delete their observable protections. New portable selection
coverage belongs in `packages/core/tests/generated-selection.test.ts`. Existing test
files named by the commands stay runnable after fixture migration. Mechanism tests may
remain, but the stated integration assertions must use canonical execution and real
captured Evaluate. No new product permutations are implied.

| Row | Required scenario and discriminating observation | Evidence home |
| --- | --- | --- |
| U5-1 | Plain value property defaults undefined, including a same-name Component descriptor. Undefined permits a non-Evaluate document but refuses a paired Evaluate before production. Defined empty, malformed map/forms, duplicate or unknown forms, missing name, unsupported kind and unoffered spelling refuse before policy/root/producer/effect, with a valid selection control. A mixed valid/invalid selection installs no partial allowance. | New generated-selection; execution-init; evaluation-profile. |
| U5-2 | Init and captured callbacks establish selection/registrations before one property read and one import per selected name. File both forms shares a definition. Public policy runs afterward; replacing registry/import/selection there cannot replace or widen captured generated execution. A later ordinary authored registration still behaves contextually. | New generated-selection; execution-init; evaluation-profile. |
| U5-3 | Selected canonical defaults/fixed/protected names, a registered function and a published provider answer run their actual retained definition. An unpublished replacement, unoffered replacement and unsupported answer refuse. Accessor-backed selection/forms/metadata are read into one owned immutable copy; attempted later mutation cannot change body, schema or recorded URL. A loaded-copy provider still publishes through the handed request. | New generated-selection; generated-owner-metadata; answer-identity; syntax-loaded-copy; evaluate-loaded-copy. |
| U5-4 | Ordinary middleware delegates and defaults only on undefined; custom defined choice is preserved, empty remains a setup refusal, and two middleware compose without union/count rejection. Ordinary map is exact. A fresh REPL entry and isolated child each install and capture their chosen setup; target-run Plan descriptions remain independent. | CLI evaluate-component; testing-execution-host; repl-execution; plan-component; plan-command-document; syntax-cli. |
| U5-5 | Generic Workflow has File/Delete, CLI Workflow additionally chosen Dir, and Fetch only when chosen; no ordinary default leakage. Actual generated File/Dir/Delete reach the Workflow provider and retain ordinary effects/cwd. Optional exact request policy stays runtime-scoped to its owner. | CLI evaluate-workflow; Workflow generated-agent-component, workspace-files; CLI workflow-agent. |
| U5-6 | Owner effects alone derive read/write selection; wrong File form, missing class, unadmitted component in an untaken branch and invalid language/props refuse before any fragment effect. Json remains available without a new effect class. Paired production and generated Syntax show the captured allowance and keep enclosing named documentation. | Core evaluate-component, generated-xmd, generated-composition, syntax-api, syntax-component. |
| U5-7 | Generated Fetch uses effective contextual Config at live invocation, including a narrowed scope and existing explicit timeout precedence; it no longer uses assembly-time timeout. Dynamic URLs in existing data expressions reach runtime policy. An allowed transformed request is a positive control; forbidden destination/method/header transformations reach zero transport calls. Bound capture cannot be moved by an in-place edit. | Core fetch-component, shared-operation-permissions; runtime fetch/permissions; CLI workflow-fetch. |
| U5-8 | A fragment's valid earlier write commits; a later runtime Fetch denial leaves that write/result intact and makes no refused transport call. Completed File/Fetch effects restore recorded results with throwing live providers/Permissions and changed physical content; no evaluator Workspace scan occurs. An unrecorded operation meets the current restriction. | Core generated-xmd/shared-operation-permissions; Workflow generated-observations, workflow-run-journal; CLI workflow-fetch. |
| U5-9 | Marker-4 admissions retain current selection terms and no generic Workspace/request inventory. Current records restore; marker-3/unknown/extra-member records refuse. URL/form/effect changes refuse; same URL with an updated body follows U4's current implementation rule. An untaken evaluation makes no admission. Nested admission/effects/later parent effects keep inline order. | Core generated-xmd; Workflow generated-observations, generated-agent-component, workflow-run-journal. |
| U5-10 | Selection-resolution failure/cancellation closes provider requests and execution-owned routes, joins teardown and reaches no policy/root. Retained callbacks refuse after closure; simultaneous executions remain isolated. Existing protected form and no-substitution defenses stay effective. | Core evaluate-provider-lifetime, answer-identity, execution-init, evaluate-loaded-copy. |
| U5-11 | No full host table, evaluation installation field, static generic request inventory, frozen generated timeout or evaluator Workspace input remains in shipped source/exports. Actual Workflow storage, forks, completed-root bypass, journal associations and provider absence remain valid. | Focused source/export audit; Workflow workflow-run/storage/journal, workspace-files; dead-code; CLI evaluate-workflow/testing-execution-host. |
| U5-12 | Portable core evidence runs on Node/Bun; CLI/Plan/plugin subprocess journeys use the new host setup and the compiled binary. Current docs name the property and live-runtime boundary. No dependency/release change or consumer-owned forwarding is introduced. | Commands 7–12; module/spec review; compiled Plan/plugin/npm-bin. |

Three reversible controls establish the new integration assertions: move capture after
public policy (U5-2 must fail); change undefined-only fallback to also replace an empty
selection (U5-4 must fail); bypass the host's terminal transformed-request restriction
(U5-7 must fail). Restore each change immediately. For a genuinely new accessor
regression, make its validated-copy-discarded control fail as well; retained U4
discriminating coverage can supply that control. Do not run unrelated controls or
broaden the matrix merely for confidence.

### Frozen focused commands

Run these in the prepared implementation worktree. Affected test helpers can be
migrated, but these paths remain the evidence homes. Report the exact commands, first
failures and final results at the feedback SHA. There are twelve commands; Node/Bun use
the same six portable files. Do not run full runtime corpora for this feedback.

```sh
# 1 — selection and assembly
 deno task test packages/core/tests/generated-selection.test.ts packages/core/tests/execution-init.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts

# 2 — Evaluate, retained definitions and admissions
 deno task test packages/core/tests/evaluate-component.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts

# 3 — live policy, protected loaded copies and descriptions
 deno task test packages/core/tests/shared-operation-permissions.test.ts packages/core/tests/fetch-component.test.ts packages/core/tests/syntax-loaded-copy.test.ts packages/core/tests/evaluate-loaded-copy.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/syntax-component.test.ts packages/runtime/tests/fetch.test.ts packages/runtime/tests/permissions.test.ts

# 4 — ordinary hosts, bounded children and Plan
 deno task test packages/cli/tests/evaluate-component.test.ts packages/cli/tests/testing-execution-host.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/plan-component.test.ts packages/cli/tests/plan-command-document.test.ts packages/cli/tests/syntax-cli.test.ts

# 5 — Workflow effects and storage
 deno task test packages/cli/tests/evaluate-workflow.test.ts packages/workflow/tests/generated-observations.test.ts packages/workflow/tests/generated-agent-component.test.ts packages/workflow/tests/workflow-run.test.ts packages/workflow/tests/workflow-run-journal.test.ts packages/workflow/tests/workflow-run-storage.test.ts packages/workflow/tests/workspace-files.test.ts

# 6 — explicit subprocess and dynamically assembled Workflow boundaries
 deno task test packages/cli/tests/workflow-fetch.test.ts packages/cli/tests/workflow-agent.test.ts

# 7 — portable evidence under Node
 pnpm exec tsx --test packages/core/tests/generated-selection.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/shared-operation-permissions.test.ts packages/core/tests/fetch-component.test.ts packages/core/tests/execution-init.test.ts

# 8 — the same portable evidence under Bun
 bun test packages/core/tests/generated-selection.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/shared-operation-permissions.test.ts packages/core/tests/fetch-component.test.ts packages/core/tests/execution-init.test.ts

# 9 — removal leaves no dead exported plumbing
 deno task lint:dead-code

# 10 — executable documentation
 deno task validate:docs

# 11 — compiled host assembly
 deno task build

# 12 — generated/compiled and npm-bin consumers after the build
 deno task test scripts/tests/plan-component-compiled.test.ts scripts/tests/plugin-compiled.test.ts scripts/tests/cli-npm-bin.test.ts
```

The existing AGENTS specialized rules still apply if a dependency, generated artifact,
release configuration or shared-state boundary changes. Full lint/typecheck/JSR/runtime
suites and CI are delivery checks, not extra prerequisites for this feedback commit. If
a focused command proves the matrix cannot establish a settled criterion, return the
concrete gap to the Planner; do not silently expand acceptance or discard a required
assertion.

### Feedback, delivery and recovery

Once the frozen focused evidence passes, commit promptly and return the exact signed
feedback SHA/tree, base, branch/worktree, clean status, complete diff size including new
files, row map, every focused command/result, retained first failures and control
results. This is the stable revision the Planner and Architect inspect. Do not wait for
the exhaustive suite merely for confidence.

Architect implementation review and Product Owner review follow the exact feedback
revision; delivery verification, publication and explicit merge approval remain
separate. Do not inspect CI as Planner feedback evidence. A later main movement is
overlap to assess, not permission to rebase a frozen reviewed revision silently.
Preserve reviewed revisions before any authorized rebase, and return material contract
changes for review.

Expected work is substantial fixture migration as well as source removal. The stack's
1.5–3.5k line estimate is not an acceptance cap. If an actual structural conflict needs
a new abstraction, public authority surface or PR split, stop that part and return the
smallest conflict to the Architect. No unresolved architecture blocker is known at this
freeze.

Do not implement U5 in the old root checkout or expand it into #902. After U5 lands, the
consumer owner can rebase #902, remove consumer-owned forwarding and prove its existing
ten rows against the landed interface. Upstream completion does not itself pass or merge
that consumer.

## Read next

Read the [starter prompt](upstream-repository-prerequisite-u5-implementor-prompt.md) in
a new authorized Implementor session. The [Planner
status](upstream-repository-prerequisite-u5-planner-status.md) records the freeze and
source verification.

Continuity: exact planning base `3a1fade9246db937e11da6cdadc4751ec924be97`, tree
`b92762664a24d7b5636b08c98d96907a614d76f0`; twelve rows and twelve commands frozen here.
Artifacts live durably in `.reviewer/upstream-u5-handoff-3a1fade9/`. Settled decisions
are the Component property, pre-policy actual-definition capture, undefined-only host
default, ordinary live permission chain and removal of generic inventories/old inputs.
No open blocker is known. Next action: separate implementation authorization, then the
new Implementor rechecks main, creates a fresh worktree and runs setup once. No
production implementation, publication or cleanup occurred in preparing this handoff.
