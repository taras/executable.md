---
inputs: {}
---

```ts persist eval
import { remark } from "npm:remark@15";

yield* Sample.around({
  *sample([context], next) {
    const result = yield* next(context);
    const file = yield* call(() => remark().process(result));
    return String(file).trim();
  },
});
```

<Content />
