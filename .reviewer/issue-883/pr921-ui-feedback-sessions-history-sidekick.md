# Make REPL navigation compact and Sidekick chat useful

The Product Owner reports unreadable conversation filters, redundant entry
navigation, technical entry labels, and empty Sidekick reply notices. They also
report that the Sidekick pane does not match the mockup. This record preserves
that feedback and the inspected evidence for a bounded UX assignment.

Inspected production source: PR2 HEAD
`27da762b7078ee8e32b1dbaf90941c4a8a90eaa7`, with the existing uncommitted
padding/color/width changes preserved. Those changes have their own released
continuation and owner. This turn changes review records only; it neither
implements these requests nor adds them silently to that continuation.

## The supplied location

The pasted location has this structure; its private draft is omitted here:

```text
xmd://repl/204bb2d1735dbceaa20efaa5f5d8d77a/sessions/entry-19
  ?draft=<encoded unsent program>
  &right=sidekick
```

It is coherent and has no duplicate path or query members:

- The opaque execution identifier selects the saved REPL session.
- `sessions` selects the Sessions surface.
- `entry-19` preserves the selected entry independently of that surface.
- `draft` carries the unsent Lio correction program. It belongs to the shared
  next-entry draft, even while Entry 19 is selected.
- `right=sidekick` selects the right pane. Sidekick is already the default, so
  this member is redundant for the effective pane selection.
- There is no `session=` conversation filter, `sidekick=` saved-chat selector,
  frozen `at=`, `inspect`, or stacked History drawer. The current chat is followed.

The URL's length is principally the encoded draft, not duplicated navigation.
Removing the draft loses unsent editor state and is not an equivalent location.
Removing `right=sidekick` preserves the effective pane choice. The current
encoder retains explicitly supplied query members for round-trip compatibility,
but the Product Owner explicitly waives existing-link compatibility for this UX
work: “existing links don't matter.” New locations may omit redundant defaults
and use simpler entry selectors without preserving old spellings or aliases.
Draft preservation remains necessary for a location that carries editor state.

## Requests and proposed presentation

### Conversation filters

Current `sessionRows()` puts `All conversations` followed by one permanently
visible row per provider key above the actual turns. Each choice is
`headline(key)`, so common prefixes dominate the sidebar and the distinguishing
suffix is truncated. Widening the sidebar does not make those identities useful
conversation titles.

Recommended presentation: one compact filter control in Sessions, such as
`[All conversations v]`. Open its choices on demand. Show the opening readable
request and agent, rather than opaque IDs, as the primary labels. For Sidekick,
use the first saved person's message; never label it from bootstrap text or
automatic feedback. Keep full keys for filtering and identity. Derive labels
from existing saved facts without a model call or a journal change.

This replaces the earlier Task C proposal's always-visible filter list. The
existing duplicate/missing-title fallback work belongs to that bounded
follow-up; do not present it as a prerequisite for the active padding slice.

### Entry labels

The Product Owner's requested direction is numeric display in an entry context:
`19`, rather than using `entry-19` as a title. When a sentence needs context,
`Entry 19` is readable. Existing-link compatibility is explicitly not a constraint,
so the URL design may also use `/sessions/19` rather than retaining
`/sessions/entry-19`. No old-link alias is required.

This waiver concerns links, not discarding saved REPL sessions or changing which
entry a retained submission identifies. Internal identity representation stays
an implementation concern; numeric public selectors can map to existing records
without rewriting their identity or repeating work.

The current catalog prints both `entry.order` and `entry.scope.name`, while the
model sets that name to `segment.key`. This produces redundant numbering with
no identifying content.

### Entry navigation

The Product Owner requests using the bottom History to select entries, rather
than keeping a second permanently visible entry list. Treat the History entry
marks as actual entry-selection controls, with keyboard equivalents. Preserve
the existing semantic entry-selection behavior and separate exact-checkpoint
inspection; selecting an entry must never execute it or submit the draft.

The current History band renders text and style only. Its marks have no mounted
control actions. Checkpoints are currently selected through the separate History
drawer. Merely removing the entry catalog would therefore remove usable
navigation; interactive History must arrive with that removal. Crowded marks
must keep every entry reachable through a chooser, without merging identities.

An optional entry list should be an on-demand dialog that helps distinguish
programs through their saved source and outcomes, rather than repeating identical
entry names. This is an optional design direction, not a release to build a
diff engine or generated entry summaries. Its detailed contents and any richer
full-history comparison beyond the existing thin navigation view need their own
bounded design. Preserve nested-scope and precise-checkpoint access when
removing the catalog.

### Empty Sidekick replies

Remove the visible `agent answered without saying anything` placeholder for a
successful control-only response. The Product Owner explicitly rejects it.
`application.ts` currently emits this row whenever a reply lacks `hasOutput`.
It consumes space for work that was never a user-facing utterance.

