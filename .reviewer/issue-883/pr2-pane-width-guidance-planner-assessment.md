# Wider-pane conflict: preserve the directions by wrapping

**Resolution released, 2026-10-15:** the Product Owner approved wrapping and
also requested Sidekick padding. Execute
[the released guidance/padding amendment](pr2-guidance-padding-planner-amendment.md)
with the existing composer/width assignment. The pending recommendation below
records the assessment before that answer; it is no longer a hold. Equal outer
widths and the six-row composer remain accepted.

The return is justified. The width amendment missed the existing one-row
guidance contract. At 120x30 the equal-share Transcript has 45 inner columns;
its required compact guidance needs about 50. Changing widths without changing
that presentation cannot preserve the required directions.

**Status: proposed resolution awaiting the Product Owner.** Keep the accepted
equal shares and six-line composer. Let contextual guidance and cold-open
refusal explanations use measured wrapped rows. No new vocabulary, omitted
required direction or test waiver is proposed. This document does not release
that behavior before the answer.

## Exact state and evidence

Committed head remains accepted 25227d38cb8087743cd404533c7960de9423a442,
parent 13c4900d, branch agent/issue-883-pr2, signature G / tarasm@gmail.com.
Composer and width work is preserved uncommitted. This assessment edits none
of it and does not claim that dirty work is a reviewed feedback commit.

The [Implementor return](pr2-pane-width-implementor-conflict.md) isolates the
width rule from the composer and records the failing accepted rows.

Two focused independent selections against the preserved work reproduce the
guidance failure and the two normal-sized refusal failures:

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts --filter 'REPL presentation: the one guidance row'
deno task test packages/cli/tests/repl-journey.test.ts --filter 'REPL first use: UI2 refusal'
```

[Guidance output](pr2-pane-width-guidance-selected-first.log): R6 fails at
120 columns because the way back to Draft is absent from the displayed sentence.
[Refusal output](pr2-pane-width-refusal-selected-first.log): both UI2 rows fail
their visible admitted observation. First outputs are preserved. Earlier
filters named nested steps and selected zero tests; those diagnostic-selection
mistakes are preserved separately and supply no passing or failing product
evidence. No unchanged rerun or source repair is claimed.

## The failures have two presentation causes

guidance chooses between its existing full and compact vocabularies by room,
drops optional parts to fit one row, then ellipsises if required parts still
cannot fit. This explains both genuinely missing required directions at medium
and earlier navigation hints disappearing as the Transcript narrows.

Cold-open refusal text already occupies several rows. described() uses chunked(),
which slices it by a fixed code-unit count and pads each piece. Those cuts can
split a word or a phrase; an assertion looking in one physical row can fail
even when the message spans several rows. Treat these separately from the
guidance's actual ellipsis. Engine-measured word wrapping and reading the
message across its owned display rows preserve the original refusal claim.

## Proposed product resolution

Keep the width table, sidebar, narrow outlet and seven-row footer. Contextual
guidance becomes one inert block with as many measured rows as its existing
words need. State remains first; the Enter action, way out and movement stay
visible. Use the existing full vocabulary in multi-column layouts and existing
compact vocabulary in narrow, rather than inventing a third vocabulary or
discarding required text to satisfy a one-row budget.

Word-wrap the cold-open refusal explanation through the existing engine fitter,
preserving its original text, focus owner and visible Exit control. Adapt its
tests to read its actual displayed rows rather than require a phrase to land
on one physical row. No navigation, provider or history behavior changes.

This does not change the footer's separate one-row action-refusal policy or
the bounded failed-entry reason. Those intentionally shortened surfaces are
outside this conflict.

The guidance/refusal blocks must reserve their real height before window
admission and commit. No text may paint over a reading or target. The composer
still derives its cap from the actual minimum-composer frame after fixed
content is accounted for. Reuse current frame preparation and measured fitting;
do not add a second focus store or a layout convergence loop.

R6 and the returned first-use/refusal rows keep their semantic assertions: all
required directions/reasons visible, no required-text ellipsis, legitimate
controls and unchanged history/lifetimes. Their one-row observation mechanics
can change only under the accepted wrapping amendment. The existing three
combined selections will remain the feedback boundary; no extra broad suite
or mutation battery is proposed.

## Continuity

Produced: this assessment and preserved independent first outputs. Width and
composer cap remain settled. Unresolved: wrap these body explanations versus
keep one row and separately approve shorter wording. Recommendation: wrapping.
Next Planner action: record the Product Owner's answer and release an exact
amendment before the Implementor continues. Preserve all in-flight work.
No production edit, commit, push, GitHub write, CI or capture occurred here.
