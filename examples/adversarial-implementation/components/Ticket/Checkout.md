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

The staged and unstaged reads do not depend on each other, so they run at the
same time. Each read renders its result as JSON, and `<All>` joins the two in
the order they are written, staged first, whichever finishes first. The pair is
parsed back into values for the same result a serial read would return.

<Dir path={props.repository}>
<Let as="rendered">
<All>
<Spawn>
<Git.Changes compare="staged" as="staged" />
<Json value={staged} />,
</Spawn>
<Spawn>
<Git.Changes compare="unstaged" as="unstaged" />
<Json value={unstaged} />
</Spawn>
</All>
</Let>
<Let as="json" value={"[" + rendered + "]"} />
<Parse schema={{type:"array",minItems:2,maxItems:2}} as="pair">{json}</Parse>
<Let as="staged" value={pair[0]} />
<Let as="unstaged" value={pair[1]} />
<Return value={{head:staged.comparison.base,clean:staged.changes.length === 0 && staged.next === null && unstaged.changes.length === 0 && unstaged.next === null,staged,unstaged}} />
</Dir>
