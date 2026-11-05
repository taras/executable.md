import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { Err, Ok } from "effection";
import type { Result } from "effection";
import type { Yield } from "@executablemd/durable-streams";

export const PLACEMENT = "executablemd.repl-placement";
const path = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const declaration = z.object({ projectDirectory: path, canonicalProjectRoot: path }).strict();
export type EntryPlacement = z.infer<typeof declaration>;

export function parseEntryPlacement(value: unknown): Result<EntryPlacement> {
  const parsed = declaration.safeParse(value);
  return parsed.success
    ? Ok(Object.freeze(parsed.data))
    : Err(new Error("This entry has an unreadable project placement."));
}

export function admissionPlacement(admission: Yield): Result<EntryPlacement | undefined> {
  return Object.hasOwn(admission.description, PLACEMENT)
    ? parseEntryPlacement(admission.description[PLACEMENT])
    : Ok(undefined);
}

export function samePlacement(
  left: EntryPlacement | undefined,
  right: EntryPlacement | undefined,
): boolean {
  return (
    left?.projectDirectory === right?.projectDirectory &&
    left?.canonicalProjectRoot === right?.canonicalProjectRoot
  );
}
