# Frozen PR 2 and assembled #881 galleries

PR 2 supplies **44 pairs**: fourteen states at three profiles and two resize
endpoints. PR 3 supplies **77 fresh assembled pairs**: twenty-five states at
three profiles and two endpoints. These are separate slice and complete-story
comparisons, not the provisional 71-pair baseline or PR 1's accepted 35 pairs.
The machine-readable list is final-gallery-plan.json. No capture is claimed
to exist yet and no implementation SHA is invented.

## Reference authority and final mapping

Use only evidence/reference.zip, SHA-256
86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b.
The exact original sources own the named visual relationships below. Images
under references/ are unchanged inherited illustrations; their provenance is
recorded in capture-runbook.md and evidence/inherited-reference-runbook.md.
They are not new browser captures, terminal pixel targets or a substitute for
literal source expectations. The scene mapping below is final for this plan:
state intent replaces provisional animation timestamps.

| Reference key | Archive source and recognizable scene | Supporting PNG |
| --- | --- | --- |
| R1 | xmd-repl-agent-sessions.jsx Shell, S/C/Y and Code: empty panes/input, coordinated surfaces and draft | reference-empty-wide.png; narrow uses reference-empty-narrow.png |
| R2 | xmd-repl-timetravel.jsx LifeLines and L, root document at lines 745–793: nested Plan, inline transition preserving Evaluate, lifecycle glyph/word and distinct output | reference-history-wide.png |
| R3 | xmd-repl-agent-sessions.jsx j1View/Shell and Code: Plan review, project question, confirmation preview, field/hint/value/validation hierarchy | reference-question-wide.png; narrow uses reference-question-narrow.png |
| R4 | xmd-repl-timetravel.jsx root settled reading/L/Code: completed rendered document before execution source, bindings jsonSpans and failure vocabulary | reference-settled-wide.png; binding reading uses reference-history-wide.png |
| R5 | xmd-repl-agent-sessions.jsx PermissionDrawer, MessageRow and j2View: waiting turn and explicitly activated permission choices/duration | reference-question-wide.png; narrow uses reference-question-narrow.png |
| R6 | xmd-journal-scrubber.jsx Scrubber/S/C and xmd-repl-timetravel.jsx Band/JournalPanel: horizontal rail, major/minor hierarchy, later dimming, distinct head/selection and exact navigation | reference-history-wide.png |

Medium uses the wide study. R2/R4/R6 are wide studies at all profiles; the whole
narrow terminal route is compared against their relationship, not a manufactured
narrow mockup. Empty and drawer scenes have their existing narrow counterparts.
Settled/failed/cleanup references supply state/structure intent; actual diagnostic
and output text comes from the real run, not an animation's fictional receipt.

All six supporting PNGs have freshly verified SHA-256:

| PNG basename | SHA-256 |
| --- | --- |
| reference-empty-wide | 3db0c270a6371e214aadac711caeafbfa1be7031f88ada4da32bed78f69456af |
| reference-empty-narrow | 7ccd22d5b4f8def9f5f9aa7a7eae9be8b2f5194792b9633c792add15838d1532 |
| reference-question-wide | 28af525ab68ba2ade907282d65c4cb5ba44aafc01efba1f075a8a9ba20a4bfe2 |
| reference-question-narrow | 807c284826dc162deed125823cdc9acc6fe5f909447347757b91ef3c4f781ca2 |
| reference-settled-wide | edb3929cb7abb7151047a419986e158c85ee79b1de37ea0574c5703643d51978 |
| reference-history-wide | 47e97966b5f8118a2acf96b8952733434375b68348ad8d4bbc89f7d3728f7706 |

## Exact scenes

Every numbered scene is captured at 160×36, 120×30 and 72×20. Narrow uses the
listed current route. Wide/medium retain all admitted panes. Pause/cleanup
scenes use the controlled host with production assembly; other scenes use the
ordinary CLI and local provider. Each capture records its actual command.
Ordinary execution states are reached by normalized input and real operations,
not presentation injection. PR 2 assesses its frozen slice; PR 3 assesses the
assembled screen, including retained PR 1 roles and the new History band.

