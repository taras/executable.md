# Section 5 product decisions: Retry and Configure

These decisions complete the product interview for the Configure/Retry slice
prepared at signed clean bb60ca35. They supplement the
[timing ruling](pr2-section5-configuration-timing-architect-decision.md) and
[Planner preparation](pr2-section5-configuration-planner-handoff.md).
They are local feature decisions, not new reusable rules.

## Retry — accepted, 2026-10-14

Retry resends the failed person's request as a new message in the same
conversation. For example, after “Inspect the bindings” fails because the agent
is unavailable, pressing Retry attempts that request again without requiring
another Send. It does not merely check availability.

Use the failed message's saved text, rather than unrelated current composer
text. Keep the old message and failed attempt; allocate the new message and turn
through the existing owner's canonical path. Retry neither switches agents nor
starts a replacement conversation, and it requires explicit activation each
time. The next-turn preference timing also applies to this new attempt.

The existing unknown-acceptance refusal remains: if history cannot establish
whether the previous request was accepted, Retry stays blocked. Identity,
storage and configuration-integrity refusals are not bypassed. Nothing here
authorizes an automatic resend or changes the closed recovery contract.

The Product Owner explicitly accepted this proposal in conversation.

## Apply and Close — accepted, 2026-10-14

Apply saves the choices and closes Configure on success. Close discards unsaved
choices; reopening shows the saved preferences. If Apply fails, Configure stays
open and shows the reason.

Closing alone performs no save or provider change. Successful model/effort
Apply means the preference was acknowledged, not that it was already applied
to the provider: the accepted next-turn timing still governs that work. Agent
Apply keeps the existing explicit new-conversation and Stop/join behavior;
failed setup preserves the old active conversation and leaves the drawer open.

The Product Owner accepted these Apply/Close semantics in conversation.

## Continuity

Retry, Apply/Close and preference timing are settled. No product question
identified by the preparation remains unanswered. The Planner incorporates
these answers, freezes the bounded matrix and releases the self-contained
Implementor assignment. Use the
[Planner continuation prompt](pr2-section5-configuration-planner-prompt.md).
No implementation change, test, commit, push or delivery action is made here.
