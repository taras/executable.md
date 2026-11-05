/**
 * The record `deno task deps` leaves behind, and what makes it current.
 *
 * This module imports nothing. `scripts/preflight.ts` reads it on a cold cache,
 * where any third-party specifier would fail to resolve before a line of it
 * ran, and a relative source file is the only kind of import that costs nothing
 * there.
 *
 * The record is a copy of each input, compared byte for byte, rather than a
 * digest of it. Four properties, all of which the comparison needs:
 *
 * - **byte-exact** — no digest, so no question of what two inputs could share;
 * - **synchronous** — a plain `readTextFileSync` and a string comparison;
 * - **dependency-free** — nothing to import beyond this file, which is what
 *   lets the preflight run before anything is cached;
 * - **cold-cache safe** — the record lives in `node_modules/`, so its absence
 *   is itself the "not prepared" answer.
 *
 * It is content-based, so a checkout or a branch switch that restores the same
 * bytes does not read as a change. Only small source inputs are copied; the generated Claude payload is checked
 * separately against the recipe's module hash.
 */

/** Where preparation records what it prepared from. Inside `node_modules/`, which is untracked. */
export const PREPARED_MARKER = "node_modules/.xmd-prepared";

/** The files whose contents decide whether a preparation is still current. */
export const PREPARED_INPUTS = [
  "deno.lock",
  "package.json",
  "packages/acp/vendor/adapters/claude/recipe.json",
  "packages/acp/vendor/adapters/claude/adapter.patch",
  "packages/acp/vendor/adapters/claude/sdk-transform.mjs",
  "packages/acp/vendor/adapters/claude/SDK-NOTICE.md",
  "scripts/lib/prepare-claude.ts",
  "scripts/lib/claude-recipe.ts",
  "scripts/lib/claude-snapshot-module.ts",
  "packages/acp/src/adapter-snapshot-type.ts",
];

/** Where the copy of `input` lives inside the marker directory. */
export function recordedCopy(input: string): string {
  return `${PREPARED_MARKER}/${input.replaceAll("/", "__")}`;
}
