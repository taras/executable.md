import { z } from "zod";
import { descriptor, snapshot, stateLimit } from "./text-storage.ts";

const role = z.enum(["architect", "planner", "implementor"]);
const revision = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .nullable();
const jsonObject = z.record(z.string(), z.json());
const provider = z.enum(["codex", "claude"]);
const profile = z
  .object({ provider, model: z.string().min(1), effort: z.string().min(1) })
  .strict();
const identity = z
  .object({
    session: z.string().min(1),
    provider,
    initialized: z.boolean(),
  })
  .strict();
export const envelope = z
  .object({
    schema: z.literal("ticket-return.v1"),
    work: z.string(),
    source: revision,
    status: z.string(),
    revision,
    publication: z.enum(["confirmed", "held"]),
    continuation: descriptor.nullable(),
    pending: z
      .object({ result: z.string(), execution: z.string(), call: z.string() })
      .strict()
      .nullable(),
    hold: z.string().nullable(),
    delivery: z
      .object({ status: z.enum(["review_pending", "feedback_pending"]), record: z.string() })
      .strict()
      .optional(),
    remainingRequiredDeliveryWork: z.array(z.string()).optional(),
    nextAction: z
      .object({
        entry: z.string(),
        record: z.string().optional(),
        gate: z.string().nullable().optional(),
        action: z.string(),
      })
      .strict()
      .optional(),
    failure: z
      .object({ name: z.string(), message: z.string(), data: z.json().nullable() })
      .strict()
      .optional(),
  })
  .strict();
export const state = z
  .object({
    schema: z.literal("ticket-state.v1"),
    manifest: z
      .object({
        schema: z.literal("ticket-workflow.v2"),
        work: z.string(),
        directory: z.string().startsWith("/"),
        identityDirectory: z.string().startsWith("/").optional(),
        assignment: jsonObject,
        roles: z.object({ architect: identity, planner: identity, implementor: identity }).strict(),
        acceptedInputs: z.array(snapshot),
        roleInputs: z.partialRecord(role, z.array(snapshot)).optional(),
        deliveredInputs: z.record(z.string(), z.array(z.string())).optional(),
        maxCorrections: z.number().int(),
        maxApiRepairs: z.number().int(),
        maxResponseCorrections: z.number().int(),
        api: jsonObject.optional(),
        delivery: jsonObject.optional(),
      })
      .strict(),
    checkpoint: z
      .object({
        reviewPolicy: z
          .object({
            kind: z.enum(["feature", "correction"]),
            assessment: jsonObject,
            reviewers: z.array(z.enum(["architect", "planner"])),
            model: z.literal("gpt-6.1-sol"),
            effort: z.enum(["medium", "high"]),
          })
          .strict(),
        work: z.string(),
        status: z.string(),
        dispatchable: z.boolean(),
        round: z.number().int().nonnegative(),
        gate: z.string(),
        revision,
        assignment: jsonObject,
        reviews: z.record(z.string(), z.string()),
        feedback: z.array(z.string()),
        initialized: z
          .object({ architect: z.boolean(), planner: z.boolean(), implementor: z.boolean() })
          .strict(),
        hold: z
          .object({ kind: z.string(), reason: z.string(), receipt: z.string().optional() })
          .strict()
          .nullable(),
        plannerCall: z.string().startsWith("/").nullable().optional(),
        feedbackInputs: z.array(z.string()).optional(),
        discovery: z.array(jsonObject).optional(),
        exactApproval: z.json().optional(),
        exactReview: z.json().optional(),
      })
      .strict(),
    calls: z.array(
      z
        .object({
          id: z.string(),
          attempt: z.string(),
          record: z.string(),
          gate: z.string(),
          round: z.number().int(),
          role,
          session: z.string(),
          provider,
          initialize: z.boolean(),
          assignment: jsonObject,
          inputs: z.array(snapshot),
          status: z.string(),
          result: z.string().nullable().optional(),
          execution: z.string(),
          artifactDocumentRecord: z.string(),
          documentRecord: z.string(),
          observation: z.string().optional(),
          validation: z.string().optional(),
          source: z.string().optional(),
          preparation: z.string().optional(),
          delivery: z.string().nullable().optional(),
          profile: profile.nullable().optional(),
        })
        .strict(),
    ),
    documents: z.record(z.string(), snapshot),
    deliveredInputs: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();

export function confirmLinks(saved: z.infer<typeof state>, selected: z.infer<typeof envelope>) {
  if (
    saved.manifest.work !== selected.work ||
    saved.checkpoint.work !== selected.work ||
    saved.manifest.assignment.revision !== selected.source ||
    saved.checkpoint.revision !== selected.revision ||
    saved.checkpoint.status !== selected.status ||
    selected.continuation === null ||
    selected.continuation.utf8Bytes > stateLimit
  ) {
    throw new Error("Ticket continuation identity does not match its confirmed return.");
  }
  for (const [index, call] of saved.calls.entries()) {
    const original = saved.manifest.roles[call.role];
    const id = String(index).padStart(4, "0");
    if (
      call.id !== id ||
      call.session !== original.session ||
      call.provider !== original.provider ||
      call.assignment.work !== selected.work ||
      call.assignment.repository !== saved.manifest.assignment.repository ||
      call.attempt !== saved.manifest.directory + "/attempts/" + id ||
      call.record !== saved.manifest.directory + "/calls/" + id ||
      call.execution !== call.record + "/execution.json" ||
      call.documentRecord !== call.record + "/documents.json" ||
      call.artifactDocumentRecord !== call.record + "/artifact-documents.json" ||
      (call.preparation !== undefined &&
        call.preparation !== saved.manifest.directory + "/preparations/" + id + "/receipt.json") ||
      (call.delivery !== undefined &&
        call.delivery !== null &&
        call.delivery !== call.attempt + "/delivery.json") ||
      (call.profile !== undefined &&
        call.profile !== null &&
        call.profile.provider !== call.provider) ||
      (call.result !== undefined &&
        call.result !== null &&
        call.result !== call.attempt + "/result.json") ||
      call.inputs.some(
        (input) => JSON.stringify(saved.documents[input.path]) !== JSON.stringify(input),
      )
    ) {
      throw new Error("Ticket call identity changed.");
    }
  }
  const receipt = saved.checkpoint.hold?.receipt;
  if (
    receipt !== undefined &&
    (saved.checkpoint.hold?.kind !== "input_preparation" ||
      receipt !==
        saved.manifest.directory +
          "/preparations/" +
          String(saved.calls.length).padStart(4, "0") +
          "/receipt.json")
  ) {
    throw new Error("Ticket preparation hold names another call.");
  }
  for (const [key, document] of Object.entries(saved.documents)) {
    if (key !== document.path) {
      throw new Error("Ticket original reference changed.");
    }
  }
}
