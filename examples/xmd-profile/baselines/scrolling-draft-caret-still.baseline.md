# Call-count baseline: Thirty arrow keys in the draft, window initially still, 120 lines

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
| calls: total | 22,776,333 |
| calls: npm @xterm/headless | 15,048,476 |
| calls: xmd cli | 3,937,575 |
| calls: npm @termless/xtermjs | 2,185,380 |
| calls: effection | 889,170 |
| calls: deno runtime | 446,864 |
| calls: effectionx | 109,502 |
| calls: xmd core | 95,218 |
| calls: npm @secretlint/core | 30,120 |
| calls: other layers | 34,028 |

```json
{
  "version": 1,
  "title": "Thirty arrow keys in the draft, window initially still, 120 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 22776333
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 15048476
    },
    {
      "name": "calls: xmd cli",
      "value": 3937575
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2185380
    },
    {
      "name": "calls: effection",
      "value": 889170
    },
    {
      "name": "calls: deno runtime",
      "value": 446864
    },
    {
      "name": "calls: effectionx",
      "value": 109502
    },
    {
      "name": "calls: xmd core",
      "value": 95218
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 30120
    },
    {
      "name": "calls: other layers",
      "value": 34028
    }
  ]
}
```
