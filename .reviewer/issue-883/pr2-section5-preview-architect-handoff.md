# Next slice: show Sidekick Output while its response arrives

**Resolved and assigned, 2026-10-14:**
[the Architect decision](pr2-section5-preview-architect-decision.md) settles
the requested boundary. Execute [the Implementor prompt](pr2-section5-preview-implementor-prompt.md)
under [the frozen plan](pr2-section5-preview-planner-handoff.md) from signed
clean 81523318. The preparation below records the source trace and questions,
not a remaining blocker.

Resolve the observation boundary for streamed Preview before the Planner issues
the next Implementor assignment. Product behavior and the pure Core preview
reader are already accepted. The missing decision is how the CLI receives live
source from a saved conversation after the accepted direct-provider correction,
under that conversation execution's disclosure policy.

This is architecture preparation only. It opens no implementation or capture.

## Exact base and accepted work

Implementation worktree:
`/Users/tarasmankovski/Repositories/taras/executable.md/.claude/worktrees/issue-883-pr2`.
Branch agent/issue-883-pr2, exact signed clean head
`815233183c7c26cd40544347191b7ba5e1f975c3`, parent
`57773de05246578da77c0f8689fbee004cbd84b4`, signature G,
signer tarasm@gmail.com. The Planner verified this state while preparing the
handoff. Nothing is pushed.

[Configure/Retry is accepted](pr2-configuration-planner-review-81523318.md).
All earlier configuration, provider routing, identity, admission, recovery,
message, Stop and question findings stay closed. This is deferred work, not a
new defect in that accepted slice.

Planning artifacts live in the main checkout at
`/Users/tarasmankovski/Repositories/taras/executable.md/.reviewer/issue-883`.
Main is e61d6ce072735b5d0cf683eeaca0f2eefddc2d59 with unrelated local edits.
Do not import or alter those edits. No production file was changed in preparing
this handoff.

## Settled experience

Read the governing accepted contracts:

