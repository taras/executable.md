---
description: 'Render task checkboxes in the supplied order. Use <Checklist items={[{ text: "Review the design", done: true }]} />.'
props:
  type: object
  properties:
    items:
      type: array
      items:
        type: object
        properties:
          text:
            type: string
          done:
            type: boolean
        required: [text, done]
        additionalProperties: false
  required: [items]
  additionalProperties: false
---

<Output><Each in={props.items} let="item"><If condition={item.done}>- [x] {item.text}
<Else>- [ ] {item.text}
</Else></If></Each></Output>
