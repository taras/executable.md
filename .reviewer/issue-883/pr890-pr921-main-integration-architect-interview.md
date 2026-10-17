# #890 / #921 integration: review the evaluation call first

Status: completed by the
[integration architecture decision](pr890-pr921-main-integration-architect-decision.md).
Control capture at chat opening is accepted by the Product Owner. Saved-chat
continuity is an existing requirement, not a pending Product Owner choice.
This note records the interview; it is not an implementation/rebase assignment.

Input: [integration handoff](pr890-pr921-main-integration-architect-handoff.md).
The committed references remain main `986948eabd070c0ae7354c2a0db8df7feed63621`,
PR1 `79d404d04d02c3840892473b6f1b2cf540f3edd1`, and PR2
`940249af47159a3bbd960b8ca8df3f10bb53811c`.

## First decision: establish each chat's controls at setup

The current Sidekick evaluation supplies definitions on every call:

```ts
yield* conversation.evaluateGeneratedXmdRoot({
  id: response,
  source: reply,
  observations: ceiling.observations,
  mutations: ceiling.mutations,
  allow: ["read", "write"],
});
```

Main instead captures the selected components once, during execution setup,
before public execution policy or document work. The accepted integration uses
that existing mechanism for the conversation's own REPL controls. Subsequent
calls supply the program rather than its implementations:

```ts
yield* conversation.evaluateGeneratedXmdRoot({
  id: response,
  source: reply,
  allow: ["read", "write"],
});
```

The accepted public request members are `id`, `source`, optional `allow`, and optional
diagnostic `position`. The host execution and conversation retain their existing
bound evaluation methods. The pure source-only preview remains separate.
Per-call component tables are removed from the public request; they are not
restored through a legacy export or a second selection channel.

Each conversation installs its own control implementations and complete
Component.generated selection through its existing trusted installations.
Core captures those exact definitions in that conversation's execution. It
does not borrow the REPL entry's selection or another conversation's controls.
Each response still owns its control journal and feedback. Capturing definitions
once must not freeze those records onto the first response: response association
stays with the existing owner and changes only for the active response, through
joined evaluation and cleanup. It is not taken from replaceable caller context.

Actual effects continue to meet the live provider and Permissions checks.
Changing the setup API does not restore generic request inventories or retained
Workspace comparisons. Source-only preview authorizes no control invocation.

This public boundary change triggers the system-boundary review required by
.agents/architect.md. The Product Owner accepted capturing the controls at chat
opening instead of supplying them on every call, answering “yes” to the concrete
call and setup proposal. This settles that interface amendment; no new reusable
rule is inferred.

## Remaining interview inventory

1. Control capture and the request-only evaluation call above are accepted.
   Carry their exact signatures and surviving exports into the final ruling.
2. Settle the closed root/fragment record shapes and compatibility. Main's
   marker-4 fragment reader already refuses older admission formats; roots must
   remain distinguishable without accepting missing authority fields. Historical
   chat inspection, new turns, and replaying an old admission are separate paths.
3. Reconcile Syntax and errors. Both scopes can use main's descriptive narrowing
   while preserving the bound owner's documentation and exact invocation route.
   Preserve the accepted root `output` versus fragment `throw` distinction,
   partial root rendering, and authoritative integrity/policy/teardown failures.

## Existing requirement: keep saved chats usable without replaying old replies

Preserve existing Sidekick messages, response outcomes, and entry
results for inspection, and allowing an otherwise valid saved conversation to
receive a new turn after the update. The existing provider identity and
configuration checks still apply. Reopening does not rerun a completed response
or continue an interrupted response's program; the next explicit response uses
a fresh evaluation sequence and the current captured controls.

This distinction follows the existing bound-root owner. generated-root-owner.ts
partitions explicit evaluations into `generated_root:N` sequences and allocates
the next address past all retained ones. It does not restore an old response's
admission when starting a new evaluation. conversation.ts's openable() reads
canonical turn identity and configuration separately. Therefore keeping old
chat history and allowing a new turn does not require treating an older
generated admission as current authorization.

Keep main's existing marker-4 fragment continuation contract. Its untagged,
marker-2 and marker-3 predecessors remain refused if an execution attempts to
restore those admissions. Preserve completed-document replay's existing bypass;
do not turn this into a new blanket rejection of historical inspection.

Format direction for the final integration ruling:
retain the exact closed marker-4 fragment shape and add a separately marked
root shape. Do not add members to marker 4 or rewrite saved records. Earlier
root records remain historical evidence, not input to a new root evaluation.
The final ruling must show the closed examples and exact context checks.

The Architect incorrectly presented this as a new product question. The Product
Owner had already settled that reopening a REPL session reopens its Sidekick.
The internal admission format must preserve that behavior; it does not create
a new choice about whether saved chats should survive an upgrade. No additional
approval is required to preserve the contract.

The final ruling needs closed serialized examples and a complete history
disposition. This preparation note does not select a new marker, amend old-
history compatibility, release implementation, or replace the Planner's hold.
The Parse follow-up and REPL presentation work remain outside this integration.
The separately evidenced submission-identity correction is recorded in
[the agent-feedback scope return](pr921-agent-feedback-scope-architect-return-940249af.md).

Only committed source and local review records were read. No production source,
branch, worktree ownership, dependency state, GitHub record, or CI state changed.
