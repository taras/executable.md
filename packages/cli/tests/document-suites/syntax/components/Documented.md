---
description: Greets the person a caller names.
as: The rendered greeting.
context: Markdown appended after the greeting.
props:
  name:
    type: string
    description: Who to greet
required: [name]
---

Hello, {props.name}.

<Content />
