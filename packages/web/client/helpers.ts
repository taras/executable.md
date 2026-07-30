import equalModule from "ajv/dist/runtime/equal.js";
import ucs2lengthModule from "ajv/dist/runtime/ucs2length.js";

/**
 * The validator script the server delivers is Ajv standalone code. It reaches
 * Ajv's runtime helpers through `require("ajv/dist/runtime/<name>").default`.
 * Under the fixed formats-disabled policy a compiled schema can only reach
 * `equal` and `ucs2length`, so the receiving side bundles exactly those two
 * implementations and refuses every other request.
 */
const helpers: Record<string, { default: unknown }> = {
  "ajv/dist/runtime/equal": toHelper("equal", equalModule),
  "ajv/dist/runtime/ucs2length": toHelper("ucs2length", ucs2lengthModule),
};

export function resolveHelper(id: string): { default: unknown } {
  const helper = helpers[id];
  if (!helper) {
    throw new Error(`the precompiled validator requested a disallowed helper: ${id}`);
  }
  return helper;
}

/**
 * One helper, in the shape the generated code reads it in.
 *
 * Ajv publishes its runtime helpers as CommonJS, and what a default import
 * yields depends on the host's interop: Deno and Node hand back the module
 * object, so the function sits one `.default` further in, while Bun hands back
 * the function itself. The generated code always reads `require(id).default`, so
 * the function is found here — however this runtime presented it — and wrapped
 * exactly once.
 *
 * Passing the module object straight through satisfies the type and fails later,
 * at validation time, with `func is not a function` — and only for the schemas
 * that reach a helper at all, which is why a `maxLength` or an object `enum` is
 * what would have exposed it. A shape neither branch recognizes fails loudly at
 * load instead of quietly inside a validator.
 */
function toHelper(name: string, imported: unknown): { default: unknown } {
  if (typeof imported === "function") {
    return { default: imported };
  }
  if (typeof imported === "object" && imported !== null && "default" in imported) {
    const { default: inner } = imported;
    if (typeof inner === "function") {
      return { default: inner };
    }
  }
  throw new Error(`the Ajv runtime helper "${name}" did not resolve to a function`);
}
