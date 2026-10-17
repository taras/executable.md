# PR 3 Planner re-review at 3fa241dc

**REQUEST CHANGES.** Reviewed revision **3fa241dccd1ca3128d7026dbdd529efc7b401ef0**, parent f509197bd1998b376b09986b79fce2740568e76f, on `agent/issue-881-pr3`, against accepted PR 2 base acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e. The working tree was clean. This is independent implementation feedback, not delivery or publication approval.

The snapshot/refusal correction, corrected pause sequence and real held-call control satisfy R1–R3. The rendered original-parity gallery also passes visual review. R4's product behavior works in the Planner's live check, but the submitted journey still passes its grouping assertion against two ungrouped positions. Newly committed source and fixtures also need the repository's existing type and resource-ownership rules applied. No persistence, lifecycle API or presentation decision is reopened.

## R4: compare the selection on the rail, not in its caption

`pr3-evidence/journey.py:249–266` scans the five rows after `[history]` and returns the first `◆`. Row 2's right-hand `◆ SELECTED · N` caption comes before row 3's actual selected rail mark. The reported column 145 is therefore the caption's column.

The submitted `grouped-selection` record chooses 18 and 19 because they are the first consecutive Component admitted rows, without first establishing that their marks share a column. In an independent real-command cold reading of the packet's checksummed settled prefix:

| Profile | Position 18 rail column | Position 19 rail column | Submitted helper's answer |
| --- | ---: | ---: | --- |
| 160×36 | 10 | 11 | 145 for both |
| 120×30 | 7 | 8 | 105 for both |
| 72×20 | 4 | 4 | 57 for both |

These are zero-based columns. The wide and medium pair is not grouped. The journey's successful equality therefore cannot establish its claim.

The Planner also selected a real shared pair through the root drawer: 23 and 24, both Component admitted. Their rail columns are 14 at wide, 10 at medium and 5 at narrow. At wide, scrolling the Entries catalog to expose the admitted scopes shows six components for 23 and seven for 24. Both exact selected ordinals remain correct. Position 218 was then selected directly while inspecting; the shared selection/head indicators, History resize through 60×15 and recovery, and return live also passed. This demonstrates working product behavior and supplies a concrete fixture for the repair.

**Required correction:** constrain the helper to the actual selected-mark row/rail region and choose a consecutive same-category pair that really shares a measured column. Keep the existing exact-prefix content discriminator and later-marker action. Correct the handback's 18/19 “one mark” claim. The new session/renderer regression is useful and can stay; it does not make the root journey's false grouping assertion valid. No sixth mutation control or additional gallery scene is requested.

Evidence: [live grouped results](pr3-planner-review-r2-evidence/grouped-live/verified-shared-results.json), [original-pair observations](pr3-planner-review-r2-evidence/grouped-live/results.json), and the preserved drivers, logs and ANSI/text/PNG captures beside them. Counts in the initial observation log are only visible catalog rows; the corrected wide check scrolls the catalog before asserting six versus seven. Zero visible rows at smaller profiles are not a claim that their prefixes contain no scopes.

## R5: apply existing code rules to the newly committed files

This revision adds production casts at `packages/cli/src/repl/session.ts:577,580`: the memo stores optional whole/prefix/error fields, then asserts both successful payloads with `as ReplModel`. Repository Code Rule 6 requires inferred/narrowed types rather than casts. Represent successful and failed cached projections with types that narrow to their actual payloads; Effection's existing `Result<T>` is available. Keep local names and helper structure as implementation decisions. No new public interface is needed.

The newly committed `packages/cli/tests/fixtures/repl/issue-881/HistoryGate.ts:51–56` creates `fs.watch` and then yields `ensure()` to register its release. Code Rule 16 explicitly forbids that order: the registration itself suspends, so cancellation there can leave the watcher without cleanup. The same file also introduces an async filesystem helper at lines 31–37 and direct fs promise operations where the repository requires Effection operations and appropriate `@effectionx/fs` operations (Code Rules 1–3).

