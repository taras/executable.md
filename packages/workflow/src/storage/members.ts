/**
 * Reading the members of a JSON object without trusting them.
 *
 * Storage parses two kinds of value it did not construct: a descriptor a caller
 * hands to `create()`, and a column a database hands back. Both are checked the
 * same way and reported differently, so the checks take the error they should
 * raise rather than choosing one.
 *
 * A shape built from these helpers is closed: `requireMemberNames` refuses a
 * member it does not declare, so a value carrying an unknown field is a parse
 * failure rather than a field silently dropped on the way to storage.
 */

import type { Json } from "@executablemd/durable-streams";

/** A JSON value that is an object: the shape normalized props always take. */
export type JsonObject = { [key: string]: Json };

/** The members of one JSON object, in the order the value wrote them. */
export type Members = Map<string, unknown>;

/** Builds the failure a check raises. */
export type Fail = (reason: string, path: string) => Error;

export function parseMembers(value: unknown, path: string, fail: Fail): Members {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`expected an object, found ${describe(value)}`, path);
  }
  return new Map(Object.entries(value));
}

export function parseStringMember(members: Members, key: string, path: string, fail: Fail): string {
  const member = members.get(key);
  if (typeof member !== "string") {
    throw fail(`expected a string, found ${describe(member)}`, `${path}.${key}`);
  }
  return member;
}

/**
 * Refuse a member this shape does not declare, without naming it.
 *
 * The names it *does* declare are ours and safe to print; the one that turned
 * up came from outside, and a value's member names are as capable of holding a
 * credential as its values are.
 */
export function requireMemberNames(
  members: Members,
  names: readonly string[],
  path: string,
  fail: Fail,
): void {
  for (const key of members.keys()) {
    if (!names.includes(key)) {
      throw fail(`expected only the members ${names.join(", ")}`, path);
    }
  }
}

/**
 * The JSON value a parsed value describes.
 *
 * `JSON.parse` answers `any`, and a stored column is not trusted merely
 * because it was valid JSON when it was written. Members are defined rather
 * than assigned: `object[key] = value` reaches `Object.prototype`'s setter for
 * `__proto__`, which replaces the prototype on Node and Bun while Deno's parse
 * keeps the key, so one record would otherwise read differently per runtime.
 */
export function parseJsonValue(value: unknown, path: string, fail: Fail): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw fail("expected a finite number", path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (let index = 0; index < value.length; index++) {
      items.push(parseJsonValue(value[index], `${path}[${index}]`, fail));
    }
    return items;
  }
  if (typeof value === "object") {
    const object: { [key: string]: Json } = {};
    for (const [key, member] of Object.entries(value)) {
      Object.defineProperty(object, key, {
        // `${path}.*`, not `${path}.${key}`: these names come from the value
        // being parsed, and a path built from one would carry it into an error
        // that travels to logs and terminals.
        value: parseJsonValue(member, `${path}.*`, fail),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return object;
  }
  throw fail(`expected a JSON value, found ${describe(value)}`, path);
}

/** The JSON object a parsed value describes. */
export function parseJsonObject(value: unknown, path: string, fail: Fail): JsonObject {
  const parsed = parseJsonValue(value, path, fail);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail(`expected an object, found ${describe(parsed)}`, path);
  }
  return parsed;
}

/** Name a value's kind without repeating what it holds. */
export function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return typeof value;
}
