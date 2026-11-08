import { parseFileWriteFailure, parseFilesFailure } from "@executablemd/runtime";
import { fitsOutward } from "./outward-size.ts";
import { z } from "zod";
import { clear, describe, stateLimit, unused, write } from "./text-storage.ts";
import { envelope, state } from "./control.ts";

export const props = {
  type: "object",
  properties: {
    record: { type: "object" },
    previous: { type: ["object", "null"], default: null },
    pending: { type: ["object", "null"], default: null },
  },
  required: ["record"],
  additionalProperties: false,
};
const input = z
  .object({ record: state, previous: envelope.nullable(), pending: envelope.shape.pending })
  .strict();
export default function* Publish(value: unknown) {
  const { record, previous, pending } = input.parse(value);
  const text = JSON.stringify(record);
  const content = describe("", text);
  const location = record.manifest.directory + "/continuations/" + content.sha256 + ".json";
  const facts = { ...content, path: location };
  const held = {
    schema: "ticket-return.v1",
    work: previous?.work ?? record.manifest.work,
    source: previous?.source ?? record.manifest.assignment.revision,
    status: "hold",
    revision: previous?.revision ?? record.checkpoint.revision,
    publication: "held",
    continuation: previous?.continuation ?? null,
    pending,
    hold: "Continuation publication did not complete. Preserve the prior state and original receipts; operator disposition is required.",
  };
  const reservation = {
    ...held,
    pending: {
      result: record.manifest.directory + "/attempts/0000/result.json",
      execution: record.manifest.directory + "/calls/0000/execution.json",
      call: record.manifest.directory + "/calls/0000/call.json",
    },
    failure: { name: "PublicationFailure", message: "x".repeat(1024), data: null },
  };
  if (!fitsOutward(reservation)) {
    return { status: "hold", reason: "Initial outward capacity exceeded; no role is authorized." };
  }
  if (facts.utf8Bytes > stateLimit) {
    return held;
  }
  try {
    if (
      previous?.continuation?.path === location &&
      previous.continuation.sha256 === facts.sha256 &&
      previous.continuation.utf8Bytes === facts.utf8Bytes &&
      previous.status === record.checkpoint.status
    ) {
      return previous;
    }
    if (!(yield* unused(String(record.manifest.assignment.repository), location))) {
      return held;
    }
    yield* write(String(record.manifest.assignment.repository), location, text);
  } catch (error) {
    const failure = {
      name: error instanceof Error ? error.name : "PublicationFailure",
      message: error instanceof Error ? error.message : "Publication failed",
      data: parseFileWriteFailure(error) ?? parseFilesFailure(error) ?? null,
    };
    yield* clear(JSON.stringify(failure));
    if (!fitsOutward({ ...held, failure })) {
      throw error;
    }
    return { ...held, failure };
  }
  const deliveryDirectory = record.manifest.delivery?.directory;
  const presentation =
    typeof deliveryDirectory === "string"
      ? {
          delivery: {
            status:
              record.checkpoint.status === "feedback_ready" ? "review_pending" : "feedback_pending",
            record: deliveryDirectory + "/requirements.json",
          },
          remainingRequiredDeliveryWork: ["independent-review", "required-ci", "main-health"],
        }
      : {};
  const last = record.calls.at(-1);
  const hold = record.checkpoint.hold;
  const decision =
    !record.checkpoint.dispatchable &&
    record.checkpoint.status === "hold" &&
    record.checkpoint.revision === record.manifest.assignment.revision &&
    record.checkpoint.feedback.length === 0 &&
    last?.status === "accepted" &&
    typeof last.result === "string" &&
    ((hold?.kind === "needs_decision" &&
      last.assignment.phase === "discovery" &&
      last.role !== "implementor") ||
      (hold?.kind === "needs_discovery" &&
        last.role === "implementor" &&
        hold.next?.phase === "discovery" &&
        hold.next.role === "architect"))
      ? last.result
      : null;
  const nextAction =
    record.checkpoint.status === "feedback_ready" && typeof deliveryDirectory === "string"
      ? { entry: "delivery.md", record: deliveryDirectory + "/requirements.json", action: "review" }
      : decision !== null
        ? {
            entry: "resolve-decision.md",
            gate: record.checkpoint.gate,
            action: "resolve_decision",
            result: decision,
            input: "ticket-decision.v1",
          }
        : {
            entry: "continue.md",
            gate: record.checkpoint.gate,
            action: record.checkpoint.dispatchable ? "continue_feedback" : "resolve_feedback_hold",
          };
  return {
    ...presentation,
    nextAction,
    schema: "ticket-return.v1",
    work: record.manifest.work,
    source: record.manifest.assignment.revision,
    status: record.checkpoint.status,
    revision: record.checkpoint.revision,
    publication: "confirmed",
    continuation: facts,
    pending: null,
    hold: null,
  };
}
