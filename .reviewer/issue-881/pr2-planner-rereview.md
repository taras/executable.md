# PR 2 Planner re-review and independent structural review

**REQUEST CHANGES** at **82a915ae70cb96bc03d61d84c501d96430a86c08**.

R1–R3 are closed. The remaining blocking finding is **R4: question previews
still lose long-line text**. The Plan source preview and README confirmation
use one drawer row per logical line; they do not receive the lossless measured
wrapping added to the main reading. This fails the existing S2 requirement and
accepted journey steps 2/5. No architecture amendment or persistence change is
needed. PR 1 remains accepted. PR 3's implementation dependency remains unmet.

## Reviewed revision and prior findings

Branch: `agent/issue-881-pr2`. Parent:
`670eb21af74c17db304f083cf5640d00e368b037`. Integrated base:
`c7d54769d56661bef38cee8549b148f3bf87a904`, combining accepted PR 1
`080b6ec80ca74e614789e8d2252857ac281df7e5` and main
`4c0414be1010f69f11bff0d1d634623a5b08f886`.
The implementation worktree stayed clean at the reviewed SHA. This review
changes review artifacts only. It uses no production edits, subagents, GitHub
mutation or CI verdict.

| Prior finding | Independent result at this revision |
| --- | --- |
| R1: authentic foreign invocation request runs work before refusal | **Closed.** The terminal compares exact request identity before claiming/delegating. The original read-only probe now reports `bodies: []` and ComponentExpansionProtocolError. CX1 also proves both genuine requests remain usable by their own terminals. |
| R2: lexical envelope changes accepted execution inputs | **Closed.** BOM/no-header, unterminated header, delimiter-with-suffix and ordinary header probes agree with the installed extractor and execute through parseSource. The focused envelope regression covers 24 shapes; inspection still evaluates no header values. |
| R3: mutable shared phases and aggregate explanation | **Closed.** Publication freezes each phase; detached aggregate member arrays are frozen. The probe's late reader receives the unchanged complete observation, with frozen phase/Result/error/member data. |
| K1 described recolouring as rail removal | **Closed.** K1 now removes the rail glyph and fails the composed-row assertion. K1b retains the separate EXIT-colour check. All 14 supplied controls have nonzero results, substantive first failures and restored hashes matching current production bytes. These records were inspected, not rerun by the Planner. |
| Committed scratch outputs and vacuous diff check | **Closed.** Scratch log/control outputs are removed from the product diff. `git diff --check c7d54769..82a915ae` exits 0. |
| Copied-bounds explanation and unstable evidence packet | **Closed.** The redundant geometry copy is removed; renderer.measure already copies bounds. The packet is stable: 320/320 listed hashes match both integrity reads, with 44 frozen pairs. All 16 contact sheets were opened. Opening them does not establish visual acceptance: R4 remains. |

The prior requests in pr2-planner-review.md and
pr2-independent-architecture-review.md remain historical records for 9d8bc463.
This review supersedes their outstanding-finding list for the new SHA.

## R4: preserve every character of question preview content

In the real Plan-to-README journey, enter Northstar and
`A lightweight workspace for coordinating coding agents.`, submit the details,
and open the README confirmation. At **72×20**, scroll its own `[↓ later]`
control through the entire drawer. The summary reads:

```text
"summary": "A lightweight workspace for coordinati
}
```

There is no continuation containing `ng coding agents.` or the closing quote.
All eleven captured narrow preview windows omit that tail. Approve, Decline and
submit are reachable, so reaching the controls alone misses the defect.
The 160×36 preview and the actual README contain the complete value; this is
presentation loss, not malformed input or a missing program result.

Decisive evidence:

- [Narrow summary and next row](pr2-planner-rereview-evidence/captures/readme-preview-traverse-72x20-04.png), with raw ANSI/text beside it.
- [Last decision controls](pr2-planner-rereview-evidence/captures/preview-last-controls-72x20.png).
- [Full wide preview](pr2-planner-rereview-evidence/captures/preview-open-wide.txt) and [actual README](pr2-planner-rereview-evidence/actual-README.md).
- [Traversal comparison](pr2-planner-rereview-evidence/preview-clipping-probe.json): full value present wide/in-file, absent tail in every narrow window.
- The supplied frozen `pr2-evidence/captures/plan-review-160x36.txt` exposes the same boundary in the Plan source preview: its first Elicit opening ends at `description: "Name y`, then the next logical content appears. The rest of that schema has no continuation.

