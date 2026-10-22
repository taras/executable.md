---
required: [input]
props:
  input:
    type: string
returns:
  type: string
---

<OwnerLeaf input={props.input} as="nested" />
<Return value={nested} />
