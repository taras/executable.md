---
inputs:
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
  ? `### ${heading}\n\n${content}`
  : `### ${heading}\n\n${clean}`;
```
