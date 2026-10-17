# Planner handoff: reusable execution and operation interfaces

Use this prompt to start a new Planner session. Prepare the five accepted upstream prerequisites that let ordinary runs, REPL entries and generated documents share contextual operations. This Planner is different from the Planner responsible for PR #902 and the later repository stack.

## Applies to

Core execution, contextual Files/Fetch, scoped permissions, Syntax, generated component selection and their CLI/Workflow hosts. Cover Deno source and compiled REPL behavior, ordinary document execution and isolated ordinary children. Preserve Node/Bun startup and existing Workflow behavior except for the explicitly accepted amendments below.

## Instructions

You are the Planner under `.agents/planner.md`. Produce a decision-complete upstream stack plan and a bounded U1 Implementor handoff from the accepted architecture and inspected source. Do not implement, commit, publish, open or modify PRs/issues, merge, or inspect CI. The present authorization is planning and local planning-document edits only.

### Establish ownership before planning

You own U1–U5. The previous Planner owns #902, its ten evidence rows, and the later repository selection, Git, publication and Issue work. Preserve that Planner's artifacts and the consumer worktree. Do not rewrite their plan or handoffs, allocate their implementation work, or send messages to others without explicit authorization. Write a local integration note they can consume after the upstream interfaces land.

These existing artifacts belong to the previous stream:

- `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-pr-stack-plan.md`
- `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-pr1-file-dir-implementor-handoff.md`
- `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-pr1-contextual-installer-plan-amendment.md`

The accepted order is:

```text
New Planner
  U1 fixed File/File.Delete/Dir; Dir in core
    -> U2 Permissions and shared Files/Fetch
       -> U3 Execution.init and contextual Syntax
          -> U4 generated metadata, URL identities, provider answers
             -> U5 contextual generated selection; remove old inputs
                -> upstream integration note
                   -> previous Planner resumes #902 refactor
                      -> later repository stack
```

All five upstream increments land before #902 is delivered. The consumer must remove repository-function forwarding before delivery. Each upstream increment must be useful on its own, leave main usable and describe its actual shipped behavior accurately. Existing paths can remain until their replacement increment. Do not introduce a temporary public interface to bridge increments or split a schema writer from its reader.

### Read the governing records

Read `AGENTS.md`, `.agents/planner.md`, `.agents/agent-writing.md`, `architecture.md` in full, the mandatory Effection v4 instructions linked by AGENTS, and the affected specifications. Read `.agents/architecture-rules.md`, `.agents/product-interface.md` and the applicable verification rules referenced by the role instructions.

The current architecture authority is:

`/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-reusable-interface-prerequisite.md`

Read its Current contract, accepted member decisions, product-verification decisions and bounded integration assessment. Its Interview reference preserves earlier proposals; superseded proposals are not open requirements. Interface, product-verification and five-PR grouping decisions are accepted. Do not repeat those interviews. Return a concrete newly discovered structural conflict to the Architect rather than choosing a different contract in the implementation plan.

Also read:

- `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-pr-stack-architecture-review.md`, especially its current prerequisite amendment.
- `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-pr1-architecture-review-2b475121.md` for the preserved consumer boundary and source trace.
- The accepted live-REPL amendment in `/private/tmp/xmd-retained-repl-repositories/architecture.md`. Historical implementation mechanisms are evidence to assess, not an approved design to copy.
- Relevant sections of `specs/executable-mdx-spec.md`, `specs/workflow-spec.md` and `specs/workflow-workspace-spec.md`, located through the actual repository tree.

### Verify the base without disturbing preserved work

Locally verified at this handoff:

- Root workspace: `/Users/tarasmankovski/Repositories/taras/executable.md`, local `main` at `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`.
- Its committed tree is `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`, identical to the reviewed baseline `f79f6730784a7ecba7253dcd35e6e5567293876c`.
- Root already has modified `AGENTS.md`, `architecture.md`, `.agents/architecture-rules.md` and `.agents/product-interface.md`, plus untracked `.agents/agent-writing.md`, `.reviewer/` and `greeting.md`. Preserve them.
- Consumer worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/pr1-file-dir`, clean on `agent/repl-file-dir-pr1` at `2b475121ab76ec1147c7661c76200efd80488506`.
- Historical worktree: `/private/tmp/xmd-retained-repl-repositories`, historical head `559f446dbba97b33042e512fd3c018b9a0f64a47`. PR #899 was reverted by `3159095cdc48e96914f69740b3940972fb0ce6bd`.

These are source facts, not fresh remote-main, remote PR or CI status. Verify current main with a read-only remote lookup and record how it was established. If unavailable, identify that limitation explicitly and separate the planning baseline from an eventual implementation base. Inspect branch/worktree state without fetching or checking out over preserved work. Do not assume historical authorization or delivery-status fields still apply.

### Preserve the accepted contract

The following are additions or changed members alongside existing APIs, not complete replacement API definitions:

```ts
interface ExecutionApi {
  init(): Operation<void>;
}

