import { z } from "zod";
import { amendment } from "./control.ts";
import { describe, read } from "./text-storage.ts";
import { verified } from "./admission.ts";
import { assembledWeights } from "./measured-weights.ts";
import { selectedSource, targetApplicability } from "./target-configuration.ts";

export const props = {
  type: "object",
  properties: {
    amendment: { type: "object" },
    repository: { type: "string" },
    revision: { type: "string" },
    previous: { type: "string" },
    parents: { type: "string" },
    descends: { type: "boolean" },
    paths: { type: "array", items: { type: "string" } },
    targetTree: { type: "string" },
    targetBlob: { type: ["string", "null"] },
  },
  required: [
    "amendment",
    "repository",
    "revision",
    "previous",
    "parents",
    "descends",
    "paths",
    "targetTree",
    "targetBlob",
  ],
  additionalProperties: false,
};
const input = z
  .object({
    amendment,
    repository: z.string().startsWith("/"),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    previous: z.string().regex(/^[0-9a-f]{40}$/),
    parents: z.string(),
    descends: z.boolean(),
    paths: z.array(z.string()),
    targetTree: z.string(),
    targetBlob: z.string().nullable(),
  })
  .strict();

export default function* AmendmentSettle(value: unknown) {
  const selected = input.parse(value);
  const admitted = selected.amendment;
  const [head, ...parents] = selected.parents.trim().split(/\s+/);
  if (head !== selected.revision) {
    throw new Error("The amended revision's parent listing names another commit.");
  }
  if (selected.previous === admitted.base) {
    if (parents.length !== 1 || parents[0] !== admitted.base) {
      throw new Error(
        "The first measured-weights import must be a signed single-parent child of " +
          admitted.base +
          "; observed parents " +
          (parents.join(", ") || "none") +
          ".",
      );
    }
  } else if (!selected.descends) {
    throw new Error("A later amendment correction must descend from the admitted head " + selected.previous + ".");
  }
  if (selected.paths.length !== 1 || selected.paths[0] !== "test-weights.json") {
    throw new Error(
      "The admitted amendment may change only test-weights.json since " +
        admitted.base +
        "; observed " +
        JSON.stringify(selected.paths) +
        ". CI shard counts, corpus, exclusions and other sources need separately scoped work.",
    );
  }
  const imported = yield* read(selected.repository, "test-weights.json");
  const observed = describe("test-weights.json", imported);
  if (!(observed.utf8Bytes === admitted.weights.utf8Bytes && observed.sha256 === admitted.weights.sha256)) {
    throw new Error("The imported test-weights.json differs from the admitted measured artifact.");
  }
  if ((yield* verified(admitted.measurement.artifact, "The retained weights artifact")) !== imported) {
    throw new Error("The retained weights artifact differs from the imported bytes.");
  }
  const configuration = yield* selectedSource(
    selected.repository,
    admitted.targetConfiguration,
    selected.targetTree,
    selected.targetBlob,
  );
  const corpus = yield* targetApplicability(
    selected.repository,
    admitted.targetConfiguration,
    configuration,
  );
  if (JSON.stringify(corpus) !== JSON.stringify(admitted.targetCorpus)) {
    throw new Error("The target corpus differs from the one admitted at " + admitted.base + ".");
  }
  if ((yield* assembledWeights(admitted.measurement, corpus)) !== imported) {
    throw new Error("The retained runtime records no longer assemble into the imported weights.");
  }
  return {
    revision: selected.revision,
    base: admitted.base,
    parents,
    paths: selected.paths,
    weights: observed,
    targetCorpus: corpus,
  };
}
