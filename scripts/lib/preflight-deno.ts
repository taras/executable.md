import { createHash } from "node:crypto";
import { PREPARED_INPUTS, PREPARED_MARKER, recordedCopy } from "./prepared.ts";

function read(root: URL, path: string): string | undefined {
  try {
    // A cold-cache refusal must run before any third-party graph is resolved.
    // oxlint-disable-next-line local/no-sync-filesystem
    return Deno.readTextFileSync(new URL(path, root));
  } catch {
    return undefined;
  }
}

export function unprepared(root: URL): string | undefined {
  for (const input of PREPARED_INPUTS) {
    const recorded = read(root, recordedCopy(input));
    if (recorded === undefined) {
      return `${PREPARED_MARKER} has no record of ${input}`;
    }
    const current = read(root, input);
    if (current === undefined) {
      return `${input} is missing`;
    }
    if (current !== recorded) {
      return `${input} changed since dependencies were installed`;
    }
  }
  const path = "packages/acp/generated/claude-snapshot.ts";
  const output = read(root, path);
  if (output === undefined) {
    return `${path} is missing`;
  }
  try {
    const recipe: unknown = JSON.parse(
      read(root, "packages/acp/vendor/adapters/claude/recipe.json") ?? "",
    );
    const expected = Reflect.get(Object(recipe), "expected");
    const hash: unknown = Reflect.get(Object(expected), "moduleSha256");
    if (typeof hash !== "string" || createHash("sha256").update(output).digest("hex") !== hash) {
      return `${path} does not match the prepared recipe`;
    }
  } catch {
    return "the Claude preparation recipe is invalid";
  }
  return undefined;
}

export function assertPrepared(root: URL): void {
  const missing = unprepared(root);
  if (missing) {
    throw new Error(`${missing} — run \`deno task setup\``);
  }
}
