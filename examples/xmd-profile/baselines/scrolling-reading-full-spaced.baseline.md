# Call-count baseline: Thirty wheel notches in the entry reading, spaced, 12 rounds of 32 lines

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
| calls: total | 23,457,179 |
| calls: npm @xterm/headless | 14,215,615 |
| calls: xmd cli | 6,364,406 |
| calls: npm @termless/xtermjs | 2,093,790 |
| calls: deno runtime | 366,166 |
| calls: effection | 358,000 |
| calls: npm @xterm/addon-unicode11 | 45,390 |
| calls: other layers | 13,812 |

```json
{
  "version": 1,
  "title": "Thirty wheel notches in the entry reading, spaced, 12 rounds of 32 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 23457179
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14215615
    },
    {
      "name": "calls: xmd cli",
      "value": 6364406
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2093790
    },
    {
      "name": "calls: deno runtime",
      "value": 366166
    },
    {
      "name": "calls: effection",
      "value": 358000
    },
    {
      "name": "calls: npm @xterm/addon-unicode11",
      "value": 45390
    },
    {
      "name": "calls: other layers",
      "value": 13812
    }
  ]
}
```
