# The drawer scope and BP5 count need no correction

**Product decision now closed:** include the UI in delivery with sidebar width
36 at wide and medium. The
[released continuation](pr921-padding-width-approved-continuation-27da762b.md)
supersedes the pending-choice/delivery-cut paragraphs below. The two evidence
dispositions remain unchanged.

The [Implementor return](pr921-padding-colors-implementor-return-27da762b.md)
matches the styling addendum on its two returned questions:

- Keep `drawer:scroll:up` and `drawer:scroll:down` on their existing surfaces.
  The visual correction covers pane windows, not the drawer controls. No wider
  styling change is assigned.
- BP5 may observe six navigation controls in this fixture. Entries only offers
  its pair when the catalog is windowed; a requirement to observe eight in a
  fitting catalog would contradict that behavior. The existing source assigns
  the semantic role to all eight pane-window controls. BP5 checks every drawn
  member, requires contributions from each pane and keeps the ordinary-action
  positive control. No extra fixture or permutation is required.

The Planner inspected the return, current source assignments, semantic role,
header props and BP5 row. This is a scope/evidence disposition, not a PASS for an
uncommitted tree. The first selection's log reports 30 tests / 112 steps, zero
failures. Command 2 reports 42 tests / 166 steps passed, two tests / five steps
failed; command 3 reports 64 tests / 175 steps passed, seven tests / ten steps
failed. These are the reported five/ten failing rows, not fifteen failed test
groups. No test was rerun here.

HEAD remains 27da762b; the padding/color changes remain in the worktree and its
preserved patch. No commit, branch change or implementation is made by this
disposition.

The [delivery assignment](pr890-pr921-final-delivery-implementor-handoff-27da762b.md)
currently freezes delivery at accepted 27da762b and parks the uncommitted UI.
After this later return, the Product Owner has been asked explicitly whether
to include the UI with a 36-column sidebar at both profiles or retain that
accepted delivery cut. Inclusion requires that answer, completion of BP4,
all three focused selections passing and one signed successor before restacking.
The recommendation is inclusion with sidebar 36; it is not yet authorization
to change the width or the delivery cut.