| ID | Narrow route; capture trigger and finite claim | Reference | PR 2 | PR 3 |
| --- | --- | --- | --- | --- |
| empty | entries; fresh view: surfaces/input, empty History without invented mark | R1/R6 | — | yes |
| draft | entries; paste original Plan entry without submit: token roles, single-row persistent draft | R1 | — | yes |
| nested-running | entries; hold the Plan provider after work starts: Evaluate/Plan rails and ACTIVE, no settlement at resolution | R2 | yes | yes |
| plan-review | entries; explicitly open actual Plan Answer: WAITING survives closing/reopening; original producer and preview roles | R3/R2 | yes | yes |
| plan-review-controls | entries; reach its final decision controls using ↓ later: last preview row and complete actionable controls | R3 | yes | yes |
| generated-inline | entries; approve Plan and open Source's admission window: exact generated heading/Elicit inside unchanged Evaluate enclosure | R2 | yes | yes |
| invalid-details | entries; submit empty project fields: real validation and continuing WAITING | R3 | yes | yes |
| completed-details | entries; Northstar/description populated, drawer open: labels/value/focus preserve roles | R3 | yes | yes |
| readme-preview-tail | entries; actual confirmation drawer, scroll through last preview/decision rows: wrapping and tail access | R3 | yes | yes |
| settled-output-first | entries; approve write, wait for full unwind, select entry's first reading window: actual Output starts before Source | R4 | yes | yes |
| settled-output-last | entries; reach rendered `README.md was created.`: actual report, complete tail, no invented or duplicated result | R4 | yes | yes |
| settled-source | entries; reach admitted source after Output: enclosure/rails, colours, separate known source owner | R2/R4 | yes | yes |
| binding-drawer | entries; submit json-entry, select/activate its binding, move focus away: JSON roles and independent selection | R4 | — | yes |
| permission-wait | sessions; actual provider request arrives with drawer closed: truthful waiting announcement, explicit activation | R5 | — | yes |
| permission-drawer | sessions; activate request, retain nonempty draft: opaque bounded drawer, options/duration and real authority | R5 | — | yes |
| failed | entries; separately submit fail-entry: actual failed diagnostic and glyph/word, retained output ownership | R4 | yes | yes |
| pausing-head | entries; crowd/background fixture started, Pause requested before all holds establish: actual PAUSING EXPANSION | R6 | — | yes |
| historical-before-admission | entries; inspect Entry 1 before admission while session advances: producer only, no future output/bindings/live badges | R2/R6 | yes | — |
| paused-historical | entries; real expansion held, select Entry 1 before admission: prefix-only panes, full dimmed later rail, History action row | R6 | — | yes |
| offscreen-advance | entries; request Pause against active provider work, inspect during PAUSING, then release it: retained/navigation growth, same exact selection/prefix, actual PAUSED head | R6 | — | yes |
| grouped-history | entries; open full History after crowd fixture: heavier collision/entry marks, measured caption range, separate exact drawer rows selected in turn | R6 | — | yes |
| shared-head-selection | entries; inspect last offered checkpoint: ◆ above and ▼ below same column, independent captions/colours | R6 | — | yes |
| settling-head | entries; root outcome retained while installation teardown held: SETTLING, neutral head, unavailable next submission; release changes head without input | R6/R4 | — | yes |
| returned-live | entries; close History, return live/Continue actual hold: latest retained source/output and current live view; selected draft unchanged | R2/R6 | yes | yes |
| cold-settled | entries; settled read-only reopen head: retained source/output/style, no live badges or provider/source load | R4/R6 | yes | yes |
| cold-historical | entries; same cold session selects pre-admission marker: original producer, retained draft, full thin navigation, no later payload or live badges | R2/R6 | — | yes |

Companion focused tests cover self-closing Evaluate, decline/unselected branches,
independent waits/readers, ENTER/EXIT/clean cancellation, empty output, static
scanner refusal, empty/singleton/unfinished and retained failure/cancellation
heads. They are not another gallery or an invitation to expand the state grid.

PR 2's two extra pairs are `question-resize-refused-60x15` and
`question-resize-recovered-160x36`: take both with the Northstar/description
question still open, visiting 160×36→120×30→72×20→60×15→160×36. The restored
frame must still show that Answer and its values, not a later permission drawer.
Compare R3, with the existing explicit undersized refusal adaptation.

