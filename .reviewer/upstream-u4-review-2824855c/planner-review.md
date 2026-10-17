# U4 Planner review — 2824855c

**REQUEST CHANGES** for `2824855c742b966628bd0d467997efec46a1362b`. The current feedback evidence is green, but probes demonstrate existing frozen validation criteria unmet. U4-7 also lacks its required positive independently loaded provider evidence. These are corrections to the frozen matrix, not new product requirements.

## Exact revision and authority

Commit `2824855c742b966628bd0d467997efec46a1362b`, tree `bdfe5cab3f9bc48c229329ce131f635550c01a27`, parent/base `6314e187dc89c3e0f2b393b60d6f5963f847a881`. Signature verified `G`; worktree clean. Diff: 40 files, +2890 / −2760. Worktree `.claude/worktrees/u4-generated-owners`, branch `agent/upstream-u4-generated-owners`.

Authority: the immutable [U4 handoff](../upstream-prerequisites-6314e187/upstream-repository-prerequisite-u4-implementor-handoff.md), frozen rows U4-1–U4-12 and accepted prerequisite contract. Nothing in this review changes those artifacts or their frozen commands.

## R1 — enforce metadata/form validation at every live admission boundary

Frozen U4-1/U4-4/U4-8 require valid metadata belonging to forms the declaration accepts. The direct pinned-definition path skips the new validator. `generated-xmd.ts::observedForms` chooses forms solely from generated effects; `offeredIdentities` reads identities without validating their URL or checking the declaration's accepted forms.

Reproduced through production `executeInstalled` with an existing durable preparation and public `evaluateGeneratedXmd`/`pinnedComponent`:

- Positive: a valid self-closing read definition returns `PROBE BODY RAN` and records a current URL admission.
- Excluded form: the definition declares `forms: ["paired"]` but offers self-closing metadata. `<Probe />` still returns `PROBE BODY RAN` and appends an admitted record. It must refuse the malformed host declaration before admitting/running it.
- Invalid URL: the same direct entry with identity `not-a-url` appends an admitted record containing that invalid identity. Only the reader of the newly written record then throws the unreadable-history error. The live declaration must be validated before appending an admission; the history reader is not its validator.

Provider publication uses the validator, but `generated-metadata.ts::acceptedForms` has a second hole. It interprets every non-array as omitted forms and silently drops unknown array members. Production provider-backed `<Evaluate>` accepts `forms: "paired"` and `forms: ["self-closing", "unknown"]`; both render `PROBE BODY RAN`. Only genuine omission means both forms. Malformed stated forms must be refused using the existing accepted-form contract rather than filtered into a valid declaration.

Relevant sites: `core/src/generated-xmd.ts:1017`, `:1061`, `:1087`; `core/src/components/generated-metadata.ts:179` and `:191`. Apply the shared metadata/form validation to the retained data each live path uses, including direct observation and mutation entries. Preserve the deliberate Json composition exception and ordinary no-metadata behavior. Do not introduce a second parser/registry/protocol or validation through a cyclic registry import.

## R2 — registration validates a different read from the metadata it retains

Frozen U4-1/U4-3 require the validated metadata to be what construction retains. `registerComponents` retains the registration's `generated` reference at line 301, validates via `admitDeclaration`, then `captureGenerated` reads its nested members again at line 318. The latter copy is not revalidated.

Reproduced with a valid registration whose self-closing identity accessor returns the accepted URL on its first read and `not-a-url` on its second. Registration succeeds. The accessor is read twice and the registry holds the frozen invalid identity `not-a-url`.

Capture once into owned data, validate that data, and publish that same data. Refusing accessor-shaped metadata is also valid if consistent with the accepted defensive-read contract. A failed capture/validation must leave the whole batch uninstalled. Audit the matching declaration-construction paths for this same check/copy separation; do not broaden the task into unrelated registration hardening.

Relevant sites: `core/src/components/registration.ts:301`, `:302`, `:318`; `core/src/components/generated-metadata.ts::captureGenerated`.

## R3 — U4-7's independently loaded provider success is not covered

The cited `syntax-loaded-copy.test.ts` bundles `invocation-identity.ts`. It verifies foreign protected implementations and routing refusal. Its provider handler is local, delegates the canonical Syntax publication unchanged, and contains no `request.answer` call. `evaluate-loaded-copy.test.ts` does not supply the missing positive provider-publication case either.

Keep those protection cases. Add the frozen positive case in the selected Deno-only suite: code loaded independently of canonical core receives the handed registrar/request, publishes its own supported function definition with current metadata using `answer(definition)`, and a generated invocation runs the retained answer. Assert the observed invocation/output and current URL record. An unchanged delegation or a locally constructed descriptor is not evidence for that changed publication member. No new matrix row is needed.

## Evidence and limits

The Implementor's ten retained frozen-command logs report the supplied passing results; copies are in `implementor-logs/`. They do not contradict the missing cases above. The larger diff is not by itself a blocker; the schema/fixture migration explains its shape. The fixed current marker `3`, per-spelling retained rows, owner-derived effects and provenance separate from URLs fit the accepted U4 boundary. No additional architecture decision is requested for those choices. The per-entry ceiling observation can remain in existing GX14b/GX14c rows without a new issue: their old joined-key collision premise no longer exists.

Planner independently ran:

```sh
deno task test packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/evaluate-provider-lifetime.test.ts
```

Result: **24 passed / 218 steps / 0 failed**, exit 0. [Existing-focused log](existing-focused.log).

The external [probe](metadata-probe.mjs) ran from the exact clean feedback worktree:

```sh
deno run --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/planner-review-u4-2824855c/metadata-probe.mjs
```

Exit 0, with the positive control and five negative-path observations described above in [probe output](metadata-probe.log). This JavaScript fixture supplies malformed runtime input deliberately; it changes no repository source, test or dependency. The first harness attempt used a workspace package import outside its package scope and failed to resolve it; the retained runnable probe uses the exact local durable-streams entrypoint. That was probe setup, not a product failure or flake.

One documentation correction to make while addressing this boundary: `core/src/component-answers.ts` still describes the removed structural identity and the old publication member in its header and installation docs. Update those descriptions to the accepted current member/provenance contract. This is not a separate architecture or evidence expansion.

No production source, branch, dependency or immutable preservation artifact was changed. Worktree remained clean. No CI, delivery or main-health state was inspected. No push or PR action occurred.

## Next action

Send the [revision prompt](implementor-revision-prompt.md) to the existing authorized Implementor. Reproduce the retained probe, make the bounded corrections, commit discriminating cases in the existing selected suites, restore all reversible controls, and return a new signed feedback SHA with affected/frozen evidence and row map. Publication remains held; no U5/#902 work or cleanup is authorized.
