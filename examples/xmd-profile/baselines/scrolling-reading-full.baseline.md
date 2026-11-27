# Call-count baseline: Thirty wheel notches in the entry reading, bursts of three, 12 rounds of 32 lines

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
| calls: total | 8,602,264 |
| calls: npm @xterm/headless | 5,093,515 |
| calls: xmd cli | 2,429,970 |
| calls: npm @termless/xtermjs | 739,090 |
| calls: effection | 158,741 |
| calls: deno runtime | 147,750 |
| calls: npm @xterm/addon-unicode11 | 24,957 |
| calls: other layers | 8,241 |

```json
{
  "version": 1,
  "title": "Thirty wheel notches in the entry reading, bursts of three, 12 rounds of 32 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 8602264
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 5093515
    },
    {
      "name": "calls: xmd cli",
      "value": 2429970
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 739090
    },
    {
      "name": "calls: effection",
      "value": 158741
    },
    {
      "name": "calls: deno runtime",
      "value": 147750
    },
    {
      "name": "calls: npm @xterm/addon-unicode11",
      "value": 24957
    },
    {
      "name": "calls: other layers",
      "value": 8241
    }
  ]
}
```
