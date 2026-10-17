---
returns:
  title: { type: string }
  steps: { type: number }

props:
  type: object
  properties:
    title: { type: string }
    steps: { type: number }
  required: [title, steps]
  additionalProperties: false
---

A value component renders nothing, so this paragraph never reaches the caller.
Its own `<Let>` is here so a row can check that a component's local binding
stays the component's: `shapeLocal` is written inside this body and is not a
root value of the entry that invoked it.

<Let as="shapeLocal" value="inside the component" />

```ts eval
const shape = { title: props.title, steps: props.steps };
```

<Return value={shape} />
