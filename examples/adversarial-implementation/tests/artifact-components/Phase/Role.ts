import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { z } from "zod";
export const props = { type: "object", additionalProperties: true };
const call = z
  .object({
    role: z.string(),
    session: z.string(),
    initialize: z.boolean(),
    inputs: z.array(z.object({ path: z.string(), content: z.string() })),
    assignment: z
      .object({
        phase: z.string(),
        request: z.string(),
        work: z.string(),
        revision: z.string(),
        artifactDirectory: z.string(),
        assessment: z.record(z.string(), z.json()),
        continuation: z.record(z.string(), z.json()),
      })
      .passthrough(),
  })
  .passthrough();
export default function* Role(input: unknown) {
  const selected = call.parse(input);
  if (!selected.assignment.request.startsWith("artifact-return:")) {
    throw new Error("Synthetic role accepts only its explicit fixture assignment.");
  }
  const config = z
    .object({ root: z.string(), references: z.array(z.string()), overage: z.boolean() })
    .strict()
    .parse(
      JSON.parse(yield* readTextFile(selected.assignment.request.slice("artifact-return:".length))),
    );
  const counter = config.root + "/effect-counter.txt";
  const count = (yield* exists(counter)) ? Number(yield* readTextFile(counter)) : 0;
  yield* writeTextFile(counter, String(count + 1));
  const received = config.root + "/received.json";
  const previous = (yield* exists(received))
    ? z.array(z.json()).parse(JSON.parse(yield* readTextFile(received)))
    : [];
  yield* writeTextFile(received, JSON.stringify([...previous, selected]));
  const receipt = selected.assignment.artifactDirectory + "/focused.json";
  yield* writeTextFile(receipt, '{"passed":true}');
  return JSON.stringify({
    schema: "phase-result.v2",
    phase: selected.assignment.phase,
    work: selected.assignment.work,
    outcome: "complete",
    revision: selected.assignment.revision,
    summary: "Synthetic role completed.",
    handoff: selected.assignment.request,
    handoffInputs: config.overage ? [] : [config.references[0]],
    artifacts: config.overage
      ? ["/" + "\u0001".repeat(200_000)]
      : [...config.references, config.references[0]],
    evidence:
      selected.role === "implementor"
        ? [
            {
              revision: selected.assignment.revision,
              command: "synthetic focused evidence",
              outcome: "passed",
              artifact: receipt,
            },
          ]
        : [],
    findings: [],
    assessment: selected.assignment.assessment,
    discoveryRequests: [],
    discoveryGaps: [],
    next: selected.assignment.continuation,
  });
}
