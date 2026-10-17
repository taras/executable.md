## Why

Hosts currently configure generated evaluation by assembling read/write contract tables, duplicating each component's forms, props and identity. That also mixes the generated vocabulary with live request policy and Workspace state.

This PR replaces that input with `Component.generated`: a contextual selection of component names and authored forms. Core retains the selected implementations before execution policy runs; live Files and Fetch operations use the providers and permissions of the scope performing them.

This is U5, the final upstream prerequisite for #181, following #905, #906, #912 and #919. #902's consumer integration follows this merge and removes its existing forwarding.

## What changes

**Before:** hosts supplied `ExecutionInstallation.evaluation`, with separate read/write tables. Duplicate profiles refused, some names bypassed host replacements, and generated admission retained Workspace and request inventories.

**After:** hosts compose one name/form selection. For example, middleware installed in the execution's setup scope can offer File reads:

```ts
yield* Component.around({
  generated: () => ({ File: ["self-closing"] }),
});
```

Core resolves File once and derives its props, implementation, read effect and identity URL from the owning definition. A paired File remains unadmitted.

- `undefined` means no generated evaluation. Defined empty or malformed selections refuse setup before policy, root import or a paired producer.
- Ordinary host defaults delegate first and apply only on `undefined`, including each REPL entry. Custom selections are preserved without automatic union.
- Replaceable names such as Glob, Fetch and Elicit resolve to the actual host answer. A selected replacement without the required generated metadata refuses setup.
- Fetch destinations, methods and complete headers are checked after middleware transformation, immediately before transport. Timeout comes from contextual Config. Dynamic destinations require no static request inventory.
- Generated records use marker 4, retaining selected classes and name/form/identity/effect rows without a Workspace basis or request inventory.

## How it works

```text
Execution.init and captured installation callbacks
  -> assemble canonical component resolution
  -> read and validate Component.generated once
  -> resolve each selected name once; retain definition and metadata together
  -> public Execution.execute policy
  -> authored document and generated execution
  -> joined teardown
```

Authored imports still use the detached options accepted by execution policy, including supported search-path replacements. Those changes cannot widen the already captured generated selection.

A bounded Workflow host derives both implicit Fetch membership and its live Permissions restriction from the same captured request list.

## Review guide

1. `packages/core/src/generated-selection.ts` and `component-api.ts`: the value property, whole-selection validation and owned capture.
2. `packages/core/src/execute.ts`: assembly before policy, canonical publication at the point that produces the answer, and authored resolution on settled options.
3. `packages/core/src/evaluation-profile.ts` and `generated-xmd.ts`: retained definitions, lifetime guards, safe request-refusal classification for Plan recovery, and marker-4 reconciliation.
4. CLI host setup and `packages/workflow/src/deno/workspace/evaluate.ts`: undefined-only fallback, explicit Workflow vocabulary, and live request bounds.

## What must stay true

- **One validated reading supplies the retained allowance.** Selection and metadata capture keep owned data; Workflow's Fetch selection and policy use the same request-list capture. Covered by U5-1–U5-3 and WGX15.
- **Policy cannot substitute a generated implementation.** Canonical publication precedes outer middleware, and retained answers keep their dispatcher and execution lifetime. Covered by answer-identity, provider-lifetime and loaded-copy tests.
- **Completed local effects restore without live work.** Permissions checks remain inside live performers; replay does not repeat I/O or evaluator inventory. Covered by generated replay and Workflow journal tests.

## How to verify it

The focused regressions prove distinct boundaries:

- EP26 and the U5-2 search-path row preserve accepted authored options while preventing generated widening.
- Real REPL entries preserve narrower custom selections and refuse defined empty ones.
- WGX13 uses the production Workflow policy and real HTTP transport: unchanged headers succeed; a case-colliding header transformation sends nothing. WGX9 mutates a bound while its policy remains live.
- WGX15 supplies an accessor-backed request list: its first empty reading offers no Fetch, is read once, and sends nothing.
- Generated record tests restore current admissions and refuse old or malformed shapes.

**At reviewed head `86c10507`:** the affected Workflow group passed 30 tests/224 steps; workflow-fetch and workflow-agent passed 2/19; execution-protocol, generated-selection and REPL passed 13/127. The Workflow regression suite passed 3/15, and check/lint passed. The Planner independently reran that suite and the retained request-capture probe.

**Earlier focused baseline `2f105ed7`:** all twelve frozen commands passed, including Node and Bun (257 tests each), documentation, dead-code, build and compiled/npm-bin journeys (7/21). The final two-file Workflow correction reran its affected evidence; this does not claim every baseline command ran again at the final head. Delivery verification remains separate.

## Scope

### Included

- Contextual generated selection across ordinary runs, REPL entries, isolated run children, Plan writers and Workflow hosts.
- Removal of the old evaluation installation input, host table builders and evaluator-only Workspace/request plumbing.
- Current record readers/writers, migrated fixtures, specifications and architecture documentation.

### Intentionally unchanged

- Fixed filesystem components, protected Evaluate/Syntax, and always-on Json composition.
- Workflow storage, root associations, transactions, restoration and forks.
- Ordinary default vocabulary: File, File.Delete, Glob, Syntax and Elicit. Dir and Fetch remain absent from that default.

## New abstractions

- `generated-selection.ts` validates the host's JavaScript-facing value before resolution.
- `useGeneratedFallback()` shares undefined-only composition across ordinary host setup and REPL entries.
- The test selection helper supplies the same contextual property from either a surrounding scope or an installation callback.

- [x] Each new abstraction has concrete consumers or a required boundary.
- [x] No speculative functionality is included.

## Risks and limitations

- **Old generated admissions cannot resume on this build.** Marker-3 and earlier records refuse as unreadable history. Stored journals are neither rewritten nor migrated.
- **Host API migration is required.** `ExecutionInstallation.evaluation`, `FragmentEvaluationInput` and the old public entry/evaluation builders are removed. In-repository hosts migrate in this PR.
- **Selecting a replaceable name now validates the actual host answer at setup**, even if the fragment never uses it. A replacement lacking the selected generated form refuses instead of falling back to core's body.
- A live runtime refusal can follow an earlier committed effect; whole-fragment language validation does not provide rollback of completed effects.

## Scope confirmation

- [x] Every changed file supports the purpose described above.
- [x] Unrelated cleanup and formatting changes are excluded.
- [x] Fixture migrations and intentional behavior changes are identified.
- [x] The description distinguishes final-head evidence from the earlier baseline.
