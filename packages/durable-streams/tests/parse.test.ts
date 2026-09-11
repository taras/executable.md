/**
 * `parseDurableEvent` — the typed inverse of `serializeDurableEvent`.
 *
 * The round-trip cases pin the representation itself: a record written by
 * the serializer parses back to an equal event, and re-serializing that
 * event reproduces the original bytes. A backend that retains the record
 * — a journal file, a SQLite column — therefore keeps the event, not an
 * approximation of it.
 *
 * The refusal cases pin the other half of the contract: a record that
 * does not describe a `DurableEvent` is refused at a named path rather
 * than coerced into one.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  type DurableEvent,
  MalformedDurableEventError,
  parseDurableEvent,
  serializeDurableEvent,
  type Yield,
} from "../mod.ts";

/**
 * Member order follows the order the producers write: the envelope, then
 * `type`/`name` ahead of a description's replay-guard fields, then a
 * result's `status` ahead of its payload. Authoring the literals that way
 * is what makes the byte round trip an assertion about the parser rather
 * than about these fixtures.
 */
const EVENTS: Record<string, DurableEvent> = {
  "a yield whose result carries no value": {
    type: "yield",
    coroutineId: "root.0",
    description: { type: "sleep", name: "sleep" },
    result: { status: "ok" },
  },
  "a yield whose description carries replay-guard fields": {
    type: "yield",
    coroutineId: "root.1",
    description: { type: "call", name: "readFile", path: "release/notes.md", retries: 2 },
    result: { status: "ok", value: { bytes: 41, digest: "6f21a9", tags: ["release", null] } },
  },
  "a yield whose result value is null": {
    type: "yield",
    coroutineId: "root.2",
    description: { type: "call", name: "lookup" },
    result: { status: "ok", value: null },
  },
  "a failed yield": {
    type: "yield",
    coroutineId: "root.3",
    description: { type: "call", name: "transform" },
    result: {
      status: "err",
      error: { message: "boom", name: "TypeError", stack: "TypeError: boom\n    at transform" },
    },
  },
  "a failed yield whose error has only a message": {
    type: "yield",
    coroutineId: "root.4",
    description: { type: "action", name: "publish" },
    result: { status: "err", error: { message: "boom" } },
  },
  "a cancelled yield": {
    type: "yield",
    coroutineId: "root.5",
    description: { type: "resource", name: "socket" },
    result: { status: "cancelled" },
  },
  "a close": {
    type: "close",
    coroutineId: "root",
    result: { status: "ok", value: "ALPHA" },
  },
  "a cancelled close": {
    type: "close",
    coroutineId: "root.6",
    result: { status: "cancelled" },
  },
};

/** Each record is refused at the path named beside it. */
const MALFORMED: Record<string, { record: string; path: string }> = {
  "text that is not JSON": {
    record: "not a record\n",
    path: "$",
  },
  "a JSON array": {
    record: "[]\n",
    path: "$",
  },
  "a JSON null": {
    record: "null\n",
    path: "$",
  },
  "a bare JSON string": {
    record: '"yield"\n',
    path: "$",
  },
  "an event with no type": {
    record: '{"coroutineId":"root","result":{"status":"cancelled"}}\n',
    path: "$.type",
  },
  "an event type outside the protocol": {
    record: '{"type":"start","coroutineId":"root","result":{"status":"cancelled"}}\n',
    path: "$.type",
  },
  "a close with no coroutine ID": {
    record: '{"type":"close","result":{"status":"cancelled"}}\n',
    path: "$.coroutineId",
  },
  "a close whose coroutine ID is a number": {
    record: '{"type":"close","coroutineId":7,"result":{"status":"cancelled"}}\n',
    path: "$.coroutineId",
  },
  "a close carrying a member the envelope does not declare": {
    record: '{"type":"close","coroutineId":"root","result":{"status":"cancelled"},"offset":3}\n',
    path: "$",
  },
  "a yield carrying a description on the envelope of a close": {
    record:
      '{"type":"close","coroutineId":"root","description":{"type":"call","name":"f"},"result":{"status":"cancelled"}}\n',
    path: "$",
  },
  "a yield with no description": {
    record: '{"type":"yield","coroutineId":"root","result":{"status":"cancelled"}}\n',
    path: "$.description",
  },
  "a description with no name": {
    record:
      '{"type":"yield","coroutineId":"root","description":{"type":"call"},"result":{"status":"cancelled"}}\n',
    path: "$.description.name",
  },
  "a description whose type is not a string": {
    record:
      '{"type":"yield","coroutineId":"root","description":{"type":4,"name":"f"},"result":{"status":"cancelled"}}\n',
    path: "$.description.type",
  },
  "a description field that overflows to infinity": {
    record:
      '{"type":"yield","coroutineId":"root","description":{"type":"call","name":"f","limit":1e999},"result":{"status":"cancelled"}}\n',
    path: "$.description.*",
  },
  "a close with no result": {
    record: '{"type":"close","coroutineId":"root"}\n',
    path: "$.result",
  },
  "a result status outside the protocol": {
    record: '{"type":"close","coroutineId":"root","result":{"status":"pending"}}\n',
    path: "$.result.status",
  },
  "a failed result with no error": {
    record: '{"type":"close","coroutineId":"root","result":{"status":"err"}}\n',
    path: "$.result.error",
  },
  "an error with no message": {
    record: '{"type":"close","coroutineId":"root","result":{"status":"err","error":{}}}\n',
    path: "$.result.error.message",
  },
  "an error whose stack is not a string": {
    record:
      '{"type":"close","coroutineId":"root","result":{"status":"err","error":{"message":"boom","stack":12}}}\n',
    path: "$.result.error.stack",
  },
  "an error carrying a member the protocol does not declare": {
    record:
      '{"type":"close","coroutineId":"root","result":{"status":"err","error":{"message":"boom","code":"ENOENT"}}}\n',
    path: "$.result.error",
  },
  "a cancelled result carrying a value": {
    record: '{"type":"close","coroutineId":"root","result":{"status":"cancelled","value":1}}\n',
    path: "$.result",
  },
  "a successful result that overflows to infinity": {
    record: '{"type":"close","coroutineId":"root","result":{"status":"ok","value":1e999}}\n',
    path: "$.result.value",
  },
  "an overflow nested inside a result value": {
    record:
      '{"type":"close","coroutineId":"root","result":{"status":"ok","value":{"sizes":[1,1e999]}}}\n',
    path: "$.result.value.*[1]",
  },
};

