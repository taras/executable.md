/**
 * Tests for the shared durable-event serializer.
 *
 * The serializer defines the NDJSON record file persistence writes and
 * inspection gates read. These tests pin the record shape, the newline, the
 * field order, and the exact boundary between "rejected" and "coerced".
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { serializeDurableEvent } from "../mod.ts";
import type { Close, DurableEvent, Json, Yield } from "../mod.ts";

const YIELD_OK: Yield = {
  type: "yield",
  coroutineId: "root.0",
  description: { type: "call", name: "stepA" },
  result: { status: "ok", value: "alpha" },
};

/** One event per branch of the DurableEvent and Result unions. */
const EVERY_EVENT_SHAPE: DurableEvent[] = [
  YIELD_OK,
  {
    type: "yield",
    coroutineId: "root.1",
    description: { type: "call", name: "stepB" },
    result: { status: "err", error: { message: "boom", name: "Error", stack: "Error: boom" } },
  },
  {
    type: "yield",
    coroutineId: "root.2",
    description: { type: "sleep", name: "sleep", ms: 10 },
    result: { status: "cancelled" },
  },
  {
    type: "close",
    coroutineId: "root",
    result: { status: "ok", value: { done: true } },
  },
  {
    type: "close",
    coroutineId: "root.1",
    result: { status: "err", error: { message: "failed" } },
  },
  {
    type: "close",
    coroutineId: "root.2",
    result: { status: "cancelled" },
  },
];

describe("serializeDurableEvent", () => {
  it("round-trips every event and result shape DurableEvent admits", function* () {
    for (const event of EVERY_EVENT_SHAPE) {
      expect(JSON.parse(serializeDurableEvent(event))).toEqual(event);
    }
  });

  it("emits exactly one line, terminated by a newline", function* () {
    for (const event of EVERY_EVENT_SHAPE) {
      const record = serializeDurableEvent(event);
      expect(record.endsWith("\n")).toBe(true);
      expect(record.split("\n")).toHaveLength(2);
    }
  });

  it("follows the event object's insertion order without sorting keys", function* () {
    expect(serializeDurableEvent(YIELD_OK)).toBe(
      '{"type":"yield","coroutineId":"root.0","description":{"type":"call","name":"stepA"},' +
        '"result":{"status":"ok","value":"alpha"}}\n',
    );

    // The same event, assembled in a different order. A property order is not
    // part of the type, so this is a plain Yield — and it serializes to
    // different bytes, which is exactly the point.
    const reordered: Yield = {
      result: { status: "ok", value: "alpha" },
      description: { type: "call", name: "stepA" },
      coroutineId: "root.0",
      type: "yield",
    };

    expect(serializeDurableEvent(reordered)).toBe(
      '{"result":{"status":"ok","value":"alpha"},"description":{"type":"call","name":"stepA"},' +
        '"coroutineId":"root.0","type":"yield"}\n',
    );
  });

  it("rejects an event JSON.stringify cannot render", function* () {
    const circular = closeOk({ depth: 1 });
    // A circular structure and a BigInt are unreachable through the
    // DurableEvent type, so both are planted reflectively on a valid event
    // rather than cast into existence.
    Reflect.set(unwrapValue(circular), "self", unwrapValue(circular));

    expect(() => serializeDurableEvent(circular)).toThrow();

    const withBigInt = closeOk({ amount: 1 });
    Reflect.set(unwrapValue(withBigInt), "amount", 1n);

    expect(() => serializeDurableEvent(withBigInt)).toThrow();
  });

  it("rejects a value with no JSON representation at all", function* () {
    expect(() => Reflect.apply(serializeDurableEvent, undefined, [undefined])).toThrow(TypeError);
  });

  it("leaves the values JSON.stringify coerces or drops alone", function* () {
    const lossy = closeOk({ kept: "yes" });
    const value = unwrapValue(lossy);
    Reflect.set(value, "gone", undefined);
    Reflect.set(value, "fn", () => "nope");
    Reflect.set(value, "nan", Number.NaN);
    Reflect.set(value, "infinite", Number.POSITIVE_INFINITY);

    expect(serializeDurableEvent(lossy)).toBe(
      '{"type":"close","coroutineId":"root","result":{"status":"ok",' +
        '"value":{"kept":"yes","nan":null,"infinite":null}}}\n',
    );
  });
});

/** A valid Close(ok) whose value is a JSON object, ready to be tampered with. */
function closeOk(value: Record<string, Json>): Close {
  return { type: "close", coroutineId: "root", result: { status: "ok", value } };
}

/** The JSON object a `closeOk` event carries, narrowed rather than cast. */
function unwrapValue(event: Close): Record<string, Json> {
  const { result } = event;
  if (result.status !== "ok" || typeof result.value !== "object" || result.value === null) {
    throw new Error("expected a Close(ok) carrying a JSON object");
  }
  if (Array.isArray(result.value)) {
    throw new Error("expected a JSON object, not an array");
  }
  return result.value;
}
