# PR 1 implementation handoff: original colours, panes and drawers

**R1–R3 addressed; ready for Planner feedback.** Revised from the reviewed
`f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa` against
[pr1-planner-review.md](pr1-planner-review.md). Not pushed, no PR.

## The commits

| | |
| --- | --- |
| Feedback commit | `080b6ec80ca74e614789e8d2252857ac281df7e5` |
| Parent | `f0b8eb1f323c1ad5826eafba978ef9c2e9f5fffa` (the reviewed commit) |
| Earlier | `56afe3af7a960d00494cd495b00274b5986e812a` |
| Base | `e68f128121cd802623ab7797a016b0c66ce91176` |
| Branch | `agent/issue-881-pr1`; worktree `.claude/worktrees/issue-881-pr1` |

Review `080b6ec8`; the whole slice is the three commits against the base.

## R1 — the roles of visible characters survive an overflowing row

The single-colour fallback is gone. The stretches of a row are now **cut at the
room the element has** (`layout.ts`, `written()` → `roomOf`/`bounded`), so the
engine never has to wrap one: every character the row can show keeps the role
it has and the order it was in, and the row shows one more character than the
word-wrapped reading it replaced rather than fewer. A row whose width the flow
decides — only the pass that is *asking* what the widths are draws one — still
takes the single operation it always did, so no measurement moved.

The two cells the review named, read out of the new captures:

| Capture | Cell | Was | Now |
| --- | --- | --- | --- |
| `plan-review-160x36` | `<` | `#c8d2d9` | `#4e8b9c` delimiter |
| `plan-review-160x36` | `Elicit` | `#c8d2d9` | `#7fd3e8` tag |
| `plan-review-160x36` | `schema` | `#c8d2d9` | `#8fa7b8` attribute |
| `completed-details-72x20` | `A lightweight` | `#8b959c` label | `#e6ecf1` value |

The overflow regression now asserts the delimiter, tag, attribute, quoted
value, reference and prose roles **on the overflowing row itself**, that no row
is one colour throughout, that a focused overflowing row keeps its cyan cue,
and that the narrow populated form keeps its field's name and its value apart —
alongside the character-prefix checks it already had. `audit.py` no longer
accepts a tag drawn as one stretch: "a tag row is not painted one colour
throughout" and "a visible value reads as a value, not as its field's name" are
now claims of its own.

No multiline editing, no new wrapping or access behavior, no generated-source
replacement, no second renderer. The measured geometry, window behavior and one
node and target per row are unchanged.

## R2 — the frozen expectations are independent of the product

New fixture `packages/cli/tests/fixtures/repl/reference-style.ts`: `SURFACE`,
`SEMANTIC` and `SYNTAX`, transcribed from the corrected archive's own `S`, `C`
and `Y` constants, carrying the archive SHA-256
`86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`, the two
source files and the extract they were read from. `RETAINED` holds the one
value the archive states differently — the selected row's `#122026` — named as
the retained terminal adaptation it is.

All 65 expected-colour references in this slice's assertions now read that
fixture. **No `REPL_PALETTE` reference remains in them**; the pre-PR1 tests are
untouched, as the review allows. Control 5 below changes one palette entry by a
single bit and three rows go red — under the reviewed commit they would all
have stayed green. My previous handback said these were literals and none came
from production; that was wrong, and this replaces it.

## R3 — the frozen resize journey

`journey.py` takes both endpoints inside `stage_details`, with the populated
project question open: refusal at 60×15, then 160×36 again. The recovered frame
shows the same `Answer` drawer with `Northstar` and
`A lightweight workspace for coordinating coding agents.` retained, its rule,
its inset and its controls. The audit now expects a question title there, not a
permission one. Still 35 pairs; no extra journey.

## Evidence

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts \
  packages/cli/tests/repl-layout-admission.test.ts \
  packages/cli/tests/repl-forms.test.ts
# ok | 28 passed (105 steps) | 0 failed  — exit 0
git diff --check    # clean, exit 0
```

Also run on this revision: the journey set
(`repl-journey`, `repl-composition`, `repl-terminal`, `repl-boundaries`,
`repl-agent-journey`) — ok, 64 passed (208 steps), exit 0;
`deno check --frozen packages/cli/src packages/cli/tests` — exit 0;
`oxfmt --check` and `oxlint` over the changed files — clean, warnings unchanged.

**Five break controls**, each applied alone to `080b6ec8`, patch and first
failing output in [pr1-controls/](pr1-controls/), production bytes SHA-256
verified restored between each, positive command re-run green afterwards:

| Control | Fails |
| --- | --- |
| Collapse token roles to ordinary source | P1-T1 ×3, D1 ×2 |
| Restore whole-row cyan focus | P1-T1, P1-T2 |
| Remove the opaque drawer surface | G5, P1-T3 — `the cell at 20,3 … carries 592652` |
| Send an overflowing row through a single-colour fallback | P1-T1 overflow, P1-T2 overflow, P1-T3 narrow form |
| Drift one palette entry by a single bit | P1-T1 ×2, P1-T2 |

## The gallery

[pr1-evidence/](pr1-evidence/) was recaptured end to end from `080b6ec8`: all
35 frozen states at 160×36, 120×30 and 72×20 plus the two question-drawer
resize endpoints, in one journey, with `actions.jsonl` recording every action
and every capture's actual columns and rows. `pr1-gallery-manifest.json` is
SHA-pinned through `sha256sums.txt` (262 files).

- `audit.py` reads the frozen table out of the cells: **421 checks, all held**.
  Against the pre-change baseline captures it reports **129 unmet claims**,
  including the two R1 claims, so it discriminates.
- All 35 pairs opened again through the 13 contact sheets;
  [image-review-log.md](pr1-evidence/image-review-log.md) records what each
  shows and where the three findings are now visible.
- Cold reopen leaves its Journal and provider log **byte-identical**
  (`cold-before.json` = `cold-after.json`).

## Standing notes

The drawer's decoration still costs its content window one row and two columns
at every profile, which is why UI16 and UI17 reach `[submit]` and the validation
row through one `[v later]` — unchanged from the reviewed commit and consistent
with the handoff. The two pre-existing drawer observations (first-field focus
ring; typing reaching the last-selected field) remain non-blocking and unfiled,
as the review directs.

No criterion in the frozen matrix is now unproven, and there is no
ordinary-source exception left to report.

## Next

Planner feedback against `080b6ec8`. Nothing pushed, no PR; say the word and I
will open the draft PR from the repository template. PR 1 does not close #881.
