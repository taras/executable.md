# Performance baseline: Loop of Json components

`Profile.Baseline` wrote this document and checks later runs against it. A measure
that moves by more than the tolerance fails the check. Run the same journey with
`XMD_PROFILE_UPDATE=1` to accept an intended change, and review the difference.

- Runtime: deno 2.9.7 on darwin arm64
- Measured from: two captures, at 50 and 200 units
- Tolerance: 1%

| Measure | Value |
| --- | ---: |
| calls per unit: total | 16,538.707 |
| calls per unit: effection | 10,726.94 |
| calls per unit: xmd core | 1,992.327 |
| calls per unit: effectionx | 1,454 |
| calls per unit: npm @secretlint/core | 1,004 |
| calls per unit: deno runtime | 532.94 |
| calls per unit: xmd durable-streams | 371 |
| calls per unit: npm @secretlint/secretlint-rule-preset-recommend | 230 |
| calls per unit: npm remend | 175.993 |
| calls per unit: xmd runtime | 40 |
| calls per unit: other layers | 11.507 |
| fixed calls: total | 8,793.667 |

```json
{
  "version": 1,
  "title": "Loop of Json components",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [
    50,
    200
  ],
  "measures": [
    {
      "name": "calls per unit: total",
      "value": 16538.707
    },
    {
      "name": "calls per unit: effection",
      "value": 10726.94
    },
    {
      "name": "calls per unit: xmd core",
      "value": 1992.327
    },
    {
      "name": "calls per unit: effectionx",
      "value": 1454
    },
    {
      "name": "calls per unit: npm @secretlint/core",
      "value": 1004
    },
    {
      "name": "calls per unit: deno runtime",
      "value": 532.94
    },
    {
      "name": "calls per unit: xmd durable-streams",
      "value": 371
    },
    {
      "name": "calls per unit: npm @secretlint/secretlint-rule-preset-recommend",
      "value": 230
    },
    {
      "name": "calls per unit: npm remend",
      "value": 175.993
    },
    {
      "name": "calls per unit: xmd runtime",
      "value": 40
    },
    {
      "name": "calls per unit: other layers",
      "value": 11.507
    },
    {
      "name": "fixed calls: total",
      "value": 8793.667
    }
  ]
}
```
