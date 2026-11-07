import { parseFilesFailure } from "@executablemd/runtime";
import { z } from "zod";

const configurationMarker = z.object({
  "executablemd.acp.configuration-failure": z.strictObject({
    reason: z.enum(["selector-unavailable", "configuration-mismatch"]),
    setting: z.enum(["model", "effort"]),
  }),
});

export const configurationSchema = configurationMarker.shape[
  "executablemd.acp.configuration-failure"
].nullable();

function chain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  let current = error;
  while (current !== undefined && current !== null && !seen.includes(current)) {
    seen.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return seen;
}

export function causedBy(error: unknown, candidates: ReadonlySet<unknown>): boolean {
  return chain(error).some((link) => candidates.has(link));
}

export function isFilesFailure(error: unknown): boolean {
  return chain(error).some((link) => parseFilesFailure(link) !== undefined);
}

export function configurationOf(error: unknown) {
  for (const link of chain(error)) {
    const parsed = configurationMarker.safeParse(link);
    if (parsed.success) {
      return parsed.data["executablemd.acp.configuration-failure"];
    }
  }
  return null;
}

export function describeFailure(error: unknown): string {
  return chain(error)
    .map((link) => (link instanceof Error ? (link.stack ?? link.message) : String(link)))
    .join("\nCaused by:\n");
}
