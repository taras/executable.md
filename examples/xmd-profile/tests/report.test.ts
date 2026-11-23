import assert from "node:assert/strict";
import {
  callers,
  compare,
  CpuProfile,
  place,
  renderCallers,
  renderComparison,
  renderSummary,
  summarize,
} from "../lib/report.ts";

const ROOT = { functionName: "(root)", url: "", lineNumber: -1 };
const EXPAND = {
  functionName: "expandEach",
  url: "file:///work/checkout/packages/core/src/expand.ts",
  lineNumber: 9,
};
const EXPAND_KEY = "expandEach xmd:core/src/expand.ts (script line 10)";
const TASK = {
  functionName: "createTask",
  url: "file:///cache/npm/registry.npmjs.org/effection/4.1.0/esm/lib/task.js",
  lineNumber: 4,
};
const TASK_KEY = "createTask npm:effection/esm/lib/task.js:5";

function profile(taskUs: number) {
  return CpuProfile.parse({
    startTime: 0,
    endTime: 2100,
    nodes: [
      { id: 1, callFrame: ROOT, children: [2, 3, 6] },
      { id: 2, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } },
      { id: 3, callFrame: EXPAND, children: [4] },
      { id: 4, callFrame: TASK, children: [5] },
      { id: 5, callFrame: EXPAND },
      {
        id: 6,
        callFrame: { functionName: "post", url: "ext:deno_node/inspector.js", lineNumber: 0 },
      },
    ],
    samples: [2, 3, 4, 5, 6, 4],
    timeDeltas: [100, 200, 300, 400, 500, taskUs],
  });
}

function at(url: string, functionName = "f") {
  return place({ functionName, url, lineNumber: 0 });
}

Deno.test("a summary keeps idle and profiler time out of active time", () => {
  const summary = summarize(profile(600));
  assert.equal(summary.sampledUs, 2100);
  assert.equal(summary.idleUs, 100);
  assert.equal(summary.profilerUs, 500);
  assert.equal(summary.activeUs, 1500);
  assert.equal(summary.samples, 6);
  assert.deepEqual(summary.layers, [
    { key: "effection", us: 900 },
    { key: "xmd core", us: 600 },
  ]);
});

Deno.test("a TypeScript position reads as a script line and a JavaScript one as a line", () => {
  assert.deepEqual(summarize(profile(600)).functions, [
    { key: TASK_KEY, us: 900 },
    { key: EXPAND_KEY, us: 600 },
  ]);
});

Deno.test("inclusive time counts a recursive XMD frame once", () => {
  assert.deepEqual(summarize(profile(600)).inclusive, [{ key: EXPAND_KEY, us: 1500 }]);
});

Deno.test("inclusive time leaves out a frame that hands its time to one callee", () => {
  const wrapped = CpuProfile.parse({
    startTime: 0,
    endTime: 1000,
    nodes: [
      { id: 1, callFrame: ROOT, children: [2] },
      {
        id: 2,
        callFrame: {
          functionName: "runXmd",
          url: "file:///work/checkout/packages/cli/src/cli.ts",
          lineNumber: 0,
        },
        children: [3],
      },
      { id: 3, callFrame: EXPAND },
    ],
    samples: [3],
    timeDeltas: [1000],
  });
  assert.deepEqual(summarize(wrapped).inclusive, [{ key: EXPAND_KEY, us: 1000 }]);
});

