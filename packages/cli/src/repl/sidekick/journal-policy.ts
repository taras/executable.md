import { Err, Ok } from "effection";
import type { Result } from "effection";
import { z } from "zod";

export const JournalMaxBytes = z.number().int().positive().safe();
const metadata = z
  .tuple([
    z.number().int().positive().safe(),
    z.string(),
    z.number().int().nonnegative().safe(),
    z.number().int().positive().safe(),
    JournalMaxBytes.optional(),
  ])
  .refine(([, , start, end]) => start < end);

export function formatJournalWindow(
  entry: number,
  query: string,
  range: { start: number; end: number },
  maxBytes?: number,
): string {
  const header = [entry, query, range.start, range.end];
  if (maxBytes !== undefined) {
    header.push(maxBytes);
  }
  return (
    `select(${JSON.stringify(header)} != null) |\n` +
    `select(.entry == ${entry}) |\n(\n${query}\n) | .[${range.start}:${range.end}]`
  );
}

export function recognizeJournalWindow(expression: string) {
  const line = expression.slice(0, expression.indexOf("\n"));
  if (!line.startsWith("select(") || !line.endsWith(" != null) |")) {
    return undefined;
  }
  try {
    const parsed = metadata.safeParse(JSON.parse(line.slice(7, -11)));
    if (!parsed.success) {
      return undefined;
    }
    const [entry, query, start, end, maxBytes] = parsed.data;
    const range = { start, end };
    return expression === formatJournalWindow(entry, query, range, maxBytes)
      ? { entry, query, range, maxBytes }
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveJournalMaxBytes(
  expression: string,
  explicit?: number,
): Result<number | undefined> {
  if (explicit !== undefined) {
    const parsed = JournalMaxBytes.safeParse(explicit);
    return parsed.success
      ? Ok(parsed.data)
      : Err(new Error("Journal maxBytes must be a positive safe integer byte count."));
  }
  return Ok(recognizeJournalWindow(expression)?.maxBytes);
}