function accepted(record: string): DurableEvent {
  const result = parseDurableEvent(record);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function acceptedYield(record: string): Yield {
  const event = accepted(record);
  if (event.type !== "yield") {
    throw new Error(`expected a yield, parsed a ${event.type}`);
  }
  return event;
}

function refusal(record: string): MalformedDurableEventError {
  const result = parseDurableEvent(record);
  if (result.ok) {
    throw new Error("expected the record to be refused");
  }
  if (!(result.error instanceof MalformedDurableEventError)) {
    throw result.error;
  }
  return result.error;
}

describe("parseDurableEvent", () => {
  for (const [name, event] of Object.entries(EVENTS)) {
    it(`restores ${name}`, function* () {
      expect(accepted(serializeDurableEvent(event))).toEqual(event);
    });
    it(`reproduces the record of ${name}`, function* () {
      const record = serializeDurableEvent(event);

      expect(serializeDurableEvent(accepted(record))).toBe(record);
    });
  }
  it("accepts a record without its terminating newline", function* () {
    const record = serializeDurableEvent(EVENTS["a close"]);

    expect(accepted(record.trimEnd())).toEqual(EVENTS["a close"]);
  });

  for (const [name, { record, path }] of Object.entries(MALFORMED)) {
    it(`refuses ${name}`, function* () {
      expect(refusal(record).path).toBe(path);
    });
  }
  it("repeats no member name from the record, only its own", function* () {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

    // A credential can be a key as easily as a value, and a path or a message
    // built from one carries it wherever the failure goes.
    const records = [
      `{"type":"yield","coroutineId":"root","description":{"type":"call","name":"f","${secret}":1e999},"result":{"status":"cancelled"}}`,
      `{"type":"close","coroutineId":"root","result":{"status":"ok","value":{"${secret}":1e999}}}`,
      `{"type":"close","coroutineId":"root","result":{"status":"cancelled"},"${secret}":1}`,
    ];

    for (const record of records) {
      const error = refusal(record);
      expect(error.message).not.toContain(secret);
      expect(error.path).not.toContain(secret);
    }
  });

  it("names the offending path without quoting the record", function* () {
    const record =
      '{"type":"close","coroutineId":"root","result":{"status":"ok","value":"s3cret-token"}}';

    expect(refusal(record.replace('"status":"ok"', '"status":"pending"')).message).toBe(
      'expected "ok", "err" or "cancelled" at $.result.status',
    );
  });
  it("keeps a __proto__ description field as an own property", function* () {
    const record =
      '{"type":"yield","coroutineId":"root","description":{"type":"call","name":"f","__proto__":{"polluted":true}},"result":{"status":"cancelled"}}\n';

    const { description } = acceptedYield(record);

    expect(Object.hasOwn(description, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(description)).toBe(Object.prototype);
    expect("polluted" in {}).toBe(false);
  });
});

describe("a cancelled close carries why it was cancelled (DEC-040)", () => {
  const cancelled = (cancellation?: "caller" | "unwound"): DurableEvent => ({
    type: "close",
    coroutineId: "root.0",
    result:
      cancellation === undefined ? { status: "cancelled" } : { status: "cancelled", cancellation },
  });

  it("round-trips both reasons", function* () {
    for (const reason of ["caller", "unwound"] as const) {
      const event = cancelled(reason);
      const record = serializeDurableEvent(event);
      expect(accepted(record)).toEqual(event);
      // And back to the same bytes, so a backend retains the event rather than
      // an approximation of it.
      expect(serializeDurableEvent(accepted(record))).toBe(record);
    }
  });

  it("keeps a legacy record's absence an absence", function* () {
    const parsed = accepted(serializeDurableEvent(cancelled()));
    expect(parsed).toEqual(cancelled());
    expect(parsed.result.status === "cancelled" && "cancellation" in parsed.result).toBe(false);
  });

  it("refuses a reason it does not recognise", function* () {
    const refused = refusal(
      JSON.stringify({
        type: "close",
        coroutineId: "root.0",
        result: { status: "cancelled", cancellation: "somebody" },
      }),
    );
    expect(refused).toBeInstanceOf(MalformedDurableEventError);
    expect(refused.message).toContain("$.result.cancellation");
  });
});