`controlled-host.ts:67–68` likewise uses `as string` for validated latch paths and imports direct fs promise operations. Narrow the values into the host operation instead of asserting them, and use the existing filesystem operation boundary where it supplies the operation needed. The controlled-host architecture itself remains accepted: one real installation holds its own teardown, with no fabricated head state.

**Required correction:** bring the newly committed code under these existing rules. Register cleanup before taking any watcher resource, with its actual release lifetime established. Alternatively, remove the unused HistoryGate probe from shipped test source and retain its historical bytes with the probe evidence. Preserve the controlled teardown fixture that the accepted gallery needs. A focused cancellation/resource check is appropriate if HistoryGate remains executable source; no new visual permutation is needed.

This is an existing ownership requirement applied to a new resource, not an expansion of the History architecture or the frozen visual matrix.

## Corrections accepted and evidence reviewed

- **R1 satisfied:** `session.reading(at)` projects the full file and prefix from one acknowledged-array slice. The root carries the resulting model/navigation pair through resolution, measurement, paint and resize. It no longer takes fresh navigation after a suspending size read. An unreadable admitted history wakes the root and draws the refused view. The admitted duplicate-final-record regression and coherent-pair regression pass independently.
- **R2 satisfied under the Planner's recorded ordering correction:** actual provider work is established, Pause reports PAUSING, work is released while inspecting, both retained and navigation counts grow, and the controller reaches PAUSED with unchanged content/selection. Closing History preserves that hold and offers no historical Continue. Returning live exposes the actual Continue and the entry reaches an outcome. The submitted counts are explicitly compared, rather than merely logged.
- **R3 satisfied:** P1-T4 composes a frame from a genuinely suspended Elicit's session-owned observations. KC3 fails that committed-cell assertion. All five controls retain complete first output, stack locations and equal before/after source hashes. Their mutations and restorations were inspected; the Planner did not rerun the destructive controls concurrently with its live journey.
- **Visual review satisfied at this revision:** all 77 supplied comparison pairs were personally opened through 27 contact sheets. Pane hierarchy, token/source/output roles, lifecycle reading, drawer treatment and the five-row recorded-order rail follow the original reference under the frozen terminal adaptations. Narrow clipping remains the accepted vertical-window behavior. No additional visual defect was found.

The original R2 section in the handback still says a complete pause means “nothing is outstanding,” says closing History leaves Continue offered while inspecting, and ends at LIVE. The later correction section and executable journey are correct. Update the earlier prose and the corresponding journey/probe explanations to the accepted expansion-walk boundary and the actual PAUSED → return live → Continue → SETTLED result. The four historical probes do not prove that all Effection work must finish before a pause can exist. This is documentation cleanup alongside the two corrections above.

## Structural checklist

The seven original-scope production checks were reviewed against the accepted architecture handoff:

| Check | Assessment |
| --- | --- |
| Authoritative retained identity | One validated snapshot supplies full identities and exact prefix; malformed history refuses. |
| Inspection reachability | Only marker/kind and band head cross; prefix content and historical authority stay isolated. |
| Execution ownership | Actual session/controller state and complete entry unwind supply the head. |
| Persistence and reconstruction | No new protocol, store or replay execution; settled cold reads perform no work. |
| Root and child boundaries | The root resolves the reading; inert data travels down and typed exact-marker actions return. |
| Mounted targets and measurement | Existing engine/Freedom boundaries remain; grouped selection works. R4 repairs its repeatable evidence. |
| Resource and concurrency boundaries | Production History reuses the existing wake/render ownership. R5 repairs the separately committed probe resource's cancellation boundary. |

No new architecture amendment is needed. R5 is application of the repository's existing code/resource rules, and R4 is the frozen H1 evidence requirement.

## Independent live journey

