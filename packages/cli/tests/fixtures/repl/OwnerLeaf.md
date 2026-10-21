---
required: [input]
props:
  input:
    type: string
returns:
  type: string
---

<Elicit schema={{type: "string"}} as="answer">{props.input}</Elicit>
<Return value={answer} />
