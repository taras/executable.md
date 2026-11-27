# Call-count baseline: Thirty keystrokes in the composer, long history, 52 rounds of 32 lines

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
| calls: total | 22,769,432 |
| calls: npm @xterm/headless | 15,048,870 |
| calls: xmd cli | 3,568,957 |
| calls: npm @termless/xtermjs | 2,223,285 |
| calls: effection | 1,243,819 |
| calls: deno runtime | 279,903 |
| calls: effectionx | 182,503 |
| calls: xmd core | 133,022 |
| calls: npm @secretlint/core | 45,180 |
| calls: other layers | 43,893 |

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
      "value": 22769432
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 15048870
    },
    {
      "name": "calls: xmd cli",
      "value": 3568957
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2223285
    },
    {
      "name": "calls: effection",
      "value": 1243819
    },
    {
      "name": "calls: deno runtime",
      "value": 279903
    },
    {
      "name": "calls: effectionx",
      "value": 182503
    },
    {
      "name": "calls: xmd core",
      "value": 133022
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
