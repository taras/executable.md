# U4 Planner revision review — 695bc5b2

**REQUEST CHANGES** for `695bc5b2f15180b5a5096bfa51a20b690cce1cbd`. The original static negative paths are corrected, registration retains its validated copy, and the independently loaded provider evidence is now present. One validation/retention defect remains in direct pinned admission. It violates frozen U4-1/U4-3/U4-8 and the preceding review's requirement to validate the data admission actually uses; no new criterion or architecture is added.

## Exact revision

- SHA: `695bc5b2f15180b5a5096bfa51a20b690cce1cbd`.
- Tree: `aff590983f9274140c44da5bb7c1ebca35240495`.
- Parent: `2824855c742b966628bd0d467997efec46a1362b`.
- Base: `6314e187dc89c3e0f2b393b60d6f5963f847a881`.
- Signature verified `G`; clean isolated `agent/upstream-u4-generated-owners` worktree.
- Revision diff: 17 files, +723 / −177; complete slice reported 44 files, +3559 / −2883.

Authority remains the immutable [U4 handoff](../upstream-prerequisites-6314e187/upstream-repository-prerequisite-u4-implementor-handoff.md) and [preceding review](../upstream-u4-review-2824855c/planner-review.md). The frozen rows/commands and the preservation snapshot are unchanged.

## Corrections accepted

R1's static metadata/form validation now runs before direct observation/mutation admission. Malformed provider `forms` no longer silently becomes omission or a filtered declaration. Extracting the existing form contract into `invocation-forms.ts` avoids the graph cycle without adding another parser. The original probe now reports all five negative paths corrected and its valid control unchanged.

R2 is closed for registration. `admitDeclaration` returns the admitted metadata and `registerComponents` uses that same owned frozen value. The accessor tests demonstrate one read and preservation of the validated URL; invalid first values refuse the batch.

R3 is closed. The new FE14/U4-7 fixture dynamically loads separate provider code, hands it the canonical registrar/request, exercises `request.answer(definition)`, and asserts the loaded module's body, one invocation and its URL in the retained admission. The unchanged foreign-protected implementation refusals remain covered. This meets the frozen positive-provider requirement.

The updated component-answers documentation and unchanged U4/U5 boundary fit the requested correction. These points do not require redesign or another architecture amendment.

## Remaining blocker — direct admission discards the validated copy

`generated-xmd.ts::admitOffered` calls `definitionGeneratedRefusal` and returns void. That validator calls `admitGeneratedForms`, which constructs and validates owned frozen metadata, but only the refusal result is kept. `observedForms` and `offeredIdentities` subsequently read the original caller-controlled definition and metadata again.

Thus the same check/copy defect repaired in registration remains at direct generated admission. The new check tests one reading; the journal retains a different reading. The later import also retains the original definition again rather than using the value validated for admission.

Reproduced at this exact SHA for both direct constructors:

| Path | Identity accessor | Reads | Result |
| --- | --- | --- | --- |
| `pinnedComponent` read observation | first: valid owner URL; later: `not-a-url` | 2 | One admitted record contains `not-a-url`; then unreadable-history failure; body count 0 |
| `pinnedMutation` paired write | first: valid owner URL; later: `not-a-url` | 2 | One admitted record contains `not-a-url`; then unreadable-history failure; body count 0 |

These are current records produced by the live path, not malformed history supplied by a caller. Rejecting the record after appending it does not satisfy live declaration validation.

Relevant sites: `core/src/generated-xmd.ts:1021`, `:1048`, `:1073`, `:1090`, `:1116` and `:880`; `core/src/components/generated-metadata.ts::definitionGeneratedRefusal`/`generatedRefusal` discard the admitted metadata result when used as a pure check. Using those refusal helpers on an already-owned stable provider copy is fine; using them as the only defense before rereading an unowned direct entry is not.

Required correction: retain/capture the definition and metadata once, validate that owned data, and use that same retained value to derive forms/URLs/policy and supply the invoked definition. Preserve fn identity, shared one-definition-per-name behavior, form dispatch, protected routes and the Json composition exception. Consistently refusing accessor-shaped direct inputs before admission is also valid. Do not introduce a new public container, context, registry or protocol.

Add a regression to the existing direct-entry tier with the alternating identity and a stable positive control. Both observation and mutation branches are exposed; establish that neither can append an unvalidated value. Prove the assertion discriminates by reverting to check-then-reread in a reversible control. This remains the existing single-read/retention and malformed-input evidence, not a new matrix row.

## Reviewed evidence

Copied Implementor logs retain the ten frozen commands and reported green results: Deno groups 25/147, 36/331, 14/83, 21/131, 19/140; Node/Bun 309 each; dead-code/build success; compiled 6/15. The three retained correction controls fail at their intended boundaries. These observations establish the reported corrections, but do not cover the remaining direct accessor path.

Planner independently ran:

```sh
deno task test packages/core/tests/generated-owner-metadata.test.ts packages/core/tests/answer-identity.test.ts packages/core/tests/generated-xmd.test.ts packages/core/tests/syntax-loaded-copy.test.ts
```

Result: **26 passed / 221 steps / 0 failed**, exit 0. [Focused log](focused.log).

The previous external metadata probe was rerun against this revision with exit 0 and corrected negative outcomes. [Original-probe rerun](original-probe.log).

The new [direct-entry read probe](pinned-read-probe.mjs) runs:

```sh
deno run --allow-all --frozen --config deno.json /private/tmp/xmd-pr181-bench-rXAXyb/planner-review-u4-695bc5b2/pinned-read-probe.mjs
```

Exit 0, reproducing both corrupt live admissions in [output](pinned-read-probe.log). It uses the public pinned constructors and real execution/durable preparation, supplying runtime accessor data from an external fixture. No repository source or tests were edited.

No CI was inspected. No production change, publication, cleanup, dependency or branch mutation occurred; worktree status remained clean and the immutable preservation copy was untouched.

## Next action

Return the [bounded revision prompt](implementor-revision-prompt.md) to the existing authorized Implementor. Correct the remaining direct retention path, return a signed feedback revision with the affected/frozen evidence, and keep publication held. U5/#902 remain held. No repeated implementation authorization is needed.
