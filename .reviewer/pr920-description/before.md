## Why

A trusted host used to state what a generated fragment may do as a whole `ExecutionInstallation.evaluation` profile: two contract tables of pinned definitions, a Workspace basis read per invocation, a frozen Fetch timeout and an exact request inventory. Most of that restated facts the components themselves already own — which identity a spelling runs under, what its props are validated against, whether it observes or mutates. The parts that did not were live state: the retained Workspace roots and the request allowlist were captured at assembly and a continuation was then compared against them.

A host now offers one thing: the names and authored forms it selects. Everything else is read off the declaration that owns the implementation, and everything live is asked where the work happens.

It is the fifth and last prerequisite in the #181 stack (after [#905](https://github.com/taras/executable.md/pull/905), [#906](https://github.com/taras/executable.md/pull/906), [#912](https://github.com/taras/executable.md/pull/912) and [#919](https://github.com/taras/executable.md/pull/919)) and is based on `main`. #902's consumer work stays held until this lands and its forwarding is removed.

## What changes

Before:

- A host wrote `evaluation: { read: [fileReadEntry(), …], write: […] }` on an installation, and two installations stating one refused with `TWO_PROFILES`.
- Selecting `Glob`, `Fetch` or `Elicit` ran a body pinned past whatever that host had legitimately registered for the name.
- `<Fetch>` carried an exact request inventory that preflight classified the element against, and the admission retained it; the generated Fetch timeout was frozen at assembly.
- The admission retained the run's Workspace roots and compared a continuation against them.

After:

- A host composes `Component.generated` — an ordinary contextual *value* property mapping component name to the authored forms it offers. Two handlers compose rather than conflict; there is no contributor count, and an empty or malformed selection refuses setup rather than being defaulted.
- Every selected name resolves to the actual host answer through the ordinary `Component.importComponent` chain and the canonical terminal behind it. A replacement that offers no generated use of the selected spelling refuses setup.
- A destination bound is a live `Permissions.fetch` restriction in the owner that performs the request, asked of the transformed request immediately before transport — so a dynamic destination is an ordinary input to preflight, and the effective Fetch timeout is resolved from contextual `Config` where the request is made.
- The `generated_xmd` record is marker 4: the selected rows and the class selection, with no Workspace basis and no request inventory. Marker-3 records are refused as unreadable history.

## How it works

```text
host middleware answers Component.generated
  → invoke(): init, installation callbacks, documentation
  → assembleComponents(): registry, bundle, declarations, protected tier, identity domains
  → admitGeneratedSelection(): one read, validated whole
  → resolveSelectedComponents(): one import per name, published where the answer was produced
  → captureEvaluationProfile(): read/write tables derived from each owner's generated metadata
  → public Execution.execute policy
  → executeDocument() reuses that same assembly
```

Canonical component assembly moved out of `executeDocument()` into the invocation owner, so a selected name resolves against the host environment before public policy can replace any of it; authored execution reuses that assembly rather than building a second one. What the assembly does *not* decide is where the document's own imports resolve from: those still go through the options the canonical request settled to, so a policy's legitimate `request.withOptions()` search-path replacement reaches authored imports and this execution's own description, while the pre-policy capture keeps the paths it resolved against.

`admitGeneratedSelection()` reads each member of the host's answer exactly once, validates all of it, and answers with a frozen owned map — so the reading that was validated is the reading that is retained.

## Review guide

**Start with:** `packages/core/src/generated-selection.ts`

**Then review:**

1. `packages/core/src/component-api.ts` — the property, its `undefined` default, and the operation
2. `src/execute.ts::assembleComponents` — the capture boundary, and what stays on the settled options
3. `src/evaluation-profile.ts` — read/write tables derived from each owner's `generated` metadata, and the refusal normalization the capture guard now owns
4. `src/generated-xmd.ts` — marker 4, and everything the walk no longer takes
5. hosts: `packages/cli/src/evaluation-profile.ts`, `src/repl/session.ts`, `src/testing-host.ts`, `src/plan-writer-profile.ts`, `packages/workflow/src/deno/workspace/evaluate.ts`, `packages/cli/src/workflow.ts`
6. the affected specs and `architecture.md`

**Look carefully at:**

- `execute.ts::resolveSelectedComponents` — canonical publication happens in the innermost `importComponent` handler, on the exact object produced. Publishing after the chain returned let a mutating handler rebaseline itself as the baseline.
- `evaluation-profile.ts::bounded` — an admitted component's ordinary `Err` becoming a marked generated-request refusal with a safe reason. Without it the Plan loop loses its retry context.
- `workflow/.../evaluate.ts::useWorkflowGenerated` — one reading of each option. Whether `<Fetch>` is offered and what a request may reach are two halves of one host statement; two readings of an accessor-backed option are two statements.
- `cli/src/evaluation-profile.ts::useGeneratedFallback` — every ordinary host's default delegates first and answers only on `undefined`, including in each REPL entry's own scope.

## What must stay true

