# Writing for agents

These approved rules govern guides and instructions written for agents,
including initial prompts and on-demand reference chapters. They supplement
the general Writing Guide in `AGENTS.md` and the
[product-interface rules](product-interface.md).

Optimize each guide for helping the agent take the next correct action. Keep
the writing human-readable so people can review what the agent is taught.

## Approved rules

1. Lead with when to read the guide and what action it enables.
2. State whether instructions apply to Sidekick responses, REPL entries or both.
3. Give direct instructions explaining what to write, under which conditions and what happens.
4. Show complete, safe-to-copy examples with required bindings and expected results.
5. Pair consequential, likely mistakes with the correct alternative and its practical consequence.
6. Keep one coherent topic per guide and name prerequisite and deeper guides using their exact component invocation.
7. Separate stable rules from current facts and obtain actual paths, capabilities and settings through inspection.
8. Use consistent terminology and ground component syntax in its authoritative reference.

## Common guide format

Use predictable Markdown sections in this order:

- **Title and opening:** when to read the guide and what it enables.
- **Applies to:** the execution contexts covered.
- **Instructions:** the actions and conditions needed to use the topic.
- **Example:** complete source followed by its expected result.
- **Common mistake:** a consequential trap and the correct alternative.
- **Read next:** exact invocations for related guides.

Omit optional sections when they add no useful information. A guide is useful
when an unfamiliar agent can discover it and perform the intended task
correctly with the documented initial context.

## Example guide excerpt

This excerpt illustrates the writing format for the Sidekick bindings chapter;
component availability is determined by the active syntax reference.

````markdown
# Bindings

Read this before using values created by earlier REPL entries.

## Applies to

Sidekick responses and the root bindings inherited by REPL entries.

## Instructions

- Read current published values with REPL.Bindings.
- Use returned binding names in entry source when appropriate.
- Each Sidekick response starts with an empty binding environment.
- Feedback does not automatically create response bindings.

## Example

```xmd
<REPL.Bindings />
```

The host returns a JSON map of published binding names and values
as feedback, then requests your next response.

## Common mistake

Receiving a binding named names does not make {names} available
in your next Sidekick response. It can be referenced inside an
entry that inherits that binding.

## Read next

Read <Guide.Recovery /> when continuing interrupted work.
````
