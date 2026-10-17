# Architect handoff: configure the next Sidekick turn while work is pending

**Resolved, 2026-10-14:**
[the timing ruling](pr2-section5-configuration-timing-architect-decision.md)
settles this return. The Planner has incorporated its ownership, ordering and
finite evidence into the preparation record. The text below is the request
history, not an outstanding Architect assignment. Retry and Apply/Close were
subsequently settled in [the product decisions](pr2-section5-configuration-product-decisions.md).
[The frozen plan](pr2-section5-configuration-planner-handoff.md) and
[Implementor prompt](pr2-section5-configuration-implementor-prompt.md) release
the bounded assignment from bb60ca35. No question from this return remains open.

The next mounted slice needs one architectural reconciliation before the Planner
can issue its Implementor assignment. The accepted product contract allows saved
model/effort changes to affect a pending automatic follow-up without stopping
current work. The accepted owner implementation refuses every such change while
busy. Do not resolve that conflict by disabling the mounted controls.

## Exact base and limits

Inspect signed clean `bb60ca35661c2988ef647cc7a456470482d06e2e`, parent
`2f3af332e09a7aa8e6acda6e51e1f63aab13614e`, branch agent/issue-883-pr2, in
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
The Planner verified HEAD, signature G, tarasm@gmail.com and clean status.

Planning documents live in the main checkout under .reviewer/issue-883.
Follow .agents/architect.md. Leave the implementation worktree unchanged.
No push, GitHub mutation, CI inspection or capture is assigned.

Configuration P1/P2, direct-provider routing, native identity, recording,
activation, R2 and the mounted message/question acceptances remain closed.
This return concerns the CLI owner's configuration timing only.

## Governing contract

[Accepted model/effort timing](architecture-review.md#accepted-modeleffort-timing-and-retention)
states that saved preferences apply to the next provider turn without
interrupting a generating response, executing response or admitted entry. It
explicitly includes an automatic follow-up after an entry's completion.
[J9](remaining-architecture.md#accepted-journey-9-configure-sidekick-independently-of-entry-agents)
and [the planning packet](planner-handoff.md#questions-selection-and-presentation)
carry that behavior forward.

The separate accepted busy agent action is Stop and start new conversation.
It joins Sidekick before switching, preserves an admitted entry and old chat,
and sends no model prompt until explicit work. That action does not make Stop
a prerequisite for changing model/effort preferences.

## Current implementation evidence

At the exact base:

- `packages/cli/src/repl/sidekick/owner.ts`, options(): refuses while busy;
  otherwise uses the conversation's explicit inspection operation.
- configure(): also refuses while busy. Otherwise it obtains holding(), writes
  one preferences record for that conversation and refreshes. It does not apply
  settings to the provider.
- select(): refuses while busy; after Stop it prepares and inspects a new
  conversation, activating only on success. Failure retains the old association.
- respond(): captures `const current = reading` at entry, then passes
  `desired(current.value, conversation)` to handle.prompt() later. A ruling must
  name when a saved preference becomes the next turn's request; removing the
  busy guard alone does not settle that ordering.
- `packages/cli/tests/repl-sidekick-configuration.test.ts`, row "configuration
  while the Sidekick is working is refused rather than queued", explicitly
  asserts configure() refuses, preferences stay absent, and configuration is
  accepted only after Stop. This was accepted evidence, not a mounted test
  artifact. Any changed assertion requires an explicit disposition here.

No probe is needed to establish this conflict: the accepted contract, branch
condition and assertion directly disagree. No runtime test was run for this
read-only handoff.

## Requested ruling

Preserve the accepted product behavior. Specify the smallest CLI ownership and
ordering correction that permits saving a preference for an already active
conversation while Sidekick is busy, without issuing overlapping provider work,
stopping its cycle or queuing another message.

Resolve these concrete boundaries:

1. Separate retaining preferences from provider inspection. Identify what can
   be saved while busy using already advertised choices and what happens when
   fresh model-dependent effort inspection is unavailable. Do not silently
   substitute an effort level or add a second provider route.
2. Name the exact point at which a next turn reads the acknowledged preference.
   A held entry followed by automatic feedback must use a preference saved
   before that turn begins. A preference saved later belongs to a later turn;
   it must not alter a request already handed to the provider.
3. Keep the chat writer, conversation association, Stop and command shutdown
   owned by their existing scopes. Identify serialization needed for preference
   writes versus message/feedback writes and agent replacement.
4. Authorize the precise adaptation of the existing busy R7 row, preserving its
   inspection and agent-switch refusals wherever they remain required.
5. Give the Planner finite evidence: a held-entry next-follow-up regression and
   its unchanged-settings control, plus any separate structural observation
   needed for cancellation or conversation binding. Do not expand into a timing
   permutation matrix.

The Planner recommends keeping provider inspection subject to the existing
single-operation boundary and treating preference retention as a separate,
conversation-bound write. This is a recommendation, not an Implementor decision
or an authorization to change Core's conversation mailbox.

## Separate pending product question

Retry is explicit and targets the same conversation. The accepted text does not
say whether its activation sends the failed person's request again as a new
message or only checks availability and waits for Send. The Planner has asked
the Product Owner this question and has not received an answer. Do not choose
the chat/message behavior in this ruling. Retry also cannot bypass unknown
acceptance, identity, storage or configuration-integrity refusals.

## Return

Write the decision and Planner instructions to
`.reviewer/issue-883/pr2-section5-configuration-timing-architect-decision.md`.
State the existing contract being restored, the required source boundaries,
the authorized test adaptation and finite evidence. No implementation is
assigned by this return.

Continuity: base bb60ca35; this handoff and
[the preparation record](pr2-section5-configuration-planner-handoff.md) are the
produced artifacts. The Implementor holds clean. Next action is the Architect
timing ruling and the Product Owner's Retry answer, followed by the Planner's
frozen Implementor assignment.
