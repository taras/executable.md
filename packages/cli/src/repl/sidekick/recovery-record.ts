import { z } from "zod";

const prefix = z
  .object({
    records: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const recoveryDecision = z
  .object({
    kind: z.literal("recovery-decision"),
    id: z.string().min(1),
    conversation: z.string().min(1),
    retained: prefix,
    requests: z.array(z.number().int().nonnegative()).min(1),
    controls: z.array(
      z.object({ response: z.string().min(1), order: z.number().int().nonnegative() }).strict(),
    ),
    message: z.string().min(1),
    text: z.string().refine((text) => text.trim().length > 0),
    origin: z.object({ kind: z.literal("ui") }).strict(),
    action: z.enum(["continue-original", "replace"]),
    basis: z.enum([
      "joined-owned-exchange",
      "retained-clean-ownership",
      "explicit-abandonment",
      "exact-original-unavailable",
    ]),
    target: z.string().min(1),
  })
  .strict()
  .refine((record) =>
    record.action === "replace"
      ? record.target !== record.conversation
      : record.target === record.conversation,
  );
export type RecoveryDecisionRecord = z.infer<typeof recoveryDecision>;

export const recoveryReference = z
  .object({
    kind: z.literal("recovery-reference"),
    conversation: z.string().min(1),
    decision: z.string().min(1),
    previous: z.string().min(1),
    next: z.string().min(1),
    sessionId: z.string().uuid(),
    phase: z.enum(["offered", "acknowledged"]),
  })
  .strict();
export type RecoveryReferenceRecord = z.infer<typeof recoveryReference>;

const control = z
  .object({ response: z.string().min(1), order: z.number().int().nonnegative() })
  .strict();

export const humanStop = z
  .object({
    kind: z.literal("human-stop"),
    conversation: z.string().min(1),
    retained: prefix,
    requests: z
      .array(z.number().int().nonnegative())
      .min(1)
      .refine((requests) => requests.every((at, index) => index === 0 || requests[index - 1] < at)),
    controls: z
      .array(control)
      .refine(
        (controls) =>
          new Set(controls.map((one) => `${one.response}\0${one.order}`)).size === controls.length,
      ),
  })
  .strict();
export type HumanStopRecord = z.infer<typeof humanStop>;
