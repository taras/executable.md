# Call-count baseline: Thirty wheel notches in the entry reading, bursts of three, 2 rounds of 32 lines

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
| calls: total | 8,055,189 |
| calls: npm @xterm/headless | 5,093,515 |
| calls: xmd cli | 1,918,989 |
| calls: npm @termless/xtermjs | 728,200 |
| calls: effection | 154,788 |
| calls: deno runtime | 126,650 |
| calls: npm @xterm/addon-unicode11 | 24,957 |
| calls: other layers | 8,090 |

```json
{
  "version": 1,
  "title": "Thirty wheel notches in the entry reading, bursts of three, 2 rounds of 32 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 8055189
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 5093515
    },
    {
      "name": "calls: xmd cli",
      "value": 1918989
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 728200
    },
    {
      "name": "calls: effection",
      "value": 154788
    },
    {
      "name": "calls: deno runtime",
      "value": 126650
    },
    {
      "name": "calls: npm @xterm/addon-unicode11",
      "value": 24957
    },
    {
      "name": "calls: other layers",
      "value": 8090
    }
  ]
}
```
