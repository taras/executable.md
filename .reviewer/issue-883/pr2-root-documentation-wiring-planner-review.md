# Review of the root documentation wiring proposal

**Resolved architecture:** the Product Owner accepted
[the bound execution/conversation interface](root-evaluation-architect-handoff.md).
The [Planner implementation amendment](root-evaluation-planner-handoff.md)
now supplies the next action and E1–E9 evidence. The original proposal review
below is historical; its request for another architecture proposal is closed.
This does not accept the implementation at 8be2d2bc.

REQUEST CHANGES to
[pr2-root-documentation-wiring-proposal.md](pr2-root-documentation-wiring-proposal.md).
Read against `8be2d2bc3c38c4a896d0b678e121beef28e02920`, parent
`91eb10bd14b279dc764958972c401810a77f230d`. No implementation is reviewed here.

The diagnosis of the private reference is sound. Reusing
`site.syntax.available(admittedSymbols(...))` preserves the execution's captured
index through the existing reference mechanism. Recollecting middleware,
recovering raw contributions and replaceable context remain rejected.

The proposed mailbox route is not yet decision-complete. It changes more than
the internal declaration of AgentConversationHost and needs an explicit
interface/ownership decision before implementation.

## 1. Specify how the CLI requests the evaluation

The accepted AgentConversation handle has exactly `prompt` and `options`.
The actual `handle()` in conversation.ts exposes those two methods, and its
private queue is not available to the CLI. Adding a third internal job kind
does not provide a caller-facing path to enqueue it.

The proposal must name the exact call from the CLI response owner to that job.
If that requires another handle member, request/installation member or host
operation, it is an amendment to the accepted Core interfaces. It cannot be
described as private plumbing with the public surface unchanged. If an existing
conforming call can reach it, identify that call and its owner without an ambient
authority lookup.

The response execution also needs its own fresh durable sequence and cancellation
join. Serving it inside the conversation mailbox must not make it replay an
unfinished response suffix, queue behind another admitted job, or finish caller
Stop before its controls and cleanup have joined. These are existing C3 and
response-owner requirements, not new lifecycle cases.

## 2. Core must pass the exact execution-minted Syntax implementation

Choose a Core-private handoff of the exact definition installed for that
execution rather than a general public accessor for the protected table. That
settles the preference in the proposal, but the source of the handoff must still
be specified.

`SYNTAX_PROTECTED` is a declaration. `installIdentities()` mints a domain and
builds an inert implementation for that execution, storing it in
`identity.protected`. `narrowComponentRouting()` keys by that exact function
object. Naming or importing the static declaration does not recover it, and
building another wrapper/domain would not be the existing route's implementation.

Name the canonical owner and private call boundary carrying that exact
definition beside the captured reference. Do not publish the protected table,
claimant, domain or raw documentation index to document code.

Making AgentConversationHost protected is acceptable only as part of a resolved
Core ownership design. The present proposal does not establish how it is
installed or selected. Do not add the synthetic host to the global protected
component catalog: that catalog claims public names in every execution, while
this host currently belongs to its own synthetic conversation root. Any change
to those visibility/resolution rules needs explicit Architect resolution.

## 3. Resolve the public operation and fallback together

The proposal says the public siteless operation keeps its current behavior, but
also deletes `installScopedProtected`, which currently supplies that behavior.
Specify what installs/routes canonical Syntax for that remaining path.

A host evaluating source that never asks for Syntax must continue to work.
That fact does not settle the named-reference contract for a source that does
ask. The Core-only fallback has not been accepted as a replacement for an
execution's composed captured reference. Routing the CLI elsewhere cannot
silently redefine the standalone operation's guarantee.

## Architect resolution prompt

Resolve the remaining Core ownership/interface amendment for #883 root Syntax.
The current public `evaluateGeneratedXmdRoot(request)` has no protected site;
the accepted AgentConversation handle contains only prompt/options. The proposal
would protect the synthetic conversation host and run response evaluation as a
mailbox job so it can narrow the execution's captured SyntaxReference. Specify
the exact caller-facing path for that job, including any explicit amendment to
the accepted handle/host surface, or provide a conforming private path using the
existing surface. Specify how canonical execution hands over its exact minted
Syntax definition without publishing the protected table or making the synthetic
host globally available. Settle the standalone public root's Syntax/fallback
behavior and routing. Preserve fresh response durable sequences, cancellation
joins, no suffix replay, captured package documentation and released fragment
behavior. No mutable context or runtime middleware recollection may carry the
authoritative reference. Keep this within PR 2; no third PR is needed.

Return one chosen design and its exact API/private boundary inventory. Then the
Planner can update the handoff and finite evidence mapping before implementation.
Do not ask the Implementor to choose these ownership/interface terms while coding.

## Evidence and continuity

This is a source/proposal review only; no test result is claimed for the design.
The known implementation HEAD remains 8be2d2bc. Its prior focused tests/probes
pass, but its Core-only index limitation remains unaccepted. The untracked
`sidekick/gate.ts` is untouched and outside this review.

No production files, CI or GitHub state were changed. The existing implementation
criteria remain in force. Next action is the Architect resolution above, followed
by a decision-complete amended wiring proposal and implementation. Earlier
accepted storage, projection, recovery, controls and scoped Syntax behavior
remain accepted.
