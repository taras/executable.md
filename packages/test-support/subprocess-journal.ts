import { Buffer } from "node:buffer";
import process from "node:process";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { withFailureJournal } from "@executablemd/testing";
import { useTestDiagnostics } from "../cli/src/test-diagnostics.ts";
import type { DeliverySink } from "../cli/src/stdout-delivery.ts";
import type { JournalCase } from "../cli/src/test-diagnostics.ts";

const MAX_ENVELOPE_BYTES = 64 * 1024;

const MAX_SNAPSHOT_BYTES = 16 * 1024;
const OVERFLOW = "snapshot exceeds journal budget";
const INVALID = "invalid snapshot";
const MISSING = "snapshot absent";

type Snapshot = readonly DurableEvent[] | typeof OVERFLOW | typeof INVALID | typeof MISSING;

function fitsEnvelope(text: string): boolean {
  return Buffer.byteLength(text) + 1 <= MAX_ENVELOPE_BYTES;
}

export function boundedJournalResult(result: object, snapshots: readonly string[][]): string {
  // Reserve every omission slot before admitting any snapshot.
  const journals: (string[] | typeof OVERFLOW)[] = snapshots.map(() => OVERFLOW);
  const serialize = () => JSON.stringify({ ...result, journals });
  let envelope = serialize();
  if (!fitsEnvelope(envelope)) {
    return JSON.stringify(result);
  }
  for (const [index, records] of snapshots.entries()) {
    if (Buffer.byteLength(JSON.stringify(records)) > MAX_SNAPSHOT_BYTES) {
      continue;
    }
    journals[index] = records;
    const candidate = serialize();
    if (fitsEnvelope(candidate)) {
      envelope = candidate;
    } else {
      journals[index] = OVERFLOW;
    }
  }
  return envelope;
}

export function readSubprocessSnapshot(value: unknown, index: number): Snapshot {
  const entry: unknown = Array.isArray(value) ? value[index] : undefined;
  if (entry === undefined) {
    return MISSING;
  }
  if (
    entry === OVERFLOW ||
    (Array.isArray(entry) && Buffer.byteLength(JSON.stringify(entry)) > MAX_SNAPSHOT_BYTES)
  ) {
    return OVERFLOW;
  }
  const events = parseSubprocessJournal(entry);
  return events.length === 0 ? INVALID : events;
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
  readonly profile?: string;
  readonly snapshot: Snapshot;
}

/** Hold settled records from a joined synthetic child through its parent's assertions. */
export function checkSubprocessJournals<T>(
  testCase: JournalCase,
  journals: readonly SubprocessJournal[],
  check: () => Operation<T>,
  sink: DeliverySink = process.stderr,
): Operation<T> {
  if (journals.length === 0) {
    return check();
  }
  return scoped(function* () {
    const diagnostics = yield* useTestDiagnostics(sink, testCase);
    const captures = journals.map(({ snapshot, source, profile }) => ({
      snapshot,
      host: diagnostics.execution("child", source, profile).journal<T>(() => false),
    }));
    let passed = false;
    yield* ensure(function* () {
      if (!passed) {
        for (const { snapshot, host } of captures) {
          if (typeof snapshot === "string") {
            yield* host.reportSaveFailure(new Error(snapshot));
          }
        }
      }
    });
    const run = captures.reduceRight<() => Operation<T>>((next, { snapshot, host }) => {
      if (typeof snapshot === "string") {
        return next;
      }
      return () =>
        withFailureJournal(host, function* (buffer) {
          for (const event of snapshot) {
            yield* buffer.append(event);
          }
          return yield* next();
        });
    }, check);
    const result = yield* scoped(run);
    passed = true;
    return result;
  });
}
