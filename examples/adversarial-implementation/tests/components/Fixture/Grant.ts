import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { z } from "zod";
import { assembleTestWeights } from "../../../../../scripts/lib/measure-weights.ts";
import {
  formatRuntimeMeasurement,
  formatTestWeights,
} from "../../../../../scripts/lib/test-weights.ts";
import type { RuntimeMeasurement } from "../../../../../scripts/lib/test-weights.ts";
import { RUNTIMES } from "../../../../../scripts/runtime-test-exclusions.ts";
import type { Runtime } from "../../../../../scripts/runtime-test-exclusions.ts";
import { describe, descriptor } from "../../../components/Ticket/text-storage.ts";
import { observeProgram, programEntry, workflowRoot } from "../../../components/Ticket/admission.ts";

export const props = {
  type: "object",
  properties: {
    completed: { type: "object" },
    predecessor: { type: ["object", "null"], default: null },
    variant: { type: "string", default: "valid" },
    name: { type: "string" },
  },
  required: ["completed", "name"],
  additionalProperties: false,
};
const input = z
  .object({
    completed: z
      .object({
        envelope: z.object({ continuation: descriptor }).passthrough(),
        revision: z.string(),
        delivery: z.object({ directory: z.string(), repository: z.string(), work: z.string() }).passthrough(),
        launch: z.string(),
        workflowRevision: z.string(),
      })
      .passthrough(),
    predecessor: descriptor.nullable(),
    variant: z.enum([
      "valid",
      "wrong-predecessor",
      "partial",
      "mixed",
      "wrong-commit",
      "digest",
      "missing-acquisition",
      "omit",
      "secret",
      "path-only",
      "stale-source",
    ]),
    name: z.string().regex(/^[A-Za-z0-9-]+$/),
  })
  .strict();
const corpus = ["packages/a/tests/a.test.ts", "packages/a/tests/b.test.ts"];

function* save(path: string, text: string) {
  yield* writeTextFile(path, text);
  return describe(path, text);
}

/**
 * Write synthetic runner evidence and an authorization for one admission. The
 * records are labelled fixture data: no hosted run produced them, and their
 * coherence comes only from the production formatter and assembly.
 */
export default function* Grant(value: unknown) {
  const { completed, predecessor, variant, name } = input.parse(value);
  const directory = completed.delivery.directory.replace(/\/delivery$/, "") + "-evidence-" + name;
  yield* ensureDir(directory);
  const run = {
    commit: variant === "wrong-commit" ? "0".repeat(40) : completed.revision,
    runUrl: "https://github.com/fixture/synthetic/actions/runs/1",
    attempt: 1,
    runner: "synthetic-fixture-runner",
  };
  const toolchain = { deno: "fixture-deno", node: "fixture-node", bun: "fixture-bun" };
  const recorded = variant === "omit" ? corpus.slice(0, 1) : corpus;
  const measurement = (
    runtime: Runtime,
    status: RuntimeMeasurement["status"],
    attempt: number,
  ): RuntimeMeasurement => ({
    runtime,
    status,
    source: { ...run, ...toolchain, attempt },
    applicable: recorded,
    measured: recorded.map((file, index) => ({ file, ms: 100 * (index + 1) + runtime.length })),
    failure: null,
  });
  const measurements = {
    deno: measurement("deno", "complete", 1),
    node: measurement("node", variant === "partial" ? "partial" : "complete", 1),
    bun: measurement("bun", "complete", variant === "mixed" ? 2 : 1),
  };
  const weights = formatTestWeights(
    assembleTestWeights(
      run,
      { deno: recorded, node: recorded, bun: recorded },
      {
        deno: measurement("deno", "complete", 1),
        node: measurement("node", "complete", 1),
        bun: measurement("bun", "complete", 1),
      },
    ),
  );
  const records = {
    deno: yield* save(directory + "/test-weights-deno-attempt-1.json", formatRuntimeMeasurement(measurements.deno)),
    node: yield* save(directory + "/test-weights-node-attempt-1.json", formatRuntimeMeasurement(measurements.node)),
    bun: yield* save(directory + "/test-weights-bun-attempt-1.json", formatRuntimeMeasurement(measurements.bun)),
  };
  const artifact = yield* save(directory + "/test-weights.json", weights);
  const acquisitionValue = {
    schema: "weights-acquisition.v1",
    run,
    records: Object.fromEntries(
      RUNTIMES.map((runtime) => [
        runtime,
        { name: "test-weights-" + runtime + "-attempt-1", sha256: records[runtime].sha256 },
      ]),
    ),
    weights: {
      name: "test-weights",
      sha256: variant === "digest" ? describe("", weights + " ").sha256 : artifact.sha256,
    },
    ...(variant === "secret"
      ? { note: ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789ABCD".slice(0, 36)].join("") }
      : {}),
  };
  const acquisition =
    variant === "missing-acquisition"
      ? { path: directory + "/absent-acquisition.json", utf8Bytes: 2, sha256: "0".repeat(64) }
      : yield* save(directory + "/acquisition.json", JSON.stringify(acquisitionValue));
  const authority = yield* save(
    directory + "/authority.md",
    "Synthetic fixture: the coordinator selects this measured-weights amendment under delegated authority.",
  );
  const launchText = yield* readTextFile(completed.launch);
  const old =
    variant === "path-only"
      ? yield* save(
          directory + "/launch-path-only.json",
          JSON.stringify({
            ...JSON.parse(launchText),
            selection: {
              ...JSON.parse(launchText).selection,
              files: [{ path: programEntry }],
            },
          }),
        )
      : describe(completed.launch, launchText);
  const files = yield* observeProgram();
  const feedback = completed.delivery.directory + "/feedback.json";
  const continuation = predecessor ?? completed.envelope.continuation;
  const authorization = {
    schema: "delivery-amendment-authorization.v1",
    work: completed.delivery.work,
    repository: completed.delivery.repository,
    revision: completed.revision,
    predecessor:
      variant === "wrong-predecessor" ? { ...continuation, sha256: "0".repeat(64) } : continuation,
    feedback: describe(feedback, yield* readTextFile(feedback)),
    purpose: "measured-test-weights",
    delta: ["test-weights.json"],
    authority: { kind: "delegated-coordinator-selection", document: authority },
    measurement: { run, records, artifact, acquisition },
    workflow: {
      old,
      new: {
        root: workflowRoot,
        entry: programEntry,
        revision: completed.workflowRevision,
        files:
          variant === "stale-source"
            ? files.map((file, index) => (index === 1 ? { ...file, sha256: "0".repeat(64) } : file))
            : files,
      },
    },
  };
  const path = directory + "/authorization.json";
  yield* writeTextFile(path, JSON.stringify(authorization));
  return { path, artifact: artifact.path, weights, directory };
}
