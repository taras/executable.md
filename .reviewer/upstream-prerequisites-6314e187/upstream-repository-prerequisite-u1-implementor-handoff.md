# Implementor handoff: fixed filesystem components in core

Make File, File.Delete and Dir retain their canonical meanings even when a repository or host offers a same-name component. Move Dir into core so a host with Files can use it without Git. Preserve operation middleware and existing filesystem behavior.

## Applies to

U1 only, the first PR in the [upstream prerequisite plan](upstream-repository-prerequisite-stack-plan.md). This is a prepared prompt for a future authorized Implementor. The present user request authorizes planning documents only. Do not start implementation, create a worktree/commit/PR or publish from this prompt until the user separately authorizes implementation. Merge requires its own explicit approval.

After authorization, implement in a new isolated worktree from freshly verified remote main. The planning lookup resolved remote main to `f79f6730784a7ecba7253dcd35e6e5567293876c` through read-only GitHub `github_fetch_commit(repo_full_name: "taras/executable.md", commit_sha: "main")` on 2026-10-12. Its committed tree is `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`, identical to the inspected root local main `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`. SSH lookup failed DNS resolution; the connector established the source revision. No CI or PR status was inspected. If main advances, compare its changes with this scope and return a material conflict before coding; do not treat the old lookup as a perpetual implementation base.

Do not use or reset the dirty root workspace or the clean consumer at `.claude/worktrees/pr1-file-dir`, branch `agent/repl-file-dir-pr1`, head `2b475121ab76ec1147c7661c76200efd80488506`. Preserve the previous Planner's three artifacts named in the initiating handoff. The previous Planner owns #902 and later repository work.

## Instructions

### Read the governing contracts

