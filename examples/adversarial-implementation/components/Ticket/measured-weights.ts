import type { Operation } from "effection";
import type { z } from "zod";
import { assembleTestWeights } from "../../../../scripts/lib/measure-weights.ts";
import {
  formatTestWeights,
  parseRuntimeMeasurement,
} from "../../../../scripts/lib/test-weights.ts";
import type { RuntimeMeasurement } from "../../../../scripts/lib/test-weights.ts";
import { RUNTIMES } from "../../../../scripts/runtime-test-exclusions.ts";
import type { Runtime } from "../../../../scripts/runtime-test-exclusions.ts";
import type { measurement, targetCorpus } from "./control.ts";
import { verified } from "./admission.ts";

/**
 * The committed weights the retained runtime records assemble into, against
 * the target checkout's own applicable corpus. Assembly refuses incomplete,
 * mixed or wrongly attributed records with every problem named.
 */
export function* assembledWeights(
  selected: z.infer<typeof measurement>,
  corpus: z.infer<typeof targetCorpus>,
): Operation<string> {
  const records: Partial<Record<Runtime, RuntimeMeasurement>> = {};
  for (const runtime of RUNTIMES) {
    records[runtime] = parseRuntimeMeasurement(
      yield* verified(selected.records[runtime], "The " + runtime + " measurement record"),
      "test-weights-" + runtime + ".json",
    );
  }
  return formatTestWeights(assembleTestWeights(selected.run, corpus.applicable, records));
}
