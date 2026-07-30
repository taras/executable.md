/**
 * The declaration boundary: what a document said, normalized and refused early.
 *
 * A WebForm is declared by a schema and an optional UI schema, and a document
 * may hold either as a structured value or as captured JSON text. Both spellings
 * normalize to the same object here, so the rest of the package — the compiler,
 * the page, the journal fingerprint — sees one representation and never asks
 * which form the author used.
 *
 * Everything this module refuses, it refuses before anything observable happens:
 * no port is bound, no browser is launched, and nothing is journaled on the
 * strength of a declaration that could not be used. That ordering is the reason
 * parsing is separate from compiling.
 *
 * The two schemas are not the same kind of thing, and the asymmetry is the point.
 * `schema` is a draft-07 JSON Schema and is validated as one. `uiSchema` is RJSF
 * configuration — `ui:widget`, `ui:order`, `ui:options` — which is not a JSON
 * Schema and would be rejected as one by a strict validator. It is normalized
 * and carried through untouched, never compiled.
 */

import type { Json, JsonObject } from "./json.ts";
import { isJsonObject, JsonParseError, parseJsonObject } from "./json.ts";
import { createServerAjv } from "./ajv-options.ts";

/** A declaration that cannot be used. Raised before any live effect. */
export class DeclarationError extends Error {
  override name = "DeclarationError";
}

export interface Declaration {
  /** The normalized draft-07 schema, ready to compile. */
  schema: JsonObject;
  /** The normalized RJSF UI schema, or absent. Never compiled as a schema. */
  uiSchema?: JsonObject;
}

/**
 * Normalize and check a declaration.
 *
 * `schema` is required; `uiSchema` is optional and `undefined` means absent.
 */
export function parseDeclaration(schema: unknown, uiSchema?: unknown): Declaration {
  const normalizedSchema = readObject("schema", schema);

  rejectAsyncSchema(normalizedSchema);
  rejectExternalReferences(normalizedSchema);
  rejectInvalidDraft07(normalizedSchema);

  if (uiSchema === undefined) {
    return { schema: normalizedSchema };
  }
  return { schema: normalizedSchema, uiSchema: readObject("uiSchema", uiSchema) };
}

/**
 * Read either spelling of a declaration into a JSON object.
 *
 * Text is parsed and then re-parsed as JSON, because `JSON.parse` answers
 * `unknown`: the second pass is what produces a typed object rather than an
 * asserted one, and it costs one walk of a value that is about to be walked
 * again anyway.
 */
function readObject(name: string, value: unknown): JsonObject {
  if (typeof value === "string") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch (error) {
      throw new DeclarationError(`<WebForm> ${name} text is not JSON: ${messageOf(error)}`);
    }
    return asObject(name, decoded);
  }
  return asObject(name, value);
}

function asObject(name: string, value: unknown): JsonObject {
  try {
    return parseJsonObject(value);
  } catch (error) {
    if (error instanceof JsonParseError) {
      throw new DeclarationError(
        `<WebForm> ${name} must be a JSON object or JSON text describing one: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Refuse `$async: true`.
 *
 * Ajv compiles an asynchronous schema without complaint and hands back a
 * validator that returns a promise. Submission validation is synchronous on both
 * sides, so such a validator would report every submission as valid — a promise
 * is truthy. Refusing the declaration is the only place this is cheap to see.
 */
function rejectAsyncSchema(schema: JsonObject): void {
  if (schema["$async"] === true) {
    throw new DeclarationError(
      "<WebForm> schema must not be asynchronous ($async: true): submission validation is synchronous.",
    );
  }
}

/**
 * Refuse a reference that leaves the document.
 *
 * Ajv reports an unreachable external reference and a mistyped local pointer
 * with the same `can't resolve reference` message, so the two are told apart
 * here — by the shape of the reference itself — rather than by reading an error
 * string. Only a same-document pointer can resolve today; file and HTTP(S)
 * references are #192.
 *
 * The scan reads every `$ref` string anywhere in the schema, without tracking
 * whether that position is a schema or data. So a `$ref` appearing inside a
 * `const` or an `enum` member — where it is a literal value that Ajv never
 * resolves — is refused as though it were a reference. That is a deliberate
 * false positive: refusing a schema that would have worked is recoverable by
 * rewriting it, while admitting a reference this package cannot resolve is not,
 * and distinguishing the two needs a full schema-position walker.
 */
function rejectExternalReferences(schema: JsonObject): void {
  for (const reference of collectReferences(schema)) {
    if (!reference.startsWith("#")) {
      throw new DeclarationError(
        `<WebForm> schema references "${reference}", which is outside the supplied schema. ` +
          "Only references contained within it resolve; external file and HTTP(S) " +
          "references are deferred to #192.",
      );
    }
  }
}

function collectReferences(value: Json): string[] {
  const references: string[] = [];
  visit(value);
  return references;

  function visit(node: Json): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!isJsonObject(node)) {
      return;
    }
    const reference = node["$ref"];
    if (typeof reference === "string") {
      references.push(reference);
    }
    for (const item of Object.values(node)) {
      visit(item);
    }
  }
}

/**
 * Refuse a schema draft-07 does not describe.
 *
 * `validateSchema` checks against the meta-schema without compiling, so an
 * unusable schema is reported as one before any validator exists. A local
 * pointer that does not resolve is not visible here — it surfaces when the
 * compiler runs, and is reported there.
 */
function rejectInvalidDraft07(schema: JsonObject): void {
  const ajv = createServerAjv();
  if (ajv.validateSchema(schema)) {
    return;
  }
  throw new DeclarationError(
    `<WebForm> schema is not a valid draft-07 JSON Schema: ${ajv.errorsText(ajv.errors)}`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
