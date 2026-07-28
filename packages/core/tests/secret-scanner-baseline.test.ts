/**
 * Recorded scan cost.
 *
 * Default-on detection means every journal append pays for a scan, so the cost
 * is a property worth watching. This records it rather than gating on it: a
 * throughput threshold measured on a developer laptop and enforced on a shared
 * CI runner is a flaky test, not a performance guarantee.
 *
 * The guard here is only against a change that makes scanning pathological —
 * orders of magnitude, not percentages. Read the logged numbers to see drift.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { createSecretScanner } from "../src/secrets/scanner.ts";
import type { SecretScanner } from "../src/secrets/scanner.ts";

/** A journal event of the size the great majority actually are. */
const SMALL = JSON.stringify({
  type: "yield",
  coroutineId: "root.0",
  description: { type: "call", name: "stepA" },
  result: { status: "ok", value: "alpha" },
});

/** An exec block that captured a large amount of process output. */
const LARGE = JSON.stringify({
  type: "yield",
  coroutineId: "root.1",
  description: { type: "exec", name: "build" },
  result: { status: "ok", value: { stdout: "output line\n".repeat(16_000) } },
});

function* measure(
  label: string,
  scanner: SecretScanner,
  content: string,
  runs: number,
): Operation<number> {
  yield* scanner.scan(content); // warm the rule set before timing

  const started = performance.now();
  for (let run = 0; run < runs; run++) {
    yield* scanner.scan(content);
  }
  const perScan = (performance.now() - started) / runs;

  console.log(
    `  ${label.padEnd(22)} ${perScan.toFixed(3)} ms/scan over ${runs} runs ` +
      `(${content.length} bytes)`,
  );
  return perScan;
}

describe("secret scanning cost", () => {
  it("records the per-scan baseline for small and large events", function* () {
    const scanner = createSecretScanner();

    const small = yield* measure("small event", scanner, SMALL, 200);
    const large = yield* measure("large event", scanner, LARGE, 20);

    // Reference measurement, Deno 2.9.1 on an M-series laptop:
    //   small event  ~1.8 ms/scan (125 bytes)
    //   large event  ~4.2 ms/scan (200 KB)
    // Cost is dominated by fixed per-call overhead rather than content size,
    // so a 44-event journal pays well under a tenth of a second.
    expect(small).toBeLessThan(500);
    expect(large).toBeLessThan(2000);
  });
});