The affected boundary is `application.ts:3386`: question.message is split into
logical lines and each becomes one drawerLine. `drawerContentRows` at 3659 also
counts logical lines. `program.ts:1439` prepares the main Output/Source reading,
but not this preview content. Vertical scrolling can only reveal rows that
were prepared; it cannot recover the remainder of these single-row lines.

Apply the existing private engine-measured wrapping approach to the question's
read-only message/source preview at its actual inset content width. Preserve
all text, explicit blank lines and token roles. Use the resulting visual rows
consistently for drawer description, row count, admission, scroll bounds and
mounted targets. Keep the established field, metadata, focus and answer
semantics. This asks for no public interface, new reader or persistence.

Extend the existing S2/journey evidence through the **actual composed drawer**:
read the full long Plan schema and the full README summary through normalized
scroll controls, including closing delimiters/quotes, and reach the existing
decisions afterward. Concatenating the displayed fragments must recover the
original logical text and roles. An assertion on prepareReading alone, or on
Approve's visibility, is insufficient. This is a frozen criterion, not another
scenario added to acceptance.

## Focused commands and independent structural checks

From `.claude/worktrees/issue-881-pr2`:

```sh
deno task test packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts packages/core/tests/component-api.test.ts packages/core/tests/invocation-scope.test.ts packages/core/tests/invocation-failures.test.ts packages/core/tests/invocation-identity.test.ts packages/core/tests/expansion-metadata.test.ts packages/core/tests/scanner.test.ts packages/core/tests/document-targets.test.ts packages/core/tests/document-target-execution.test.ts packages/core/tests/evaluate-component.test.ts
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-journey.test.ts packages/cli/tests/repl-agent-journey.test.ts
deno task test packages/cli/tests/repl-lifecycle.test.ts packages/cli/tests/repl-agent-execution.test.ts
git diff --check c7d54769..82a915ae
```

All exit 0: **Core 53 tests / 414 steps; CLI 94 / 314; supplemental 14 / 52**.
Full outputs are core.log, cli.log and lifecycle.log in the new evidence folder.
The read-only contract probe also exits 0, closing R1–R3. Its source and output
are retained there. It ran from the repository root against the implementation
worktree's config:

```sh
deno run --allow-all --config .claude/worktrees/issue-881-pr2/deno.json --node-modules-dir=manual --cached-only --frozen /private/tmp/issue881-planner-82a915ae/contract-probe.ts
``` These passing tests do not discriminate R4.

This is an independent review by the Planner, who did not implement PR 2. It
checks the seven frozen requirements, without adopting the Implementor's
self-assessment as a verdict.

| Frozen structural check | Result |
| --- | --- |
| 1. Canonical execution, exact delegation, outcome authority | Supported after R1/R3 corrections: exact identity precedes work; canonical failure and binding acceptance remain Core-owned. |
| 2. Existing owners, ordered cleanup, consumer lifetime | Held body/cleanup/middleware cleanup, failure/cancellation and session release tests pass. This live run completes Plan approval and teardown without the former storage collision. |
| 3. Narrow generated capabilities; presentation grants no authority | Generated execution and lifecycle regressions pass; CurrentOccurrence remains presentation lineage, not authorization or durable identity. |
| 4. Pure canonical inspection and retained replacement ownership | Supported after R2: shared canonical scanner, lexical-only envelope and exact retained-range replacement. |
| 5. No persistence extension; observed/unobserved equivalence | Focused canonical comparisons pass for output, bindings, failure and serialized Journal bytes. No retained lifecycle field/record is introduced. |
| 6. Prefix isolation, cold reads, actual output owner | Offscreen and cold checks pass below. TL10's compile/source-read counters stay zero; actual output/report belongs to the entry. |
| 7. Immutable root view, measured preparation/admission, mounted targets | Root/action/main-reading ownership remains intact. **Preview preparation is incomplete (R4)**: question-message content is not represented by the lossless visual rows the frozen presentation requires. |

## Planner-owned journey and visual evidence

The Planner drove one real execution through the accepted story, visiting all
three profiles at each recorded stage, with additional narrow traversal. Inputs,
provider records, raw captures and selected images are retained. No view state
was injected.

