# Architect handoff: settle Sidekick conversation creation-policy compatibility

**Disposition, 2026-10-12:** this referral is resolved by the accepted
[session configuration amendment](pr2-recovery-creation-policy-architect-decision.md)
and [Planner handoff](pr2-session-configuration-planner-handoff.md), grounded at
the exact base below. The values are configuration, not policy. Implementation
and R2 completion remain pending. The original referral follows as history.

The remaining R2 question is whether a saved Sidekick conversation may continue
when its provider creation policy has changed. Resolve that boundary before the
Planner assigns its final recovery correction. Matching conversation ID, agent
name or native session ID does not by itself establish compatible policy.

## Exact state

Worktree: `.claude/worktrees/issue-883-pr2`
Branch: `agent/issue-883-pr2`
Accepted head: `b01bbe6c5a51a383d52a1d8ce25d384b6aefc3e2`
Parent: `1d373a61cbb6266e4dd90bf17c8076c278174b0f`
Signature: G, tarasm@gmail.com. Worktree verified clean.

The first section 5 increment is accepted: independent `--sidekit-agent`
selection, profile data and the `view`/`right` location members. Its correction
review is [pr2-selection-planner-review-b01bbe6c.md](pr2-selection-planner-review-b01bbe6c.md).
The assigned boundary/help command independently passed 5 tests/46 steps.
This does not mount a Sidekick surface or acquire its owner in program.ts.

The existing creation-policy return was grounded at 14ee0d8e. This handoff
updates its base and preserves its question. Later accepted recovery fixes,
message association, vocabulary and selection/routing do not settle it.

## Governing contract

Read the repository instructions, .agents/architect.md and its required
rulebooks, architecture.md fully, and the affected Core/ACP specifications.
Read these planning records from the repository root; inspect code in the
implementation worktree:

- [remaining-architecture.md](remaining-architecture.md), provider association:
  compare retained provider, resolved agent command, tagged native identity and
  creation policy before continuation. Reattach the same conversation under the
  same policy.
- [storage-contract.md](storage-contract.md), lines 145–151: retain those facts
  together; compatible reference refresh is context, not a widened policy.
- [core-interfaces-proposal.md](core-interfaces-proposal.md), installations:
  the trusted assembly selects the constrained creation policy and retains what
  strict reattachment comparison needs.
- [planner-handoff.md](planner-handoff.md), R2 case 2: incompatible creation
  policy refuses replacement on explicit work.
- [pr2-recovery-creation-policy-architect-return.md](pr2-recovery-creation-policy-architect-return.md),
  the original unresolved return.

## Current evidence

The following is a direct trace at b01bbe6c, not a claim that every provider
internal has already been exhaustively investigated:

- packages/cli/src/repl/sidekick/owner.ts opens useAgentConversation with its
  conversation stream, saved conversation ID, saved agent and trusted
  installations.
- packages/core/src/agent/conversation.ts, bindConversation(), retains and
  compares `{id, agent}`. A policy change can preserve both.
- The same module's openable() reads retained turn outcomes and checks their
  native conversation identities. Those checks establish identity, not policy
  equality.
- packages/acp/src/session-store.ts exposes retained agentCommand and optional
  agentSessionId. Its public retained reading does not state creation policy.

Trace the actual ACP-first provider/session path and any canonical retained
policy comparison before concluding that a boundary is absent. A code comment
saying installations settle policy is not evidence that it is retained and
compared on reopening.

Accepted R2 evidence already covers the real assertion-before-acknowledgement
interruption with separate processes and the disk-backed ACPX store, native
identity mismatch, interrupted effects/questions, feedback acceptance and
message-to-turn association. Do not reopen those corrections or substitute
them for this policy question.

## Required disposition

First determine whether the existing canonical machinery already enforces the
accepted requirement. If it does, identify the exact policy value, who captures
it, where it is retained, the comparison and the refusal point. Supply one
same-ID/same-agent scenario whose policy difference actually reaches that
comparison, alongside its compatible control. A direct trace or the smallest
isolated probe is enough to establish the architecture finding; the Planner
will freeze the implementation evidence.

If that boundary is absent, propose the smallest explicit architecture
amendment. State:

1. What creation policy means on this supported path, including which facts
   affect compatibility and which are ordinary turn preferences or context.
2. Who captures and owns the authoritative policy at creation.
3. Where it is retained and what permits or refuses continuation.
4. How the assertion-before-acknowledgement interruption preserves the same
   decision, without silently creating a replacement conversation.
5. Any public interface, record or compatibility changes required, including
   how existing histories without the required fact are treated.

Interview the Product Owner on material choices before declaring the amendment
complete. Apply the Architect's system-boundary interview if ownership,
reachability, lifetime or a public/cross-package interface changes. Bring a
concrete recommendation rather than asking the Implementor to invent a policy
channel.

Keep compatible documentation refresh and selected model/effort distinct from
creation policy unless the actual canonical contract establishes otherwise.
Do not hash arbitrary installation functions, treat CLI prose or replaceable
context as authority, or silently widen the conversation/placement interface.
Do not introduce new names without the repository's required description
interview.

## Return and limits

Record the disposition and any accepted amendment in
`.reviewer/issue-883/pr2-recovery-creation-policy-architect-decision.md`.
Return a self-contained Planner handoff with the exact reviewed base, concrete
code/data trace, settled ownership and compatibility rules, any approved
interface changes, and the one representative incompatible/compatible
observation the Planner should assign.

No production implementation is assigned here. Preserve the accepted history
grammar, root evaluation, admission/Pause order, Stop cleanup, Elicit ownership,
feedback, configuration and message association. No broad test battery,
permutation matrix, push, GitHub mutation or CI inspection is authorized.

R2 remains incomplete until this disposition and any required implementation
are accepted. Mounted section 5 integration, owner acquisition, terminal R7/R8
and the 36-frame packet remain separate Planner assignments; this handoff does
not open or redesign them.
