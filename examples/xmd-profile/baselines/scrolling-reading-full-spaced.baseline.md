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
| calls: total | 22,564,175 |
| calls: npm @xterm/headless | 15,198,025 |
| calls: xmd cli | 4,467,400 |
| calls: npm @termless/xtermjs | 2,217,270 |
| calls: effection | 350,967 |
| calls: deno runtime | 271,528 |
| calls: npm @xterm/addon-unicode11 | 45,390 |
| calls: other layers | 13,595 |

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
      "value": 22564175
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 15198025
    },
    {
      "name": "calls: xmd cli",
      "value": 4467400
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2217270
    },
    {
      "name": "calls: effection",
      "value": 350967
    },
    {
      "name": "calls: deno runtime",
      "value": 271528
    },
    {
      "name": "calls: npm @xterm/addon-unicode11",
      "value": 45390
    },
    {
      "name": "calls: other layers",
      "value": 13595
    }
  ]
}
```
