# Call-count baseline: Thirty keystrokes in the composer, sparse screen, 2 rounds of 32 lines

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
| calls: total | 21,726,564 |
| calls: npm @xterm/headless | 15,048,870 |
| calls: xmd cli | 2,637,627 |
| calls: npm @termless/xtermjs | 2,184,795 |
| calls: effection | 1,237,548 |
| calls: deno runtime | 213,691 |
| calls: effectionx | 182,078 |
| calls: xmd core | 132,900 |
| calls: npm @secretlint/core | 45,180 |
| calls: other layers | 43,875 |

```json
{
  "version": 1,
  "title": "Thirty keystrokes in the composer, sparse screen, 2 rounds of 32 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 21726564
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 15048870
    },
    {
      "name": "calls: xmd cli",
      "value": 2637627
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2184795
    },
    {
      "name": "calls: effection",
      "value": 1237548
    },
    {
      "name": "calls: deno runtime",
      "value": 213691
    },
    {
      "name": "calls: effectionx",
      "value": 182078
    },
    {
      "name": "calls: xmd core",
      "value": 132900
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 45180
    },
    {
      "name": "calls: other layers",
      "value": 43875
    }
  ]
}
```
