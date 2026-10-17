# Make conversation choices recognizable

The Product Owner reports that the conversation list's IDs are effectively
indistinguishable. Source inspection confirms that the filter choices render
the provider key itself, rather than a description of the conversation.

Base: d906c6360533aaf894f5424dd4689aceedf08c3b, PR #921. Independent
uncommitted padding corrections are present in application.ts and
repl-presentation-style.test.ts; they are preserved. This assessment changes
neither implementation nor those corrections.

## Current surface

In packages/cli/src/repl/application.ts, sessionRows() gathers the entry and
Sidekick provider keys into one filter list. The conversation choice at
sessions:conversation:<key> displays headline(key), fitted with an ellipsis to
the sidebar. Its action correctly retains the complete key.

This spends the small sidebar's 28 or 32 columns on opaque identity. Provider
keys can share long prefixes, so truncation makes them less distinguishable;
even different suffixes do not tell a person which work belongs to a choice.
The subordinate metadata also shows provider and CLI conversation IDs.

The existing turn rows demonstrate a more useful established pattern:
headline(turn.prompt) for entry work, and a person's saved message for Sidekick
work, with the agent shown as a separate fact. Sidekick automatic feedback is
explicitly classified and is not a person's message.

## Recommended display correction

Label a conversation with its opening user-facing request, with the agent as
secondary text. For entry-agent conversations, use the first retained Prompt
input. For Sidekick conversations, use the first saved person's message, not
the orientation/bootstrap/provider input or an automatic feedback turn.
Use literal retained text, not a generated summary or another agent call.

For example, using the supplied request's literal wording:

```text
Canonical correction for Lio…
  claude
```

Keep full provider and CLI IDs as identity for keys, actions, filtering and
copied locations. Do not infer association from a display title, merge rows
with matching titles, rewrite history or rename a provider conversation.
Display labels should remain the same on cold reopen. Detailed inspection can
expose the full technical IDs where someone needs them; this assessment does
not invent a new details drawer.

The exact fallback for a conversation with no readable opening request, and
the visible distinction between conversations whose request and agent are the
same, remain to be settled with the display design. An opaque truncated ID
should not silently become the primary label again in those cases.

## Evidence and limits

Source inspected: application.ts sessionRows(), ReplAgentTurn/
ReplAgentSession in repl/model.ts, SidekickConversation/SidekickSavedTurn in
sidekick/model.ts, and Core's PromptRecord. The existing projected shapes
already retain input/message text and agent facts. An authored Session name is
not a field of ReplAgentTurn or PromptRecord, so this assessment does not claim
that it can replace the key without further work.

No runtime tests are needed to establish that the label is headline(key).
This is a product-interface assessment, not a completed implementation,
released assignment, or claim that a new label was rendered. No agent call,
personal-history write, GitHub mutation, push or CI inspection occurred.