- [Streaming preview and final text](architecture-review.md#accepted-streaming-preview-and-final-text).
- [The canonical preview interface](core-interfaces-proposal.md#2-safe-streaming-preview).
- [Journey 4](remaining-architecture.md#accepted-journey-4-streamed-chat-and-operation-feedback-stay-distinct)
  and [Journey 11](remaining-architecture.md#accepted-journey-11-correct-ordinary-failures-and-pause-provider-failures).
- The conversation cycle, section 4, R5/R6 and V03 in
  [the main plan](planner-handoff.md).
- [The accepted direct-provider plan](pr2-direct-provider-planner-handoff.md),
  especially DP2 and DP4. Architecture rules 23–25 remain governing.

While a response arrives, only recognizable literal top-level Output text is
shown as Preview. Computed content, interpolation and component-produced text
wait for evaluated results. Candidate controls do nothing while generation is
partial, even if the current prefix happens to be syntactically complete.

Preview remains Preview during response execution. On settlement, canonical
evaluated Output replaces it in the same response item. Provider failure or Stop
leaves shown Preview labelled Incomplete and runs no candidate controls. A
runtime failure instead shows actual evaluated partial Output and its truthful
failure. Controls-only replies produce no fallback body chat. Feedback stays
separate from chat, and provider failure waits for explicit Retry/message.

Use previewGeneratedXmdRoot() on the complete accumulated prefix. The CLI adds
no scanner, tag regular expression, source repair or evaluator. Identical
prefixes have the same projection regardless of transport splits. Preview
grants no authority and must cross the existing disclosure policy before
presentation. Generic Output remains buffered.

No new product interview is requested. If tracing reveals a genuinely unsettled
product choice, identify it separately rather than choosing it in the ruling.

## What the current code supplies

All source paths below are relative to the implementation worktree.

1. `packages/core/src/generated-xmd-preview.ts` implements the accepted pure
   preview operation, exported through Core's host surface. Its tests already
   cover incomplete syntax, passive fences, computed portions and chunk splits.
2. `packages/cli/src/repl/sidekick/owner.ts`, respond(), calls handle.prompt()
   and receives its completed Result. It has no live source reading today.
   Its existing changes stream wakes the root after detached facts change.
3. `packages/core/src/agent/conversation.ts`, conversationTurn(), calls the
   captured AgentConversationProvider directly. Its canonical runPrompt() call
   remains inside persistPrompt(). Completion evidence, activation, native
   identity and configuration comparisons are distinct accepted checks.
4. `packages/core/src/agent/function-components.ts`, runPrompt(), is the common
   canonical consumer for ordinary Prompt and direct conversation turns. It
   consumes started/text_delta/terminal events. The direct path wraps the
   provider stream in auditedPromptStream().
5. `packages/core/src/agent/publication.ts` exposes begin(input) and
   publish(publication) to trusted hosts. begin() supplies a host-owned opaque
   handle that returns at publication. There is no intermediate event callback.
   Publication still requires the exact durable append, once.
6. `packages/cli/src/repl/agent.ts` observes ordinary Agent.prompt middleware
   by wrapping the cold stream and forwarding its events and return unchanged.
   That middleware is bypassed by saved conversations. Installing it around
   owner.message() therefore supplies no direct-path observation.
7. `packages/core/src/execute.ts`'s DocumentOutput bridge uses the package-private
   clearsLiveOutput() in `src/secrets/policy.ts`. The durable journal has its own
   pre-append gate. Public secretPolicy()/scanSecrets() resolve the authenticated
   policy of the execution in which they run; reading them in the CLI root is
   not proof that the conversation execution cleared candidate text.
8. `packages/cli/src/repl/program.ts`, sidekickReadingOf(), currently derives
   chat from acknowledged history. application.ts's sidekickItems() draws it.
   The incomplete history item contains failed source, but its current row
   shows the failure, not a safe literal Output projection.
9. `packages/cli/tests/support/fake-acp.ts` currently emits a scripted reply
   as one delta; held turns hold before any text. Incremental held-after-delta
   transport evidence will need a small extension at this existing fixture.

The original plan's instruction to subscribe to canonical prompt observation
before starting a turn is still required. It does not name an observation seam
that can supply intermediate source on this base. In particular, ordinary Agent
middleware must not be restored as the saved-conversation route to obtain it.

## Decisions requested

Return a decision-complete boundary for these linked questions:

1. **Where observation happens.** Choose how a trusted host receives source
   from the canonical direct turn. State whether the existing host publisher
   gains a narrowly scoped observation member or a different existing seam is
   sufficient. If an interface change is needed, name the exact members, types,
   export and installation site. If a selected-provider decorator is preferred,
   state why it preserves the accepted captured-provider and audit contracts;
   do not leave that judgment to the Implementor.
2. **Which turn it describes.** Bind each notification to the exact canonical
   turn and Sidekick response that owns it. Reuse existing lifetime/handle
   evidence where possible. Text, predicted turn ordinals and the next matching
   input cannot identify it. State how live Preview and acknowledged reply
   become one item, including successive automatic turns and late notifications
   after Stop or agent replacement. No second durable ID or record is proposed.
3. **Disclosure before presentation.** Name the execution and point at which
   accumulated candidate text is cleared. Cover findings, scanner failure and
   unavailable/counterfeit policy without exposing raw source or secret matches.
   State whether rejection withholds live presentation while the existing
   journal gate retains failure ownership. Do not export a scanner or private
   policy, scan each delta independently as if chunk boundaries were meaningful,
   or disable detection for the feature.
4. **Lifetime and observation failure.** Preserve one cold subscription, exact
   provider event/return forwarding, direct-path permission audit, and joined
   cancellation. State whether observation may suspend the consumer and how an
   observer failure is handled without becoming a fabricated provider terminal
   or losing durable failure classification. Ordinary turns and hosts without
   observation preserve their behavior.
5. **Incomplete presentation and saved facts.** State what remains process-local
   after Stop when cancellation writes no turn record, and what a cold reading
   may reconstruct from a canonical failed record when one exists. Show safe
   literal Preview rather than raw generated source. Do not invent a completed
   turn, response record, acceptance or automatic resend to preserve a screen.

Recommendation: keep observation at the canonical runPrompt() consumer, with
correlation based on the existing host begin handle and disclosure performed
inside the owning execution before candidate text reaches the screen. Preserve
publication as the durable acknowledgement boundary. The Architect chooses the
smallest concrete host surface and its failure semantics; the Planner does not
authorize a new public API by this recommendation.

## Finite evidence for the subsequent Planner assignment

The following are proposed observations for the already accepted J4/J11
contract, not an implementation assignment or a new permutation matrix:

- Hold a real direct-provider turn after literal Output and candidate fill/read
  controls arrive. With no terminal input, show Preview once, unchanged draft,
  no control pair/effect, editable unsent message and Stop. Release successful
  generation and separately hold response execution; only its settlement
  replaces the same item with evaluated Output. Ordered designated feedback
  reaches the next turn without becoming chat.
- Split representative prefixes inside an Output delimiter, an expression and
  a passive fence. Compare the mounted candidate with Core's established pure
  projection; computed text waits and controls-only source yields no fallback
  chat. Reuse existing Core parser rows rather than duplicate their corpus.
- Fail generation after text, and Stop after text as its cancellation pair.
  Both show Incomplete, evaluate nothing and start no automatic successor.
  Preserve existing Stop join/entry-independence and Retry semantics. A later
  runtime failure remains evaluated partial Output, with prior effects intact.
- Exercise the chosen disclosure seam with an accumulated secret-bearing
  candidate and its cleared control in the owning execution. Reuse existing
  policy tests for authentication/failure semantics; nominate only the extra
  structural evidence the new seam actually requires.
- Check one stable response item across the live-to-retained transition and
  no stale Preview after a stopped cycle is followed by new explicit work.
  No input is required to receive updates; hidden panes have no targets; both
  composers, History and focus survive ordinary resize/tab changes.

The Planner freezes exact rows, controls and focused commands after the ruling,
using mounted-program.ts, the real owner/profile/repository/Core evaluator and
the existing fake transport. No second terminal host or evaluator. Preserve
DP2/DP4, C2, R2 and accepted mounted/configuration assertions. Full R5–R8 and the
36-frame packet remain separate completion work.

## Required return and limits

Follow .agents/architect.md and the repository instructions. Trace these paths
at the exact base; use a focused isolated probe if needed and preserve its first
output. Record the accepted boundary and Planner handoff as
`.reviewer/issue-883/pr2-section5-preview-architect-decision.md` in the main
checkout. Name exact source/public-contract changes, ownership, disclosure,
failure/cancellation semantics and the finite evidence consequences.

Leave implementation unchanged. No provider rerouting, broader session
authority, new journal grammar, Sessions work, capture, dependency changes,
push, GitHub write or CI inspection. Do not reopen accepted findings.

Continuity: exact base 815233183c7c26cd40544347191b7ba5e1f975c3; produced artifacts
are this handoff and pr2-section5-preview-architect-prompt.md. Product Preview
behavior is settled. Observation/disclosure/lifetime mechanics require the
Architect's ruling. Next action belongs to the Architect, then the Planner
freezes a bounded Implementor assignment from this same accepted base.
