import assert from "node:assert/strict";
import { wheelSteps } from "../lib/wheel-pattern.ts";

Deno.test("a wheel pattern plays each run as one step", () => {
  assert.deepEqual(wheelSteps("...ddddd....uuuu"), [
    { kind: "pause", ticks: 3 },
    { kind: "wheel", delta: 5 },
    { kind: "pause", ticks: 4 },
    { kind: "wheel", delta: -4 },
  ]);
});

Deno.test("a wheel pattern keeps a change of direction as two bursts", () => {
  assert.deepEqual(wheelSteps("ddu"), [
    { kind: "wheel", delta: 2 },
    { kind: "wheel", delta: -1 },
  ]);
});

Deno.test("a wheel pattern refuses an unknown mark and an empty pattern", () => {
  assert.throws(() => wheelSteps("dd x"), /not " "/);
  assert.throws(() => wheelSteps(""), /at least one step/);
});
