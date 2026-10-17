# Keep sidebar labels readable with matching padding

**Implemented and accepted: [PASS at 6ca23952](pr921-padding-planner-review-6ca23952.md).**
The 36-column rule and BP1–BP5 are complete. The next assigned work is the
separate silent-reply correction; no width or padding choice remains open.

**Approved and released.** The Product Owner agrees to include the UI work in
delivery with sidebar width **36 at both wide and medium**. Use the
[continuation prompt](pr921-padding-width-approved-continuation-27da762b.md).
The earlier park/exclude interpretation and pending width question are
superseded. Keep the existing work, finish BP4 and the three focused selections,
then hand back one signed UI successor for review before restacking.

Preserve the uncommitted work and
[patch](pr921-body-padding-work-in-progress-27da762b.patch) at HEAD
`27da762b7078ee8e32b1dbaf90941c4a8a90eaa7` in
`.claude/worktrees/issue-883-pr2`. The existing designated Implementor remains
the sole writer. No reset, branch recreation, duplicate implementation or push.

## The returned conflict is valid

The [Implementor return](pr921-body-padding-implementor-conflict-27da762b.md)
isolates the sidebar inset from the working Transcript inset. The original
assignment froze widths and vocabulary while taking four cells from the sidebar
body. Its widest required status and filtered control no longer fit. This is
a product conflict, not permission to accept truncated states or re-anchor
assertions to a misleading prefix.

The suggested four-cell widening restores wide's former text space but does
not repair medium. At medium it would produce outer 32, body 28 and label room
26, still smaller than the 27-cell `completed, not recorded yet` state.

## Accepted width ruling

Set the sidebar to **36 columns at both wide and medium**. Keep the two-cell
body inset on each side. Its measured body is then 32 columns, with 30 after
the focus marker: the same space the previous full-width wide sidebar had.
This accommodates the existing 30-cell filtered control and preserves the
whole longest status without changing its vocabulary. This does not promise
unbounded names or identifiers fit; retain the existing intentional name
elision and full identities on actions/routes.

Continue splitting the remaining columns equally between Transcript and the
right pane, with the odd cell going to Transcript. The proposed table is:

| Terminal | Sidebar | Transcript | Right pane | Right starts at |
| --- | ---: | ---: | ---: | ---: |
| 160x36 | 36 | 62 | 62 | 98 |
| 120x30 | 36 | 42 | 42 | 78 |
| 161x36 | 36 | 63 | 62 | 99 |

Coordinates are zero-based. The right pane's inner Bindings widths become
61/41/61 respectively, and its Sidekick body widths become 57/37/57.
Sidebar width takes four additional cells at wide and eight at medium; each
main pane gives up two or four respectively. The medium Transcript is tighter,
but its complete retained text remains available by wrapping and scrolling.

This supersedes only the fixed outer-width clauses in the
[padding assignment](pr921-shared-body-padding-planner-handoff-27da762b.md)
and the earlier PW table. Both insets, full-width headers within their new
columns, P=1, seven-row footer and the measured guidance-safe route drawer
remain required. Sidekick pane-local drawers follow their actual pane; their
ownership and behavior do not change. Narrow keeps its existing geometry.

## Released continuation and finite evidence

Keep the completed Transcript/sidebar body measurement and the correction that
finds each body by its own id. A narrow outlet's shared region cannot identify
which body's width a consumer requested. No Core or durable behavior changes.

Update `layout.ts`'s sidebar widths and affected width examples. Update the
independent PW table to the proposed literals above. Adapt clicks and column
searches to the correct drawn window, without treating the first duplicate
label on screen as the Transcript's control. Keep the full retained output
claims and the existing BP1–BP3 evidence. The reported rejoining of wrapped
readiness text within its own Transcript column is permitted; it must observe
the same complete sentence in current frames, not earlier cells or the journal.

Add one finite BP4 presenter check at 160x36 and 120x30 using existing turn
fixtures: the longest terminal state is drawn whole, the filtered
`All conversations (filtered)` control is drawn whole, and rows and targets
remain inside the sidebar body. Keep existing entry-selection and distinct-row
claims. The earlier wide-only evidence is insufficient for the medium conflict.
Existing BP1–BP3, PW, UH5 and mounted journeys cover the new column bounds,
wrapping, guidance, resizing and controls. No new mutation battery or runtime
matrix is added.

Align only the affected width/padding prose in `specs/repl-spec.md` and
`architecture.md`. Rerun the same three frozen commands in the padding
assignment after all changes. Preserve all initial failing and isolation logs.
Once the amended evidence passes, create one signed feedback successor and
return its exact identity, commands, BP1–BP4 mapping and adaptations for review.
This UI continuation ends with exact-SHA review. Publication and delivery CI
follow the updated delivery handoff after that successor is accepted.

## Continuity

The implementation remains uncommitted at base 27da762b. The Transcript portion
has reported passing isolation evidence; the combined slice is not accepted.
The Product Owner's width-versus-vocabulary choice is closed at 36 columns for
both profiles, and the UI successor is included in delivery. History stacking,
conversation labels, the narrow pending-question layout, EH1/UI10, Parse #922,
teaching, captures and delivery remain separate. No production code or ref was
changed by the Planner.
