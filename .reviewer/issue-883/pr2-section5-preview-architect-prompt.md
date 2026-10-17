# Architect assignment: the Sidekick streamed Preview boundary

**Completed, 2026-10-14:** [the ruling](pr2-section5-preview-architect-decision.md)
is incorporated into [the frozen plan](pr2-section5-preview-planner-handoff.md).
Next action is [the Implementor assignment](pr2-section5-preview-implementor-prompt.md)
from signed clean 81523318. This earlier Architect prompt is historical.

Follow .agents/architect.md and execute the handoff in the main checkout:

`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883/pr2-section5-preview-architect-handoff.md`

Work from signed clean
`815233183c7c26cd40544347191b7ba5e1f975c3`, parent
`57773de05246578da77c0f8689fbee004cbd84b4`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Verify HEAD/tree and preserve all unrelated work.

The next feature is already accepted: literal top-level Output appears as
Preview while a Sidekick response arrives, then evaluated Output replaces that
same item; unsuccessful generation leaves Incomplete and executes no controls.
Core's pure preview reader exists. No new product interview is requested.

Resolve the missing live observation seam. Saved conversations now consume
their captured provider directly, bypassing the ordinary Agent.prompt middleware
the original CLI observation plan relied on. The host publisher currently has
begin/publish but no intermediate event callback. Choose the smallest canonical
observation mechanism and specify exact surface, correlation, owning-execution
disclosure, observation failure and cancellation behavior. Preserve the direct
provider route, one cold subscription, permission audit, exact completion
evidence, native identity and durable acknowledgement.

Read the full handoff for evidence and the five requested decisions. Record
the ruling and decision-complete Planner return at
`.reviewer/issue-883/pr2-section5-preview-architect-decision.md` in the main
checkout. A focused scratch probe is allowed if needed; preserve first output.
Leave implementation unchanged. The Planner freezes the implementation rows
and commands after this ruling.

Configure/Retry and all prior slices remain accepted. No Sessions work, capture,
push, GitHub mutation, CI inspection or dependency change. Do not silently
implement an API extension or restore compositional routing to obtain Preview.

Continuity: base 81523318; governing artifact is the linked full handoff; product
behavior is settled, observation/disclosure/lifetime mechanics await this
ruling. Return the recorded decision to the Planner for the next Implementor
assignment.
