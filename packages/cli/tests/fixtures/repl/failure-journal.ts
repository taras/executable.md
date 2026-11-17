import type { Operation } from "effection";
import process from "node:process";
import { captureTestJournal } from "@executablemd/test-support/failure-journal";
import type { JournalCase } from "../../../src/test-diagnostics.ts";
import type { DeliverySink } from "../../../src/stdout-delivery.ts";
import { partitionEntrySegments } from "../../../src/repl/entries.ts";
import type { ReplExecution } from "../../../src/repl/journal.ts";

/** Capture the admission owned by a synthetic, single-entry REPL fixture. */
export function captureReplEntry(
  testCase: JournalCase,
  id: string,
  source: string,
  body: (holder: ReplExecution) => Operation<void>,
  sink: DeliverySink = process.stderr,
): Operation<void> {
  return captureTestJournal(testCase, source, (stream) => body({ id, stream }), {
    sink,
    selectEvents(events) {
      const partition = partitionEntrySegments(events);
      if (!partition.ok) {
        throw partition.error;
      }
      if (partition.value.length > 1) {
        throw new Error("fixture execution holds more than one admitted entry");
      }
      return partition.value[0]?.events ?? [];
    },
  });
}
