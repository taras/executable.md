import { Buffer } from "node:buffer";
import { describe, it } from "../bdd.ts";
import { expect } from "../expect.ts";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { boundedJournalResult, readSubprocessSnapshot } from "../subprocess-journal.ts";

const close: DurableEvent = {
  type: "close",
  coroutineId: "root",
  result: { status: "ok", value: null },
};
const line = serializeDurableEvent(close);

describe("private subprocess journal envelope", () => {
  // deno-lint-ignore require-yield
  it("preserves the original result when even the omission slots cannot fit", function* () {
    const result = { kind: "selected", value: "é".repeat(32 * 1024) };
    const printed = JSON.parse(boundedJournalResult(result, [[line]]));
    expect(printed).toEqual(result);
    expect(readSubprocessSnapshot(printed.journals, 0)).toBe("snapshot absent");
  });

  // deno-lint-ignore require-yield
  it("keeps fixed slots and valid siblings across both byte limits", function* () {
    const large = [
      serializeDurableEvent({
        ...close,
        result: { status: "ok", value: "é".repeat(7 * 1024) },
      }),
    ];
    const oversized = ["é".repeat(16 * 1024)];
    const printed = boundedJournalResult({ value: "é".repeat(12 * 1024) }, [
      large,
      oversized,
      large,
      large,
      [line],
    ]);
    expect(Buffer.byteLength(printed) + 1).toBeLessThanOrEqual(64 * 1024);
    const { journals } = JSON.parse(printed);
    expect(readSubprocessSnapshot(journals, 0)).toHaveLength(1);
    expect(readSubprocessSnapshot(journals, 1)).toBe("snapshot exceeds journal budget");
    expect(readSubprocessSnapshot(journals, 2)).toHaveLength(1);
    expect(readSubprocessSnapshot(journals, 3)).toBe("snapshot exceeds journal budget");
    expect(readSubprocessSnapshot(journals, 4)).toEqual([close]);
  });

  // deno-lint-ignore require-yield
  it("rejects a partially valid snapshot without losing its sibling", function* () {
    const { journals } = JSON.parse(boundedJournalResult({}, [[line, "malformed"], [line]]));
    expect(readSubprocessSnapshot(journals, 0)).toBe("invalid snapshot");
    expect(readSubprocessSnapshot(journals, 1)).toEqual([close]);
  });
});
