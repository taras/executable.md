# Prepare #881: original Terminal Interface parity

The remaining original parity work is frozen for implementation:

- [PR 2: lifecycle, Source and Output](pr2-implementation-handoff.md), with exact
  Core interfaces, ownership, engine-measured wrapping, focused tests and
  **44 comparison pairs**.
- [PR 3: History rail and exact selection](pr3-implementation-handoff.md), with
  one retained snapshot, truthful head states, measured grouping/caption rules,
  focused tests and **77 fresh assembled pairs**.
- [Final gallery matrix](final-gallery-matrix.md) and
  [machine-readable scene plan](final-gallery-plan.json).
- [Exact stack and evidence rules](stack-and-evidence.md) and
  [private engine measurement](planning-measurement.md).

**PR 1 implementation feedback: PASS** at
`080b6ec80ca74e614789e8d2252857ac281df7e5`. Preserve its
[acceptance](pr1-planner-acceptance.md), [handoff](pr1-handoff.md) and 35-pair
record. The branch is unpublished. PR 2 starts there and integrates recorded
main `4c0414be1010f69f11bff0d1d634623a5b08f886`; PR 3 starts from the future
accepted PR 2 feedback SHA.

The Architect/Product Owner decisions are complete in the
[PR 2](pr2-planner-handoff.md) and [PR 3](pr3-planner-handoff.md) architecture
handoffs. No persistence change or renewed Journal decision is needed.
**PR 2 has no planning blocker. PR 3 implementation depends on PR 2 acceptance.**
No PR 2/3 production change, implementation verdict, commit, push or PR is issued
by this planning packet.

The [baseline comparison](comparison.html), [gap assessment](assessment.md) and
[earlier proposed matrix](comparison-matrix.md) remain historical evidence. They
are not the frozen final acceptance matrix.

## Authority and base

- Governing [Story #881](https://github.com/taras/executable.md/issues/881), child
  of [Quest #827](https://github.com/taras/executable.md/issues/827).
- Original archive: [XMD REPL Terminal Interface corrected.zip](https://github.com/user-attachments/files/32939115/XMD.REPL.Terminal.Interface.corrected.zip).
  SHA-256 `86be64318121546f3208342edaf17f0a3aed35f3fde2766b523423e6c708c77b`.
  The downloaded, verified bytes are in [evidence/reference.zip](evidence/reference.zip).
- Captured production: `2d719f78025059158a35023701fdff52b855a65b`, local main.
- PR 1 recorded main base: `e68f128121cd802623ab7797a016b0c66ce91176`.
  Current remote main read for the later slices on 2026-10-08:
  `4c0414be1010f69f11bff0d1d634623a5b08f886`. The shared stack record accounts
  for #880/#884 and the actual unpublished predecessor.
- #876 measured layout, #877 reveal retention and #878 semantic row styling are
  merged foundations. Reuse them. No required unmerged stack was identified.
  Refresh main and overlapping PRs immediately before implementation starts.

Relevant installed versions: Effection 4.1.0, @effectionx/context-api 0.6.0,
@bomb.sh/tty 0.9.0 and core 0.13.1. Freedom is the repository's patched vendor
snapshot of commit `8be97e7201cd6effddb2f8b240b4b5166641e7f0`, rather than an npm
dependency. The proposal reuses these versions and their existing adapters.

The archive owns visual intent. The current REPL specification and architecture
own execution and interaction. A visual conflict remains a decision, rather
than an implicit change to those contracts. The existing Story is preserved in
[story-draft.md](story-draft.md); no GitHub rewrite is proposed.

## Evidence and limits

The pre-change baseline contains 71 production/reference pairs: 23 scenes at all three supported
profiles, one wide resize recovery and one undersized refusal. ANSI screens,
plain text, PNGs, action records, a local provider fixture and the retained
Journal are preserved. [capture-runbook.md](capture-runbook.md) records provenance
and reproduction; [image-review-log.md](image-review-log.md) records inspection.

Production images are fresh. Reference PNGs are unchanged derivatives inherited
from the earlier review gallery, with that provenance stated in the runbook.
The archive itself was freshly downloaded and verified. Scene times identify
reference analogues; they do not establish an identical workflow or a terminal
pixel target. No newer archive supplies a requirement.

The existing presentation-style test passes: 7 tests, 25 steps. The installed
TTY engine also accepts independently coloured text runs in one element. Both
are useful implementation evidence; neither is a visual-parity verdict.
Cold inspection leaves the Journal and provider log byte-identical.

## Continuity

The Product Owner settled lifecycle authority: middleware observes complete
invocations and feeds a session-owned live view; the Journal supplies retained
history. A missing observation boundary is addressed without persistence.
Historical panes receive no live lifecycle overlay; returning live receives the
session's current snapshot. Original UI parity remains the scope.

No production files, dependencies, commits, GitHub state or CI were changed.
The untracked greeting.md predates this work and is untouched. The isolated tmux
server is stopped. Review-created histories remain in the normal host storage;
no other history was changed.

Next Implementor action: prepare the isolated PR 2 stack from its frozen
handoff, run the focused evidence and return a stable feedback SHA. PR 3 follows
that accepted revision. Feedback acceptance and separately authorized delivery
retain their own gates. This turn changes only planning artifacts; no production
or GitHub state changed. The earlier 71-pair baseline and accepted 35-pair PR 1
record remain intact.