Keep the underlying turn, response, controls, and feedback records. Keep real
failures, interrupted work, pending questions, and actionable state visible;
do not filter a failed response merely because it has no Output. Selecting a
control-only turn from Sessions must reveal useful associated work or its
containing request, without manufacturing an empty chat message as an anchor.

If useful activity is shown, describe what actually happened, such as `Read
bindings`, `Updated draft`, or `Entry 19 completed`, from the corresponding
recorded operation. This is activity presentation, not a fallback publication
of raw return values or automatic feedback as chat.

## Mockup comparison

The accepted visual reference is
[repl-sidekick-clear-columns.html](reference/repl-sidekick-clear-columns.html),
with the [captured reference](reference/sidekick-clear-columns.png) and
[terminal adaptation](reference/README.md). The local Downloads export is the
same-size original source recorded in that provenance packet; use the accepted
refinement and later width/spacing amendments for comparison.

The current renderer follows parts of the column geometry, tabs, colors, and
composer constraints. Its conversation hierarchy remains materially different:

| Mockup | Current chat rendering |
| --- | --- |
| Distinct person/Sidekick role headings and grouped response body | Flat `you:` / agent-prefixed text rows |
| Compact operation activity associated with a response | Control-only responses become no-Output notices; no corresponding operation hierarchy |
| Visible reply text only when the response actually says something | An extra placeholder is inserted for each successful no-Output response |
| Clear spacing and response grouping | Wrapping/padding improvements do not establish that grouping |

The mockup also includes scripted countdowns, inline questions, and raw-source/
returned-feedback expanders. Those were explicitly excluded as automatic
production requirements in the provenance record. Do not implement all scripted
behavior under the label of visual parity. The accepted terminal footer and
Sidekick question/configuration drawers remain governing unless amended.

A useful next comparison must show a populated exchange with actual output and
control-only work, not just an empty pane or a count of passing layout tests.
Compare role hierarchy, grouping, activity, composer placement and boundaries
against the accepted reference at the agreed terminal sizes. No populated
terminal capture was produced in this turn; the comparison above is from the
reference image/template and production descriptions.

## Scope relative to #921

The Product Owner's earlier instruction remains: fix PR-caused defects here;
put pre-existing behavior and added capabilities in follow-up issues.

| Item | Causality / disposition |
| --- | --- |
| Provider-ID filter labels and always-visible choices | Already present at PR base `79d404d0`. Task C / follow-up UX work; Sidekick adds more pressure to it, but did not originate that rendering. |
| Technical entry titles and duplicate catalog | Already present at PR base. Numeric display and interactive History replacing that catalog are follow-up navigation work. |
| Location duplication | No malformed or duplicated navigation reproduced in this supplied URL. Its explicit default pane member is semantically redundant; draft preservation is intentional. |
| Successful no-Output chat placeholder | Introduced with Sidekick in this PR. The requested correction belongs to its chat presentation and must preserve failure/recovery visibility. |
| Broader mockup alignment | Separate conformity review against the accepted terminal adaptation. Correct traced omissions from the accepted contract; classify genuinely new interactions as follow-ups. Do not treat either padding tests or the entire scripted prototype as automatic acceptance. |

This is a local feedback/scope record, not a newly created GitHub issue or a
ready-to-execute combined implementation assignment. The Planner should keep
the PR-owned empty-reply correction bounded, carry the navigation/filter work
into follow-up issues, and coordinate any accepted visual correction with the
current worktree owner and delivery freeze. No source, user history, agent
session, branch, commit, GitHub record, or dependency state changed here.

## Follow-up tickets created at the Product Owner's request

After the assessment, the Product Owner explicitly requested tickets for the
other UX work. Four open stories were created and independently read back with
their exact titles, descriptions, and `enhancement` / `UX` labels verified:

- [#928 — Readable, compact conversation filters](https://github.com/taras/executable.md/issues/928).
- [#929 — Numeric entry labels and simpler locations](https://github.com/taras/executable.md/issues/929), including the explicit waiver of old-link compatibility.
- [#930 — Select entries directly from History](https://github.com/taras/executable.md/issues/930), with an optional on-demand entry list that distinguishes saved programs.
- [#931 — Sidekick conversation layout matching the approved reference](https://github.com/taras/executable.md/issues/931), with populated terminal comparisons and bounded activity presentation.

No duplicate issue was found in the related open REPL stories. #895 continues
to own the broader focus-region navigation model; #898 owns agent initiative,
not this conversation layout. Their active descriptions were left unchanged.
The empty-reply placeholder remains a PR-owned #921 correction rather than
being deferred into one of these tickets. No implementation was performed.
