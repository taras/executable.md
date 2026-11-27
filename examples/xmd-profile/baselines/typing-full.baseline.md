# Call-count baseline: Thirty keystrokes in the composer, full screen, 12 rounds of 32 lines

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
| calls: total | 22,350,614 |
| calls: npm @xterm/headless | 15,048,870 |
| calls: xmd cli | 3,185,646 |
| calls: npm @termless/xtermjs | 2,217,465 |
| calls: effection | 1,246,224 |
| calls: deno runtime | 248,064 |
| calls: effectionx | 182,311 |
| calls: xmd core | 132,961 |
| calls: npm @secretlint/core | 45,180 |
| calls: other layers | 43,893 |

```json
{
  "version": 1,
  "title": "Thirty keystrokes in the composer, full screen, 12 rounds of 32 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 22350614
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 15048870
    },
    {
      "name": "calls: xmd cli",
      "value": 3185646
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2217465
    },
    {
      "name": "calls: effection",
      "value": 1246224
    },
    {
      "name": "calls: deno runtime",
      "value": 248064
    },
    {
      "name": "calls: effectionx",
      "value": 182311
    },
    {
      "name": "calls: xmd core",
      "value": 132961
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 45180
    },
    {
      "name": "calls: other layers",
      "value": 43893
    }
  ]
}
```