interface ComponentApi {
  readonly generated: Readonly<Record<string, readonly InvocationForm[]>> | undefined;
}

interface PermissionsApi {
  fetch(input: string, init?: FetchInit): boolean;
  files(operation: "read" | "write"): boolean;
}

interface SyntaxApi {
  readonly symbols: SyntaxSymbols;
  readonly text: string;
  documentation(names: readonly string[]): Operation<string>;
}

interface ComponentDeclaration {
  readonly generated?: Readonly<Partial<Record<InvocationForm, GeneratedForm>>>;
}

interface GeneratedForm {
  readonly identity: string;
  readonly effect: "read" | "write";
}

interface ComponentAnswerRequest {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
  answer(definition: ImportedDefinition): ImportedDefinition;
}
```

Context-api already supports value properties. Consumers yield `Component.operations.generated` and `Syntax.operations.symbols` without calling them. Boolean permission methods are lifted operations, for example `yield* Permissions.operations.fetch(url, init)`. No upstream context-api change has been established as necessary.

Execution.init defaults to no-op. Host middleware sets up ordinary package functions and delegates with unchanged `next`. Core awaits initialization inside its existing execution-owned scope before reading authoritative contextual dependencies and before public execution policy. It then validates and retains generated selection and resolved implementations. Failure unwinds that scope before policy or document execution. Every executing REPL entry owns fresh recording state; nested scopes inherit it. Isolated ordinary children explicitly assemble their chosen host behavior because they do not inherit middleware. No setup arrays, execution IDs, entry keys, owner tokens or receipts are introduced.

Permissions apply to supported operations in a scope regardless of their authored, generated or other contextual caller. Defaults permit. Host limits and ancestor/child restrictions compose so descendants cannot widen them and siblings regain the enclosing allowance. Check immediately before actual I/O, after middleware transformations. Synthetic answers that perform no I/O need no transport check. Replacement I/O implementations carry the same responsibility. Keep provider containment and other host limits. Do not describe arbitrary native runtime access as sandboxed.

Files reads are readText/glob; mutations include replacement, deletion, directory creation and temporary acquisition. Pure preliminary path checking is not authorization. Preserve File's path check before its children, with write permission checked at the eventual mutation. Denial returns the normal Files Err with permission-denied data. Fetch denial retains ordinary operation-failure behavior, binds no response and sends no request. Owned resource cleanup always follows acquisition lifetime, including cancellation under a descendant restriction; it is not a fresh document delete or rollback.

File, File.Delete and Dir have fixed component bodies, across authored/generated use. Files middleware still answers, transforms, delegates and refuses normally. Dir belongs in core and works without Git. Reuse canonical selection/final-answer verification and ordinary bodies/form dispatch. Do not expand the fixed-name set or generate new Dir availability merely by moving its ownership.

Syntax members use ordinary contextual dispatch. Default text renders effective symbols; default named documentation uses the enclosing catalog and effective availability. Descriptions never determine generated admission. Preserve lazy inspection, origin-only lookup without loading unused TypeScript implementations, scoped narrowing and recorded final Syntax text during replay.

Component.generated defaults to undefined: generated evaluation is absent and Evaluate refuses before its producer. A defined empty or malformed selection fails setup. Ordinary host middleware can delegate and supply its default only when the result is undefined. Multiple middleware handlers are allowed; there is no automatic union and no old two-profile count refusal. Capture the final complete selection before public policy. Validate requested forms against metadata on actual resolved owning declarations and retain implementation plus metadata together. Later document replacement cannot widen it.

Generated identities are URLs under `https://executable.md/`, with no version or revision. Provider answers carry metadata on the definition through the existing private request lifetime; publication is synchronous, with no separate identity argument. Source position serves diagnostics. Preserve implementation binding, loaded-copy/repeated-provider behavior and unsupported generated definition-kind refusals. A copied URL alone grants nothing. Replace the affected generated schema as one current schema; no backward readers, aliases, migrations or version-selected schemas. This does not remove or version unrelated Workflow snapshot/database storage, and authorizes no stored-data deletion.

