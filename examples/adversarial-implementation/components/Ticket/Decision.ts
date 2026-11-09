import { z } from "zod";
import { envelope, state } from "./control.ts";
import { describe, descriptor, readBounded, same, stateLimit, textLimit } from "./text-storage.ts";

export const props = {
  type: "object",
  properties: {
    path: { type: "string", pattern: "^/" },
    record: { type: "object" },
    saved: { type: "object" },
  },
  required: ["path", "record", "saved"],
  additionalProperties: false,
};
const reference = descriptor.extend({ path: z.string().startsWith("/") }).strict();
const text = reference.extend({ utf8Bytes: z.number().int().min(1).max(textLimit) }).strict();
const request = z
  .object({
    schema: z.literal("ticket-decision.v1"),
    work: z.string().min(1),
    continuation: reference,
    heldResult: reference,
    disposition: z.enum(["accept", "amend"]),
    decision: text,
    provenance: text,
    acceptedInputs: z.array(reference),
  })
  .strict();
type Reference = z.infer<typeof reference>;

export default function* Decision(value: unknown) {
  const input = z
    .object({ path: z.string().startsWith("/"), record: envelope, saved: state })
    .strict()
    .parse(value);
  const source = yield* readBounded(input.path, stateLimit);
  const selected = request.parse(JSON.parse(source));
  const { saved } = input;
  if (selected.work !== saved.manifest.work) {
    throw new Error("The decision names another work item; no resolution was recorded.");
  }
  if (
    input.record.continuation === null ||
    !same(selected.continuation, input.record.continuation)
  ) {
    throw new Error(
      "The decision is bound to another or stale continuation; bind it to this exact confirmed hold.",
    );
  }
  const call = saved.calls.at(-1);
  const result = typeof call?.result === "string" ? saved.documents[call.result] : undefined;
  if (result === undefined || !same(selected.heldResult, result)) {
    throw new Error(
      "The decision names another held result; bind it to the retained result of the final call.",
    );
  }
  const references = new Map<string, Reference>();
  for (const entry of [selected.decision, selected.provenance, ...selected.acceptedInputs]) {
    const prior = references.get(entry.path);
    if (prior !== undefined && !same(prior, entry)) {
      throw new Error("One decision reference names different contents: " + entry.path);
    }
    references.set(entry.path, entry);
  }
  return {
    request: selected,
    file: describe(input.path, source),
    references: [...references.keys()],
    descriptors: Object.fromEntries(references),
  };
}
