import assert from "node:assert/strict";
import {
  compareTypingRuns,
  EDITS,
  VIEWPORT,
  WARMUP,
  WORKLOADS,
} from "../lib/typing-latency-report.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function output(revision: string, count = EDITS) {
  return {
    revision,
    stdout: WORKLOADS.map(
      (workload) =>
        "XMD_TYPING_SAMPLE " +
        JSON.stringify({
          revision,
          runtime: Deno.version,
          host: { os: Deno.build.os, arch: Deno.build.arch },
          viewport: VIEWPORT,
          workload,
          warmup: WARMUP,
          samples: Array.from({ length: count }, (_, index) => ({
            edit: index + 1,
            writes: 1,
            milliseconds: index < WARMUP ? 99 : index + (revision === HEAD ? 2 : 0),
          })),
        }),
    ).join("\n"),
  };
}

Deno.test("mounted typing report retains raw edits and summarizes only measured edits", () => {
  const { workloads } = compareTypingRuns(output(BASE), output(HEAD));
  for (const pair of workloads) {
    assert.equal(pair.baseline.samples.length, EDITS);
    assert.equal(pair.baseline.count, EDITS - WARMUP);
    assert.equal(pair.baseline.medianMs, 24.5);
    assert.equal(pair.baseline.p95Ms, 38);
    assert.deepEqual(pair.deltaMs, { median: 2, p95: 2 });
  }
});

Deno.test("mounted typing report fails on missing samples and mismatched revisions", () => {
  assert.throws(() => compareTypingRuns(output(BASE), output(HEAD, EDITS - 1)));
  assert.throws(() => compareTypingRuns(output(BASE), { ...output(HEAD), revision: BASE }));
});
