import type { Operation } from "effection";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { assembleTestWeights } from "../../../../scripts/lib/measure-weights.ts";
import { applicableTestFiles } from "../../../../scripts/lib/test-files.ts";
import {
  formatTestWeights,
  parseRuntimeMeasurement,
} from "../../../../scripts/lib/test-weights.ts";
import type { RuntimeMeasurement } from "../../../../scripts/lib/test-weights.ts";
import { RUNTIMES } from "../../../../scripts/runtime-test-exclusions.ts";
import type { Runtime } from "../../../../scripts/runtime-test-exclusions.ts";
import type { measurement } from "./control.ts";
import { verified } from "./admission.ts";

/**
 * The committed weights the retained runtime records assemble into, against the
 * corpus the checkout at `repository` applies. Assembly refuses incomplete,
 * mixed or wrongly attributed records with every problem named.
 */
export function* assembledWeights(
  repository: string,
  selected: z.infer<typeof measurement>,
): Operation<string> {
  const root = pathToFileURL(repository.endsWith("/") ? repository : repository + "/");
  const applicable: Record<Runtime, string[]> = { deno: [], node: [], bun: [] };
  const records: Partial<Record<Runtime, RuntimeMeasurement>> = {};
  for (const runtime of RUNTIMES) {
    applicable[runtime] = yield* applicableTestFiles(runtime, root);
    records[runtime] = parseRuntimeMeasurement(
      yield* verified(selected.records[runtime], "The " + runtime + " measurement record"),
      "test-weights-" + runtime + ".json",
    );
  }
  return formatTestWeights(assembleTestWeights(selected.run, applicable, records));
}
