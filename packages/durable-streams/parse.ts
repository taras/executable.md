/**
 * `parseDurableEvent` is the typed inverse of `serializeDurableEvent`.
 *
 * A backend that retains the NDJSON record — a journal file, a SQLite
 * column — reads it back through this function. The record is parsed,
 * never trusted: every member is checked against the protocol types and
 * the returned event is rebuilt from the checked members, so nothing
 * reaches replay because it merely looked plausible.
 *
 * The closed shapes — the event envelope, a protocol `Result`, a
 * `SerializedError` — reject members they do not declare. An
 * `EffectDescription` declares an index signature, so its extra members
 * are admitted as `Json`; those are the input fields replay guards read.
 */

import { Err, Ok } from "effection";
import { MalformedDurableEventError } from "./errors.ts";
import type {
  Close,
  DurableEvent,
  EffectDescription,
  EffectionResult,
  Json,
  Result,
  SerializedError,
  Yield,
} from "./types.ts";

/**
 * Parse one NDJSON record produced by `serializeDurableEvent`.
 *
 * The record's terminating newline is optional — `JSON.parse` ignores
 * trailing whitespace — so a stored record and a line split out of a
 * journal file both parse.
 */
export function parseDurableEvent(record: string): EffectionResult<DurableEvent> {
  try {
    return Ok(parseEvent(parseRecord(record)));
  } catch (error) {
    if (error instanceof MalformedDurableEventError) {
      return Err(error);
    }
    throw error;
  }
}

function parseRecord(record: string): unknown {
  try {
    return JSON.parse(record);
  } catch {
    // The thrown SyntaxError quotes the offending text, which is the one
    // thing a journal parse failure must not repeat.
    throw new MalformedDurableEventError("expected a JSON record", "$");
  }
}

function parseEvent(value: unknown): DurableEvent {
  const members = parseMembers(value, "$");
  const type = parseStringMember(members, "type", "$");

  if (type === "yield") {
    return parseYield(members);
  }
  if (type === "close") {
    return parseClose(members);
  }
  throw new MalformedDurableEventError('expected "yield" or "close"', "$.type");
}

function parseYield(members: Members): Yield {
  requireMemberNames(members, ["type", "coroutineId", "description", "result"], "$");

  return {
    type: "yield",
    coroutineId: parseStringMember(members, "coroutineId", "$"),
    description: parseEffectDescription(members.get("description"), "$.description"),
    result: parseResult(members.get("result"), "$.result"),
  };
}

function parseClose(members: Members): Close {
  requireMemberNames(members, ["type", "coroutineId", "result"], "$");

  return {
    type: "close",
    coroutineId: parseStringMember(members, "coroutineId", "$"),
    result: parseResult(members.get("result"), "$.result"),
  };
}

function parseEffectDescription(value: unknown, path: string): EffectDescription {
  const members = parseMembers(value, path);
  const description: EffectDescription = {
    type: parseStringMember(members, "type", path),
    name: parseStringMember(members, "name", path),
  };

  for (const [key, member] of members) {
    if (key === "type" || key === "name") {
      continue;
    }
    define(description, key, parseJsonValue(member, `${path}.${key}`));
  }

  return description;
}

function parseResult(value: unknown, path: string): Result {
  const members = parseMembers(value, path);
  const status = parseStringMember(members, "status", path);

  switch (status) {
    case "ok": {
      requireMemberNames(members, ["status", "value"], path);
      if (!members.has("value")) {
        return { status: "ok" };
      }
      return { status: "ok", value: parseJsonValue(members.get("value"), `${path}.value`) };
    }
    case "err": {
      requireMemberNames(members, ["status", "error"], path);
      return { status: "err", error: parseSerializedError(members.get("error"), `${path}.error`) };
    }
    case "cancelled": {
      requireMemberNames(members, ["status"], path);
      return { status: "cancelled" };
    }
    default:
      throw new MalformedDurableEventError('expected "ok", "err" or "cancelled"', `${path}.status`);
  }
}

function parseSerializedError(value: unknown, path: string): SerializedError {
  const members = parseMembers(value, path);
  requireMemberNames(members, ["message", "name", "stack"], path);

  const error: SerializedError = { message: parseStringMember(members, "message", path) };
  if (members.has("name")) {
    error.name = parseStringMember(members, "name", path);
  }
  if (members.has("stack")) {
    error.stack = parseStringMember(members, "stack", path);
  }
  return error;
}

function parseJsonValue(value: unknown, path: string): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    // JSON has no infinity literal, but an exponent large enough to
    // overflow — `1e999` — parses to one.
    if (!Number.isFinite(value)) {
      throw new MalformedDurableEventError("expected a finite number", path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (let index = 0; index < value.length; index++) {
      items.push(parseJsonValue(value[index], `${path}[${index}]`));
    }
    return items;
  }
  if (typeof value === "object") {
    const object: { [key: string]: Json } = {};
    for (const [key, member] of Object.entries(value)) {
      define(object, key, parseJsonValue(member, `${path}.${key}`));
    }
    return object;
  }
  throw new MalformedDurableEventError(`expected a JSON value, found ${describe(value)}`, path);
}

/** The members of one JSON object, in the order the record wrote them. */
type Members = Map<string, unknown>;

function parseMembers(value: unknown, path: string): Members {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedDurableEventError(`expected an object, found ${describe(value)}`, path);
  }
  return new Map(Object.entries(value));
}

function parseStringMember(members: Members, key: string, path: string): string {
  const member = members.get(key);
  if (typeof member !== "string") {
    throw new MalformedDurableEventError(
      `expected a string, found ${describe(member)}`,
      `${path}.${key}`,
    );
  }
  return member;
}

function requireMemberNames(members: Members, names: string[], path: string): void {
  for (const key of members.keys()) {
    if (!names.includes(key)) {
      throw new MalformedDurableEventError(`unexpected member ${JSON.stringify(key)}`, path);
    }
  }
}

/**
 * Add one member as a plain own data property.
 *
 * `object[key] = value` is not equivalent for the key `__proto__`: it
 * reaches `Object.prototype`'s inherited setter, which under V8 and
 * JavaScriptCore replaces the object's prototype and drops the key while
 * Deno's parse keeps it. `JSON.parse` makes `__proto__` an own property,
 * so any record can carry one, and the same record would otherwise parse
 * to a different object on different runtimes.
 */
function define(object: { [key: string]: Json }, key: string, value: Json): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return typeof value;
}
