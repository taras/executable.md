---
description: >-
  Read HEAD and tracked changes in the assigned checkout. Use <Ticket.Checkout
  repository={assignment.repository} as="checkout" /> before checking a phase revision.
props:
  type: object
  properties:
    repository: {type: string, pattern: '^/'}
  required: [repository]
  additionalProperties: false
returns: {type: object}
---

Use the repository selected by this entry's original workspace or its enclosing
Repository/Worktree. Enter the assigned checkout without creating or switching it.

<Dir path={props.repository}>
<Git.Changes compare="staged" as="staged" />
<Git.Changes compare="unstaged" as="unstaged" />
<Return value={{head:staged.comparison.base,clean:staged.changes.length === 0 && staged.next === null && unstaged.changes.length === 0 && unstaged.next === null,staged,unstaged}} />
</Dir>
