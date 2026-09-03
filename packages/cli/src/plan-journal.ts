/**
 * `xmd plan --journal` — the diagnostic record of one authorship invocation
 * (specs/plan-command-spec.md).
 *
 * The file holds the command root's ordinary live durable events, serialized as
 * the same JSONL sequence every other trace uses. It is a record of how a Plan
 * came to be written, not a history anything reads back: this command opens no
 * journal as input, resumes nothing from one, and runs no program that could be
 * resumed.
 *
 * What is here rather than beside `xmd run`'s journal is the wording. A caller
 * who asked `xmd plan` for a trace is told which `--journal` path to choose and
 * what survived a failure, and neither sentence is `xmd run`'s to change. The
 * bytes are identical; only the diagnostics are this command's own.
 */

import { Err, Ok, until } from "effection";
import type { Operation, Result } from "effection";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";

import { FileStream } from "./file-stream.ts";
import { describeError } from "./props.ts";

/** What a caller who named a path something already occupies is told. */
export function journalExistsRefusal(path: string): string {
  return `Journal file already exists: ${path}. Choose a different --journal path.`;
}

/** What a path this command could not create at all is refused with. */
export function journalCreationRefusal(path: string, reason: string): string {
  return (
    `Could not create journal file ${path}: ${reason}\n\n` +
    "Choose a different --journal path and try again."
  );
}

/**
 * What an entry the file would not take ends authorship with.
 *
 * It names what is still readable, because that is the whole value left: the
 * entries recorded before the failure are the trace of everything that did
 * happen, and a caller who reads "the journal is incomplete" would throw away
 * the evidence they asked for.
 */
export function journalAppendFailure(path: string, reason: string): string {
  return (
    `Could not write the next entry to journal file ${path}: ${reason}\n\n` +
    "The journal still contains the entries recorded before this failure."
  );
}

/**
 * Exclusively create the named journal and hand back the stream that appends to
 * it, or refuse.
 *
 * Exclusive creation, so a path somebody kept is left byte-identical and this
 * command stops before the catalog, the session directory, the provider, any
 * turn, the review or the artifact exists. There is no check-then-create: the
 * open is the check. The creation handle is closed straight away — appending is
 * the stream's business, and a handle held open across the whole invocation
 * would be one more thing a teardown has to get right.
 */
export function* createPlanJournal(path: string): Operation<Result<DurableStream>> {
  let handle: FileHandle;
  try {
    handle = yield* until(open(path, "wx"));
  } catch (error) {
    const existing =
      error instanceof Error &&
      (("code" in error && error.code === "EEXIST") || error.message.startsWith("EEXIST:"));
    if (existing) {
      return Err(new Error(journalExistsRefusal(path)));
    }
    return Err(new Error(journalCreationRefusal(path, describeError(error))));
  }

  try {
    yield* until(handle.close());
  } catch (error) {
    return Err(new Error(journalCreationRefusal(path, describeError(error))));
  }

  return Ok(planJournalStream(path, new FileStream(path)));
}

/**
 * What an entry the journal would not take ends authorship with.
 *
 * A class rather than a message, because it has to survive being wrapped. The
 * durable runtime reports a refused append as its own failure to persist an
 * event, and a person who asked for a journal is owed the sentence about the
 * file rather than the one about the protocol — so this travels as the `cause`
 * and the command reads it back out (see {@link journalRefusal}).
 */
export class PlanJournalError extends Error {
  constructor(path: string, cause: unknown) {
    super(journalAppendFailure(path, describeError(cause)), { cause });
    this.name = "PlanJournalError";
  }
}

/**
 * The journal refusal underneath a failure, when that is what the failure is.
 *
 * Read from the cause chain rather than from a flag something set beside it: a
 * refused entry is reported here exactly when it is what ended this authorship,
 * so an unrelated failure keeps its own account.
 */
export function journalRefusal(error: unknown): PlanJournalError | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof PlanJournalError) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Wrap the stream that writes the file, so a refused entry says whose file it
 * is and what survived.
 *
 * A translation and nothing else: the same `serializeDurableEvent()` JSONL, in
 * commit order, with no curated projection and no format of this command's own.
 *
 * The backing stream is a parameter because a filesystem will not fail an
 * append on request. Production hands it a {@link FileStream} over `path`; a
 * case that has to prove what a failed entry leaves behind hands it one that
 * writes the same file and then refuses, so what it reads back is this
 * translation rather than a message the case wrote itself.
 */
export function planJournalStream(path: string, backing: DurableStream): DurableStream {
  return {
    readAll: () => backing.readAll(),
    *append(event: DurableEvent): Operation<void> {
      try {
        yield* backing.append(event);
      } catch (error) {
        throw new PlanJournalError(path, error);
      }
    },
  };
}