The Planner completed post-commit production-input checks at all three profiles: the original held Plan; Pause and offscreen advance with prefix/selection preserved; unanswered Plan close/reopen; complete original schema traversal; generated source and enclosure; required-field validation and entered values; full README confirmation summary and decisions; the actual written README; settled output/source traversal; warm and cold early-prefix inspection; retained draft; and cold head plus cold selected-location reopening. The populated form additionally survived 60×15 refusal and 160×36 recovery. The controlled production host showed SETTLING while its installation teardown was held, refused another submission, and repainted SETTLED after release without input.

Cold checks retained the same 47,333-byte / 35-record Journal hash and 8,521-byte / 11-record provider-log hash through head and prefix reopening. The separate copied 218-position history supplied the true grouped selections, later-marker selection and History resize checks above. No source load or provider execution was introduced by the production change; the focused H6 regression covers the source-load counter boundary.

The drivers used separate owned PTYs, working directories and provider logs, with the normal home and unchanged prepared dependencies. Their distinct first traceback outputs are preserved; the generic failure-image overwrite is disclosed in the driver notes. Reviewer helper corrections are documented in [driver-notes.md](pr3-planner-review-r2-evidence/driver-notes.md): a narrow heading lookup, footer contamination in source comparison, counting a clipped catalog, and a missing helper name inherited from the previous slice. Completed continuation scripts and final logs supply the actual proof; early helper failures are not presented as product failures or silently replaced with green logs.

## Independent commands and provenance

Both exact frozen commands were run from the reviewed worktree:

```sh
deno task test packages/cli/tests/repl-history.test.ts packages/cli/tests/repl-model.test.ts packages/cli/tests/repl-execution.test.ts packages/cli/tests/repl-entries.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-composition.test.ts packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-journey.test.ts
deno task test packages/cli/tests/repl-source-reading.test.ts packages/cli/tests/repl-forms.test.ts packages/cli/tests/repl-agent-journey.test.ts
git diff --check
git diff --cached --check
```

Results: **99 passed / 312 steps**, **19 passed / 111 steps**, no failures; both whitespace gates exit 0. No full-suite, dependency mutation, CI, push or PR work was performed.

All **558 supplied checksum entries** match. All ten hashes in revision-provenance.json match both committed blobs at 3fa241dc and the working files. The independent copy of the gallery audit reports 77 checked, 0 failed, 76 bands and 70 marked rails.

The captures preceded creation of the commit object. Their documented source-equivalence claim is accepted for this review together with verified current committed-file identity and the independent post-commit live checks. The hash list was written afterward and is not a contemporaneous capture-start fingerprint; this review does not pretend otherwise. A rerun solely to change capture timestamps is not requested.

## Next Implementor action

Correct the R4 evidence helper/claim and R5's newly committed code-rule violations, then return a stable feedback revision with the existing focused commands, five controls and honest packet provenance. Keep the original parity scope, 77-scene/profile pairs and architecture unchanged. Retain the current gallery as reviewed evidence for 3fa241dc; do not silently relabel inherited captures as a later capture run. The before-commit timing caveat alone does not require another journey.

For this bounded repair, the Planner permits reuse of the 77 visually reviewed pairs at their actual 3fa241dc provenance if changes remain confined to memo typing, capture/probe fixtures, the grouping-evidence helper and explanatory text, without changing rendered behavior. Run the corrected grouped-selection journey against the new feedback commit and retain its actual rail/content captures. Do not recapture all 77 merely to replace a revision label. A change to rendered behavior instead needs its affected visual evidence refreshed. This is an explicit evidence-sufficiency ruling; it adds no gallery scene or mutation control.

The Planner owns the next re-review and verdict. No delivery authorization is issued. Accepted predecessors remain PR 1 at 080b6ec80ca74e614789e8d2252857ac281df7e5 and PR 2 at acadbbdb4fa7d8c8c86fa85f6657d29c5d95bc3e.

Review evidence: 853 checksummed files in [pr3-planner-review-r2-evidence/sha256sums.txt](pr3-planner-review-r2-evidence/sha256sums.txt).
