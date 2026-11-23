# Call-count baseline: Thirty arrow keys in the draft, window moved by warm-up, 368 lines

This document records how much work an exercise asks for: the number of function
calls it makes, by layer. `Profile.Baseline` checks later runs against it.

A shift means the exercise now does more work, or less, than when this was
recorded. It is a reason to look, not a verdict, because a count is not a
duration. Measure the time before deciding whether the change matters. Then fix
it, or run the same exercise with `XMD_PROFILE_UPDATE=1` and review the difference.

A count misses time spent inside one function, garbage collection, WebAssembly and
other native work. An exercise can get slower without any figure here moving.
The other layers row is recorded for context and never fails the comparison.

- Runtime: deno 2.9.7 on darwin arm64
- Measured from: one capture
- Tolerance: 1%

| Measure | Value |
| --- | ---: |
| calls: total | 24,204,839 |
| calls: npm @xterm/headless | 14,068,491 |
| calls: xmd cli | 5,915,172 |
| calls: npm @termless/xtermjs | 2,058,270 |
| calls: deno runtime | 971,158 |
| calls: effection | 900,332 |
| calls: effectionx | 118,137 |
| calls: xmd core | 99,036 |
| calls: npm @secretlint/core | 30,120 |
| calls: other layers | 44,123 |

```json
{
  "version": 1,
  "title": "Thirty arrow keys in the draft, window moved by warm-up, 368 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 24204839
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14068491
    },
    {
      "name": "calls: xmd cli",
      "value": 5915172
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2058270
    },
    {
      "name": "calls: deno runtime",
      "value": 971158
    },
    {
      "name": "calls: effection",
      "value": 900332
    },
    {
      "name": "calls: effectionx",
      "value": 118137
    },
    {
      "name": "calls: xmd core",
      "value": 99036
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 30120
    },
    {
      "name": "calls: other layers",
      "value": 44123
    }
  ]
}
```