Completed local operations replay recorded results without executing local effects or checking, inventorying, predicting or restoring checkout state. New work uses the live environment and current permissions. Local work with no acknowledged result may run again. The REPL is a foreground experimentation environment; its user or agent handles environmental mismatches. Preserve positional/nested journal behavior and existing external Git-host/Issue reconciliation. Keep Workflow bundle/run contributions, durable preparation, structural declarations, harness lifetimes and completed-output behavior in their existing owning paths.

### Plan each accepted increment

For each PR, identify exact modules that stay, change, move or disappear; its public boundaries; normal/failure/cancellation behavior; specification edits; focused evidence; dependencies; and uncertain expected diff size. Inspect source rather than treating this list as an implementation recipe.

1. **U1 — Fixed filesystem components.** Move Dir from Git to core and remove duplicate registration/definition ownership. Fix File/File.Delete/Dir selection and final import answers using existing canonical machinery. Preserve ordinary form dispatch, generated host availability and Files customization. Exclude provider/journal redesign and generated identity replacement.
2. **U2 — Permissions and shared operation routes.** Add direct Permissions methods/defaults and terminal checks in host/Workflow providers. Route authored/generated Files and Fetch through the same contextual APIs. Remove duplicate evaluation transports/adapters. Preserve response normalization, timeout behavior, transactions, containment, cleanup and middleware results. Leave unrelated evaluation inputs until their complete replacement.
3. **U3 — Initialization and Syntax.** Add Execution.init at the accepted lifecycle boundary and contextual Syntax. Cover command, REPL and explicit isolated-child assembly, fresh execution state and joined teardown. Keep unrelated trusted Workflow/Plugin contributions on existing paths. Do not change the held consumer or add new forwarding.
4. **U4 — Metadata and URL identities.** Put GeneratedForm metadata on owning declarations/resolved definitions; change provider answer publication; update all affected current readers, writers, hosts and fixtures together. Preserve exact implementation binding. Existing host read/write selection can remain until U5, using owner metadata. Exclude new generated component kinds, duplicate registries and static request inventories.
5. **U5 — Contextual host selection and evaluation removal.** Add Component.generated composition/capture and remove full read/write contract tables and the old profile-count error. Replace frozen generated fetchTimeout with contextual Config. Remove generic evaluator Workspace snapshot observation/membership checks and static exact-request authorization. Preserve actual Workflow snapshot storage/restoration/forks, host-specific runtime URL/method/header policy, current generated vocabulary, Syntax narrowing, replay and external reconciliation. Remove only unused legacy builders/adapters; keep useful normalization/journal helpers.

Source-informed review-size ranges are U1 0.7–1.8k, U2 1.5–3.5k, U3 1–2.5k, U4 2–4.5k and U5 1.5–3.5k lines of additions plus deletions, including tests/docs and both sides of moves. They are uncertain exposure estimates, not budgets or approvals; U4/U5 have the most uncertainty. If source inspection shows an incoherent or oversized boundary, return a concrete split to the Architect. Do not force a patch under a numeric allowance.

Useful source starting points, to verify in the current tree:

- Core: execute.ts; component-api.ts; component-answers.ts; types.ts; components/{registration,registry,select,protected,component-resolution}; evaluation-profile.ts; fragment-capabilities.ts; generated-xmd.ts; File/FileDelete/Fetch/Syntax/Evaluate; Syntax renderers; fetch request/response/journal helpers; execution declarations and test harness.
- Runtime: contextual APIs, Files/host-files, Config and package API exports.
- Git: composition/components/Dir.ts, composition/installation.ts and definitions.ts, plugin and identity declarations.
- CLI: command/REPL/run/Plan evaluation assembly, testing-host isolated children, and Deno/Node/Bun/compiled entrypoints.
- Workflow: run.ts, bundle.ts and deno/workspace/{evaluate,files,effect,restore}.

Do not assume the reverted implementation should survive. Reuse ordinary component/provider bodies, canonical resolution, lifecycle/error machinery, Syntax renderers, journal operations and private provider provenance where they meet this contract. Discard whole-checkout recovery, File-specific site/factory/identity routing, private inspect/answer continuation and duplicate generated I/O delivery. Never mutate `next` or attach metadata to it. Do not add Execution.historyChecks, restoreContext, generic preparation arrays, extra callback phases, pre-dispatch permission wrappers or a second contract registry.

### Freeze proportional evidence

