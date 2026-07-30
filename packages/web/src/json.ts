/**
 * The package's JSON boundary.
 *
 * A WebForm declaration arrives as an unknown value — a structured value a
 * document bound, or text a document captured — and everything downstream
 * treats it as JSON: it is validated as a schema, embedded in a script the
 * browser loads, and fingerprinted for the journal. Parsing is what earns the
 * type. Nothing here asserts it, so a value that is not JSON is refused where it
 * enters rather than discovered later by something that assumed it.
 *
 * `Json` is recursive and package-private. This is deliberately not
 * `@executablemd/core`'s parser: the package does not depend on core, and it
 * will not until the component slice needs the Component Api.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export class JsonParseError extends Error {
  override name = "JsonParseError";
}

export function parseJson(value: unknown): Json {
  return parseValue(value, new Set(), "$");
}

export function parseJsonObject(value: unknown): JsonObject {
  const parsed = parseJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JsonParseError(`expected a JSON object, got ${describe(value)}`);
  }
  return parsed;
}

export function isJsonObject(value: Json | undefined): value is JsonObject {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function parseValue(value: unknown, seen: Set<object>, path: string): Json {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    // A non-finite number serializes to `null`, so admitting one here would let
    // the schema the browser receives differ from the schema the server
    // compiled.
    if (!Number.isFinite(value)) {
      throw new JsonParseError(`non-finite number at ${path}`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new JsonParseError(`non-JSON ${typeof value} at ${path}`);
  }

  if (seen.has(value)) {
    throw new JsonParseError(`circular reference at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // Every index is parsed rather than mapped: `.map` skips a sparse hole and
      // would admit an array whose element type is a lie.
      const items: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) {
          throw new JsonParseError(`missing array element at ${path}[${index}]`);
        }
        items.push(parseValue(value[index], seen, `${path}[${index}]`));
      }
      return items;
    }
    if (!isPlainObject(value)) {
      throw new JsonParseError(`non-plain object at ${path}`);
    }
    const entries: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new JsonParseError(`undefined value at ${path}.${key}`);
      }
      define(entries, key, parseValue(item, seen, `${path}.${key}`));
    }
    return entries;
  } finally {
    seen.delete(value);
  }
}

/**
 * Add one key as a plain own data property.
 *
 * `entries[key] = value` is not equivalent, and the difference is not cosmetic:
 * for the key `__proto__` it reaches `Object.prototype`'s inherited setter
 * instead of defining anything. What that does depends on the engine — V8 under
 * Node and JavaScriptCore under Bun replace the object's prototype and drop the
 * key, while Deno keeps it as an own property — so the same declaration would
 * normalize to a different object on different runtimes, and a schema property
 * legitimately named `__proto__` would disappear on two of the three.
 *
 * Defining the property sidesteps the setter, so every key behaves like every
 * other key everywhere.
 */
function define(entries: JsonObject, key: string, value: Json): void {
  Object.defineProperty(entries, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
