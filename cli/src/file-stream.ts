/**
 * FileStream — a DurableStream backed by a JSONL file.
 *
 * Events are loaded from disk before construction (via loadJournal),
 * so readAll() returns the snapshot synchronously. New events are
 * persisted to the file via appendFile before updating in-memory
 * state, guaranteeing persist-before-resume.
 *
 * All file I/O uses Effection's call() — no raw Promises.
 */

import { call } from "effection";
import type { Operation } from "effection";
import { appendFile } from "node:fs/promises";
import type { DurableStream, DurableEvent } from "@executablemd/durable-streams";

function cloneEvent(event: DurableEvent): DurableEvent {
  return structuredClone(event);
}

export class FileStream implements DurableStream {
  private events: DurableEvent[];
  private filePath: string;

  /** Optional callback invoked on each append (for --verbose observability). */
  onAppend: ((event: DurableEvent) => void) | null = null;

  constructor(filePath: string, initialEvents: DurableEvent[] = []) {
    this.filePath = filePath;
    this.events = initialEvents.map(cloneEvent);
  }

  // deno-lint-ignore require-yield
  *readAll(): Operation<DurableEvent[]> {
    return this.events.map(cloneEvent);
  }

  *append(event: DurableEvent): Operation<void> {
    const cloned = cloneEvent(event);

    // Persist to file FIRST (persist-before-resume guarantee)
    yield* call(() => appendFile(this.filePath, JSON.stringify(cloned) + "\n"));

    // Then update in-memory state
    this.events.push(cloned);

    // Fire observability callback (for --verbose stderr logging)
    this.onAppend?.(cloneEvent(cloned));
  }
}
