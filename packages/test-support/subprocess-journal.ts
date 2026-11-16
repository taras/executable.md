import { Buffer } from "node:buffer";
import process from "node:process";
import { scoped } from "effection";
import type { Operation } from "effection";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { withFailureJournal } from "@executablemd/testing";
import { useTestDiagnostics } from "../cli/src/test-diagnostics.ts";
import type { JournalCase } from "../cli/src/test-diagnostics.ts";

const MAX_ENVELOPE_BYTES = 64 * 1024;

export function boundedJournalResult(result: object, evidence: object): string {
  const enriched = JSON.stringify({ ...result, ...evidence });
  return Buffer.byteLength(enriched) + 1 <= MAX_ENVELOPE_BYTES ? enriched : JSON.stringify(result);
}

export function parseSubprocessJournal(value: unknown): DurableEvent[] {
  if (!Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_ENVELOPE_BYTES) {
    return [];
  }
  const events: DurableEvent[] = [];
  for (const record of value) {
    if (typeof record !== "string") {
      return [];
    }
    const parsed = parseDurableEvent(record);
    if (!parsed.ok) {
      return [];
    }
    events.push(parsed.value);
  }
  return events;
}

export interface SubprocessJournal {
  readonly source: string;
  readonly events: readonly DurableEvent[];
}

/** Hold settled records from a joined synthetic child through its parent's assertions. */
export function checkSubprocessJournals<T>(
  testCase: JournalCase,
  journals: readonly SubprocessJournal[],
  check: () => Operation<T>,
): Operation<T> {
  if (journals.length === 0) {
    return check();
  }
  return scoped(function* () {
    const diagnostics = yield* useTestDiagnostics(process.stderr, testCase);
    const captures = journals.map((journal) => ({
      events: journal.events,
      host: diagnostics.execution("child", journal.source).journal<T>(() => false),
    }));
    const run = captures.reduceRight<() => Operation<T>>(
      (next, { events, host }) =>
        () =>
          withFailureJournal(host, function* (buffer) {
            for (const event of events) {
              yield* buffer.append(event);
            }
            return yield* next();
          }),
      check,
    );
    return yield* run();
  });
}
