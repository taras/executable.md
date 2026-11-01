import { z } from "zod";

export const UiSize = z
  .object({
    columns: z.number().int().positive().max(1000),
    rows: z.number().int().positive().max(1000),
  })
  .strict();
const point = z
  .object({ column: z.number().int().nonnegative(), row: z.number().int().nonnegative() })
  .strict();
const key = z.enum([
  "Enter",
  "Escape",
  "Tab",
  "Backtab",
  "Backspace",
  "Interrupt",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Alt+ArrowUp",
  "Alt+ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
export const physical = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("input"),
      event: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("text"), text: z.string().max(65536) }).strict(),
        z.object({ kind: z.literal("key"), key }).strict(),
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("pointer"), at: point }).strict(),
  z.object({ kind: z.literal("wheel"), at: point, direction: z.enum(["up", "down"]) }).strict(),
  z.object({ kind: z.literal("resize"), size: UiSize }).strict(),
  z.object({ kind: z.literal("eof") }).strict(),
]);
export const applied = z
  .object({
    kind: z.literal("applied"),
    sequence: z.number().int().positive(),
    size: UiSize,
    applied: z.boolean(),
  })
  .strict();
export const incoming = z.union([physical, applied]);
export const presentation = z
  .object({
    kind: z.literal("frame"),
    sequence: z.number().int().positive(),
    size: UiSize,
    bytes: z.array(z.number().int().min(0).max(255)).max(200000),
  })
  .strict();
