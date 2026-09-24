// oxlint-disable bombshell-dev/no-generic-error
import type { JsonValue } from "./types.ts";

export function validateJsonValue(value: unknown): asserts value is JsonValue {
  if (value === undefined) {
    throw new Error("undefined is not a valid JsonValue");
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new Error("NaN is not a valid JsonValue");
    }
    if (!Number.isFinite(value)) {
      throw new Error(`${value} is not a valid JsonValue`);
    }
    return;
  }
  if (
    typeof value === "string" || typeof value === "boolean" || value === null
  ) {
    return;
  }
  if (typeof value === "function") {
    throw new Error("functions are not valid JsonValues");
  }
  if (typeof value === "symbol") {
    throw new Error("symbols are not valid JsonValues");
  }
  if (typeof value === "bigint") {
    throw new Error("bigints are not valid JsonValues");
  }
  if (value instanceof Date) {
    throw new Error("Date instances are not valid JsonValues");
  }
  if (value instanceof Map) {
    throw new Error("Map instances are not valid JsonValues");
  }
  if (value instanceof Set) {
    throw new Error("Set instances are not valid JsonValues");
  }
  if (value instanceof RegExp) {
    throw new Error("RegExp instances are not valid JsonValues");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonValue(item);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      validateJsonValue((value as Record<string, unknown>)[key]);
    }
    return;
  }
  throw new Error(`${String(value)} is not a valid JsonValue`);
}
