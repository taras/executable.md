# U4 Implementor handoff — generated owner metadata and URL identities

Read this after U3 and before implementing the next prerequisite for #902. U4 puts each generated form's identity and read/write effect on the declaration that owns its implementation. A provider publishes that definition through its existing request. Core keeps the exact implementation and its validated metadata together.

**Planning complete; evidence frozen.** This handoff authorizes no implementation, publication or merge. Route it to a separate Implementor after U4 implementation authorization. The Planner remains the Planner.

## Applies to

Core component declarations and resolved function definitions, provider answer publication, generated admission and continuation records, and the shipped CLI/Workflow/Git consumers of those boundaries. U4 follows landed U3. U5 subsequently replaces host selection and removes the remaining evaluation inputs; #902's consumer work follows U5.

Authority: [Current contract](upstream-repository-reusable-interface-prerequisite.md#current-contract), its accepted generated metadata, URL identity, provider answer and compatibility decisions, and [stack U4](upstream-repository-prerequisite-stack-plan.md#u4--generated-owner-metadata-and-url-identities). Earlier interview proposals are historical where the Current contract supersedes them. U3's accepted A2/A3 amendments remain effective.

## Verified starting point

| Item | Value |
| --- | --- |
| Main, verified through the GitHub API during planning | `6314e187dc89c3e0f2b393b60d6f5963f847a881` |
| Tree | `3c4f45ca509e0de6ee820341c602319c7482386d` |
| Landed predecessor | U3, [PR #912](https://github.com/taras/executable.md/pull/912) |
| Published U3 head, same tree as the merge | `bc2c59c8b6f7a5854dda7b6a8bc70970003987ba` |
| Exact inspected source | `/private/tmp/xmd-pr181-bench-rXAXyb/u4-planner-source` |

The source directory is a Git archive, without dependencies or a Git worktree. Do not run setup or implementation there. Recheck main when starting; account for later landed overlap before selecting the implementation base. Create a fresh isolated U4 branch/worktree from the verified landed predecessor and run `deno task setup` once. Record its actual base and branch. Do not reuse U3's branch, reset root main, or install into the preserved #902 worktree.

Known open overlap: #890 remains open at `79d404d04d02c3840892473b6f1b2cf540f3edd1`, based on older main. Its host/generated/specification overlap is not a dependency. Recheck if its state changes; do not merge an unlanded PR to manufacture a base. #902 remains preserved at `2b475121ab76ec1147c7661c76200efd80488506`, branch `agent/repl-file-dir-pr1`.

Preserve all root workspace edits, other branches and worktrees. Landed #908's architecture/JSDoc prose rules apply; keep literal code identifiers exact. The previous U3 review was against `ac466780`; the published head was rebased and received documentation corrections. The [U3 landed receipt](upstream-repository-prerequisite-u3-landed.md) distinguishes those revisions.

## Smallest useful example

One File definition describes two forms, without restating its name, schema or function:

```ts
generated: {
  "self-closing": {
    identity: "https://executable.md/components/file/read",
    effect: "read",
  },
  paired: {
    identity: "https://executable.md/components/file/write",
    effect: "write",
  },
}
```

A provider supplies a definition once:

```ts
return request.answer(definition);
```

This call publishes metadata synchronously. It performs no component body or I/O. The request already fixes the name and the resolution it answers. Neither a URL nor metadata alone admits a component. The host still chooses the offered names/forms, and core still validates the exact final implementation before retaining it.

## Instructions

### 1. Add metadata to the owning declaration and preserve it through construction

Use the accepted shape, with existing declaration members unchanged:

```ts
interface GeneratedForm {
  readonly identity: string;
  readonly effect: "read" | "write";
}

interface ComponentDeclaration {
  readonly generated?: Readonly<Partial<Record<InvocationForm, GeneratedForm>>>;
}
```

Add the member to the existing declaration/registration and resolved function-definition paths, rather than creating another component registry. `ComponentDeclaration` and `ComponentRegistration` are in `core/src/components/registration.ts`; `FunctionComponentDefinition` is in `core/src/types.ts`. Carry the same information through core registry options, fixed definitions, protected declarations and the identity-built registration paths in `invocation-identity.ts`. Export the necessary type through the existing core type surface; add no runtime metadata API or public catalog.

Audit the field-by-field copies in `execute.ts` (especially `retainedIdentityComponent`), `invocation-identity.ts` (`IdentityComponent`, `ProtectedDeclaration`, `IdentityRegistration` and `installIdentities`) and the declaration admission paths. A declaration that crossed validation must not lose `generated` when its function definition is built. The shared `admitDeclaration` boundary validates registrations and factory declarations; generated capture also validates resolved provider definitions, which need not have passed registration.

Validate external data rather than trusting TypeScript. A generated map contains only authored form keys; each value has a valid identity and exactly the accepted effect. Every offered form must be among the declaration's accepted forms. An omitted `forms` declaration retains its existing meaning of both forms. Omitted metadata, an empty metadata map, or an omitted form offers no generated use for that form; these do not disable ordinary authored use. An attempted generated selection without the required metadata refuses.

The identity is an absolute URL in the accepted `https://executable.md/` namespace, stored and compared as the supplied string. Validate the HTTPS origin, not a substring or look-alike hostname. Do not fetch it, infer identity from function text, normalize different strings into aliases, require a live endpoint, or restore revision/version segments. Do not add a general public URL parser or a new path language. The owner paths below are the concrete naming choices for shipped forms; custom identities use the same accepted namespace.

Use one small package-internal validation/retention helper where necessary to keep callers consistent. It must not import the registry/protected component graph merely to validate plain metadata: U3 already exposed an initialization cycle through that graph. Existing callers retain their own error families and diagnostic context.

### 2. Declare the shipped forms at their owners

| Owner/form | Identity | Effect |
| --- | --- | --- |
| File, self-closing | `https://executable.md/components/file/read` | read |
| File, paired | `https://executable.md/components/file/write` | write |
| File.Delete, self-closing | `https://executable.md/components/file/delete` | write |
| Dir, paired | `https://executable.md/components/dir/ensure` | write |
| Glob, self-closing | `https://executable.md/components/glob/read` | read |
| Fetch, self-closing | `https://executable.md/components/fetch/read` | read |
| Syntax, self-closing | `https://executable.md/components/syntax/read` | read |
| Elicit, paired | `https://executable.md/components/elicit/ask` | write |

File/File.Delete/Dir metadata belongs in `components/fixed-filesystem.ts`. Glob/Fetch/Elicit metadata belongs with their canonical registry definitions. Syntax metadata belongs on its protected declaration and travels to the execution-built definition. Evaluate receives no generated metadata: this does not admit evaluation inside evaluation.

Each shared fixed filesystem definition remains deeply immutable, including its new metadata map and nested form records. Extend existing freezing rather than accepting a cross-execution mutation baseline. Execution-built definitions retain their current detect-and-refuse behavior; do not freeze them indiscriminately or retire that observable defense. `retain`/`stillDescribes` in `components/component-resolution.ts` must include metadata with all other descriptive data and preserve the exact callable reference.

Json remains always-on trusted composition. Its existing internal retained identity becomes `https://executable.md/components/json`; it does not receive a new public pure-effect class or read/write GeneratedForm merely to fit the new map. Other pure language constructs retain their current treatment. No declaration gains generated authority simply by carrying metadata, and ordinary/Workflow host vocabularies do not expand.

### 3. Replace provider publication, using the existing private resolution machinery

In `components/component-resolution.ts` and `component-answers.ts`, replace the old publication member with:

```ts
interface ComponentAnswerRequest {
  readonly name: string;
  readonly position?: Readonly<SourcePosition>;
  answer(definition: ImportedDefinition): ImportedDefinition;
}
```

There is no separate identity argument. The URL and effect come from the definition's per-form metadata. Provider installation origin remains provenance and diagnostic information; it is not the replaced origin/key/revision identity. Diagnostic position remains copied data, not authentication.

Keep the current provider installation, exact resolution-window object, per-handler request and synchronous close operation. The open handler may publish the definition for the name it was asked. Return, throw and cancellation close its request in the existing `finally`. A request from a previous resolution cannot answer a later one, even for the same name. Preserve activation/revocation, one provider's inability to take another provider's answer, and repeated use of one unchanged provider definition across distinct windows.

Core retains a defensive copy when the definition is published and returns that same retained result with its provenance after verifying the exact final answer. It must not verify one object and then recopy a value the public chain can change between reads. Preserve the first-publication baseline for reusable objects, descriptor/prototype/function comparisons, alternating-proxy defense and spent-window rules. Editing the function, schema or nested generated metadata invalidates publication; a later window cannot turn that edit into a new baseline.

An ordinary unidentified import answer remains valid on ordinary authored paths. A metadata-bearing object returned without the required canonical/provider provenance does not become a generated answer. Publishing object A and returning a spread copy, object B, or a changed A must not admit B. Copied core URLs do not turn a foreign implementation into canonical File/Syntax/Evaluate. Separately loaded providers may use the request they were handed; no module-global registry, shared symbol, context token or replacement identity protocol is added.

Update `core/tests/support/answer-provider.ts`, direct request users in core lifetime/identity/loaded-copy tests and every production caller. Remove the old method and its separate identity-input types; leave unrelated invocation, document and durable-work authentication methods alone. The reference inventory is a search aid, not authority to rename every similarly spelled method.

### 4. Derive current capture from the definitions while retaining U4's host selection boundary

Change `evaluation-profile.ts`, `execute.ts::resolveComponentAnswers`, `components/Evaluate.ts`, `generated-xmd.ts` and `fragment-capabilities.ts` together. The current `answeredNames` rule assumes one origin/key/revision triple per name. Replace that assumption: a name resolves once to one definition, while each selected form reads its own URL and effect from that definition. File's two forms and a provider's two different form identities share one implementation and one resolution.

Retain exact implementation, schema, forms, generated metadata and original form dispatcher together. Lifetime wrappers must preserve form dispatch and the execution's private protected route/provenance. Core-owned definitions and ordinary registered definitions use their existing canonical construction/provenance; supported provider answers use the publication above. A same-name replacement is not made canonical by copying its URL. Do not widen supported definition kinds: non-function definitions, structural constructs and test-harness objects that the generated path currently refuses remain refused.

U4 keeps `ExecutionInstallation.evaluation`, its read/write host selection, the one-profile rule, `statesEvaluation`, Workspace input, fetchTimeout and static request ceilings. These are removed by U5. The surviving tables/helpers select the existing names/forms/operations; they derive identity, effects and component contracts from owning definitions. They do not restate GeneratedForm maps or carry caller-supplied implementation identity alongside the definition. Refuse a selected form missing metadata or placed in the wrong effect table, and preserve ambiguity checks for overlapping forms or different implementations under one name.

Temporary core entry and pinned-definition constructors may remain for their current consumers. Remove their independent identity/legacy arguments and derive the relevant form metadata from the definition they actually retain. Update all callers in the same change. Preserve existing name aliases while those constructors support them; the alias does not change the owning implementation's metadata or make its descriptive origin canonical. Generic metadata carries no HTTP request list. Existing request ceiling data stays at the transitional host/policy boundary, with U2's complete URL/method/header checks intact until U5.

This step must not move generated selection capture before public policy or invent another contextual selection API: U5 owns that timing/property migration. Preserve U3 initialization and Syntax composition, existing late provider resolution, history admissions, durable preparation and authoring resolution precedence.

### 5. Replace the affected generated record representation in one current path

`generated-xmd.ts` currently writes tagged records with structured identities, reads both those and untagged older records, and reconciles legacy strings through aliases. Replace all affected current writers, readers, comparison keys, policy/admission/named records and diagnostic spellings together. `components/Evaluate.ts` must no longer reconstruct the old identity from origin/key/revision.

The identity value is now the URL string. Preserve existing implementation-source and effect distinctions beside it wherever current admission comparison needs them; do not encode them as another origin/key/revision object. Retained policy must distinguish a changed URL, admitted form or effect and retain the selected-table ordering. No function is serialized. Within a live resolution the callable must remain the exact retained callable; between executions an updated implementation under the same URL is not rejected merely for lacking the old revision.

Keep one closed current record schema. Remove old untagged readers, structured-identity readers, legacy unions, alias arrays, revision constants and revision-dependent comparisons from this affected boundary. An existing envelope tag may remain as a fixed current marker; do not add schema negotiation, a new version branch, migration, or compatibility adapters. Reject old records safely, before their generated work runs, with the existing unreadable-history failure path. Do not relabel an old string as a URL or read an old object partially. No journal or stored database is rewritten, deleted or converted.

Preserve passive completed-result replay, admission-before-effects order, same-root inline nested effects, cancellation/joined teardown and per-occurrence durable identities. Retain existing request-ceiling and Workspace membership behavior in U4. Unrelated Git-host/Issue identity records, Workflow database/snapshot versions, restoration and external reconciliation do not change.

### 6. Update all shipped consumers and current documentation

`git/src/composition/definitions.ts` currently supplies Dir's host-owned revision and a released alias. Remove that obsolete ownership: the generated Dir URL/effect comes from core's owning definition. Migrate `gitDirectoryEntry` and its CLI/Workflow/test consumers together; the thin selector may remain until U5 if used, but it no longer owns an identity or compatibility constant. Do not remove `COMPOSITION_ORIGIN` when other Git declarations still use it.

Update `workflow/src/generated-observations.ts`, `workflow/src/deno/workspace/evaluate.ts`, CLI `evaluation-profile.ts` and `workflow.ts`, public core `/host` exports, and all affected fixtures/readers. Keep ordinary hosts without Dir/Fetch and Workflow's existing Dir/optional-Fetch choice. Workflow directory creation, transactional Files behavior and live Permissions remain unchanged.

Rewrite the affected present-tense contracts in executable §§5.3, 5.6, 6.13/6.13.1/6.13.2 and the CIV/PA/EP/FE/GXC/GX evidence tiers; workspace §§6.3, 8.4 and 9 and WGAC evidence; architecture's canonical import/provider/generated identity boundaries. Preserve SyntaxSymbols' descriptive shape and lazy origin-only inspection. Do not claim U5's property or removed inputs already ship. Update comments/specification rows whose revision/one-identity premise becomes false without weakening their surviving provenance, form or replay assertions.

## Source inventory and expected change shape

The [reference inventory](u4-source-reference-inventory.txt) records exact baseline locations of old generated identity types/constants, constructors and provider publication calls. Inspect it with these primary modules:

- Core owners/types: `types.ts`, `components/{registration,registry,protected,fixed-filesystem,Syntax}.ts`, `invocation-identity.ts` and `execution-declarations.ts` where declarations are validated/copied.
- Core publication/capture: `component-answers.ts`, `components/component-resolution.ts`, `execute.ts`, `evaluation-profile.ts`, `fragment-capabilities.ts`, `components/Evaluate.ts`, `generated-xmd.ts`, and `host.ts`/existing type exports.
- Hosts: CLI `evaluation-profile.ts`/`workflow.ts`; Workflow `generated-observations.ts`/`deno/workspace/evaluate.ts`; Git `composition/definitions.ts`/`mod.ts` and direct consumers.
- Tests/fixtures: selected files below plus `core/tests/support/answer-provider.ts` and any directly imported fixtures touched by the migration.

The expected diff consists of small metadata additions at owners, replacement/removal of provider and schema code, and fixture/spec migrations. The stack's 2–4.5k-line estimate includes additions and deletions and is uncertain, not an allowance or acceptance target. A larger fixture migration alone is not a new architecture; a second registry, public protocol or independently mergeable outcome is. Return a concrete scope conflict before expanding those boundaries.

## Frozen acceptance and evidence matrix

The following twelve rows and focused commands are the finite feedback threshold. Reuse existing cases where they discriminate the requirement. New imagined permutations do not expand acceptance; return a demonstrated gap or a distinct structural conflict to the Planner/Architect.

| Row | Required observations | Evidence placement |
| --- | --- | --- |
| U4-1 | Metadata validation accepts the current map and rejects non-URL/out-of-namespace identity, unknown effect/key, malformed value and a form the declaration does not accept. Omission/empty map preserves ordinary use but supplies no selected generated form. A refused registration batch installs nothing. | New `core/tests/generated-owner-metadata.test.ts`; `component-registration.test.ts` |
| U4-2 | Shipped owner definitions carry the exact table above; File's two identities/effects differ on one definition. Registration/factory/protected construction preserves metadata. Json stays trusted composition, Evaluate gains no generated form, and metadata alone admits nothing. | New metadata file; `evaluation-profile.test.ts`; fixed-filesystem tests |
| U4-3 | Retention includes nested generated data and exact fn. A mutation after publication/issuance is refused; repeated publication cannot rebaseline a changed object. Shared fixed definitions reject nested metadata mutation and a fresh execution sees the original contract. | `answer-identity.test.ts`; `fixed-filesystem-components.test.ts`; new metadata file |
| U4-4 | Typed request exposes only answer(definition) plus unchanged name/position. It retains the publication-time copy. Different/copied/substituted final answers, unsupported kinds and unproven copied URLs refuse generated capture; ordinary unidentified authored answers still work. | `answer-identity.test.ts`; `evaluate-component.test.ts`; existing provider fixture |
| U4-5 | Return, throw and deterministic cancellation close the per-handler request. Stale requests cannot publish into the same name's next window or a different name. Cancellation joins acquired cleanup; execution teardown revokes retained bodies. | `evaluate-provider-lifetime.test.ts`; CIV/PA lifetime cases |
| U4-6 | One unchanged definition can answer successive windows; repeated installation and overlapping executions retain their supported isolation. One provider cannot take another's publication; alternating reads cannot substitute between check and retention. | `answer-identity.test.ts`; provider integration cases |
| U4-7 | An independently loaded provider uses the handed request successfully with current metadata. A foreign fixed/protected implementation still cannot replace canonical core by copying metadata. | Extend existing Deno-only `syntax-loaded-copy.test.ts`; `evaluate-loaded-copy.test.ts` |
| U4-8 | One dual-form provider name resolves once, retaining one callable and two form URLs/effects. Missing selected metadata, a wrong effect table, overlapping forms or two definitions under one name refuse before generated effects. Actual dispatcher and supported form behavior survive sealing. | `evaluation-profile.test.ts`; `evaluate-component.test.ts`; new metadata file |
| U4-9 | Current URL records round-trip and restore. Changed URL/form/effect refuses continuation before generated work. Untagged old records, old tagged identity objects, legacy strings, malformed URLs and extra/unknown fields refuse as unreadable. Same URL with an updated implementation has no revision-only refusal; completed results remain passive. | `generated-xmd.test.ts`; `generated-composition.test.ts`; provider continuation cases |
| U4-10 | Admission precedes nested effects and later parent work in one durable sequence; partial continuation, cancellation and joined teardown keep that order. No changed operation identity crosses sibling Evaluate occurrences. | `generated-xmd.test.ts`; `evaluate-component.test.ts`; Workflow generated suites |
| U4-11 | CLI ordinary selection stays unchanged; Workflow keeps its Dir/optional-Fetch selection with core's Dir metadata. Files/Fetch Permissions, request ceilings, directory restoration and Workflow effect/replay behavior survive the schema change. | `cli/tests/evaluate-workflow.test.ts`; Workflow generated suites; `shared-operation-permissions.test.ts`; Git repository-components |
| U4-12 | Source and compiled Plan/plugin paths consume current metadata/records; U3 init/contextual Syntax and unrelated Workflow admissions/preparation remain intact. Removed types/arguments/aliases have no live consumers. | Build/docs; compiled suites; core init/Syntax and Workflow run/bundle suites; dead-code inventory |

Where a case's old identity premise becomes false, replace it with the corresponding current-contract assertion. In particular EP18/19's one-triple-per-name premise becomes one-definition/per-form metadata, and legacy-success rows become old-record-refusal rows. Preserve their independent lookup-count, form-dispatch, implementation-binding, no-effect and replay observations. Do not simply delete the evidence when changing fixtures.

Use one representative metadata mutation, one copied-final-answer control, the existing lifetime handshakes and one independently loaded provider. Demonstrate the new critical assertions discriminate: removing metadata comparison, request close, or old-record rejection must make the corresponding focused assertion fail. Run these controls in reversible local edits, restore them, and retain first failure output. Existing tests that already discriminate an unchanged invariant need not receive another control run.

## Frozen focused feedback commands

After separate implementation authorization and one setup, run known regressions first when fixing failures, then this bounded set from the isolated U4 worktree:

```sh
deno task test packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/fixed-filesystem-components.test.ts packages/core/tests/evaluation-profile.test.ts
deno task test packages/core/tests/evaluate-component.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/shared-operation-permissions.test.ts
deno task test packages/core/tests/syntax-loaded-copy.test.ts packages/core/tests/evaluate-loaded-copy.test.ts packages/core/tests/execution-init.test.ts packages/core/tests/syntax-api.test.ts packages/core/tests/syntax-component.test.ts
deno task test packages/workflow/tests/generated-observations.test.ts packages/workflow/tests/generated-agent-component.test.ts packages/workflow/tests/workflow-run.test.ts packages/workflow/tests/workflow-run-journal.test.ts packages/core/tests/workflow-component-bundle.test.ts
deno task test packages/cli/tests/evaluate-workflow.test.ts packages/cli/tests/plan-component.test.ts packages/cli/tests/plan-command-document.test.ts packages/cli/tests/syntax-cli.test.ts packages/git/tests/repository-components.test.ts
pnpm exec tsx --tsconfig tsconfig.node.json --test --test-concurrency=1 packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts
bun test --timeout=300000 packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/component-registration.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts packages/core/tests/generated-xmd.test.ts
deno task lint:dead-code
deno task build
deno task test scripts/tests/plan-component-compiled.test.ts scripts/tests/plugin-compiled.test.ts
```

Only `generated-owner-metadata.test.ts` is new. Every other selected path exists in the exact predecessor archive. Respect the runtime exclusion manifest: Workflow database and loaded-copy integration remains in the selected Deno groups. Use the prepared Deno cache explicitly when CLI subprocess fixtures isolate HOME. Build precedes compiled evidence and installs nothing. No dependency/layout/release change requires extra composability work for this slice.

Freeze these as feedback evidence, separate from delivery. Commit promptly once the focused evidence passes; return exact signed SHA/tree/base, actual diff totals including staged new files, clean status, every command/result, row map and retained control/first-failure output. Full lint, full typechecks, exhaustive runtime suites and CI are not feedback prerequisites unless a specialized repository rule applies. Required delivery gates remain authoritative before merge; the reviewing Planner does not inspect CI.

## Common mistakes

Do not replace the old separate identity argument with a separate URL argument. Do not compare only the function while dropping metadata, or only the URL while dropping implementation provenance. Do not retain a published definition by reading the chain's object a second time after verification.

Do not keep one identity per name when forms differ, put read/write classification on a host table as a second source, or accidentally expand the ordinary generated vocabulary when core owns Dir. Do not change Elicit's currently pinned generated behavior by resolving a same-name ordinary replacement instead.

Do not interpret old admission records through a URL alias, introduce revision paths, or rewrite stored journals. Do not remove Workspace/request/timeout policy in U4, add Component.generated early, restore Plan read grants or scope observers, or forward repository functions through execution inputs.

## Continuity and next action

Exact planning base: `6314e187dc89c3e0f2b393b60d6f5963f847a881`, tree `3c4f45ca509e0de6ee820341c602319c7482386d`. Produced artifacts: this handoff, [U4 planning status](upstream-repository-prerequisite-u4-planner-status.md), [U3 landed receipt](upstream-repository-prerequisite-u3-landed.md), [reference inventory](u4-source-reference-inventory.txt), exact source archive and [Implementor starter prompt](upstream-repository-prerequisite-u4-implementor-prompt.md).

Settled: per-form optional metadata, URL namespace and shipped owner paths, existing provider request with synchronous answer(definition), retained exact implementation/metadata, no older generated-schema compatibility, unchanged supported kinds and U4/U5 split. No unresolved architecture blocker was found. The implementation must return a concrete conflict rather than invent a new protocol if the existing resolution machinery cannot carry these facts.

Next role: a separate Implementor, after explicit U4 implementation authorization. Prepare an isolated worktree, implement this bounded slice and return a signed feedback revision with the frozen evidence. Architect/Planner implementation review, Product Owner review, delivery verification, publication and merge remain separate. U5 waits for landed U4; #902 stays held through U4–U5 and removal of consumer-owned forwarding.
