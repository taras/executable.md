---
inputs:
  pr:
    type: object
    required: true
  pattern: "factory|abstract|base|provider|strategy|adapter|helper|util"
  severity: warning
  message: "New abstraction files: {names}. Verify 3+ consumers."
---

```ts eval
const re = new RegExp(pattern, "i");
const suspicious = pr.created
  .filter(f => f.path.endsWith(".ts") && !f.isTest && !f.isTypeDeclaration)
  .filter(f => re.test(f.path));
const triggered = suspicious.length > 0;
const resolvedMessage = message.replace(
  "{names}", suspicious.map(f => f.path).join(", ")
);
```

<Finding when={triggered} severity={severity} message={resolvedMessage} />
