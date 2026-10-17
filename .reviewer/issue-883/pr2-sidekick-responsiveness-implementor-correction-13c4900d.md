# Finish the responsiveness evidence without changing the production design

**Completed: PASS at 25227d38.**
[The closing review](pr2-sidekick-responsiveness-planner-review-25227d38.md)
accepts this correction. No further implementation is assigned here. Preserve
the accepted signed clean head and hold for the next released assignment.
The instructions below record the completed correction.

Follow .agents/implementor.md and continue from signed clean
`13c4900dbf0c4e57411241ada84aa00f4b55ba65`, parent
`39c24f37fdb967c3aa90870f9b4e22e536dc0fec`, branch agent/issue-883-pr2.
Worktree: `/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Verify head/signature/tree. Preserve ancestors; no amend, reset, rebase or
unrelated main changes.

Read [the review](pr2-sidekick-responsiveness-planner-review-13c4900d.md) and
RS3–RS5 in [the frozen continuation](pr2-sidekick-responsiveness-implementor-prompt.md).
The production cache/visibility fix, per-chat scrolling, CF-E1 and header prose
correction are accepted. This assignment finishes omitted observations inside
the existing RS4/RS5 rows, removes one cast and aligns one architecture paragraph.

## Make these bounded changes

1. Remove chatOf's `as ReplSidekickReading` in
   repl-presentation-style.test.ts. Keep a typed fixture and the same values;
   add no replacement cast.
2. RS4: include an existing final Preview item, grow its text with its key
   unchanged, then append the next item. Preserve the changed-line-alone cost
   comparison and prior-line reuse. Compare the full prepared chat rows with an
   uncached answer, including text, keys and count, rather than only mounted
   keys. Keep the blank-line/Unicode fixture and observe the new visible text.
3. RS5: assert the first hidden frame as well as warmed typing against
   equivalent empty-chat frame work. Keep entry warmup symmetric. In the same
   resize/switch/withdraw sequence, actually change the chat identity and
   actually withdraw or replace a Preview that was present. Compare full
   prepared rows/text/counts with uncached preparation. A different chat must
   carry its own conversation, reading and row ownership. Preserve hidden/show
   and resize observations; do not add another scenario matrix.
4. Add a short architecture paragraph beside chat fitting explaining the
   independent command-owned cut store, exact-input reuse, pruning after a
   completed list, size invalidation and hidden-chat avoidance. No benchmark
   numbers, terminology entry or public API change.

No production change is expected or assigned. If these exact observations
expose a real defect, preserve its first output and return the concrete finding
before expanding this tests/prose correction. Do not rework notification,
disclosure, identity, storage or viewport architecture.

## Focused feedback

Run only:

```sh
deno task test packages/cli/tests/repl-presentation-style.test.ts packages/cli/tests/repl-sidekick-presentation.test.ts
```

This directly covers all changed tests, RS2–RS5, CF-P1/CF-E1 and mounted geometry.
The eleven selections, preserved external probes and latency diagnostic do not
need repeating for a tests/prose-only correction. No new mutation battery,
broad lint/check/JSR, full runtime suite, CI, dependency/cache repair or capture
is assigned. The PTY environment limitation and open M1 flake remain outside
scope; do not weaken assertions.

Continue through the finite correction, preserve first failures and commit
promptly when the focused command passes. Return one signed feedback SHA with
parent, branch/signature/clean state, the exact command/result and fixture or
assertion adaptations. Stop for review of that exact commit. No push or GitHub
write is authorized.

Base: 13c4900d. Produced: this correction and its linked review. No architecture
question remains for responsiveness. The composer height cap still awaits the
Product Owner, so that separate addendum is not released. Teaching, the 36-frame
packet and delivery remain separate.
