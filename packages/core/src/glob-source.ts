/**
 * The rules a glob's own text is held to, and what a failed search may say.
 *
 * `<Glob>` is written in two places now: the ordinary component an author
 * writes, and the capability an evaluation profile admits into a generated
 * fragment. Both take the same patterns, refuse the same unusable ones, and
 * sanitize a provider's failure the same way — so the rules live here once
 * rather than in each of them.
 *
 * What is *not* here is the search. Matching, ordering, deduplication and
 * traversal belong to the Files provider, and which provider a caller reaches
 * is exactly what separates the two call sites: an author's `<Glob>` resolves
 * `API.Files`, and an admitted fragment reaches the operation its host handed
 * the profile.
 *
 * Neither is the error class. A refusal an author reads and a refusal a
 * generated fragment produces are different failures with different boundaries,
 * so each caller builds its own from the sentence this module decides.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import type { FilesFailureData } from "@executablemd/runtime";

import { reason } from "./components/fs-error-phrases.ts";
import type { Json, PropsSchema, ReturnsSchema } from "./types.ts";

/**
 * The two props a search takes, wherever it is written.
 *
 * One value rather than one per call site. An admitted fragment writes the same
 * element an author does, and a second schema that drifted would make one of
 * them accept a spelling the other refuses.
 */
export const GLOB_PROPS: PropsSchema = {
  type: "object",
  properties: {
    include: { type: "array", items: { type: "string" }, minItems: 1 },
    exclude: { type: "array", items: { type: "string" }, default: [] },
  },
  required: ["include"],
  additionalProperties: false,
};

/**
 * What a search binds.
 *
 * Declaring it is what makes the component a value component: the engine
 * requires `as`, renders nothing, and validates what comes back (§6.10).
 */
export const GLOB_RETURNS: ReturnsSchema = {
  type: "array",
  items: { type: "string" },
};

/**
 * The patterns a prop holds, checked for the two things that make one unusable.
 *
 * Prop validation has already established an array of strings, so the shape is
 * re-read rather than asserted (`as` would claim it instead) and a value that
 * somehow is not one contributes nothing. What validation cannot express is
 * *meaning*: patterns match paths relative to the working directory, so an
 * absolute pattern and one that starts by leaving cannot match anything a
 * search can produce.
 *
 * Only a whole `..` first segment leaves. `..notes.md` is an ordinary name, and
 * a `..` further along — `docs/../*.md` — is a path the search never generates,
 * so it matches nothing for the ordinary reason and needs no special refusal.
 */
export function globPatterns(prop: string, value: Json | undefined): Result<string[]> {
  if (!Array.isArray(value)) {
    return Ok([]);
  }

  const found: string[] = [];
  for (const pattern of value) {
    if (typeof pattern !== "string") {
      continue;
    }
    if (pattern.length === 0) {
      return Err(
        new Error(
          `${prop} holds an empty pattern, which matches nothing; ` +
            "give a pattern relative to the working directory.",
        ),
      );
    }
    if (absolute(pattern)) {
      return Err(
        new Error(
          `${prop} pattern "${pattern}" is absolute; ` +
            "give a pattern relative to the working directory.",
        ),
      );
    }
    if (pattern === ".." || pattern.startsWith("../")) {
      return Err(new Error(`${prop} pattern "${pattern}" reaches outside the working directory.`));
    }
    found.push(pattern);
  }
  return Ok(found);
}

/**
 * Whether a pattern names an absolute location.
 *
 * Decided from the pattern's own grammar rather than the running platform's.
 * Patterns match POSIX-relative paths on every host — that is what makes one
 * document mean one thing everywhere — so a leading `/` is absolute wherever
 * this runs, and so is a drive-letter prefix, which is absolute on the host that
 * has drives and matches nothing on the hosts that do not. A leading backslash
 * is left alone: in this dialect it escapes the character after it.
 */
function absolute(pattern: string): boolean {
  return pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern);
}

/**
 * One sanitized sentence for a failed search.
 *
 * The two questions a caller can act on are separated from the rest. A working
 * directory that is missing or is a file is something about the environment; a
 * pattern the dialect cannot compile — an unterminated character class — is
 * something about the text that asked. Which pattern it was does not survive
 * the provider boundary, so the sentence lists the candidates instead of naming
 * one. They are the caller's own text.
 *
 * Everything else names no path. What failed is the working directory or
 * something under it, and both are absolute paths nobody wrote (§1.2).
 */
export function globFailure(
  data: FilesFailureData | undefined,
  candidates: readonly string[],
): string {
  if (data?.phase === "target" && data.reason === "missing") {
    return "the working directory does not exist.";
  }
  if (data?.phase === "target" && data.reason === "not-directory") {
    return "the working directory is not a directory.";
  }
  if (data?.phase === "pattern") {
    return `one of these patterns cannot be used: ${candidates.map((p) => `"${p}"`).join(", ")}.`;
  }
  return `cannot search the working directory: ${reason(data?.reason)}.`;
}
