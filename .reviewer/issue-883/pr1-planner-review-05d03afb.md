# Core PR 1 Planner review — historical PASS (superseded)

Current verdict at this SHA: **REQUEST CHANGES**. The confirmed Architect
finding blocks the accepted passive draft-fill program; see
[the Planner correction](pr890-planner-correction.md). The historical evidence
and earlier finding closures below remain recorded, but CLI PR 2 must consume
the corrected Core revision after review.

Accepted feedback commit: `05d03afb0ff1356707f66f2f1b741a5d8ec6ba95`.
Parent: `2765a76be0916e1d7ae0201345eb7fe7b861ad2e`.
Stack base: `e61d6ce072735b5d0cf683eeaca0f2eefddc2d59`, containing the
post-#881 foundation `b88da5ea979fa17fe217507ecaae2e224856bace`.
The reviewed worktree is clean.

Core PR 1 satisfies the frozen C1–C3 implementation and evidence matrix.
Both earlier findings are closed. CLI PR 2 can start from this exact accepted
Core revision under the existing handoff. No architecture decision remains open.

## Accepted evidence

| Criterion | Conclusion |
| --- | --- |
| C1 — generated root | Accepted: canonical admission and rendering, truthful partial failure, context retention and released fragment compatibility. |
| C2 — prefix preview | Accepted: pure deterministic projection, literal/computed separation and incomplete/invalid distinction. |
| C3 — conversation | Accepted: canonical placement and turns, retained identity, cancellation joining, overlap and closed-handle refusal, configuration/options behavior and native provider reconciliation. |

The cancellation correction accepted at `2765a76b` remains intact, with
CV18/CV19 passing. The established native mismatch checks remain intact, with
CV21/CV23/CV24 and the canonical provider HC3 passing.

HC1 closes the remaining pre-mapping evidence gap. It opens the real canonical
ACP provider through `useAgentConversation`, with a scriptable ACPX runtime.
The provider accepts the first turn and promotes its own record to a native
assertion; the host's acknowledgement hook then fails. The test observes that
assertion, no pending materialization and no native identity in the interrupted
Prompt record. It releases the owner and reopens over the actual retained
history and provider store. Explicit new work commits that same assertion,
keeps one store record, and sends only the new prompt rather than resending the
interrupted one. HC2 covers refusal after a completed turn has retained identity.

HC1/HC2 passing against the older Core implementation is consistent with their
purpose: they prove the already-canonical provider behavior reached through this
new host boundary. They now exercise the actual acceptance/acknowledgement
window. HC3 separately discriminates the new Core identity check. No further
negative control or scenario is required by this review.

The ACP package is the appropriate home for this integration evidence because
Core does not depend on ACP. CV22 now names its completed-turn reopening
behavior accurately and points to HC1 for the earlier provider window.
The ACP specification records the provider assertion/retained-turn distinction
and cancellation join. This revision changes no production code.

## Verification at the exact commit

Reviewer ran:

```sh
deno task test packages/core/tests/generated-xmd-root.test.ts packages/core/tests/generated-xmd-preview.test.ts packages/core/tests/agent-conversation.test.ts packages/acp/tests/host-conversation.test.ts
```

**20 tests, 91 steps passed; zero failures.**

The Implementor handback additionally records the handoff's released-fragment
and Agent regressions, touched-boundary tests, the complete ACP package,
documentation checks, typecheck, lint/format and Node/Bun execution of the new
integration file as passing. Those checks were not repeated here. The unchanged
cancellation probe passed in the prior review and is also reported passing at
this revision. No CI was inspected.

This is a completed Planner implementation verdict. Delivery verification
remains governed by the existing repository merge procedure; it is a separate
boundary from this PASS.

## Continuity and next action

Produced review: `.reviewer/issue-883/pr1-planner-review-05d03afb.md`.
Readiness is updated in `README.md` and `planner-handoff.md` in the same directory.
The frozen acceptance matrix and architecture remain unchanged.

Next Implementor action: prepare CLI PR 2 from
`05d03afb0ff1356707f66f2f1b741a5d8ec6ba95`, record the actual branch/base, run
setup once for its worktree, and implement the complete CLI Sidekick under
`planner-handoff.md` and the accepted syntax discovery amendment. Return the
stable CLI feedback commit with R1–R8 evidence and the required terminal
comparison packet. Core PR 1 alone does not close #883.

No unresolved Core feedback finding remains. This verdict grants no GitHub-write
or memory-restructuring authorization.
