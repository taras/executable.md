---
returns:
  passed: { type: boolean }
  summary: { type: string }
---

# Release check

This body is observability. `xmd run` shows it with `--verbose` and prints only
the value below on stdout.

```ts eval
const findings = [];
const verdict = {
  passed: findings.length === 0,
  summary: findings.length === 0 ? "no findings" : `${findings.length} findings`,
};
```

<Return value={verdict} />
