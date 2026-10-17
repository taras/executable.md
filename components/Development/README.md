# Development role components

Read this before delegating repository design, planning, implementation or review.
Use these components to send one request with the repository and role instructions
to a named Codex conversation.

## Applies to

Ordinary XMD documents and REPL entries with the Agent components available and
this repository's `components` directory on the include path. These invocations
belong in an entry, not in a Sidekick response.

## Instructions

Choose `Development.Architect`, `Development.Planner` or
`Development.Implementor` for the corresponding repository role. Each accepts
only these inputs:

| Input | Contract |
| --- | --- |
| `session` | Required string naming the conversation. Use a distinct name for each role. |
| `request` | Required string containing the assignment or review request. |
| `model` | Optional exact provider model ID; defaults to `gpt-6.1-sol`. |

Select the working directory before invoking a role. The component reads
`AGENTS.md` and `.agents/architect.md`, `.agents/planner.md` or
`.agents/implementor.md` from that directory as literal text. Keep Architect and
Planner at the repository root; enter the designated isolated worktree before
resolving Implementor's session. Make the components available through the include
path at every selected working directory.

Each invocation selects Codex and sends one prompt, in this order: the role
introduction, `Repository instructions:` and the complete `AGENTS.md`,
`Role instructions:` and the complete role file, then `Request:` and your request.
Instruction-file markup stays text. A failed turn stops the invocation, so save
a reply only after the invocation succeeds.

Without `as`, the complete reply renders as Markdown. With `as`, the reply is
bound as text and the invocation renders nothing. Save that successful reply
before interpreting it. The caller selects cwd, saves artifacts and decides what
work follows; returned text is not executed by these components.

For a later entry, invoke the same role with the same session name in the same
working directory and pass saved text or paths in the request. Ordinary session
selection also depends on the resolved agent command and compatible retained
provider state. Repeating a label alone does not prove that a conversation
continued. Carry no live Session or Worktree handle between entries.

## Example

Run this entry at the repository root with its `components` include path:

```xmd
<Development.Architect
  session="feature-architect"
  request="Review feedback commit FULL_SHA against the accepted structural checklist in the saved assignment."
  as="architectReply"
/>
<File path="architect-reply.md">{architectReply}</File>
```

The invocation binds the complete successful reply and writes it to
`architect-reply.md`. The reply depends on the conversation; the component adds
no response schema. Substitute the exact reviewed SHA and assignment location
before sending the request.

## Common mistake

Invoking Implementor before entering its worktree selects a conversation in the
wrong directory. Enter the worktree with the existing `Dir` component first,
then invoke `Development.Implementor` there. Pass instruction files with
self-closing `File` reads when composing prompts; invoking `AGENTS.md` as a
component would execute its examples.
