/**
 * Walking a draft-07 schema by position.
 *
 * Two preflight checks need to know where they are: one inspects `$ref`, the
 * other inspects declared names. Both are wrong if they simply recurse through
 * every object, because a schema contains data as well as schemas. `const`,
 * `enum`, `default`, and `examples` hold arbitrary JSON values, and an object in
 * one of those is a value the author wants matched — not a subschema. An object
 * carrying `$ref` inside a `const` is data that happens to look like a
 * reference, and Ajv never resolves it.
 *
 * So this walker visits only the positions draft-07 defines as schemas, reached
 * through the keywords that bear them, and reports the names those positions
 * declare. Everything else is passed over.
 */

import type { Json, JsonObject } from "./types.ts";
import { isJsonObject } from "./json.ts";

/** Where a declared name came from, for printed errors. */
export type NameKind =
  | "property"
  | "pattern property"
  | "definition"
  | "dependency"
  | "required property"
  | "property dependency";

/**
 * One schema position, rewritten.
 *
 * Returns what should stand at this position. Everything the walker knows about
 * where schemas are and where data is applies, so a transform never reaches a
 * `const`, an `enum` member, a `default` or an `examples` entry, and never
 * touches a name a schema declares.
 */
export type SchemaTransform = (schema: JsonObject, path: string) => JsonObject;

export interface SchemaVisitor {
  /** One subschema, at a real schema position. */
  subschema(schema: JsonObject, path: string): void;
  /** One name a schema position declares. */
  declaredName(name: string, kind: NameKind, path: string): void;
}

/** Keywords whose value is a single subschema. */
const SUBSCHEMA: readonly string[] = [
  "additionalProperties",
  "additionalItems",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
];

/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_LIST: readonly string[] = ["allOf", "anyOf", "oneOf"];

/**
 * Keywords whose value is a map of names to subschemas.
 *
 * `dependencies` is handled separately: draft-07 lets each of its values be
 * either a subschema or an array of property names.
 */
const SUBSCHEMA_MAP: readonly [string, NameKind][] = [
  ["properties", "property"],
  ["patternProperties", "pattern property"],
  ["definitions", "definition"],
];

/**
 * Visit the root schema and every subschema beneath it.
 *
 * `items` is either one subschema or a tuple of them, and both spellings are
 * followed. A keyword whose value is not the shape draft-07 expects is skipped
 * rather than guessed at — meta-schema validation is what reports it, and it runs
 * on the same declaration.
 */
export function walkSchema(root: JsonObject, visitor: SchemaVisitor): void {
  visit(root, "#");

  function visit(schema: JsonObject, path: string): void {
    visitor.subschema(schema, path);

    for (const keyword of SUBSCHEMA) {
      const value = schema[keyword];
      if (isJsonObject(value)) {
        visit(value, `${path}/${keyword}`);
      }
    }

    for (const keyword of SUBSCHEMA_LIST) {
      const value = schema[keyword];
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          if (isJsonObject(entry)) {
            visit(entry, `${path}/${keyword}/${index}`);
          }
        });
      }
    }

    for (const [keyword, kind] of SUBSCHEMA_MAP) {
      const value = schema[keyword];
      if (!isJsonObject(value)) {
        continue;
      }
      for (const [name, entry] of Object.entries(value)) {
        visitor.declaredName(name, kind, `${path}/${keyword}`);
        if (isJsonObject(entry)) {
          visit(entry, `${path}/${keyword}/${name}`);
        }
      }
    }

    visitItems(schema["items"], `${path}/items`);
    visitDependencies(schema["dependencies"], `${path}/dependencies`);
    visitRequired(schema["required"], `${path}/required`);
  }

  function visitItems(value: Json | undefined, path: string): void {
    if (isJsonObject(value)) {
      visit(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isJsonObject(entry)) {
          visit(entry, `${path}/${index}`);
        }
      });
    }
  }

  function visitDependencies(value: Json | undefined, path: string): void {
    if (!isJsonObject(value)) {
      return;
    }
    for (const [name, entry] of Object.entries(value)) {
      visitor.declaredName(name, "dependency", path);
      if (isJsonObject(entry)) {
        visit(entry, `${path}/${name}`);
        continue;
      }
      if (Array.isArray(entry)) {
        for (const dependent of entry) {
          if (typeof dependent === "string") {
            visitor.declaredName(dependent, "property dependency", `${path}/${name}`);
          }
        }
      }
    }
  }

  function visitRequired(value: Json | undefined, path: string): void {
    if (!Array.isArray(value)) {
      return;
    }
    for (const name of value) {
      if (typeof name === "string") {
        visitor.declaredName(name, "required property", path);
      }
    }
  }
}

