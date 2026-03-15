/**
 * loadJournal — read a JSONL journal file and return parsed DurableEvents.
 *
 * Handles:
 * - File doesn't exist → returns [] (fresh run)
 * - Empty file → returns [] (fresh run)
 * - Corrupt/partial last line → skips it (crash-safe)
 * - Previous failed run → strips the Close(err) on root so durableRun
 *   replays all successful effects and continues live from the failure point
 *
 * All file I/O uses Effection's call() — no raw Promises.
 */

import { call } from "effection";
import type { Operation } from "effection";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { DurableEvent } from "@effectionx/durable-streams";

/**
 * Load journal events from a JSONL file.
 *
 * If the file doesn't exist, returns an empty array (fresh run).
 * If the last event is a failed Close on the root coroutine, it is
 * stripped so that durableRun will replay successful effects and
 * continue live from the failure point.
 */
export function* loadJournal(filePath: string): Operation<DurableEvent[]> {
  // Synchronous existence check — no Promise, no yield needed
  if (!existsSync(filePath)) {
    return [];
  }

  const content: string = yield* call(() => readFile(filePath, "utf-8"));

  if (!content.trim()) {
    return [];
  }

  const lines = content.trim().split("\n");
  const events: DurableEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as DurableEvent);
    } catch {
      // Corrupt or partial last line (crash mid-write) — stop here.
      // All events before this line were fully written and are safe.
      break;
    }
  }

  // Strip failed Close event on the root coroutine for retry.
  // This allows durableRun to treat the workflow as "in progress",
  // replay all successful Yield events (skipping re-execution),
  // and continue live from the point of failure.
  const last = events.at(-1);
  if (
    last &&
    last.type === "close" &&
    last.result.status === "err" &&
    last.coroutineId === "root"
  ) {
    events.pop();
  }

  return events;
}
