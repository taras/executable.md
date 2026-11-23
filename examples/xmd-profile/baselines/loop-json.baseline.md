# Call-count baseline: Loop of Json components

This document records how much work an exercise asks for: the number of function
calls it makes, by layer. `Profile.Baseline` checks later runs against it.

A shift means the exercise now does more work, or less, than when this was
recorded. It is a reason to look, not a verdict, because a count is not a
duration. Measure the time before deciding whether the change matters. Then fix
it, or run the same exercise with `XMD_PROFILE_UPDATE=1` and review the difference.

A count misses time spent inside one function, garbage collection, WebAssembly and
other native work. An exercise can get slower without any figure here moving.

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
