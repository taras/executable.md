import { z } from "zod";
import { confirmLinks, envelope, state } from "./control.ts";
import { describe, read, stateLimit } from "./text-storage.ts";
import { confirmAdmission } from "./admission.ts";

export const props = {
  type: "object",
  properties: { record: { type: "object" } },
  required: ["record"],
  additionalProperties: false,
};
export default function* LoadState(value: unknown) {
  const selected = z.object({ record: envelope }).strict().parse(value).record;
  if (selected.publication !== "confirmed" || selected.continuation === null) {
    throw new Error(
      "Unknown ticket publication requires operator disposition; no state is adopted.",
    );
  }
  const expected = selected.continuation;
  const text = yield* read("/", expected.path, stateLimit);
  const actual = describe(expected.path, text);
  if (actual.utf8Bytes !== expected.utf8Bytes || actual.sha256 !== expected.sha256) {
    throw new Error(
      "Confirmed continuation is missing or changed; no automatic reconstruction is permitted.",
    );
  }
  const saved = state.parse(JSON.parse(text));
  confirmLinks(saved, selected);
  yield* confirmAdmission(saved);
  return saved;
}
