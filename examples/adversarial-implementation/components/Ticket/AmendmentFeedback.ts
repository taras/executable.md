import { z } from "zod";
import { envelope, state } from "./control.ts";
import { describe, read, unused, write } from "./text-storage.ts";
import { finalFeedback } from "./admission.ts";

export const props = {
  type: "object",
  properties: { record: { type: "object" }, confirmed: { type: "object" } },
  required: ["record", "confirmed"],
  additionalProperties: false,
};

export default function* AmendmentFeedback(value: unknown) {
  const selected = z.object({ record: state, confirmed: envelope }).strict().parse(value);
  const saved = selected.record;
  const admitted = saved.checkpoint.amendment;
  const continuation = selected.confirmed.continuation;
  const revision = saved.checkpoint.revision;
  if (
    admitted === undefined ||
    saved.checkpoint.status !== "feedback_ready" ||
    selected.confirmed.publication !== "confirmed" ||
    continuation === null ||
    revision === null
  ) {
    throw new Error("Only a confirmed amended feedback_ready continuation publishes final feedback.");
  }
  const amended = saved.calls.slice(admitted.calls);
  const implementation = amended.filter((call) => call.role === "implementor").at(-1);
  const reviews = Object.entries(saved.checkpoint.reviews)
    .filter(([, reviewed]) => reviewed === revision)
    .flatMap(([role]) => {
      const call = amended.filter((entry) => entry.role === role).at(-1);
      return call?.result ? [call.result] : [];
    });
  if (implementation?.result === undefined || implementation.result === null) {
    throw new Error("Final amendment feedback requires the admitted implementation result.");
  }
  const path = admitted.reservation + "/feedback.json";
  const text = JSON.stringify(
    finalFeedback.parse({
      schema: "delivery-amendment-feedback.v1",
      status: "feedback_ready",
      revision,
      base: admitted.base,
      original: admitted.feedback,
      request: admitted.request,
      disposition: describe(admitted.disposition, yield* read("/", admitted.disposition)),
      continuation,
      implementation: implementation.result,
      reviews,
    }),
  );
  if (!(yield* unused("/", path))) {
    throw new Error(
      "Final amendment feedback already exists at " + path + "; preserve it for reconciliation.",
    );
  }
  yield* write("/", path, text);
  return describe(path, text);
}
