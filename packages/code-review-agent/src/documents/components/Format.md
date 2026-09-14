---
props:
  type: object
  properties: {}
  additionalProperties: false
description: >-
  Reformat its content as Markdown. `<Format>…</Format>` renders the content,
  normalizes it through remark and trims the result.
context: >-
  The Markdown to reformat.
---

```ts eval
import { remark } from "npm:remark@15";

const content = yield* renderChildren();
const file = yield* call(() => remark().process(content));
return String(file).trim();
```
