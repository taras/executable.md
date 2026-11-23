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
| calls: total | 8,733,052 |
| calls: npm @xterm/headless | 4,766,045 |
| calls: xmd cli | 2,904,862 |
| calls: npm @termless/xtermjs | 687,910 |
| calls: deno runtime | 180,618 |
| calls: effection | 160,187 |
| calls: npm @xterm/addon-unicode11 | 24,957 |
| calls: other layers | 8,473 |

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
      "value": 8733052
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 4766045
    },
    {
      "name": "calls: xmd cli",
      "value": 2904862
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 687910
    },
    {
      "name": "calls: deno runtime",
      "value": 180618
    },
    {
      "name": "calls: effection",
      "value": 160187
    },
    {
      "name": "calls: npm @xterm/addon-unicode11",
      "value": 24957
    },
    {
      "name": "calls: other layers",
      "value": 8473
    }
  ]
}
```