- **A host selects names and forms, and nothing else.** Enforced by `admitGeneratedSelection()` accepting only a map of component names to canonical form lists; checked by the `U5-1` refusal table and the `FE31`/`FE34` profile rows.
- **The selection is read once, before public policy.** Enforced by reading it in `assembleComponents()` after the installation callbacks and before `Execution.execute`; checked by `U5-2`, which records when the property is read and that a policy's widened selection changes nothing.
- **A selected name runs the implementation the ordinary chain answered with.** Enforced by resolving through `Component.importComponent` and publishing at the innermost producer; checked by the `U5-3` rows — unpublished, mutated, wrapped and replaced answers all refuse.
- **An ordinary host's default composes; it does not answer.** Enforced by `useGeneratedFallback()`; checked by `FE24` and the two REPL entry rows, where a defined narrower selection is read and a defined empty one refuses the entry before its body.
- **What a request may reach is live.** Enforced by the `Permissions.fetch` restriction reading the transformed request immediately before transport, and by deriving both the `<Fetch>` offer and the bound from one reading of the host's list; checked by `WGX7`–`WGX15`.
- **A record this build did not write is not a grant.** Enforced by the single marker-4 shape read closed; checked by the `generated-xmd` record table.

## How to verify it

- `U5-1`/`U5-2`/`U5-3` (`packages/core/tests/generated-selection.test.ts`) prove the default is absent, that a malformed or empty selection refuses before policy, the root import, any producer and any effect, and that each selected name resolves once to its actual retained definition. They fail if a partial allowance survives an invalid member, if the property is read after policy, or if a mutated answer can rebaseline itself.
- `U5-2`'s search-path row proves a policy's `withOptions()` includes replacement reaches authored imports while the capture keeps its own paths, and fails if assembly's pre-policy reference decides authored resolution — the defect `EP26` also catches.
- `WGX13` drives the production Workflow helper, canonical `<Evaluate>` and the real Fetch terminal against a loopback server: unchanged headers reach it carrying exactly what was bounded, and a transformation that adds a differently cased spelling of a bounded name reaches it not at all. It fails if the comparator collapses case-colliding names, in which case the server receives `EXTRA, admitted`.
- `WGX15` proves the request allowance is read once: with an accessor stating no bound first and a bound afterwards, `<Fetch>` is never offered, nothing is sent and the read count is one. It fails if the selection and the policy come from different readings, in which case the fragment performs `GET /not-admitted`.
- `WGX9` mutates the host's own bound while the same installed policy is still live, then proves the stated request still passes and both the changed destination and the changed header value refuse.
- `FE34` and the `generated-xmd` record table prove an admitted component's refusal still carries a safe generated-request reason, and that marker-3 and malformed records refuse before restoring anything.

Twelve frozen feedback commands, all green: Deno groups `26/159`, `34/287`, `28/171`, `25/173`, `30/224`, `2/19`; Node `257 pass`; Bun `257 pass`; `deno task lint:dead-code`; `deno task validate:docs`; `deno task build`; compiled and npm-bin `7/21`. `deno task check` and `deno task lint` are also clean.

## Scope

### Included

- `Component.generated` as a plain contextual value property, with `undefined` as the default and one validated read per execution.
- Canonical component assembly ahead of public execution policy, with the selected definitions and their metadata retained together.
- Marker-4 `generated_xmd` records, with no Workspace basis and no request inventory.
- Every shipped host migrated: ordinary `xmd run`, REPL entries, isolated `host="run"` children, the Plan writer, and the Workflow attachment with its optional live request bound.
- The affected specs' present-tense contracts and `architecture.md`'s generated-evaluation boundary.

### Intentionally unchanged

- `<Evaluate>` stays canonical core's own protected component; a host offers the selection, never the component.
- `<Json>` stays always-on trusted composition and needs no effect class.
- Permissions, the contextual `Config` timeout, canonical protection, provider provenance and completed local replay are untouched — the removals here are host *inputs*, not live policy.
- No stored journal is rewritten or migrated; marker-3 records refuse rather than convert.
- `Dir` and `Fetch` are still absent from the ordinary command selection: an ordinary run creates no directory and reads no network on a document's behalf.

## New abstractions

- `core/src/generated-selection.ts` exists because one host answer crosses the boundary from JavaScript and must be validated whole before a single name is resolved; its consumer is `assembleComponents()`, and its refusal text is the one the host-facing error reports.
- `cli/src/evaluation-profile.ts::useGeneratedFallback` exists because three ordinary hosts — `xmd run`, each REPL entry and an isolated run child — need the same delegate-first rule, and a host that answered instead would be the one place a plugin's selection could not be read.
- `core/tests/support/generated-selection.ts` exists because a case either owns the scope around its execution or states its selection beside the rest of what it installs; both reach the one contextual property.
- [x] Each new abstraction has multiple concrete uses or a clear justification.
- [x] No speculative functionality is included.

## Risks and limitations

- **A generated-admission record written by an earlier build no longer resumes.** Marker-3 records are refused as unreadable history before the admission they would have restored performs anything. A run suspended mid-fragment on an older build must be started again; nothing stored is rewritten.
- **Host-facing surface changed.** `ExecutionInstallation.evaluation`, `FragmentEvaluationInput`, the entry constructors, `FragmentCapability`, `evaluateGeneratedXmd`, every `pinned*`, `statesEvaluation`, `workspaceRootSelection` and `gitDirectoryEntry()` are gone; `src/fragment-capabilities.ts` and `workflow/src/generated-observations.ts` are deleted. In-repo consumers are migrated here.
- **A Workflow host that bounds no request offers no `<Fetch>` at all**, rather than offering it and refusing every destination.
- The test migration is a large share of the diff. Where a row's old premise became false it was replaced with the current-contract assertion rather than deleted.

## Scope confirmation

- [x] Every changed file supports the purpose described above.
- [x] Unrelated cleanup and formatting changes are excluded.
- [x] Generated or mechanical changes are clearly identified.
- [x] The description matches the final diff and test results.