Read `AGENTS.md`, `architecture.md` fully, `.agents/implementor.md` if present, `.agents/architecture-rules.md`, `.agents/product-interface.md`, the mandatory [Effection v4 instructions](https://github.com/thefrontside/effection/blob/v4/AGENTS.md), and the affected specifications listed below. Before editing agent-facing instructions read `.agents/agent-writing.md`; this task needs no new agent guide. Before changing component descriptions read `.agents/component-descriptions.md`.

The [accepted prerequisite](upstream-repository-reusable-interface-prerequisite.md), its Current contract and U1 bounded-integration section govern. The [upstream plan](upstream-repository-prerequisite-stack-plan.md) defines stack ownership. Settled member and product decisions require no new interview. Historical implementation at `/private/tmp/xmd-retained-repl-repositories` is evidence only; do not copy its filesystem factories, sites, private continuations, recovery or forwarding.

Use Effection generators and `yield*`, `until` for promise adaptation and `@effectionx/fs` for supported filesystem operations. Keep source provider-neutral; runtime-specific behavior stays in existing adapters. Parse values to narrow types, use Effection Results, and establish cleanup before resources/listeners can exist. Do not attach metadata to or mutate `next`. Use ASCII diagrams if a document needs a diagram.

### Deliver the bounded outcome

The following core-host document works with a Files provider and no Git Plugin:

```md
<Dir path="notes">
  <File path="message.md">first</File>
  <File path="message.md" as="message" />
  {message}
  <File.Delete path="message.md" />
</Dir>
```

Repository-local `File.md`, `File/Delete.md` and `Dir.md` containing recognizable replacement markers do not run. Output contains the read text, the directory persists, the file is gone, and cwd restores. When Files middleware transforms the write payload, the later read returns the transformed payload. Fixed component bodies therefore continue to use contextual operations.

Scope is exactly File, File.Delete and Dir added to the existing fixed-name boundary. Syntax/Evaluate remain fixed as today. All other component defaults remain replaceable. This PR adds no generated Dir/Fetch availability to ordinary hosts, no Permissions, init, Syntax API, generated metadata or new identity/schema.

### Implement in this order

1. Move the provider-neutral Dir form/body from Git into core. Establish its one ordinary core definition alongside File/File.Delete.
2. Extend canonical selection, materialization and final-answer verification to those ordinary definitions. Update admission/inspection/set consumers with the same ownership change.
3. Remove Git's duplicate body/definition/registration and move owning documentation. Update existing generated definition consumers without changing the old profile's identities, selection or I/O delivery.
4. Add the finite evidence below, amend affected existing expectations/specifications and run the frozen focused commands.
5. Once focused evidence passes, create the feedback commit promptly and return the exact SHA and all focused commands/results. Do not publish or merge as part of feedback.

Each step stays within one U1 PR; these are implementation steps, not separately mergeable halves.

### Preserve one definition and ordinary form dispatch

Move `packages/git/src/composition/components/Dir.ts` to `packages/core/src/components/Dir.ts`. Replace imports of the core package root with owning core internals; no core-to-Git dependency. Keep its existing `FormDeclaration`, props, sanitized `DirInvocationError` behavior and operation ordering. Delete the old implementation path, with no alias/forwarding body.

Create the internal ordinary definition source `packages/core/src/components/fixed-filesystem.ts` from the existing File/FileDelete/Dir form declarations, schemas and documentation. Build each ordinary dispatcher once in canonical core. This module is an owning source for three concrete definitions, not an additional public registry. Normalization can use existing small helpers where appropriate; do not build a generic factory/identity/site system for filesystem components.

Remove File/File.Delete from the replaceable entries in `components/registry.ts`. Keep unrelated defaults unchanged. `CORE_COMPONENT_NAMES` continues to enumerate default-registry names; `PROTECTED_COMPONENT_NAMES` includes all five fixed names. Existing readers that need the full built-in set use the existing union or the shared canonical lookup. Avoid cycles or two independently constructed definitions when organizing imports.

Generalize `components/protected.ts` and the protected path in `execute.ts` to supply the ordinary fixed definitions as well as the existing execution-built Syntax/Evaluate definitions. Keep the special identity-built `ProtectedBody`/`ProtectedSite` route for its existing consumers. File/File.Delete/Dir run their ordinary dispatchers, not a new special route. Existing `CanonicalImports` issuance, retained descriptor verification and `ProtectedImports` final-answer checks protect the selected answer. The engine invokes its retained canonical answer after verification.

Both defenses are required: selection wins before repository/default/host tiers, and a final `Component.importComponent` middleware answer cannot substitute another function or mutate the selected definition. Middleware may observe, delegate unchanged or refuse by throwing. A definition from a separately loaded copy, a rebuilt descriptor, another name's answer or a changed descriptor is not the canonical answer. No function equality supplied by a caller replaces private issuance.

`components/{registration,declared-markdown,bundle}.ts` and `execution-declarations.ts` already reject protected names. Keep those gates driven by the shared fixed-name set. Default and reserved registrations, Markdown/structural declarations and bundles cannot claim a new fixed name. Preserve rejected-batch rollback. Same-name repository candidates are ignored without reading/importing their bodies, including unused TypeScript candidates.

Update `select.ts`, `inspect.ts`, `component-documentation.ts`, `types.ts` only as needed for their protected descriptor shape and shared ownership. Inspection reports core protected origin, correct schemas/forms and documentation once. CLI `workflow-bundle.ts` must reject protected claims at its existing early validation boundary after File/Delete leave the default set. Do not let its default-only check silently admit them until a later core failure.

### Remove Git ownership without changing host selection

In Git `composition/definitions.ts`, remove `dirDefinition` and the Dir body/form imports. Keep `COMPOSITION_ORIGIN` for the remaining components. Keep the existing `gitDirectoryEntry()` identity-only helper and its current representation/aliases until U4/U5 replace that boundary. It acquires no replacement body, registration or new public interface in U1.

In `composition/installation.ts`, remove Dir's registration and its local cached definition. Git owns twelve registrations; the combined author-visible vocabulary still includes core Dir. Remove the duplicate Dir long-form entry from Git `composition/components.md`, place it in core `components/components.md`, and update package/header prose that attributes Dir to Git. Do not remove Repository/Worktree examples that use core Dir.

`generated-xmd.ts` currently reads File/Delete definitions directly from `CORE_REGISTRY`; update its pinned builders to the sole fixed definition source. Update direct test harness lookups, including `file-component.test.ts` and `generated-xmd.test.ts`. Preserve existing generated identity representations/readers, ordinary and Workflow form selections, generated preflight and effect ordering in U1. Existing private generated capability bodies/transports survive until U2; do not expand U1 into their replacement. A generic Workflow profile without a directory entry remains without generated Dir.

Update Git `module-partition.test.ts` and `provider-neutrality.test.ts` inventories for the deleted module, and the existing `repository-components.test.ts` import of Dir's error type. Its directory regression cases move to core where they require no Git, or remain as integration cases importing the core source within the repository. No public Dir error export is required just to satisfy a test.

### Keep the operation and lifecycle contracts

- File keeps its authenticated self-closing read/paired write distinction. An empty paired body is still a write. Pure path checking happens before children; writing happens after them through the installed Files provider.
- File.Delete remains self-closing only; paired and unissued/mismatched invocation refusal precedes cwd/provider access. It removes one file/final link, never a directory, and absence succeeds. Existing sanitized printed errors and empty text capture remain.
- Dir remains paired only. It resolves a relative path from enclosing cwd and preserves established absolute-path meaning. Ensure completes before cwd binding or content. A refused ensure starts neither. Existing directories retain contents; missing directories are created recursively.
- Dir installs cwd in the invocation's existing scope. Return, body failure and cancellation restore enclosing cwd. Successful creation persists; there is no teardown delete/rollback and Repository selection does not change.
- Files middleware continues to answer, transform, delegate or refuse. Missing/broken provider behavior stays fatal; ordinary provider Results remain ordinary. U1 introduces no default Files provider or new error classification.
- Preserve existing replay semantics and journal operations. Fixed selections use the existing protected selection representation; do not invent a new journal protocol or compatibility layer. Do not silently reinterpret an old selection whose recorded origin no longer exists as a different component. Existing generated identities stay unchanged until U4.

No lease, common-directory lock, repository discovery, Git-host/Issue reconciliation, generic Workspace, recorder or consumer forwarding edit belongs here.

### Update the shipped documentation

Amend `architecture.md` ownership/selection/inspection descriptions to include the three fixed filesystem components, reusing its existing canonical-tier explanation. Describe U1 behavior in the present tense; later APIs are not implemented by this PR.

Update `specs/executable-mdx-spec.md` §§1.2, 5.3, 5.6, 6.13 and 6.13.1 plus CR/SY evidence. Add a stable core Dir subsection with the existing general contract and cross-reference Workflow's logical/transaction semantics. Narrow statements saying every core default is replaceable to the remaining defaults. Update `specs/workflow-workspace-spec.md` §§2.1, 6.3, 8.4 and affected vocabulary/origin statements: Dir is supplied by core, while its current generated entry still uses the existing identity at this increment. Preserve §10.1 directory transactions and Workflow replay rules.

Update core/Git package documentation and rendered descriptions together. `component-documentation.ts` derives core coverage from default plus protected names; the move must satisfy that index and the existing compiled/npm asset layout. No documentation asset generator or dependency change is expected. If an existing generated artifact is affected, use its repository producer and verify the generated result; never hand-edit it.

### Frozen evidence

This nine-row matrix is the acceptance threshold. Reuse existing tests for unchanged semantics. Add `packages/core/tests/fixed-filesystem-components.test.ts` for the new canonical/no-Git boundary and move only relevant Dir regressions into it. Update existing tests whose ownership assumptions change. A row may have several assertions proving distinct boundaries; do not multiply it into all combinations of names, runtimes and attack shapes.

| Row | Scenario and observable result | Evidence location; defect caught |
| --- | --- | --- |
| U1-1 | Core host + Files, no Git, local File/File.Delete/Dir marker candidates. Dir ensures, File writes/reads exact text and Delete removes it; no markers; directory persists. Repeat with transforming Files middleware and observe changed read text. | New core file. Proves complete provider-neutral feature and continued operation composition. |
| U1-2 | New fixed names reject default/reserved registrations. One mixed batch with an ordinary name leaves nothing installed. Representative Markdown, structural and bundle claim attempts refuse through their existing gates. A same-name local `.ts` with a throwing top level is never loaded; unrelated Json/local default still wins normally. | New file plus `component-registration.test.ts`, existing declaration/bundle suites as listed below. Proves every ownership gate and preserves open names. Use a representative fixed name per declaration kind, not a cross product. |
| U1-3 | Final import middleware can observe/delegate/refuse. Replacement of each fixed name is refused before its body/I/O. Representative File descriptor mutation, another-name answer and foreign loaded-copy definition fail canonical verification. | New core file using existing resolution/test helpers. Proves selection alone is insufficient and the retained answer remains authoritative. Reuse the existing loaded-copy technique; add no new production test API. |
| U1-4 | File read vs paired/empty-paired write remains scan-selected; paired Delete and self-closing Dir refuse before provider work even if contextual `hasContent` lies. An unissued/mismatched dispatcher invocation refuses. | Existing File/Delete and invocation-identity tests, new file for Dir. Proves ordinary authenticated dispatch survives table changes. |
| U1-5 | Dir nested cwd restores after normal return and body failure; deterministic cancellation after body entry restores cwd before the owner settles. A refused ensure runs no children/binding. Successful ensure remains after failure/cancellation; adopting populated directory preserves contents and Repository selection stays unchanged in existing integration. | New file and `git/tests/repository-components.test.ts`. Proves scope ownership, ordering and absence of rollback. Synchronize entry/halt with operations, not sleep. |
| U1-6 | Inspection/docs list each fixed name once with core protected origin/correct forms and no local implementation loading. CLI bundle validation rejects fixed claims early. Git's list has twelve registrations and no Dir body module; bundled hosts still describe Dir. | `syntax-catalog.test.ts`, `syntax-component.test.ts`, `cli/tests/syntax-cli.test.ts`, `cli/tests/workflow-declaration.test.ts`, Git inventory tests and documentation validation. Proves execution/inspection/package ownership agree. |
| U1-7 | Ordinary generated selection still omits Dir/Fetch; Workflow explicit selection still supports paired Dir and File read/write/Delete with existing identities/forms. Generic omitted directory stays omitted. Existing preflight and nested generated ordering pass. | Core `evaluation-profile.test.ts`, `generated-xmd.test.ts`, CLI `evaluate-component.test.ts`, `evaluate-workflow.test.ts`. Proves ownership move does not widen or break generated hosts. |
| U1-8 | Workflow Dir ensure publishes before children, refusal leaves unchanged root, completed ensure replays without repeating, and File/Delete retain their provider outcomes. | `workflow/tests/workspace-files.test.ts` existing WF directory/File/Delete cases. Proves dynamic host and transaction integration survive the move. No new Workflow semantics. |
| U1-9 | A source CLI run with local fixed-name markers performs the filesystem journey and restores later sibling cwd. Deno/Node/Bun all retain startup and Dir/File/Delete behavior; compiled Deno runs that journey away from the checkout and supplies core-owned Dir docs. | Add the source CLI case to `cli/tests/run-composition.test.ts` using test-support launcher; add the compiled case to `scripts/tests/plugin-compiled.test.ts` and run its existing relevant integration. Proves real entrypoints, compiled graph and embedded documentation. No no-Git CLI flag. |

New tests use the portable BDD shim and per-invocation temporary state. No shared dependency/cache mutation. Existing source-CLI assembly can include the bundled Git Plugin; U1-1 proves no-Git core composition separately. The runtime tests prove portably owned filesystem behavior, not Node/Bun operational repository support.

### Run the focused feedback commands

After separate implementation authorization, prepare the new worktree once with `deno task setup`. Builds install nothing. U1 adds no dependency or lockfile change. Run these from that worktree; retain the first failure output before a retry and fix focused failures before the feedback commit.

```bash
deno task test packages/core/tests/fixed-filesystem-components.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/file-component.test.ts packages/core/tests/file-delete-component.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/syntax-catalog.test.ts packages/core/tests/syntax-component.test.ts packages/core/tests/declared-markdown-component.test.ts packages/core/tests/workflow-component-bundle.test.ts
deno task test packages/core/tests/evaluation-profile.test.ts packages/core/tests/generated-xmd.test.ts packages/cli/tests/evaluate-component.test.ts packages/cli/tests/evaluate-workflow.test.ts packages/workflow/tests/workspace-files.test.ts
deno task test packages/git/tests/repository-components.test.ts packages/git/tests/module-partition.test.ts packages/git/tests/provider-neutrality.test.ts packages/cli/tests/run-composition.test.ts packages/cli/tests/syntax-cli.test.ts packages/cli/tests/workflow-declaration.test.ts
pnpm exec tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 packages/core/tests/fixed-filesystem-components.test.ts packages/cli/tests/run-composition.test.ts
bun test --timeout=300000 packages/core/tests/fixed-filesystem-components.test.ts packages/cli/tests/run-composition.test.ts
deno task validate:docs
deno task build
deno task test scripts/tests/plugin-compiled.test.ts
```

These explicit integration files are deliberate: dynamic imports, host assembly, moved file inventories and a compiled binary are not fully visible to import-graph selection. Node/Bun use the repository runner's actual underlying command shapes for only the two selected files; `pnpm test:node`/`bun run test:bun` without a shard would run the whole corpus and are not required here. The compiled suite requires the binary built from this revision; a stale existing `dist/xmd` is insufficient.

If the actual predecessor renamed a listed file, resolve its equivalent before work and record the adjustment with the Planner. If a selected file cannot prove its row, return that evidence gap; do not invent a wider acceptance battery. This matrix does not require a new full runtime suite, broad benchmark or speculative permutation. Tests/lint/typecheck beyond this threshold become feedback blockers only for a demonstrated unmet criterion or an applicable repository rule.

Commit promptly when these commands and the nine rows pass. Return exact SHA, actual base, `git diff --stat`, a row-to-test map, every focused command and exit/result, first failure receipts/fixes if any, and any material limitation. Architect and Product Owner review that stable revision. Do not wait for CI or run exhaustive suites merely for confidence before offering feedback.

Delivery verification remains separate: required CI checks and branch protection own the full battery, and explicit merge approval is required. Apply AGENTS generated-artifact/dependency-state/special verification rules if the actual patch touches them. Do not hand-edit test weights; the existing measurement workflow supplies provenance at delivery. No CI inspection is authorized by this handoff. An unchanged revision that passes after failing requires the AGENTS flake record; if creating that issue is not separately authorized, return its concrete evidence/request instead of silently dropping it.

### Return a structural conflict instead of changing the design

No blocker is currently identified. If canonical protection genuinely requires filesystem-specific identity routing, or preserving a shipped host requires a temporary public bridge/schema split, stop dependent work and return the concrete source conflict and one recommendation to the Architect. Ordinary internal representation, helper extraction and test organization are Implementor mechanics within the stated boundaries. Estimated review size is 0.7–1.8k additions plus deletions including tests/docs and both move sides, with uncertainty; it is neither a budget nor approval for an incoherent patch.

## Common mistake

Do not make File fixed only by changing repository precedence. The final import answer is verified too. Do not copy the generated transport redesign into U1 or solve protection by preventing Files middleware. Do not resume #902 or edit its ten evidence rows.

## Read next

Use the [stack plan](upstream-repository-prerequisite-stack-plan.md) for U2–U5 boundaries and [consumer integration note](upstream-repository-prerequisite-consumer-integration-note.md) for what this PR enables later. U1 is ready for review and separate implementation authorization. Exact planning base: remote `f79f6730784a7ecba7253dcd35e6e5567293876c`, local `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`, identical tree `4790d98d737af9b4b64c1f11d38cfaf991b3cd46`; point-in-time source verification only. Artifacts live at `/private/tmp/xmd-pr181-bench-rXAXyb/upstream-repository-prerequisite-{stack-plan,u1-implementor-handoff,consumer-integration-note}.md`. Fixed ownership, ordinary dispatch, operation customization and frozen evidence are settled. No unresolved blocker remains. Next Implementor action, once authorized: reverify main, create an isolated worktree, prepare once and implement U1 only.
