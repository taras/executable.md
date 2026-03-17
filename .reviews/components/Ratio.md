---
inputs:
  pr:
    type: object
    required: true
  numerator:
    type: string
    required: true
  denominator:
    type: string
    required: true
  threshold:
    type: number
    required: true
  minDenominator: 10
  excludeTests: true
  severity: warning
  message:
    type: string
    required: true
---

```ts eval
const numRe = new RegExp(numerator, "g");
const denRe = new RegExp(denominator, "g");
const lines = excludeTests
  ? pr.added.filter(l => !l.isTest)
  : pr.added;
const source = lines.map(l => l.content).join("\n");

const numCount = (source.match(numRe) ?? []).length;
const denCount = (source.match(denRe) ?? []).length;

if (denCount >= minDenominator && numCount / denCount > threshold) {
  const ratio = (numCount / denCount * 100).toFixed(1);
  const icon = severity === "error" ? "\ud83d\udd34" : "\ud83d\udfe1";
  return icon + " " + message
    .replace("{ratio}", ratio)
    .replace("{numeratorCount}", String(numCount))
    .replace("{denominatorCount}", String(denCount));
}
```
