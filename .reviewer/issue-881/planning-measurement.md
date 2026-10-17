# Engine measurement for wrapped readings and History

The installed @bomb.sh/tty 0.9.0 engine answers natural text width through a
fit-sized element. No public line-break API or renderer change is needed.
These are planning probes, not a product test or implementation verdict.

Two read-only Node probes imported the installed engine in the accepted PR 1
worktree. Each rendered an element with width/height fit inside a 160×36 root,
then immediately copied its bounds before the next render. No engine error
occurred. The probes installed nothing and changed no production file.

| Exact text | UTF-16 units | Engine width | Engine height |
| --- | ---: | ---: | ---: |
| abc | 3 | 3 | 1 |
| 界é🙂 | 4 | 5 | 1 |
| e followed by U+0301 combining accent | 2 | 1 | 1 |
| a b c | 5 | 5 | 1 |
| x repeated 240 times | 240 | 240 | 1 |

The longer probe also showed that a nominal fixed width does not itself prevent
an unbroken text operation from expanding its measured minimum. Merely bounding
a box or reading its wrapped height is insufficient. Construct complete fitting
row fragments before admission, and measure the operations actually drawn.

## Private preparation method

After prepareFrame's empty width pass, use renderer.measure with independent
probe ops and structural ids. A probe is a fit-sized text element with the same
run/style operations the final row uses, without a viewport's fixed-height clip.
Read natural widths only; discard its output bytes. Batch modest probe groups
and copy every answer before another measurement invalidates engine info.
Keep the existing measuring and committing engine pair and frame acknowledgment.

For each explicit logical line, consider cuts at Unicode grapheme boundaries;
UTF-16 offsets index source, never terminal width. Find the longest prefix whose
engine-measured width fits the available measured content region. Prefer its
last fitting word/whitespace boundary; if no such boundary exists, take the
longest fitting grapheme prefix. Preserve whitespace in the fragments, never
trim it. Keep blank logical lines as one row. Keep explicit newlines in the
logical reading and omit only those separator bytes from visual row text.
Measure the finished candidate again using its actual run ops. Every nonempty
iteration consumes source; no ellipsis or single-colour fallback is allowed.

Split token runs by the chosen source offsets, maintaining their roles. Carry
source owner, logical line and continuation identity on private prepared rows.
Only the first visual row of an opening/closing observation carries its badge;
rails continue. Measurements reserve rails, a separator and the stable status
column first. These reservations are engine-measured, not text.length. Include
`◀ EXIT · ● WAITING` and the existing cancelled wording in the maximum status
width along with all six phase readings. The two accents in cleanup wait remain
distinct. Status-only changes reuse the same reservation and source cuts.

The private result becomes immutable frame preparation data. The same prepared
row list supplies row counts, window admission, descriptions, boxes and targets.
The application consumes those rows; renderer input remains only engine ops.
Do not call measurement from a pure description or create a child reader.
Reprepare after size, selected reading, output or source changes. A phase-only
update can reuse cuts. Unmeasured passes emit no windowed content.

Use the same fit probe for full Unicode arrow controls and History captions.
Widths of labels are engine results; ordinal spacing is arithmetic within the
engine's measured rail region. Static caption probes share preparation, not a
new frame subscription. Cache only private immutable input/size/style results;
no offset, width, phase or probe is retained in the Journal.

The supported fixtures leave room for at least one grapheme after reservations.
An engine refusal remains the existing frame refusal. Do not repair an
unprovable fit by clipping source or spilling into another region.

Probe entrypoints used in this session were
/private/tmp/issue-881-measure-probe.mjs and
/private/tmp/issue-881-fit-probe.mjs; these are local exploratory tooling.
The required implementation regressions reproduce the Unicode, unbroken-token
and exact-row-fit boundaries through Effection and the production renderer.
