# Call-count baseline: Thirty keystrokes in the composer, long history, 52 rounds of 32 lines

This document records how much work an exercise asks for: the number of function
calls it makes, by layer. `Profile.Baseline` checks later runs against it.

A shift means the exercise now does more work, or less, than when this was
recorded. It is a reason to look, not a verdict, because a count is not a
duration. Measure the time before deciding whether the change matters. Then fix
it, or run the same exercise with `XMD_PROFILE_UPDATE=1` and review the difference.

A count misses time spent inside one function, garbage collection, WebAssembly and
other native work. An exercise can get slower without any figure here moving.

- Runtime: deno 2.9.7 on darwin arm64
- Measured from: one capture
- Tolerance: 1%

| Measure | Value |
| --- | ---: |
| calls: total | 23,263,221 |
| calls: npm @xterm/headless | 14,066,460 |
| calls: xmd cli | 5,048,590 |
| calls: npm @termless/xtermjs | 2,097,375 |
| calls: effection | 1,260,084 |
| calls: deno runtime | 355,513 |
| calls: effectionx | 195,731 |
| calls: xmd core | 138,101 |
| calls: npm @secretlint/core | 45,180 |
| calls: other layers | 56,187 |

```json
{
  "version": 1,
  "title": "Thirty keystrokes in the composer, long history, 52 rounds of 32 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 23263221
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14066460
    },
    {
      "name": "calls: xmd cli",
      "value": 5048590
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2097375
    },
    {
      "name": "calls: effection",
      "value": 1260084
    },
    {
      "name": "calls: deno runtime",
      "value": 355513
    },
    {
      "name": "calls: effectionx",
      "value": 195731
    },
    {
      "name": "calls: xmd core",
      "value": 138101
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 45180
    },
    {
      "name": "calls: other layers",
      "value": 56187
    }
  ]
}
```
