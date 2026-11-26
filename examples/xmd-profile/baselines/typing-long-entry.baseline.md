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
| calls: total | 21,425,939 |
| calls: npm @xterm/headless | 14,066,460 |
| calls: xmd cli | 3,321,416 |
| calls: npm @termless/xtermjs | 2,094,435 |
| calls: effection | 1,242,628 |
| calls: deno runtime | 297,302 |
| calls: effectionx | 182,952 |
| calls: xmd core | 132,963 |
| calls: npm @secretlint/core | 45,180 |
| calls: other layers | 42,603 |

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
      "value": 21425939
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14066460
    },
    {
      "name": "calls: xmd cli",
      "value": 3321416
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2094435
    },
    {
      "name": "calls: effection",
      "value": 1242628
    },
    {
      "name": "calls: deno runtime",
      "value": 297302
    },
    {
      "name": "calls: effectionx",
      "value": 182952
    },
    {
      "name": "calls: xmd core",
      "value": 132963
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 45180
    },
    {
      "name": "calls: other layers",
      "value": 42603
    }
  ]
}
```
