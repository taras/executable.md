# PR 1 handoff: original colours, panes and drawers

**Ready for implementation.** This is the approved first slice of
[Story #881](https://github.com/taras/executable.md/issues/881). XMD and JSON
keep their original token colours when focused. Panes have distinct surfaces;
an open drawer has an opaque, bounded surface with a readable title, content,
fields and actions. This document freezes PR 1's examples and evidence. The
full-story proposal and comparison matrix do not add acceptance criteria here.

The Product Owner approves this slice and the private token-run approach in the
current planning session. Local types, helper names and lexical implementation
remain Implementor decisions under the existing architecture rules. PR 1 has
no pending architecture decision.

## Base and authority

Start from main **`e68f128121cd802623ab7797a016b0c66ce91176`**, resolved again on
2026-10-08. Captured production is
`2d719f78025059158a35023701fdff52b855a65b`; the only intervening change is
#879's history terminology in architecture.md. Production bytes are unchanged.
Reuse merged #876 measured layout, #877 reveal retention and #878 row styling.
There is no required unmerged stack. The read-only base and overlap checks are
recorded in [evidence/pr1-base-state.json](evidence/pr1-base-state.json). At this check, #805 at
`7cc1752d6ae3a90c234b768842cfb714d874e093` and the older #779 POC at
`11720a1301acc846f7d6c3767f117f407ec1f81e` change no private REPL files owned by
this slice; neither is a dependency. Refresh main and overlapping file changes
before editing. A changed base is recorded, not silently substituted.

The visual authority is the original
[corrected Terminal Interface archive](https://github.com/user-attachments/files/32939115/XMD.REPL.Terminal.Interface.corrected.zip),
SHA-256 `86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`.
The verified bytes are [evidence/reference.zip](evidence/reference.zip).
`xmd-repl-timetravel.jsx` supplies `S`, `C`, `Y`, `xmdSpans` and `jsonSpans`;
`xmd-repl-agent-sessions.jsx` supplies `Shell`, the question drawers and
`PermissionDrawer`. The [source extract](evidence/reference-style-extract.txt)
preserves the literal palette. The archive supplies appearance; existing
architecture and REPL/XMD specifications supply execution and interaction.

Read repository AGENTS.md, Effection's required AGENTS.md,
[Implementor instructions](../../.agents/implementor.md), architecture.md and
the affected REPL and executable-MDX contracts before implementation. Relevant
installed versions are Effection 4.1.0, context-api 0.6.0, tty 0.9.0 and core
0.13.1. Freedom is the patched vendor snapshot of
`8be97e7201cd6effddb2f8b240b4b5166641e7f0`. No dependency or vendor change is
needed. Run `deno task setup` only to prepare a new worktree; builds install
nothing and verification does not mutate dependency state.

## Slice boundary

Style the existing source rows, visible draft text, question source previews,
JSON bindings and their inspectors. Coordinate the existing Sessions,
Transcript, Bindings, draft and contextual drawer surfaces. Group existing
question and permission content by its present roles. Preserve every existing
word, choice, value, validation message and action.

Lifecycle observation, invocation APIs, component rails/badges, generated-source
replacement or ownership, transcript restructuring, new long-source presentation
policy and History are later slices. Do not edit their models, controls,
captions or geometry in PR 1. Existing successful, failed and waiting entry or
Agent cues retain their current meaning; a styling change adds no state.
Source already shown in a drawer may receive token colours without settling
how generated source appears in the later transcript.

Keep the existing profiles, column constraints, integer drawer rectangle and
seven-row footer. At 72×20 only the current routed outlet and contextual drawer
are mounted. Keep explicit activation, Tab/Backtab/Enter/Escape, pointer
equivalence, modal containment, window controls, process-local offsets, the
single-row draft and absent location when no execution exists. No automatic
drawer, new shortcut, editor, route, public syntax or permission behavior is
introduced. Permission dismissal still denies; closing an Answer drawer still
does not answer it.

## Frozen colours and emphasis

These literal values are the independent expectations. Tests must not obtain
expected colours from production palette or style functions.

| Visible role | RGB hex | Concrete example |
| --- | --- | --- |
| XMD delimiter | `#4e8b9c` | `<`, `</`, `>`, `/>` |
| Tag name | `#7fd3e8` | `Elicit`, `Plan` |
| Attribute name / JSON key | `#8fa7b8` | `as`, `schema`, `"name"` |
| Quoted XMD value, including quotes | `#d6b477` | `"answers"` |
| Reference braces / JSON boolean | `#9b8ed0` | `{`, `}`, `true`, `false` |
| Reference content | `#b7aee0` | `schema`, `answers` inside braces |
| JSON number | `#d69a6a` | `3`, `-12.5` |
| Ordinary source / whitespace | `#c8d2d9` | `Enter the project details.` |
| Source heading | `#c7c4e6` | `# Create a project README`, bold |
| Punctuation | `#7c868d` | attribute `=`, JSON `{ } [ ] , :` |
| JSON string, including quotes | `#9ec49a` | `"Northstar"` |
| JSON null | `#8b959c` | `null` |
| Rendered output / entered value | `#e6ecf1` | README result, populated text field |
| Pane heading / ordinary drawer title / action | `#cfe0ea` | `Bindings`, `Binding · tokens`, `[close]` |
| Question or permission drawer title | `#c99a3f` | existing `Answer` or form title, `Permission · …` |
| Field label | `#8b959c` | `*Project name:` |
| Hint / metadata | `#7b858d` | `Name your project.` |
| Existing success / failure or validation / waiting accent | `#5aa87c` / `#c2766e` / `#c99a3f` | existing outcome and validation words |
| Focus marker | `#7fd3e8` | existing `>` |

Headings and drawer titles use terminal bold. Focus adds the existing marker
and bold emphasis while each token and semantic foreground keeps its colour.
Selection remains the existing `*` cue and full measured row background
`#122026`, independently of keyboard focus. These selection and focus mechanics
are retained terminal adaptations. Do not import the reference's new focus
badge, variable font sizes or animation timing.

| Surface | RGB hex | Boundary |
| --- | --- | --- |
| Application | `#0b0d0f` | uncovered application area |
| Sessions/catalog | `#090b0c` | its admitted pane |
| Transcript/routed centre | `#0c0e11` | its admitted pane |
| Bindings | `#0a0c0e` | its admitted pane |
| Draft | `#0a0d0f` | existing single-row draft |
| Drawer | `#0e1316` | entire admitted rectangle, including unused cells |
| Editable value | `#090c0e` | its measured value row |
| Pane/input separators | `#161c21` | existing pane/input boundaries |
| Contextual drawer top edge | `#c99a3f` | one terminal-cell rule inside its admitted rectangle |

Do not restyle the History band. The reference's pixel padding becomes a
one-cell horizontal inset for drawer title/content, with the top rule separating
the drawer from the background reading. Titles do not join cut-off background
labels. All decoration belongs to the measured rectangle, and consumes measured
capacity before admission. Field value surfaces and the drawer remain opaque
after focus changes, shorter values, scrolling, closing and resize.

## Frozen surface examples

**Source.** In an existing draft or read-only source row, preserve exactly:

```md
# Create a project README
<Elicit as="answers" schema={schema}>Enter the project details.</Elicit>
<Plan as="draft">{answers}</Plan>
```

The table assigns separate colours to delimiters, names, attributes, `=`,
quoted values, braces and reference content. Ordinary prose remains source
coloured. These are presentation examples using existing grammar, not a new
executable program or an adoption of the reference's JavaScript conditions.
An unfinished draft such as `<Elicit as="ans` remains editable and preserves
all characters. Unclassified spans use ordinary source styling. Highlighting
does not validate, evaluate, reject or rewrite input.

**JSON.** The existing `tokens` binding inspector shows its complete parsed
value with the key/string/number/boolean/null/punctuation roles above:

```json
{
  "name": "Northstar",
  "count": 3,
  "approved": true,
  "empty": null
}
```

Escaped quotes and backslashes remain intact. Classify JSON from an already
parsed value or an explicitly known JSON presentation, not by guessing that
arbitrary provider/output prose is JSON. The binding's name, selection and
inspector behavior stay unchanged. Moving focus does not turn this value cyan.

**Project question.** Within the existing Answer drawer, read the existing
message, then each field's label, hint and editable value as one group, then
validation and `[submit]`. `*Project name:`, `Name your project.`, and
`Northstar` remain distinguishable label, hint and value. The second group
contains `*One-sentence description:`, `Describe its purpose.` and
`A lightweight workspace for coordinating coding agents.`. Empty submission
keeps the form open and shows its existing actionable validation text in the
failure accent. Required markers and input prefixes remain visible without
colour. Do not invent a disabled-submit policy or change form validation.

**Plan/README preview.** The existing Answer drawer keeps its read-only message
and source preview before its existing decision choices and `[submit]`.
Source syntax receives token colours; the README message retains readable
heading/prose emphasis. Existing earlier/later controls reach preview and
decisions. This slice does not introduce a generated-source replacement view,
new preview captions, a split editor or a different wrapping policy.

**Permission.** Sessions retains its current pending request hierarchy. Explicit
activation opens the existing Permission drawer. Its title, tool/kind details,
provider option labels, duration and denial/dismissal controls remain distinct
inside the opaque surface. Gold reflects the already pending request, not a
new lifecycle observer. Keep provider labels and existing permission semantics.

## Implementation ownership and sequence

Production ownership is private to `packages/cli/src/repl/`:

1. Map the frozen roles and surfaces in `presentation-style.ts`. Add immutable
   plain token runs in `description.ts` and concrete application descriptions
   in `application.ts`. A private `presentation-text.ts` helper is permitted
   for the source/JSON consumers. Its exact names and types are local decisions.
2. Emit multiple engine text operations inside each existing keyed element in
   `layout.ts`. Runs concatenate to the same displayed text. Reuse one builder
   for measuring and committing. The installed same-element
   [TTY probe](evidence/tty-probe.jsonl) establishes this capability.
3. Apply pane and drawer surfaces, edge, inset and grouping through that same
   measured layout. Decoration reduces the content capacity used by the existing
   windows. Reuse node keys, modal branch and semantic actions. `reconcile.ts`
   changes only if threading immutable view data requires it.
4. Extend the focused evidence below and document the delivered presentation
   contract in `specs/repl-spec.md` and architecture.md's private REPL section.
   Describe only this implemented slice in the present tense.

Immutable data crosses direct parent-child boundaries; typed actions return
through mounted ancestry. The root owns selection/routes/drafts, Freedom owns
focus and node lifetimes, and the renderer remains model-blind. No ANSI escapes
enter view data, no node is created per token, and no second coordinate calculator
or renderer is added. Keep Measure → admit → reconcile → draw and validate the
desired set before mutation. Absent content supplies no node, cell or target.

No Core, Journal, persistence, session observation, provider adapter or runtime
entrypoint change is part of PR 1. Failure, cancellation and teardown behavior
remain the existing operations' behavior. Presentation resources remain bound
to their existing owners; no extra reader, listener or clock is needed.

## Frozen focused evidence

Extend the existing `repl-presentation-style.test.ts` using the real engine
pair, mounted tree, committed frame rectangles and terminal grid in
`tests/fixtures/repl/presentation.ts`. A reference-style fixture may contain
the independent literal expectations and archive provenance. Do not derive
expected values from production role helpers.

| ID | Required evidence | Defect it distinguishes |
| --- | --- | --- |
| P1-T1 | Commit the representative XMD and JSON examples. Assert named characters, literal RGB and heading weight in their actual rectangles. Include one escaped string and unfinished draft; concatenated runs preserve the input exactly. | One colour applied to a whole code row; dropped or rewritten draft characters; expected values imported from production. |
| P1-T2 | Focus a token-bearing draft/control and move focus away from a selected entry. Assert retained token/semantic colours, cyan `>` and bold focus, `*` and `#122026` across the selected row's measured width. | Focus flattening all foregrounds; selection following focus or covering only the label. |
| P1-T3 | Commit empty panes, populated/invalid question, JSON inspector and permission drawer. Assert literal surfaces/edge, title inside its rectangle, label/hint/value/validation roles, and opaque unused drawer cells. Commit shorter content and close the drawer; inspect vacated cells. | A title spliced into background text; background leaking through an overlay; fields visually undifferentiated; stale pixels. |
| P1-T4 | Run the existing layout-admission and forms regressions, preserving their behavioral assertions. Add assertions only where drawer decoration changes capacity. Check supported profiles, measured window reachability, fixed footer, whole controls, and absent narrow outlets/targets. UI16/UI17 may advance the existing content window as specified below. | Padding painted after admission; hidden or unreachable submit/choices; duplicate narrow panes or altered validation/input. |

The measured top rule consumes one content row; the side insets consume two
columns. At 72×20, UI16's submit control and UI17's validation row therefore
require one `[v later]` action. Keep both tests at 72×20 and reach those rows
through the existing window action and measured admission, rather than assigning
an offset directly. Recompute UI16's placed controls, modal ring and guidance
from that advanced window, retaining every forward/reverse traversal,
containment and action assertion. UI17 still verifies the field explanation and
unchanged lifecycle guidance in the same frame. Rows outside the first window
remain absent from its drawing, pointer targets and Tab ring. This adjustment
changes fixture positioning; it drops no behavioral claim and adds no product
interaction.

Run exactly this focused positive command, plus the control reruns and whitespace
check below. Additional checks are required only by an actual failure or changed
boundary, not a newly imagined permutation.

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-layout-admission.test.ts packages/cli/tests/repl-forms.test.ts
git diff --check
```

Run three isolated break controls in the implementation's own worktree:
collapse token roles to ordinary source (P1-T1 fails); restore whole-row cyan
focus (P1-T2 fails); remove the opaque drawer surface (P1-T3 fails at a named
unused/background cell). Save each patch and the first failing output. Restore
production bytes exactly between controls, then rerun the positive command.
Do not mutate dependencies or add a permanent switch for these controls.

Once these focused checks pass, create the stable feedback commit promptly and
report its exact SHA, parent, commands and results. Capture the gallery from that
commit, with no production edits. Do not delay the feedback commit for the full
suite, lint/typecheck battery or CI. A passing baseline test is not evidence
that the new slice passes. Preserve the first failure before rerunning; follow
the repository flake procedure if an unchanged revision passes on retry.

## Frozen PR 1 visual evidence

Use an isolated PTY and the real CLI/input/TTY path. The
[capture runbook](capture-runbook.md), [local provider](fixture-agent.py),
[Plan entry](plan-entry.md), [generated fixture](generated-readme.md) and
[JSON entry](json-entry.md) provide the reproducible production journey. Copy
the harness into a fresh evidence directory; update its private socket, working
directory and entrypoint paths for the implementation worktree. Preserve the
baseline packet. No external provider request is needed.

Capture **these 11 states at 160×36, 120×30 and 72×20: 33 pairs**. The existing
same-named files in `captures/` and `pairs/` are the pre-change examples.

| States | Surface comparison frozen for PR 1 |
| --- | --- |
| `empty`, `draft` | Original Agent Sessions `Shell` and source `Code`: pane/input surfaces, headings, persistent draft and token roles. |
| `plan-review`, `plan-review-controls` | Original Plan-review drawer: opaque bound, separate title, source colours, reachable existing choices and submit. |
| `binding-drawer` | Original Time Travel `jsonSpans`/`Code` and bindings palette: JSON roles and inspector surface only. No History or source-rail comparison. |
| `invalid-details`, `completed-details` | Original project-form drawer: label/hint/value/validation hierarchy and focused populated field. |
| `readme-preview` | Original confirmation drawer: readable existing preview, decisions and surface separation only. |
| `permission-wait`, `permission-drawer` | Original Sessions/Permission drawer: existing pending-request hierarchy, explicit opening, grouped provider details and controls. |
| `cold-settled` | Original settled pane colours; retained content keeps the same styling after a read-only reopen. No new historical presentation. |

Also capture **two resize endpoints**: with the populated question drawer open,
resize to 60×15 and capture the existing refusal; restore 160×36 and capture the
same admitted drawer and values. Total: **35 pairs**. Preserve originals, ANSI,
dimensions, input actions, fixture traffic and a SHA-pinned manifest. Check cold
reopen leaves its Journal and provider log byte-identical.

The archive source elements named above freeze the PR 1 comparisons; the inherited
reference PNGs are supporting illustrations with their recorded provenance, not
an executable oracle. Their full-story timestamps and History/generated-source
mapping remain provisional. Keep the whole production screen for geometry
evidence, but assess only the PR 1 surfaces/roles. Browser pixel sizes and
animation times are not terminal targets.

The Implementor opens all 35 pairs and records whether the frozen relationships
hold. Planner feedback reviews the exact commit, focused tests/controls and
these pairs. Lifecycle, generated-source structure and History gaps in those
screens do not fail this slice. A real unmet criterion returns for correction;
an unrelated observation does not silently enlarge the matrix.

## Feedback, delivery and continuity

Hand back the exact commit SHA/parent, changed files, all focused commands and
results, independent colour fixture provenance, restored control evidence and
the 35-pair gallery/runbook/manifest. Explain any criterion the evidence cannot
prove. Stop before push or PR creation unless separately authorized. PR 1 does
not close #881.

Feedback acceptance is distinct from merge readiness. Required CI and `green`
own the exhaustive runtime shards, lint, typechecks, JSR and site checks before
merge. A private presentation change does not require repeating whole runtime
suites locally. Dependency/build mutation and test-discovery rules apply if
scope actually changes; neither is part of this slice. Do not inspect CI for a
Planner feedback verdict.

Exact base: `e68f128121cd802623ab7797a016b0c66ce91176`. Artifact:
`.reviewer/issue-881/pr1-handoff.md`, with its frozen 35-pair evidence subset in
`pr1-gallery-manifest.json`. Settled: original colours and surfaces, retained
interaction/layout ownership, private same-element token runs, local types and
helpers delegated. **PR 1 blockers: none.** Next Implementor action: prepare an
isolated branch/worktree on the resolved base and implement this slice.

Before PR 2, the Architect supplies the exact complete-invocation observation
API, phases/outcomes and installation/attribution contract. Before PRs 2 and 3,
the Architect and Product Owner finalize generated-source/History presentation
and the final reference scene mapping; the Planner then freezes their separate
handoffs. Session-owned middleware observations, completion after teardown and
separation from retained inspection are settled. No persistence change or
renewed Journal decision is needed.
