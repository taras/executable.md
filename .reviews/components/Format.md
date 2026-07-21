---
inputs:
  type: object
  properties: {}
  additionalProperties: false
---

```ts eval
import { remark } from "npm:remark@15";

const content = yield* renderChildren();
const file = yield* call(() => remark().process(content));
return String(file).trim();
```
