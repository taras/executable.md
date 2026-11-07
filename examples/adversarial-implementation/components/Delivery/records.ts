import { z } from "zod";
import { configurationSchema } from "./failure.ts";

export const reviewerSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().nullable(),
  session: z.string().min(1),
});

export const catalogSchema = z.strictObject({
  state: z.enum(["selected", "unavailable", "failed"]),
  choices: z.array(z.string().min(1)).min(1),
  model: z.string().min(1).nullable(),
  advertised: z.array(z.string()).nullable(),
  failure: z.string().nullable(),
});

const turnSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("reply"), reply: z.string() }),
  z.strictObject({
    state: z.literal("failed"),
    stage: z.enum(["session", "turn"]),
    failure: z.string(),
    partial: z.string(),
    configuration: configurationSchema,
  }),
]);

export const outcomeSchema = z.strictObject({
  schema: z.literal("delivery-review-outcome.v1"),
  reviewer: reviewerSchema,
  catalog: catalogSchema,
  turn: turnSchema.nullable(),
});

export const executionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed"), failure: z.null() }),
  z.strictObject({ status: z.literal("failed"), failure: z.string() }),
]);

const entrySchema = z.strictObject({
  reviewer: reviewerSchema,
  choices: z.array(z.string().min(1)).min(1),
});

export const selectionSchema = z.strictObject({
  schema: z.literal("delivery-review-selection.v1"),
  work: z.string().min(1),
  repository: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  policy: z.record(z.string(), z.unknown()),
  inputs: z.array(z.record(z.string(), z.unknown())),
  responseSchema: z.record(z.string(), z.unknown()),
  chain: z.enum(["fable-astra", "astra-final", "single"]),
  reviewers: z.array(entrySchema).min(1).max(2),
});

export const attemptSchema = z.strictObject({
  position: z.number().int().min(0).max(1),
  reviewer: reviewerSchema,
  model: z.string().nullable(),
  state: z.enum(["reserved", "review", "eligible", "held"]),
  reason: z.string().min(1),
  evidence: z.array(z.string().startsWith("/")),
});

export const holdSchema = z.strictObject({
  schema: z.literal("delivery-review-hold.v1"),
  work: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  chain: z.enum(["fable-astra", "astra-final"]),
  summary: z.string().min(1),
  unknown: z.string().min(1),
  attempts: z.array(attemptSchema).min(1).max(2),
});

export const dispositionSchema = z.strictObject({
  schema: z.literal("delivery-review-disposition.v1"),
  hold: holdSchema,
  answer: z.strictObject({ disposition: z.enum(["hold", "reconcile"]) }),
});
