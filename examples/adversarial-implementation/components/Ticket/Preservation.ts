import { z } from "zod";
import type { Operation } from "effection";

export const props = {
  type: "object",
  properties: {
    inputs: { type: "array", items: { type: "object" } },
    reduction: { type: "object" },
  },
  required: ["inputs", "reduction"],
  additionalProperties: false,
};
export const returns = { type: "object" };

export default function* Preservation(input: unknown): Operation<unknown> {
  const { inputs, reduction } = z
    .object({
      inputs: z.array(z.object({ path: z.string(), content: z.string() })),
      reduction: z.object({
        content: z.string(),
        dispositions: z.array(
          z.object({
            source: z.string(),
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
            kind: z.enum(["extract", "consolidate", "reference"]),
            targetStart: z.number().int().nonnegative().nullable(),
            reason: z.string().min(1),
          }),
        ),
      }),
    })
    .parse(input);
  const failures: string[] = [];
  for (const item of reduction.dispositions) {
    const source = inputs.find((source) => source.path === item.source);
    if (!source || item.end <= item.start || item.end > source.content.length) {
      failures.push(`Invalid source span: ${item.source}:${item.start}-${item.end}`);
      continue;
    }
    if (item.kind === "reference") {
      if (!reduction.content.includes(item.source)) {
        failures.push(`Missing original reference: ${item.source}`);
      }
    } else if (
      item.targetStart === null ||
      reduction.content.slice(item.targetStart, item.targetStart + item.end - item.start) !==
        source.content.slice(item.start, item.end)
    ) {
      failures.push(`Changed extract: ${item.source}:${item.start}-${item.end}`);
    }
  }
  for (const source of inputs) {
    let end = 0;
    const spans = reduction.dispositions
      .filter((item) => item.source === source.path)
      .sort((a, b) => a.start - b.start);
    for (const span of spans) {
      if (span.start !== end) {
        failures.push(`Unmapped or overlapping source: ${source.path}:${end}-${span.start}`);
      }
      end = span.end;
    }
    if (end !== source.content.length) {
      failures.push(`Unmapped source: ${source.path}:${end}-${source.content.length}`);
    }
  }
  return { valid: failures.length === 0, failures };
}
