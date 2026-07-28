/**
 * Serialization utilities for the durable execution protocol.
 *
 * Converts between:
 * - Protocol Result ({ status: "ok" | "err" | "cancelled" })
 * - Effection Result ({ ok: true, value } | { ok: false, error })
 * - Error ↔ SerializedError
 *
 * `serializeDurableEvent` is the shared NDJSON representation: file
 * persistence writes it, and gates that inspect the persisted form derive
 * it from the same function.
 */

import type { DurableEvent, EffectionResult, Json, Result, SerializedError } from "./types.ts";

/**
 * Render one durable event as its NDJSON record, terminating newline
 * included.
 *
 * This is ordinary `JSON.stringify(event) + "\n"`. Field order follows the
 * event object's own insertion order; nothing is sorted, normalized, or
 * otherwise canonicalized. The value of sharing it is that file persistence
 * and anything inspecting the persisted form cannot drift apart, not that
 * the output is a canonical form of the event.
 *
 * Serialization fails when `JSON.stringify` throws — a circular structure or
 * a `BigInt` — or when it does not return a string. Values that
 * `JSON.stringify` silently coerces or drops are left alone: `undefined`,
 * function and symbol members are omitted, non-finite numbers become `null`,
 * and non-plain objects serialize through `toJSON`.
 */
export function serializeDurableEvent(event: DurableEvent): string {
  const record = JSON.stringify(event);

  // JSON.stringify returns undefined rather than throwing when the value
  // itself has no JSON representation.
  if (typeof record !== "string") {
    throw new TypeError("serializeDurableEvent: event has no JSON representation");
  }

  return `${record}\n`;
}

/** Serialize an Error to a JSON-safe SerializedError. */
export function serializeError(error: Error): SerializedError {
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

/** Deserialize a SerializedError back to an Error. */
export function deserializeError(se: SerializedError): Error {
  const error = new Error(se.message);
  if (se.name) {
    error.name = se.name;
  }
  if (se.stack) {
    error.stack = se.stack;
  }
  return error;
}

/**
 * Convert a protocol Result to an Effection Result.
 *
 * - ok → { ok: true, value }
 * - err → { ok: false, error } (deserialized)
 * - cancelled → { ok: false, error } with a CancelledError
 *
 * The value is returned as-is (Json). The caller is responsible for any
 * narrowing to a specific type T.
 */
export function protocolToEffection<T>(result: Result): EffectionResult<T> {
  switch (result.status) {
    case "ok":
      return { ok: true, value: result.value as T };
    case "err":
      return { ok: false, error: deserializeError(result.error) };
    case "cancelled":
      return { ok: false, error: new Error("cancelled") };
  }
}

/**
 * Convert an Effection Result to a protocol Result.
 *
 * The value must be JSON-serializable. This function does NOT validate
 * serializability — that is the caller's responsibility.
 */
export function effectionToProtocol<T>(result: EffectionResult<T>): Result {
  if (result.ok) {
    return { status: "ok", value: result.value as Json };
  } else {
    return { status: "err", error: serializeError(result.error) };
  }
}
