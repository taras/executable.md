# Call-count baseline: Thirty keystrokes in the composer, 2-round history

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
| calls: total | 26,340,958 |
| calls: npm @xterm/headless | 14,066,460 |
| calls: xmd cli | 8,199,849 |
| calls: npm @termless/xtermjs | 2,064,615 |
| calls: effection | 1,251,954 |
| calls: deno runtime | 254,605 |
| calls: xmd core | 199,749 |
| calls: effectionx | 195,688 |
| calls: npm @secretlint/core | 45,180 |
| calls: xmd durable-streams | 27,000 |
| calls: other layers | 35,858 |

```json
{
  "version": 1,
  "title": "Thirty keystrokes in the composer, 2-round history",
  "runtime": "deno 2.9.7 on darwin arm64",
  "tolerance": 1,
  "units": [],
  "measures": [
    {
      "name": "calls: total",
      "value": 26340958
    },
    {
      "name": "calls: npm @xterm/headless",
      "value": 14066460
    },
    {
      "name": "calls: xmd cli",
      "value": 8199849
    },
    {
      "name": "calls: npm @termless/xtermjs",
      "value": 2064615
    },
    {
      "name": "calls: effection",
      "value": 1251954
    },
    {
      "name": "calls: deno runtime",
      "value": 254605
    },
    {
      "name": "calls: xmd core",
      "value": 199749
    },
    {
      "name": "calls: effectionx",
      "value": 195688
    },
    {
      "name": "calls: npm @secretlint/core",
      "value": 45180
    },
    {
      "name": "calls: xmd durable-streams",
      "value": 27000
    },
    {
      "name": "calls: other layers",
      "value": 35858
    }
  ]
}
```
