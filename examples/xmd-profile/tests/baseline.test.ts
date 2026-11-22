import assert from "node:assert/strict";
import {
  Baseline,
  check,
  layerValues,
  measures,
  namedLayers,
  parseBaseline,
  renderBaseline,
  renderCheck,
} from "../lib/baseline.ts";
import type { CallCounts } from "../lib/calls.ts";

function counts(effection: number, core: number, tiny: number): CallCounts {
  return {
    total: effection + core + tiny,
    functions: [
      {
        name: "trap",
        source: "npm:effection/esm/lib/trap.js",
        layer: "effection",
        calls: effection,
      },
      { name: "expandEach", source: "xmd:core/src/expand.ts", layer: "xmd core", calls: core },
      { name: "parse", source: "npm:zod/index.js", layer: "npm zod", calls: tiny },
    ],
  };
}

const SMALL = counts(600, 399, 1);
const LARGE = counts(2400, 1596, 2);

function recorded(): Baseline {
  return {
    version: 1,
    title: "loop of json",
    runtime: "deno 2.9.7",
    tolerance: 1,
    units: [],
    measures: measures(layerValues([{ counts: SMALL }])),
  };
}

Deno.test("one capture gives calls by layer, with small layers grouped", () => {
  assert.deepEqual(measures(layerValues([{ counts: SMALL }])), [
    { name: "calls: total", value: 1000 },
    { name: "calls: effection", value: 600 },
    { name: "calls: xmd core", value: 399 },
    { name: "calls: other layers", value: 1 },
  ]);
});

Deno.test("two captures give calls per unit and the fixed cost", () => {
  const values = layerValues([
    { counts: SMALL, units: 100 },
    { counts: LARGE, units: 400 },
  ]);
  assert.deepEqual(measures(values), [
    { name: "calls per unit: total", value: 9.993 },
    { name: "calls per unit: effection", value: 6 },
    { name: "calls per unit: xmd core", value: 3.99 },
    { name: "calls per unit: other layers", value: 0.003 },
    { name: "fixed calls: total", value: 0.667 },
  ]);
});

Deno.test("captures without usable units are refused", () => {
  assert.throws(() => layerValues([]));
  assert.throws(() => layerValues([{ counts: SMALL }, { counts: LARGE }]));
  assert.throws(() =>
    layerValues([
      { counts: SMALL, units: 400 },
      { counts: LARGE, units: 100 },
    ]),
  );
});

Deno.test("a check reuses the layers the baseline named", () => {
  const baseline = recorded();
  assert.deepEqual(namedLayers(baseline), ["effection", "xmd core"]);
  const grown = measures(layerValues([{ counts: counts(600, 399, 300) }]), namedLayers(baseline));
  assert.deepEqual(grown.at(-1), { name: "calls: other layers", value: 300 });
});

Deno.test("a measure beyond the tolerance shifts in either direction", () => {
  const baseline = recorded();
  const same = check(baseline, measures(layerValues([{ counts: SMALL }])), "deno 2.9.7");
  assert.equal(same.shifted, false);
  for (const effection of [620, 580]) {
    const moved = check(
      baseline,
      measures(layerValues([{ counts: counts(effection, 399, 1) }]), namedLayers(baseline)),
      "deno 2.9.7",
    );
    assert.equal(moved.shifted, true);
    const names = moved.rows.filter((row) => row.shifted).map((row) => row.name);
    assert.deepEqual(names, ["calls: total", "calls: effection"]);
  }
  const within = check(
    baseline,
    measures(layerValues([{ counts: counts(605, 399, 1) }]), namedLayers(baseline)),
    "deno 2.9.7",
  );
  assert.equal(within.shifted, false);
});

Deno.test("a different runtime is reported as not comparable", () => {
  const result = check(recorded(), measures(layerValues([{ counts: SMALL }])), "deno 3.0.0");
  assert.equal(result.comparable, false);
  assert.equal(result.shifted, false);
  assert.match(renderCheck("baselines/loop.md", result), /was not compared/);
});

Deno.test("a baseline document round-trips through its data block", () => {
  const baseline = recorded();
  const document = renderBaseline(baseline);
  assert.match(document, /\| calls: effection \| 600 \|/);
  assert.deepEqual(parseBaseline(document), baseline);
  assert.throws(() => parseBaseline("# no data here"));
});

Deno.test("the rendered check lists only the shifted measures", () => {
  const baseline = recorded();
  const moved = check(
    baseline,
    measures(layerValues([{ counts: counts(620, 399, 1) }]), namedLayers(baseline)),
    "deno 2.9.7",
  );
  const text = renderCheck("baselines/loop.md", moved);
  assert.match(text, /2 of 4 measures shifted/);
  assert.match(text, /\| calls: effection \| 600 \| 620 \| \+3\.33% \|/);
  assert.doesNotMatch(text, /xmd core/);
});
