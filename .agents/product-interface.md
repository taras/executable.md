# Product interface

This rulebook governs the words and structures a person or agent must type or
read while using XMD. Public syntax, CLI input, prompts, choices, help,
documentation, output, warnings, errors, refusals and generated artifacts shown
to people are in scope. Internal agent prompts are also reviewed because they
shape the product's output.

Component descriptions also follow the specialized additions in
[component-descriptions.md](component-descriptions.md).

## Approved rules

1. Design public XMD interfaces so people understand what to write, what will happen, what it affects and what they receive.
2. Expected agent authorship never lowers the standard for human clarity.
3. Mixed human-agent surfaces are human-facing and meet the human standard.
4. Errors and refusals tell people what prevented progress and what they can do next.
5. Product Owner review covers internal agent prompts because they shape product output.
6. Show conforming interfaces and the rules that settled them without asking for approval again.
7. Review unresolved interfaces with the Product Owner one at a time.

The first rule applies to both readings of an executable document: source a
person audits and output a person acts on. Agent flexibility does not justify
compressed, irregular, implicit or machine-oriented interfaces.

## Feature review

The Architect inventories every interface a feature adds or changes. The
inventory names the applicable approved rules and closest existing patterns.
Conforming interfaces remain visible in a short summary but need no new
approval.

Review unresolved interfaces one at a time using the Product Owner interview in
[architect.md](architect.md). For a new interface, **Current** shows the closest
established pattern. **Proposed** shows the exact shape and wording together.

Feedback applies first to the feature. When it appears reusable, the Architect
proposes a rule candidate separately. Only explicit Product Owner approval
promotes it into this file.