/**
 * Rewrite every real schema position, leaving everything else exactly as it is.
 *
 * The same position table `walkSchema` visits, used to build a copy rather than
 * to inspect one. Data keywords are carried across by value, declared names are
 * carried across as names, and nothing in the input is mutated — a caller can
 * hand this an authored schema and keep using it afterwards.
 *
 * Every object it builds has a null prototype, so a key named `__proto__`
 * arriving in data is an ordinary member rather than an assignment that
 * rewrites the object it was copied into.
 */
export function mapSchema(root: JsonObject, transform: SchemaTransform): JsonObject {
  return rewrite(root, "#");

  function rewrite(schema: JsonObject, path: string): JsonObject {
    const mapped = transform(schema, path);
    const copy = record();
    for (const [keyword, value] of Object.entries(mapped)) {
      copy[keyword] = rewriteKeyword(keyword, value, path);
    }
    return copy;
  }

  function rewriteKeyword(keyword: string, value: Json, path: string): Json {
    if (SUBSCHEMA.includes(keyword)) {
      return isJsonObject(value) ? rewrite(value, `${path}/${keyword}`) : detach(value);
    }
    if (SUBSCHEMA_LIST.includes(keyword)) {
      return Array.isArray(value)
        ? value.map((entry, index) =>
            isJsonObject(entry) ? rewrite(entry, `${path}/${keyword}/${index}`) : detach(entry),
          )
        : detach(value);
    }
    if (SUBSCHEMA_MAP.some(([name]) => name === keyword)) {
      return rewriteMap(value, `${path}/${keyword}`);
    }
    if (keyword === "items") {
      if (isJsonObject(value)) {
        return rewrite(value, `${path}/items`);
      }
      return Array.isArray(value)
        ? value.map((entry, index) =>
            isJsonObject(entry) ? rewrite(entry, `${path}/items/${index}`) : detach(entry),
          )
        : detach(value);
    }
    if (keyword === "dependencies") {
      return rewriteDependencies(value, `${path}/dependencies`);
    }
    // Everything else is data: `const`, `enum`, `default`, `examples`, every
    // scalar constraint, and every keyword this draft does not define.
    return detach(value);
  }

  function rewriteMap(value: Json, path: string): Json {
    if (!isJsonObject(value)) {
      return detach(value);
    }
    const copy = record();
    for (const [name, entry] of Object.entries(value)) {
      copy[name] = isJsonObject(entry) ? rewrite(entry, `${path}/${name}`) : detach(entry);
    }
    return copy;
  }

  function rewriteDependencies(value: Json, path: string): Json {
    if (!isJsonObject(value)) {
      return detach(value);
    }
    const copy = record();
    for (const [name, entry] of Object.entries(value)) {
      copy[name] = isJsonObject(entry) ? rewrite(entry, `${path}/${name}`) : detach(entry);
    }
    return copy;
  }
}

/**
 * One JSON value, copied all the way down, with every object own-keyed.
 *
 * Data, not schema. A copy so nothing downstream can change what the author
 * wrote, and null-prototyped so a member named `__proto__`, `toString` or
 * `constructor` is a member rather than something the language answers for.
 */
export function detach(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => detach(entry));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const copy = record();
  for (const name of Object.getOwnPropertyNames(value)) {
    copy[name] = detach(Reflect.get(value, name));
  }
  return copy;
}

/** One object with no prototype, so every name it answers is a name it holds. */
function record(): JsonObject {
  return Object.create(null);
}
