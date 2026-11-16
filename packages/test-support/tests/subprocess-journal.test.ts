import { describe, it } from "../bdd.ts";
import { expect } from "../expect.ts";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { boundedJournalResult, parseSubprocessJournal } from "../subprocess-journal.ts";

describe("private subprocess journal envelope", () => {
  // deno-lint-ignore require-yield
  it("keeps the ordinary result when the UTF-8 envelope exceeds its limit", function* () {
    const result = { kind: "selected" };
    expect(JSON.parse(boundedJournalResult(result, { journal: ["é".repeat(32 * 1024)] }))).toEqual(
      result,
    );
  });

  // deno-lint-ignore require-yield
  it("rejects a partially valid snapshot", function* () {
    const event: DurableEvent = {
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value: null },
    };
    const line = serializeDurableEvent(event);
    expect(parseSubprocessJournal([line])).toEqual([event]);
    expect(parseSubprocessJournal([line, "malformed"])).toEqual([]);
  });
});
