---
returns:
  passed: { type: boolean }
  summary: { type: string }

props:
  type: object
  properties:
    findings:
      type: array
      items: { type: string }
  required: [findings]
  additionalProperties: false
---

This paragraph is documentation. A value component renders nothing, so
VERDICT_DOC_LEAK never reaches the caller.

```ts eval
const verdict = {
  passed: findings.length === 0,
  summary: findings.length === 0 ? "no findings" : `${findings.length} findings`,
};
```

<Return value={verdict} />
