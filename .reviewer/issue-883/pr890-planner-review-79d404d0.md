# PR #890 Planner review — PASS

Accepted head: `79d404d04d02c3840892473b6f1b2cf540f3edd1`.
Parent: `05d03afb0ff1356707f66f2f1b741a5d8ec6ba95`.
Stack base: `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`.
PR: [#890](https://github.com/taras/executable.md/pull/890).
The reviewed Core worktree is clean.

The restored C1 requirement is satisfied. The approved Let/select=code capture
now reaches the pinned paired draft receiver exactly once, preserving the
accepted entry-only binding references and nested passive fences. The unchanged
Architect probe passes all three cases. The earlier blanket-refusal finding is
corrected, and no Core Planner feedback finding remains.

## Why the correction satisfies the contract

The correction changes both admission and expansion. A root may interpolate its
own bindings because its expansion scope now supplies a fresh Component.env,
with empty props and its own live binding overlay. Canonical expansion receives
empty meta and props. Let and Json can bind values in that environment; the
admitting document's bindings are not its input.

GR17 proves local binding use, GR18/GR19 prove literal fill and passive capture,
GR20 proves the accepted Each/greeting source arrives as source rather than
executing, and GR21 proves nested passive fences survive. GR22 drives the root
from a real host component after the document binds `secret`; neither rendered
Output nor the draft receiver resolves that host binding.

The root-only condition is explicit in both places: interpolation admission is
relaxed only for ROOT_CONTEXT, and the fresh environment is installed only for
ROOT_CONTEXT. Fragment admission retains its previous refusal, and fragment
expansion is unchanged. The existing whole-source checks for executable response
fences, computed expression props, unpinned components, forbidden structural
syntax and context-switched retained admissions remain in place.

The documentation now distinguishes a root's environment from a fragment's
inherited environment. Preview still treats interpolation as computed text and
performs no evaluation. The conversation/provider implementation is untouched;
its accepted cancellation and native-identity evidence remains passing.

## Reviewer verification at the exact head

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts packages/acp/tests/host-conversation.test.ts
```

**21 tests, 95 steps passed; zero failures.**

```sh
deno task test packages/core/tests/generated-xmd.test.ts packages/core/tests/generated-composition.test.ts packages/core/tests/evaluation-profile.test.ts packages/core/tests/component-expansion.test.ts packages/core/tests/source-inspection.test.ts
```

**28 tests, 289 steps passed; zero failures.** This includes the released
fragment refusal and retained-record compatibility evidence.

```sh
deno test --allow-all --frozen --config deno.json /Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr890-passive-draft-probe.test.ts
```

**1 test, 3 steps passed; zero failures.** Literal fill, simple passive capture
and the accepted entry-only reference program each reach the receiver once with
the exact expected text.

The Implementor also reports Agent/touched-boundary regressions, the unchanged
cancellation probe, typecheck, lint and documentation validation as passing at
this revision. They were not repeated here. No CI was inspected and no new
negative controls were required for this verdict.

## Continuity and next action

This PASS supersedes the Planner correction against `05d03afb`. C1, including
the restored passive-draft requirement, is accepted; C2 and C3 remain accepted.
The Architect's own review record remains its record; this document is the
Planner verdict on the correction.

Produced review: `.reviewer/issue-883/pr890-planner-review-79d404d0.md`.
README, the PR review index and the handoff now point to this accepted revision.
The product contract and frozen delivery split are unchanged.

Next Implementor action: preserve the uncommitted draft in
`.claude/worktrees/issue-883-pr2`, advance that worktree's base to the accepted
`79d404d04d02c3840892473b6f1b2cf540f3edd1`, record its actual base and continue
the complete CLI slice under `planner-handoff.md` and the syntax discovery
amendment. Return the stable CLI feedback SHA with R1–R8 evidence and the
terminal comparison packet. PR #890 alone does not close #883.

This is implementation acceptance, separate from delivery verification. No
production file, PR 2 worktree, memory or GitHub state was changed by this review.
