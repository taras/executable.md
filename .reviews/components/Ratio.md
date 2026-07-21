---
inputs:
  type: object
  properties:
    pr:
      type: object
    numerator:
      type: string
    denominator:
      type: string
    threshold:
      type: number
    minDenominator:
      type: number
      default: 10
    excludeTests:
      type: boolean
      default: true
    severity:
      type: string
      default: warning
    message:
      type: string
  required: [pr, numerator, denominator, threshold, message]
  additionalProperties: false
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
