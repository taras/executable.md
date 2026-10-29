/**
 * This command's own history, read when no record is still being written.
 *
 * `mountedReading` reads the files the running command appends to, through the
 * product's own reader — and that reader refuses a chat history whose last line
 * carries no terminator, because a half-written record at rest is not a record
 * (`readSidekickRecords` in `src/repl/sidekick/history.ts`). A test that reads
 * while the host's append is in flight sees exactly that, and the refusal is
 * right: what is wrong is the moment the test chose.
 *
 * So the read is retried until that one refusal stops happening, and nothing
 * else is retried: a missing file, a record this version cannot read, or a
 * malformed one is raised at once. A tail that never finishes is raised too,
 * with the history's own words, once the wait runs out — so a journal that is
 * genuinely torn at rest still fails here, as loudly as it did before.
 */

import type { Operation } from "effection";

import { SidekickHistoryError } from "../../src/repl/sidekick/history.ts";
import type { SidekickRecord } from "../../src/repl/sidekick/history.ts";
import type { ReplModel } from "../../src/repl/model.ts";
import { awaitedFact, mountedReading } from "./mounted-repl.ts";
import type { MountedRepl } from "./mounted-repl.ts";

/** What is on disk for one mounted command: its chat, and its entry history. */
export interface MountedHistory {
  readonly execution: string;
  readonly chat: readonly SidekickRecord[];
  readonly model: ReplModel;
}

/** The one refusal a reader gets from a record that is still being appended. */
const UNFINISHED = "ends in a record that was never finished writing";

function unfinished(caught: unknown): boolean {
  return caught instanceof SidekickHistoryError && caught.message.includes(UNFINISHED);
}

/** Read this command's history, waiting out an append that is in flight. */
export function* settledReading(repl: MountedRepl): Operation<MountedHistory> {
  let read: MountedHistory | undefined;
  let refused: unknown;
  try {
    yield* awaitedFact("a history with no record still being written", function* () {
      try {
        read = yield* mountedReading(repl);
        return true;
      } catch (caught) {
        if (!unfinished(caught)) {
          throw caught;
        }
        refused = caught;
        return false;
      }
    });
  } catch (caught) {
    // The history's own refusal rather than the wait's, so a tail that never
    // finished says what it was.
    throw refused ?? caught;
  }
  if (read === undefined) {
    throw refused ?? new Error("this command's history was never read");
  }
  return read;
}
