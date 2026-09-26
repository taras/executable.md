/**
 * What is allowed to be in a semantic model, checked by walking one.
 *
 * "No continuation, callback, StarFX handle, renderer object, terminal cell or
 * generator-local value in the model" is not a property a type can hold: every
 * one of those satisfies `unknown`, and a structural interface accepts an
 * object carrying extra members. So it is checked by walking the value and
 * naming everything that is not plain frozen data.
 *
 * The rule is a whitelist rather than a list of things to reject, because a
 * list of rejections only finds what someone thought of. A string, a finite
 * number, a boolean and `null` are values; a frozen array and a frozen plain
 * object are containers of values; everything else — a function, a generator,
 * a promise, a symbol, a class instance, a `Map`, a `Uint8Array`, a proxy over
 * any of them, and `undefined` — is named with the path it was found at.
 *
 * `undefined` is refused deliberately. The model has no optional member, so a
 * member that is absent is a shape defect and not a spelling of "nothing".
 */

function label(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "function") {
    return "a function";
  }
  if (typeof value === "symbol") {
    return "a symbol";
  }
  if (typeof value === "bigint") {
    return "a bigint";
  }
  if (typeof value === "number") {
    return "a non-finite number";
  }
  if (value === null || typeof value !== "object") {
    return `a ${typeof value}`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null || Array.isArray(value)) {
    return "unfrozen";
  }
  const name = value.constructor === undefined ? "an exotic object" : value.constructor.name;
  return `a ${name}`;
}

function walk(value: unknown, at: string, found: string[]): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      found.push(`${at}: ${label(value)}`);
    }
    return;
  }
  if (typeof value !== "object") {
    found.push(`${at}: ${label(value)}`);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (!Object.isFrozen(value)) {
      found.push(`${at}: an unfrozen array`);
    }
    for (const [index, member] of value.entries()) {
      walk(member, `${at}[${index}]`, found);
    }
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    found.push(`${at}: ${label(value)}`);
    return;
  }
  if (!Object.isFrozen(value)) {
    found.push(`${at}: an unfrozen object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      found.push(`${at}: a symbol key ${String(key)}`);
      continue;
    }
    walk(Reflect.get(value, key), `${at}.${key}`, found);
  }
}

/**
 * Everything reachable from `value` that is not plain frozen data, as paths.
 *
 * An empty answer is the claim. A non-empty one names where the foreign value
 * sits, so a control that smuggles one in says what it smuggled and where.
 */
export function foreignValues(value: unknown, at = "model"): readonly string[] {
  const found: string[] = [];
  walk(value, at, found);
  return found;
}
