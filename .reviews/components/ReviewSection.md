---
inputs:
  heading:
    type: string
    required: true
  clean: "\u2705 No issues found."
---

```ts eval
const content = yield* renderChildren();
return content.trim().length > 0
  ? `### ${heading}\n\n${content}`
  : `### ${heading}\n\n${clean}`;
```
