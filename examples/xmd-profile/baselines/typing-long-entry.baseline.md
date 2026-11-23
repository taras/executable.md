# Call-count baseline: Thirty keystrokes in the composer, long entry, 12 rounds of 368 lines

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
| calls: total | 22,264,087 |
| calls: npm @xterm/headless | 14,066,460 |
| calls: xmd cli | 4,110,346 |
| calls: npm @termless/xtermjs | 2,094,675 |
| calls: effection | 1,259,468 |
| calls: deno runtime | 297,877 |
| calls: effectionx | 195,732 |
| calls: xmd core | 138,162 |
| calls: npm @secretlint/core | 45,180 |
| calls: other layers | 56,187 |

```json
{
  "version": 1,
  "title": "Thirty keystrokes in the composer, long entry, 12 rounds of 368 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 22264087
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14066460
    },
    {
      "name": "calls: xmd cli",
      "value": 4110346
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2094675
    },
    {
      "name": "calls: effection",
      "value": 1259468
    },
    {
      "name": "calls: deno runtime",
      "value": 297877
    },
    {
      "name": "calls: effectionx",
      "value": 195732
    },
    {
      "name": "calls: xmd core",
      "value": 138162
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
