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
The staged and unstaged reads run together, because neither depends on the other.

<Dir path={props.repository}>
<Ticket.CheckoutReads as="checkout" />
<Return value={checkout} />
</Dir>
