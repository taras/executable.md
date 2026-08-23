/**
 * One consumer process for the interference proof.
 *
 * Usage (started by `scripts/verify.ts`, never by hand):
 *   <deno|tsx|bun> scripts/verify-consumer.ts <runtime> <root> <control>
 *
 * Deliberately thin. Everything it does is in `lib/consumer-cycle.ts`, which is
 * portable, so the three runtimes run the same loop rather than three loops
 * that agree today.
 */
import { exit, main } from "effection";

import { consume, isRuntime } from "./lib/consumer-cycle.ts";

main(function* (args) {
  const [runtime, root, control] = args;
  if (runtime === undefined || !isRuntime(runtime)) {
    console.error(`usage: verify-consumer.ts <deno|node|bun> <root> <control>`);
    yield* exit(2);
    return;
  }
  if (root === undefined || control === undefined) {
    console.error(`usage: verify-consumer.ts ${runtime} <root> <control>`);
    yield* exit(2);
    return;
  }

  const counted = yield* consume({ runtime, root, control });
  console.log(
    `${runtime}: ${counted.before} cycle(s) before, ${counted.during} during, ` +
      `${counted.after} after`,
  );
});
