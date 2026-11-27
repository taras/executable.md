# Call-count baseline: Thirty arrow keys in the draft, window moved by warm-up, 120 lines

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
| calls: total | 22,806,955 |
| calls: npm @xterm/headless | 15,072,925 |
| calls: xmd cli | 3,936,710 |
| calls: npm @termless/xtermjs | 2,185,110 |
| calls: effection | 892,556 |
| calls: deno runtime | 446,571 |
| calls: effectionx | 109,501 |
| calls: xmd core | 95,250 |
| calls: npm @secretlint/core | 30,120 |
| calls: other layers | 38,212 |

```json
{
  "version": 1,
  "title": "Thirty arrow keys in the draft, window moved by warm-up, 120 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 22806955
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 15072925
    },
    {
      "name": "calls: xmd cli",
      "value": 3936710
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2185110
    },
    {
      "name": "calls: effection",
      "value": 892556
    },
    {
      "name": "calls: deno runtime",
      "value": 446571
    },
    {
      "name": "calls: effectionx",
      "value": 109501
    },
    {
      "name": "calls: xmd core",
      "value": 95250
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 30120
    },
    {
      "name": "calls: other layers",
      "value": 38212
    }
  ]
}
```
