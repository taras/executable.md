import { z } from "zod";

export const size = z.object({ columns: z.int().min(1).max(500), rows: z.int().min(1).max(200) });
export const point = z.object({ column: z.int().nonnegative(), row: z.int().nonnegative() });
export const region = z.enum(["sidekick-composer", "transcript", "history"]);
export const waitOptions = z.object({
  text: z.string().min(1),
  region: region.optional(),
  timeout: z.int().positive().optional(),
  at: point.optional(),
  present: z.boolean().optional(),
  unique: z.boolean().optional(),
});
export const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ready") }),
  z.object({ action: z.literal("attachment-ready"), path: z.string() }),
  z.object({ action: z.literal("focus") }),
  z.object({ action: z.literal("type"), text: z.string() }),
  z.object({ action: z.literal("key"), key: z.string().min(1) }),
  z.object({ action: z.literal("click"), at: point }),
  z.object({
    action: z.literal("scroll"),
    delta: z.int(),
    region: region.optional(),
    at: point.optional(),
  }),
  z.object({ action: z.literal("wait"), ...waitOptions.shape }),
  z.object({ action: z.literal("resize"), ...size.shape }),
  z.object({ action: z.literal("look") }),
  z.object({ action: z.literal("exit") }),
  z.object({ action: z.literal("stop") }),
]);
export const response = z.object({ error: z.string() }).or(z.object({ value: z.unknown() }));
export const exitResult = z.object({
  exitCode: z.int().nullable(),
  location: z.string().nullable(),
});
export const launch = z.object({
  directory: z.string(),
  cwd: z.string(),
  home: z.string(),
  scenario: z.string().optional(),
  entry: z.string(),
  denoDir: z.string(),
  ...size.shape,
  args: z.array(z.string()),
});
export const defaultSize = { columns: 160, rows: 36 };
export const worktree = new URL("../../../", import.meta.url);
export type Command = z.infer<typeof command>;
export type Launch = z.infer<typeof launch>;
export type Point = z.infer<typeof point>;
export type Size = z.infer<typeof size>;
export type Region = z.infer<typeof region>;
export type WaitOptions = z.infer<typeof waitOptions>;
