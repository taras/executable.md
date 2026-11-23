import assert from "node:assert/strict";
import { callsByLayer, countCalls, Coverage, renderCalls } from "../lib/calls.ts";

const coverage = Coverage.parse({
  result: [
    {
      url: "file:///work/checkout/packages/core/src/expand.ts",
      functions: [
        { functionName: "", ranges: [{ startOffset: 0, endOffset: 900, count: 1 }] },
        { functionName: "expandEach", ranges: [{ startOffset: 40, endOffset: 90, count: 3 }] },
        { functionName: "", ranges: [{ startOffset: 120, endOffset: 150, count: 2 }] },
        { functionName: "", ranges: [{ startOffset: 300, endOffset: 340, count: 5 }] },
        { functionName: "unused", ranges: [{ startOffset: 400, endOffset: 440, count: 0 }] },
      ],
    },
    {
      url: "file:///cache/npm/registry.npmjs.org/effection/4.1.0/esm/lib/trap.js",
      functions: [
        { functionName: "trap", ranges: [{ startOffset: 10, endOffset: 60, count: 10 }] },
      ],
    },
    {
      url: "",
      functions: [
        { functionName: "hidden", ranges: [{ startOffset: 5, endOffset: 9, count: 99 }] },
      ],
    },
  ],
});

Deno.test("call counts skip module bodies, unrun functions and scripts with no source", () => {
  const counts = countCalls(coverage);
  assert.equal(counts.total, 20);
  assert.deepEqual(counts.functions, [
    { name: "trap", source: "npm:effection/esm/lib/trap.js", layer: "effection", calls: 10 },
    { name: "(anonymous)", source: "xmd:core/src/expand.ts", layer: "xmd core", calls: 7 },
    { name: "expandEach", source: "xmd:core/src/expand.ts", layer: "xmd core", calls: 3 },
  ]);
});

Deno.test("calls are totalled by layer", () => {
  assert.deepEqual(callsByLayer(countCalls(coverage)), [
    { layer: "effection", calls: 10 },
    { layer: "xmd core", calls: 10 },
  ]);
});

Deno.test("the rendered counts report totals and shares", () => {
  const text = renderCalls("each.calls.json", countCalls(coverage), 2);
  assert.match(text, /20 function calls across 3 functions/);
  assert.match(text, /A count shows how much work was asked for, not how long it took/);
  assert.match(text, /\| `effection` \| 10 \| 50\.0% \|/);
  assert.match(text, /\| `\(anonymous\) xmd:core\/src\/expand\.ts` \| 7 \| 35\.0% \|/);
  assert.doesNotMatch(text, /expandEach/);
});
