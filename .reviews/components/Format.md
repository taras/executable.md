---
inputs: {}
---

```ts eval
import { remark } from "npm:remark@15";

const content = yield* renderChildren();
const file = yield* call(() => remark().process(content));
return String(file).trim();
```
