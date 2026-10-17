# Correct replacement PR2's typing and integration evidence

Follow .agents/implementor.md. Continue in .claude/worktrees/issue-883-pr2 on
agent/issue-883-pr2-main-integration from signed clean
5a3d32bd6209744f0e7b837567fae87bc17b7d57. Read the
[review](pr921-replacement-planner-review-5a3d32bd.md) completely. Preserve this
commit, accepted parent 85da74b9, original branches and all safety refs. Leave
the accepted PR1 worktree and the other writer's isolated branch/worktree alone.

This is a bounded correction inside the accepted architecture and existing
IN1–IN8 matrix. No new product or architecture decision is delegated.

1. **R-P1:** remove only the four new assertions identified in the review:
   controls.ts's two definition casts, canonicalProps's schema cast, and IN5's
   subprocess chat-array cast. Construct definitions with compiler-checked
   types; narrow/parse incoming data. Do not substitute another assertion or
   an unchecked generic parser. Older unrelated casts are not assigned cleanup.
2. **R-E1:** complete IN6 using real owned captures and retained journals.
   Observe two live Sidekick owners with distinguishable request handles;
   post-capture definition/selection interception and an entry-only name cannot
   substitute or widen either. Legitimate controls reach their own owners;
   attempted substitution may refuse under the existing Core contract but must
   invoke no replacement. In one owner, changed facts are read through the same
   captured control on a later response, with exact per-response control order
   and designated feedback. Include an ordinary failure after an actual control.
   Extend the held-cleanup Stop fixture so no successor starts before join, and
   an actual successor control files under its own response, without a late
   outcome being transferred. Combine observations where one journey suffices;
   do not add a new permutation or mutation battery.
3. **R-E2:** strengthen existing IN5c. Identify the newly appended canonical
   turn through typed readers and assert that turn's native identity, not a
   substring in the complete old history. Compare the active conversation and
   preparation/activation records before and after; no replacement conversation
   is created. Preserve the old history prefix and visible facts alongside the
   existing marker-5/generated_root:3 and non-repeated-fill checks. Keep the
   accepted old-writer fixture and receipt byte-identical; do not regenerate it.
4. **Lost stream observation:** extend host-generated-root.test.ts E1a to consume
   execution.output through completion. Assert the document's own text appears
   and the evaluated root's distinctive text does not. Preserve the existing
   returned-rendering and completion assertions. The Planner assigns this
   test-only restoration to this PR2 successor to preserve the accepted parent;
   do not change or re-port PR1 production code, copy its old protocol tier,
   move its branch or start another integration.
5. Correct the stale profile.ts pinnedElicit paragraph and respond()'s comment
   saying the ceiling is constructed per response. Other prose changes are
   needed only if a genuine fix changes implemented behavior.

Use existing owner/control/Stop and typed durable/Prompt readers. No public
testing hook, new authority Context, callback protocol or second evaluator.
Production behavior is not alleged broken by the review: fix production only
if these assigned observations expose a concrete violation, preserving the
existing capture, association, cancellation and failure contracts. Preserve
first failure output and explain any such fix in the handback.

Run these three frozen selections against the final correction:

```sh
deno task test packages/core/tests/host-generated-root.test.ts packages/core/tests/generated-xmd-root.test.ts packages/core/tests/agent-conversation.test.ts packages/core/tests/agent-function-components.test.ts packages/core/tests/agent-session-launch.test.ts packages/core/tests/agent-session-setup.test.ts
deno task test packages/cli/tests/repl-sidekick-presentation.test.ts packages/cli/tests/repl-sidekick-journey.test.ts packages/cli/tests/repl-sidekick-lifecycle.test.ts
deno task test packages/cli/tests/repl-sidekick-storage.test.ts packages/cli/tests/repl-sidekick-recovery.test.ts packages/cli/tests/repl-sidekick-configuration.test.ts packages/cli/tests/repl-sidekick-controls.test.ts packages/cli/tests/repl-sidekick-output.test.ts
```

These are commands 1, 4 and 5. Commands 2, 3, 6 and 7 do not need repetition
for these test additions, typing and comment changes alone. If a real fix
reaches another assigned boundary, rerun the affected command and report why.
No full lint/check/JSR/runtime suite, dependency setup or CI prerequisite is added.

The review independently reproduces command 6's exact EH1/UI10 baseline
truncations. Its release exception remains unchanged; do not repair, weaken,
skip or silently report it green. Command 3 passed unchanged outside the
reviewer's filesystem sandbox after npm cache EPERM; no cache/dependency repair
or product-flake work is assigned.

Once the affected focused evidence passes, promptly create one signed successor
and return SHA/parent/tree/signature, all commands/results, R-P1/R-E1/R-E2 and
stream-observation mapping, fixture adaptations and any first failures. Stop
for that exact revision's review before publication. No amend, reset, rebase,
push, GitHub mutation, CI inspection, user-history repair, unrelated UI request,
Parse #922, teaching, capture packet or delivery work is assigned.
