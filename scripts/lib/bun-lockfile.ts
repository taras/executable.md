import { z } from "zod";

const LockfileSchema = z.object({
  workspaces: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      version: z.string().optional(),
    }),
  ),
});

/** What `bun.lock` records for one workspace member. */
export interface LockedWorkspace {
  name?: string;
  version?: string;
}

/**
 * Bun writes its text lockfile as JSON with trailing commas, and nothing else
 * JSON refuses — no comments, no unquoted keys, no single-quoted strings. So
 * the file becomes parseable by dropping every comma whose next non-whitespace
 * character closes its container. A comma inside a string value is not one of
 * those, which is why this walks the text instead of matching it.
 */
function withoutTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) {
        next += 1;
      }
      if (text[next] === "}" || text[next] === "]") {
        continue;
      }
    }

    out += char;
  }

  return out;
}

/** Every workspace member `text` records, keyed by its root-relative directory. */
export function parseBunLockfile(text: string): Record<string, LockedWorkspace> {
  return LockfileSchema.parse(JSON.parse(withoutTrailingCommas(text))).workspaces;
}