Use the accepted product journeys as the cross-stack outcomes. Assign each to the increment that supplies its behavior and distinguish upstream evidence from consumer integration evidence:

- Scoped read-only restriction: authored/generated reads succeed, writes refuse normally without changing targets, and a sibling write succeeds after leaving the child scope. Include direct contextual consumers, transformed actual requests and synthetic answers where they prove different boundaries.
- Fixed filesystem components in a core host without Git: attempted local replacements emit recognizable markers if used; expect normal Dir/File/Delete behavior and no replacement markers. Keep Files middleware transformation observable and verify working-directory restoration on failure. This does not require a new CLI flag.
- Fresh initialization, failure before policy/body, owned teardown and explicit isolated-child assembly. Syntax output must reflect contextual composition while completed replay avoids live lookup.
- Generated selection absence/invalid values, custom/default composition, form validation, exact implementation/metadata binding, request lifetime and current-schema consistency. Keep ordinary/Workflow vocabulary and affected nested journal behavior intact.
- Consumer integration: changed-file reopen returns recorded binding `first` while disk stays externally edited to `second`; a new entry reads `second`. Cover source and compiled Deno REPL.
- Consumer interruption: completed recorded operation replays without physical rewrite; write completed without a recorded result may retry against current policy. Use deterministic evidence on each side of the durable-result boundary, not timing or disk observation alone. No new public fault-injection/recovery API.
- Consumer cost: paired ordinary-run/fresh-entry fixtures for File read/write/delete and Dir creation, then larger unrelated checkout content; report calls, journal bytes and time. Separate completed reopening with no physical repetition/inventory. Do not invent a numeric budget or a broad benchmark project.

The previous Planner owns changes to the preserved ten consumer evidence rows. Your integration note explains which upstream contracts affect them; do not replace them yourself. Freeze a finite U1 evidence matrix before handing it to the Implementor. Plan U2–U5 evidence at stack level now, then make each later handoff decision-complete against its actual predecessor revision. Do not produce five speculative full implementation prompts at once.

Follow AGENTS test selection and feedback-versus-delivery rules. Choose focused meaningful regressions and explicit integration files where subprocesses, generated code or dynamic imports defeat import-graph selection. Planning needs source evidence, not installs or test runs merely to populate a plan. Eventual Implementor instructions must require a stable feedback commit once the selected evidence passes, with exact SHA and every focused command returned. That is a future implementation instruction, not present permission to commit. Full delivery verification and required CI remain separate.

### Produce separate artifacts

Write only new planning artifacts under `/private/tmp/xmd-pr181-bench-rXAXyb/`:

- `upstream-repository-prerequisite-stack-plan.md`: U1–U5 scope, ownership, dependencies, modules, specifications, evidence, estimates and future handoff sequence.
- `upstream-repository-prerequisite-u1-implementor-handoff.md`: bounded U1 prompt with frozen scope/evidence and an explicit authorization boundary.
- `upstream-repository-prerequisite-consumer-integration-note.md`: contract for the previous Planner to resume #902 after U1–U5 land.

The integration note must identify the consumer changes: rebase the preserved branch; install existing repository/recorder setup through Execution.init per executing entry; use one authored/generated Files middleware; remove repository-function parameters to runXmd and isolated children; retire repl-repositories.ts and its generated-access wrapper. Preserve accepted native common-directory lease ownership/teardown, ordinary Results, passive history, entry isolation and positional replay. Do not reopen unaffected selection, Git-host/Issue or lease decisions.

If an architecture blocker emerges, record source evidence, the missing decision and one recommendation for the Architect. Do not bury it in Implementor choices or reopen settled decisions without a concrete conflict. Existing acceptance of the interfaces and stack outline approves no exact implementation. Each eventual revision still requires Architect implementation review, Product Owner review, delivery verification and explicit merge approval.

## Common mistake

Do not overwrite `upstream-repository-pr-stack-plan.md` or resume #902 implementation from this prompt. Write the separate prerequisite plan above. The existing Planner resumes the preserved consumer only after the upstream stack lands and their consumer handoff is updated.

## Read next

Use the Current contract and bounded integration sections of `upstream-repository-reusable-interface-prerequisite.md` for the settled design. Use `.agents/planner.md` for decision completeness and evidence ownership.

End your planning handback with the exact verified base and any limitation on that verification, all produced artifact paths, settled decisions, unresolved blockers and the next authorized action. If no blocker exists, identify U1 as ready for the next review/implementation authorization; do not start implementation yourself.
