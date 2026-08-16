import { DatabaseSync } from "node:sqlite";
import { exampleSync, processSync } from "./example-sync.ts";

/** A name ending in Sync that nothing filesystem-shaped ever bound. */
export function summarize(input: string): string {
  return processSync(exampleSync(input));
}

/** A synchronous database transaction is not filesystem work the rule owns. */
export function count(path: string): number {
  const database = new DatabaseSync(path);
  return database.prepare("select count(*) from rows").get().total;
}

/** A method named for synchrony on an object the rule cannot resolve. */
export function flush(sink: { flushSync(): void }): void {
  sink.flushSync();
}
