# Choose APIs by ownership and intended composition

Read this when choosing between an owned handle, a Context-selected service
and contextual Api middleware. It records an approved architecture pattern and
records existing APIs to revisit later. It does not assign their refactoring.

**Approved, 2026-10-13.** The Product Owner explicitly approves the three rules
and the Code Rule 15 amendment below. They are recorded in the main checkout's
[architecture rules, 23–25](../.agents/architecture-rules.md) and
[AGENTS.md, Code Rule 15](../AGENTS.md). Other API choices remain deferred review
candidates. No production implementation or implementation-worktree edit is
made by this record.

## Applies to

TypeScript architecture and provider integration, including Core/host and
cross-package interfaces. This is not new syntax for Sidekick responses or REPL
entries.

## Approved rules

1. Use methods on an owned handle for operations tied to that instance.
2. Use a Context to select a scoped service; capture it for any lifetime that requires a fixed provider.
3. Use middleware when per-call interception or transformation is an intended extension point.

Each rule is one sentence below 160 characters. The choice follows what callers should be able
to vary, rather than a blanket requirement that callable operations use
middleware.

Core keeps authorization, durable identity, reconciliation and canonical
outcomes with their existing owners. A Context can select a trusted service;
replacing its value does not rewrite the owner's history or constitute proof
that an operation was authorized or completed.

| Need | API shape | Consequence |
| --- | --- | --- |
| Work on one particular execution, conversation or tree | Methods on that owned handle | The caller states which instance the operation belongs to |
| Let the host choose a service for a scope | Context containing the selected service | The consumer captures it for the lifetime that needs a fixed choice |
| Let extensions intercept, transform, refuse or delegate individual calls | Contextual Api middleware | Per-call composition is an intentional product/extension contract |

Capturing a service controls selection for the consumer's lifetime. It does not
make mutable service state immutable or add a live-update protocol. A future
verified configuration update remains an operation on the same owned
conversation, rather than silent retargeting by replacing Context.

## Examples from the current work

The accepted root-evaluation decision put evaluation on HostExecution and
AgentConversation. Evaluation belongs to that particular execution or
conversation, so an owned method fits. It replaced the generatedRoot callback
proposal. See [the accepted handoff](issue-883/root-evaluation-architect-handoff.md).

REPL tree validation similarly belongs on the returned tree, alongside apply;
the caller uses the object that owns reconciliation. See
[the validation review](issue-883/pr2-repl-validation-architect-review-a49229e9.md).

For Sidekick, a provider object selected through Context replaces the proposed
session/prompt inspection direction under these approved rules. The host
chooses the provider and Core holds it for the live conversation. Its existing
configuration admission and canonical recording remain private Core
responsibilities. The concrete four-method interface and integration are in
[the Architect handoff](issue-883/pr2-direct-provider-architect-handoff.md);
the Planner prepares the replacement implementation assignment.

## Align the existing operations rule

Before the approved amendment, AGENTS.md Code Rule 15 said:

> State shared across loaded copies uses stable, namespaced names: plain structural values for composition data and a contextual Api for operations.

That blanket choice conflicted with a Context-selected callable service. The
Product Owner approves its replacement, now recorded in AGENTS.md:

> State shared across loaded copies uses stable, namespaced names. Use owned handles for instance operations, Context for scoped service selection, and contextual Api middleware for intended per-call composition.

Its existing authority constraint remains:

> Security enforcement, durable identity, and reconciliation never trust replaceable context state.

This is an approved general rule change. An implementation worktree receives
the accepted instructions through its normal delivery plan. This record does
not edit that checkout.

## Deferred API review candidates

| API | Evidence of the same design pressure | Question for its later review |
| --- | --- | --- |
| AgentProviders.install | Provider selection uses private inspect/acknowledge exchanges through the registered provider's captured continuation | Does installation need per-call composition, or would scoped provider selection and direct Core-owned installation better express its purpose? |
| Git-host reconciliation routing | One request-only middleware operation reaches an invocation-private terminal through inspect/answer exchanges | Which parts require composition, which select a provider, and which must remain private reconciliation authority? |

These are candidates, not findings or approved rewrites. Their authority,
credential handling, replay and lifetime constraints need their own reviews.
The pattern does not imply that a Context can replace a canonical terminal or
that all existing middleware is wrong. Ordinary Agent operation composition
also needs its own assessment if later work proposes changing it globally.

## Next action

Prepare #883's bounded Planner correction assignment from the Architect handoff.
Keep other API work deferred; no GitHub issue, production
edit, commit, push or CI inspection is assigned here.
