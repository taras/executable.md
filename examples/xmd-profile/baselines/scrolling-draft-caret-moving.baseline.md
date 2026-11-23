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
| calls: total | 22,606,052 |
| calls: npm @xterm/headless | 14,073,955 |
| calls: xmd cli | 4,791,521 |
| calls: npm @termless/xtermjs | 2,058,270 |
| calls: effection | 895,282 |
| calls: deno runtime | 493,920 |
| calls: effectionx | 117,989 |
| calls: xmd core | 99,006 |
| calls: npm @secretlint/core | 30,120 |
| calls: other layers | 45,989 |

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
      "value": 22606052
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14073955
    },
    {
      "name": "calls: xmd cli",
      "value": 4791521
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2058270
    },
    {
      "name": "calls: effection",
      "value": 895282
    },
    {
      "name": "calls: deno runtime",
      "value": 493920
    },
    {
      "name": "calls: effectionx",
      "value": 117989
    },
    {
      "name": "calls: xmd core",
      "value": 99006
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 30120
    },
    {
      "name": "calls: other layers",
      "value": 45989
    }
  ]
}
```
