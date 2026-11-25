# Call-count baseline: Thirty keystrokes in the composer, long entry, 12 rounds of 368 lines

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
| calls: total | 22,226,771 |
| calls: npm @xterm/headless | 14,066,460 |
| calls: xmd cli | 4,114,161 |
| calls: npm @termless/xtermjs | 2,094,435 |
| calls: effection | 1,249,198 |
| calls: deno runtime | 298,431 |
| calls: effectionx | 183,164 |
| calls: xmd core | 132,964 |
| calls: npm @secretlint/core | 45,180 |
| calls: other layers | 42,778 |

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
      "value": 22226771
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14066460
    },
    {
      "name": "calls: xmd cli",
      "value": 4114161
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2094435
    },
    {
      "name": "calls: effection",
      "value": 1249198
    },
    {
      "name": "calls: deno runtime",
      "value": 298431
    },
    {
      "name": "calls: effectionx",
      "value": 183164
    },
    {
      "name": "calls: xmd core",
      "value": 132964
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 45180
    },
    {
      "name": "calls: other layers",
      "value": 42778
    }
  ]
}
```