PR 3's two extra pairs are `history-resize-refused-60x15` and
`history-resize-recovered-160x36`: an exact crowded historical marker selected,
History open and draft `<Json value="next" />` retained. Visit the same sizes;
restore the same marker, route and admitted focus under existing window rules.
Compare R6. Supported intermediate geometry and target agreement are also
asserted in H5, rather than adding more pairs.

## Approved terminal adaptations

These are the complete consequential adaptations for comparison:

1. Fixed cells, terminal font/weight and actual 160/120/72-column profiles replace
   browser pixels/variable font sizes. The footer remains action + five History
   + single-row draft, with drawer above. Narrow mounts only its routed surface.
2. PR 1's gold drawer top rule and one-cell inset consume one row/two columns;
   existing decisions/validation stay reachable through windows. Focus adds
   weight plus its cyan cue; selected surface remains independent.
3. Source/output wrap and vertical windows replace pixel-sized browser text
   regions. Source character/role tails remain reachable. Full state words use
   one stable measured right column; rails remain at left. Glyphs/labels are
   actual phases, not frame-duration animations.
4. Generated fixture uses supported declarative Switch/File XMD; paired Evaluate
   retains its enclosure and replaces inner content, self-closing attaches a
   child. Real rendered output stays separate and comes first at entry level.
5. Arrow labels are ↑/↓ with existing activation semantics. Drawers still require
   explicit opening. No mock scrubbing or arrow shortcut is introduced.
6. History uses recorded ordinals instead of elapsed/compressed-wait clocks;
   tall/short glyphs replace pixel notches. Consecutive collisions group visually,
   captions merge actual entry ranges, exact drawer actions remain separate.
   Accepted truthful head words and neutral settled colour replace mock success/
   completed claims. Amber selection above and head below preserve both at one
   column. Category-only drawer wording protects the navigation exception.
7. Cold/prefix views show retained facts with no ephemeral lifecycle reconstruction
   or future content. This intentionally differs from an animation that simply
   freezes all its live state. Returning live reads actual current work.

Other visible differences must be classified against a named frozen claim;
do not approve new adaptations silently. Browser timings, a fictional receipt,
elapsed times and extra features are not requirements.

## Capture, audit and review

Use separate pr2-evidence/ and pr3-evidence/ directories. Preserve original
`tmux capture-pane -p -e -N` ANSI, plain text, terminal PNG and paired PNG, actual
dimensions, normalized input/actions, local provider log, relevant retained
Journal copy and before/after SHA-256. Keep fixture commands/version, feedback
SHA and clean-tree proof, archive/source/image hashes, route/marker, runtime,
tmux/font/theme/cell-renderer settings and reference key per pair in the manifest.
Use private temporary sockets/history working directories; stop only the
harness's own server and never touch another invocation's temporary state.

The merged terminal bench can collect ordinary CLI originals; when automating,
keep its single-run pointer isolated to the implementation worktree. The existing
capture/render harness can drive the multi-scene journey and controlled host.
Record adaptations to its input matching after `entries` and Unicode labels.
No screenshot or baseline terminal frame substitutes for a fresh final capture.

For each scene assert its named claim in committed cells plus the common
relationships: full footer/drawer bounds, no pane overflow, correct admitted
route, focus/selection cues preserving token semantics, and complete controls.
PR 2 additionally samples independent L/source roles and reserved status bounds;
PR 3 additionally samples independent rail/entry/minor/selection/head colours and
exact ordinal labels. The scene table and C/L/S/H test tables freeze claims;
cell coordinates come from the actual engine bounds, not hand-positioned guesses.
Keep expected characters/colours independent of production role maps. An audit
reports each named claim, not only a total, and demonstrates failures against the
unchanged pre-change baseline. Break controls are frozen in each slice's handoff.

Open every pair at readable resolution, using indexed contact sheets only when
the full cells/text remain legible. Record each pair as matching, approved
adaptation (name it) or unmet criterion (name it), plus the reviewer's actual
inspection. Do not infer review from filenames or a green audit count.
Cold-open both settled head and earlier prefix: identical Journal/provider bytes
and zero component-source loads, not merely a visually similar screen.

The feedback handback includes these local artifacts. #881's eventual delivery
links a publicly accessible gallery and originals from its authorized PR; local
links alone do not satisfy that separate publication requirement. This planning
turn creates no PR or public upload and claims no final parity verdict.
