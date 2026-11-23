# Call-count baseline: Thirty arrow keys in the draft, window initially still, 120 lines

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
| calls: total | 22,586,461 |
| calls: npm @xterm/headless | 14,049,506 |
| calls: xmd cli | 4,793,573 |
| calls: npm @termless/xtermjs | 2,058,540 |
| calls: effection | 900,339 |
| calls: deno runtime | 495,307 |
| calls: effectionx | 118,137 |
| calls: xmd core | 98,974 |
| calls: npm @secretlint/core | 30,120 |
| calls: other layers | 41,965 |

```json
{
  "version": 1,
  "title": "Thirty arrow keys in the draft, window initially still, 120 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 22586461
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14049506
    },
    {
      "name": "calls: xmd cli",
      "value": 4793573
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2058540
    },
    {
      "name": "calls: effection",
      "value": 900339
    },
    {
      "name": "calls: deno runtime",
      "value": 495307
    },
    {
      "name": "calls: effectionx",
      "value": 118137
    },
    {
      "name": "calls: xmd core",
      "value": 98974
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 30120
    },
    {
      "name": "calls: other layers",
      "value": 41965
    }
  ]
}
```
