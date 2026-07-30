import equal from "ajv/dist/runtime/equal.js";
import ucs2length from "ajv/dist/runtime/ucs2length.js";

/**
 * The validator script the server delivers is Ajv standalone code. It reaches
 * Ajv's runtime helpers through `require("ajv/dist/runtime/<name>").default`.
 * Under the fixed formats-disabled policy a compiled schema can only reach
 * `equal` and `ucs2length`, so the receiving side bundles exactly those two
 * implementations and refuses every other request.
 */
const helpers: Record<string, { default: unknown }> = {
  "ajv/dist/runtime/equal": { default: equal },
  "ajv/dist/runtime/ucs2length": { default: ucs2length },
};

export function resolveHelper(id: string): { default: unknown } {
  const helper = helpers[id];
  if (!helper) {
    throw new Error(`the precompiled validator requested a disallowed helper: ${id}`);
  }
  return helper;
}
