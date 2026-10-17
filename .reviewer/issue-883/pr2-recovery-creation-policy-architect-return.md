# Architect return: identify the retained creation-policy boundary for R2

**Resolved architecture referral, 2026-10-12:** the accepted
[session configuration amendment](pr2-recovery-creation-policy-architect-decision.md)
and [Planner handoff](pr2-session-configuration-planner-handoff.md) settle this
boundary at b01bbe6c. The values are configuration, not policy. Implementation
and R2 completion remain pending. The earlier return below is historical.

Review the existing #883 Sidekick creation-policy requirement at exact head
`14ee0d8ed2cf98468e8968fa766f2fb5bfafecf9`, parent 2cd17192. Do not implement
or change the pending work. The Planner's companion review is
pr2-recovery-planner-review-14ee0d8e.md.

The accepted remaining-architecture.md provider-association section requires
comparison of provider, resolved agent command, tagged native identity and
creation policy before continuation. storage-contract.md retains the same
requirement. core-interfaces-proposal.md's installations member says the
assembly retains the policy needed for strict reattachment comparison. The
R2 case-2 matrix includes incompatible creation policy refusing replacement.

The Implementor proposes treating a history bound to another id or agent as
this policy refusal. Core bindConversation retains {id, agent} and checks those
two values; openable checks native identity assertions among Prompt records.
Neither cited check compares creation policy. They remain required checks,
but a policy can change while both id and agent stay the same.

Please identify the existing canonical policy value and retained comparison
used by Sidekick's actual ACP-first conversation path, including the location
and one same-id/same-agent incompatible-policy observation that discriminates
it. If the path already enforces the accepted requirement, return the concrete
seam and the finite evidence needed for the Planner to freeze its test.

If that boundary is absent, return the smallest explicit architecture amendment
for who captures the policy, what compatibility means, where it is retained and
which canonical owner refuses before replacement or a new provider turn. Keep compatible
orientation refresh separate from creation policy. Do not derive authority from
CLI prose, hash arbitrary installation functions, use replaceable context as a
policy account, or silently broaden the public conversation/placement request.
Any material interface/ownership choice needs the Architect's normal interview
before it becomes an implementation assignment.

This is not an invitation to add a policy permutation matrix or reopen accepted
configuration, Stop, Elicit, feedback, admission or R2 cases 1/3/4. The next
Planner action is to incorporate a concrete existing-boundary ruling or an
accepted amendment into the finite R2 correction. Until then the Implementor
may correct the independently demonstrated reporting/reconciliation gaps and
the actual assertion-to-mapping interruption test under the companion prompt,
but may not invent a policy channel or declare R2 complete.

Exact reviewed head is 14ee0d8e; latest accepted increment is 2cd17192. No
production change, push, GitHub mutation or CI inspection is authorized here.
