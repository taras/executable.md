import type { Operation } from "effection";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { forEachLine } from "./record-file.ts";
import type { LineOptions } from "./record-file.ts";
import { RetainedBindings } from "./retained-bindings.ts";
import { sealEvent, stringSharing } from "./retained-event.ts";

/** What the REPL could not read or write, and nothing of what it held. */
export class ReplJournalError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "ReplJournalError";
  }
}

/** V8's maximum string length, applied to a single serialized record. */
const MAX_RECORD_UNITS = 0x1fffffe8;

interface JournalScan {
  readonly maxRecordUnits?: number;
  readonly range?: LineOptions["range"];
  readonly observe?: LineOptions["observe"];
  readonly recordBytes?: LineOptions["recordBytes"];
  readonly segmentSharing?: boolean;
}

/**
 * Every record one file holds, in append order.
 *
 * A missing final newline is a refusal rather than a shorter history: the last
 * record was still being written, and reading around it would present a prefix
 * as the whole of what happened.
 *
 * The limit can be set lower to exercise the record boundary in tests.
 */
export function* readRecords(
  path: string,
  maxRecordUnits = MAX_RECORD_UNITS,
): Operation<DurableEvent[]> {
  const events: DurableEvent[] = [];
  // deno-lint-ignore require-yield
  yield* scanEntryRecords(path, { maxRecordUnits }, function* (event) {
    events.push(event);
  });
  return events;
}

export function* scanEntryRecords(
  path: string,
  options: JournalScan,
  visit: (event: DurableEvent) => Operation<void>,
): Operation<number> {
  let share = stringSharing();
  let bindings = new RetainedBindings();
  let count = 0;
  const maxRecordUnits = options.maxRecordUnits ?? MAX_RECORD_UNITS;
  return yield* forEachLine(
    path,
    {
      range: options.range,
      observe: options.observe,
      recordBytes: options.recordBytes,
      recordLimit: {
        units: maxRecordUnits,
        exceeded: (record) =>
          new ReplJournalError(
            `this execution's history holds a record that exceeds ` +
              `${maxRecordUnits.toLocaleString("en-US")} UTF-16 code units (record ${record}).`,
          ),
      },
      refusals: {
        unterminated: () =>
          new ReplJournalError(
            "this execution's history ends in a record that was never finished writing.",
          ),
      },
    },
    function* (line): Operation<void> {
      const parsed = parseDurableEvent(line);
      if (!parsed.ok) {
        // The record's own text stays out of this: a history holds whatever a
        // person's document held.
        throw new ReplJournalError(
          `this execution's history holds a record this version cannot read (record ` +
            `${count + 1}).`,
        );
      }
      const recorded = bindings.share(sealEvent(parsed.value, share));
      bindings.remember(recorded);
      count += 1;
      yield* visit(recorded);
      if (options.segmentSharing && recorded.type === "close" && recorded.coroutineId === "root") {
        share = stringSharing();
        bindings = new RetainedBindings();
      }
    },
  );
}