Deno.test("frames are placed by where their source came from", () => {
  assert.equal(
    at(
      "file:///tmp/deno-compile-xmd/.deno_compile_node_modules/localhost/effection/4.1.0/esm/lib/do.js",
    ).source,
    "npm:effection/esm/lib/do.js",
  );
  assert.equal(
    at("file:///c/npm/registry.npmjs.org/@effectionx/context-api/0.6.0/dist/mod.js").layer,
    "effectionx",
  );
  assert.equal(
    at("file:///w/node_modules/.deno/acorn@8.16.0/node_modules/acorn/dist/acorn.mjs").layer,
    "npm acorn",
  );
  assert.equal(at("file:///w/packages/durable-streams/effect.ts").layer, "xmd durable-streams");
  assert.equal(at("ext:core/00_infra.js").layer, "deno runtime");
  assert.equal(at("data:application/javascript;base64,AAAA").layer, "eval block");
  assert.deepEqual(at("wasm://wasm/000771aa", "wasm-function[54]"), {
    layer: "wasm",
    source: "wasm:000771aa",
  });
  assert.equal(at("", "op_fs_stat_async").layer, "native");
  assert.equal(at("", "(garbage collector)").layer, "garbage collector");
});

Deno.test("a sample that names a missing node fails the summary", () => {
  const broken = profile(600);
  assert.throws(() => summarize({ ...broken, samples: [99], timeDeltas: [1] }));
});

Deno.test("callers report the time that flows through each caller", () => {
  assert.deepEqual(callers(profile(600), "createTask"), {
    name: "createTask",
    selfUs: 900,
    totalUs: 1300,
    immediate: [{ key: EXPAND_KEY, us: 1300 }],
    above: [{ key: EXPAND_KEY, us: 1300 }],
  });
});

Deno.test("callers count a recursive function from its outermost call", () => {
  const found = callers(profile(600), "expandEach");
  assert.equal(found.selfUs, 600);
  assert.equal(found.totalUs, 1500);
  assert.deepEqual(found.immediate, [{ key: "(root)", us: 1500 }]);
  assert.deepEqual(found.above, []);
  assert.match(renderCallers(found, 1500, 5), /Callers of `expandEach`/);
});

Deno.test("callers of a function the profile never ran fail", () => {
  assert.throws(() => callers(profile(600), "absent"), /no frame named absent/);
});

Deno.test("a comparison orders rows by the size of the change", () => {
  const comparison = compare(summarize(profile(600)), summarize(profile(1600)));
  assert.deepEqual(comparison.active, {
    key: "active",
    baselineUs: 1500,
    candidateUs: 2500,
    deltaUs: 1000,
  });
  assert.deepEqual(comparison.layers[0], {
    key: "effection",
    baselineUs: 900,
    candidateUs: 1900,
    deltaUs: 1000,
  });
  assert.equal(comparison.layers[1]?.deltaUs, 0);
  assert.match(renderComparison(comparison, 5), /delta \+1\.0 ms/);
});

Deno.test("the rendered summary reports each kind of time", () => {
  const text = renderSummary("each.cpuprofile", summarize(profile(600)), 5);
  assert.match(text, /2\.1 ms sampled, 1\.5 ms active, 0\.1 ms idle, 0\.5 ms profiler, 6 samples/);
  assert.match(text, /\| `effection` \| 0\.9 \| 60\.0% \|/);
});

Deno.test("callers list every XMD frame above the function, nearest first", () => {
  const nested = CpuProfile.parse({
    startTime: 0,
    endTime: 1000,
    nodes: [
      { id: 1, callFrame: ROOT, children: [2] },
      {
        id: 2,
        callFrame: {
          functionName: "runXmd",
          url: "file:///w/packages/cli/src/cli.ts",
          lineNumber: 0,
        },
        children: [3],
      },
      {
        id: 3,
        callFrame: {
          functionName: "prepare",
          url: "file:///w/packages/cli/src/repl/application.ts",
          lineNumber: 4,
        },
        children: [4],
      },
      { id: 4, callFrame: EXPAND },
    ],
    samples: [4],
    timeDeltas: [1000],
  });
  assert.deepEqual(callers(nested, "expandEach").above, [
    { key: "prepare xmd:cli/src/repl/application.ts (script line 5)", us: 1000 },
    { key: "runXmd xmd:cli/src/cli.ts (script line 1)", us: 1000 },
  ]);
});
