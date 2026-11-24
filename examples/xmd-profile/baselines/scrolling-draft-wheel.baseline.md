# Call-count baseline: Draft wheel bursts, 120 lines

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
| calls: total | 7,340,127 |
| calls: npm @xterm/headless | 4,698,234 |
| calls: xmd cli | 1,657,868 |
| calls: npm @termless/xtermjs | 686,080 |
| calls: deno runtime | 169,899 |
| calls: effection | 117,589 |
| calls: other layers | 10,457 |

```json
{
  "version": 1,
  "title": "Draft wheel bursts, 120 lines",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 7340127
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 4698234
    },
    {
      "name": "calls: xmd cli",
      "value": 1657868
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 686080
    },
    {
      "name": "calls: deno runtime",
      "value": 169899
    },
    {
      "name": "calls: effection",
      "value": 117589
    },
    {
      "name": "calls: other layers",
      "value": 10457
    }
  ]
}
```
