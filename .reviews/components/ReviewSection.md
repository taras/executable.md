---
props:
  type: object
  properties:
    heading:
      type: string
    clean:
      type: string
      default: "\u2705 No issues found."
  required: [heading]
  additionalProperties: false
---

```ts eval
const content = yield* renderChildren();
return content.trim().length > 0
  ? `### ${props.heading}\n\n${content}`
  : `### ${props.heading}\n\n${props.clean}`;
```