| Accepted step | Independent result |
| --- | --- |
| 1. Original nested Plan and ACTIVE statuses | Passed at 160×36, 120×30 and 72×20; nested-running captures. |
| 2. Plan review, decisions, close/reopen | Pending question and source preservation pass at all profiles: plan-review-controls, plan-dismissed, plan-reopened. Full source-preview readability fails R4. |
| 3. Generated source inside Evaluate | Passed: original producer is replaced after admission; enclosure remains. generated-inline and the 52 narrow source-traversal windows reach the schema tail and closing Evaluate. |
| 4. Empty validation and populated form | Passed through existing interaction: invalid-details, completed-details, populated refusal/recovery. The known focus behavior required the established wide focus workaround; narrow field entry and submission are recorded. Fields were refilled after an additional driver close/reopen discarded unsubmitted values. |
| 5. Whole README preview, approval and result | **Fails R4.** Approval succeeds, the real file contains the complete values, Output starts with the document, and its actual final report is reachable. The preview loses text. File existence alone is not presented as an independent write-count measurement; canonical once-only evidence remains in the focused Core suites. |
| 6. Earlier prefix, offscreen advance and return live | Passed at all profiles: provider completes and a question arrives offscreen while selected source stays unchanged; return live shows the current question. |
| 7. Resize and reachable content | Supported profiles and populated 60×15 refusal/recovery pass. Explicit narrow source traversal and cold output/report/source-end reads pass. Preview wrapping remains R4. |
| 8. Cold head and earlier-prefix reopen | Passed at all profiles. Original producer returns in the early prefix with no future output or live badges. Journal/provider hashes remain identical. |

The exact cold head is:
`xmd://repl/bbc58804e58e43a8e2f8b802e8fa59c8/entries/entry-1`.
The earlier prefix is that URI plus `?at=yield:root:0&inspect`.
Across head/prefix reopens and the additional narrow tail read, the Journal
stays **47,323 bytes / 35 lines**, SHA-256
`847ee05b07d9e1305d545fdc7093e2bbc99df04ed2fb03215101316a59d9ef9e`.
The provider log stays **8,521 bytes / 11 lines**, SHA-256
`eba0a2f670904a31a521728050fd1935e90912931d0c0e43c34773729094821c`.
Source-load/compile assertions come from the frozen cold regressions; these
hashes alone do not measure source loads.

All **44 frozen comparison pairs** were opened through **16 supplied contact
sheets**, using the older reference archive
`86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`.
The complete image inventory is image-review.md. Supplementary Planner captures
do not enlarge the frozen gallery. The gallery is reviewed, but not accepted
because of R4.

Driver failures and corrections are preserved in driver-notes.md and their
first logs/captures. In particular, planner-journey-finish.log's generic
“whole preview”/“passed” messages are withdrawn: its checks established controls
and traversal, not retention of every preview character. The visual review and
preview-clipping-probe.json establish the failed requirement. This document is
the authoritative verdict. No flaky product rerun is claimed.

## Ready-to-send revision prompt

> Revise PR 2 from 82a915ae70cb96bc03d61d84c501d96430a86c08 for R4 only.
> Preserve the closed R1–R3 corrections. Prepare the actual question-message
> preview as lossless engine-measured visual rows, at the drawer's measured
> inset width, and use those rows for rendering, admission and scrolling.
> The original Plan schema and the README confirmation must remain entirely
> readable with their token roles, including the missing summary tail and
> closing quote. Keep current fields, focus and answer semantics; add no public
> API, persistence or Journal change.
>
> Extend the existing S2/journey regression through committed drawer cells and
> normalized scrolling so it fails on this revision, rather than merely proving
> that Approve is reachable. Run the frozen focused commands and base-to-head
> diff check, commit promptly once they pass, and return the exact SHA/parent/base.
> Refresh the unchanged 44-pair gallery from that SHA and the affected clipping
> control, retaining first failure and byte restoration. Preserve unaffected
> control evidence with clear provenance. Do not expand the gallery or rewrite
> PR 1's accepted record; do not push or open a PR.
>
> Return implementation evidence. The Planner retains visual re-review and the
> accept-or-request-changes verdict. PR 3 remains at its frozen handoff, waiting
> for PR 2 acceptance.

Continuity: reviewed SHA and integrated base are above. Produced artifacts are
this review and pr2-planner-rereview-evidence/. R1–R3 and the previous packet/
handback corrections are closed. R4 is the sole remaining blocking finding;
it restores the already accepted preview-wrapping contract. Next Implementor
action is that focused revision. No complete #881 or delivery acceptance is issued.
