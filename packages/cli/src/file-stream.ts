import { until } from "effection";
import type { Operation } from "effection";
import { appendFile } from "node:fs/promises";
import type { DurableStream, DurableEvent } from "@executablemd/durable-streams";

function cloneEvent(event: DurableEvent): DurableEvent {
  return structuredClone(event);
}

export class FileStream implements DurableStream {
  private events: DurableEvent[];
  private filePath: string;

  onAppend: ((event: DurableEvent) => void) | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.events = [];
  }

  // deno-lint-ignore require-yield
  *readAll(): Operation<DurableEvent[]> {
    return this.events.map(cloneEvent);
  }

  *append(event: DurableEvent): Operation<void> {
    const cloned = cloneEvent(event);

    yield* until(appendFile(this.filePath, JSON.stringify(cloned) + "\n"));
    this.events.push(cloned);
    this.onAppend?.(cloneEvent(cloned));
  }
}
