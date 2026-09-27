/**
 * One execution's history, as one append-only file.
 *
 * The file holds nothing but `serializeDurableEvent` records, one per line. That
 * is the whole storage design: no manifest, no projected model, no cache, no
 * checkpoint index and no UI sidecar. Everything the REPL shows is read back
 * from these records, so there is no second copy of the truth to disagree with
 * them and nothing to migrate when the model changes.
 *
 * Reading is hostile. Each line is parsed through `parseDurableEvent`, a file
 * whose last record has no terminating newline is a write that did not finish,
 * and anything that is not a regular file is refused before it is read. What a
 * refusal never does is quote the file back: its contents are a person's own
 * history.
 *
 * Nothing here chooses a runtime. Reading, existence, kind and directory
 * creation are `@effectionx/fs` operations; the two this repository's portable
 * filesystem layer does not offer — creating a name exclusively and appending to
 * it — cross the contextual host boundary. The storage root arrives as an
 * argument, so the kernel never reads a home directory, an environment variable
 * or a platform name to find one.
 *
 * Writing is single-writer, which is the `DurableStream` contract and not a
 * claim this feature strengthens. Two processes appending to one execution is
 * outside that contract and unsupported; no lease is taken, because a lease
 * whose crash behavior nothing here proves would be a worse answer than the
 * documented one.
 */

import type { Operation } from "effection";
import { ensureDir, exists, readTextFile, stat } from "@effectionx/fs";
import { join } from "node:path";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";

import { ReplHost } from "./host.ts";
import { isOpaqueExecution } from "./route.ts";

/** What the REPL could not read or write, and nothing of what it held. */
export class ReplJournalError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "ReplJournalError";
  }
}

/**
 * An append-only stream that says when a record has actually been retained.
 *
 * The interface rather than the class, so a test injects an in-memory one and
 * the same corpus runs under all three runtimes without an operator's
 * filesystem being part of what is under test.
 */
export interface RetainedStream extends DurableStream {
  /** Called after each append has been retained, with what was retained. */
  onAppend: ((event: DurableEvent) => void) | null;
}

/**
 * One execution's retained stream.
 *
 * The events are held in memory because this process is the only writer: what is
 * in hand is what the file holds. An append reaches the file first and is only
 * then acknowledged — remembered and announced — so nothing downstream ever sees
 * a record that a crash would have lost.
 */
export class RetainedReplStream implements RetainedStream {
  readonly path: string;
  private events: DurableEvent[];

  /** Called after each append has reached the file, with what reached it. */
  onAppend: ((event: DurableEvent) => void) | null = null;

  constructor(path: string, retained: readonly DurableEvent[] = []) {
    this.path = path;
    this.events = retained.map(clone);
  }

  // deno-lint-ignore require-yield
  *readAll(): Operation<DurableEvent[]> {
    return this.events.map(clone);
  }

  *append(event: DurableEvent): Operation<void> {
    const recorded = clone(event);

    yield* ReplHost.operations.appendRecord(this.path, serializeDurableEvent(recorded));

    this.events.push(recorded);
    this.onAppend?.(clone(recorded));
  }
}

/** One execution the REPL can show: an opaque name and the stream behind it. */
export interface ReplExecution {
  readonly id: string;
  readonly stream: RetainedStream;
}

/**
 * Where a set of executions live, and how one is reached.
 *
 * A plain value built from a root, rather than an Api of its own: which
 * directory holds them is the host's decision, and everything after that is
 * ordinary portable code.
 */
export interface ReplRepository {
  /** Begin a new execution under a name nothing else holds. */
  create(): Operation<ReplExecution>;
  /** Open the exact execution this name addresses, and refuse anything else. */
  open(execution: string): Operation<ReplExecution>;
}

export function replRepository(root: string): ReplRepository {
  return {
    *create(): Operation<ReplExecution> {
      return yield* createExecutionFile(root, yield* ReplHost.operations.identify());
    },
    open(execution: string): Operation<ReplExecution> {
      return openExecutionFile(root, execution);
    },
  };
}

/** Where one execution's history lives, given the root a host chose. */
export function executionPath(root: string, execution: string): string {
  if (!isOpaqueExecution(execution)) {
    // Checked before the join rather than after: an identifier that could
    // address a parent directory must never become a path at all.
    throw new ReplJournalError(
      "an execution is named by the opaque identifier the REPL created for it",
    );
  }
  return join(root, `${execution}.jsonl`);
}

/**
 * Create one execution's file, exclusively.
 *
 * The existence check is for the sentence a person reads; the host's exclusive
 * create is the guard. Between the two, another writer taking the name is still
 * a refusal rather than a merge, which is what makes the check a courtesy
 * instead of a race this depends on.
 */
export function* createExecutionFile(root: string, execution: string): Operation<ReplExecution> {
  const path = executionPath(root, execution);
  yield* ensureDir(root);

  if (yield* exists(path)) {
    throw new ReplJournalError(
      "this execution already has a history. Open it instead of starting it again.",
    );
  }
  try {
    yield* ReplHost.operations.createExclusive(path);
  } catch (error) {
    throw new ReplJournalError("this execution's history could not be created.", { cause: error });
  }

  return { id: execution, stream: new RetainedReplStream(path) };
}

/**
 * Open one execution's file and read every record it holds.
 *
 * Nothing is projected here: this answers what the file says, and deciding
 * whether what it says is a possible history belongs to the projector.
 */
export function* openExecutionFile(root: string, execution: string): Operation<ReplExecution> {
  const path = executionPath(root, execution);

  if (!(yield* exists(path))) {
    throw new ReplJournalError("this execution has no history here.");
  }
  const target = yield* stat(path);
  if (!target.isFile()) {
    throw new ReplJournalError("this execution's history is not a file.");
  }

  return { id: execution, stream: new RetainedReplStream(path, yield* readRecords(path)) };
}

/**
 * Every record one file holds, in append order.
 *
 * A missing final newline is a refusal rather than a shorter history: the last
 * record was still being written, and reading around it would present a prefix
 * as the whole of what happened.
 */
export function* readRecords(path: string): Operation<DurableEvent[]> {
  const text = yield* readTextFile(path);
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new ReplJournalError(
      "this execution's history ends in a record that was never finished writing.",
    );
  }

  const events: DurableEvent[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      // The record's own text stays out of this: a history holds whatever a
      // person's document held.
      throw new ReplJournalError(
        `this execution's history holds a record this version cannot read (record ` +
          `${events.length + 1}).`,
      );
    }
    events.push(parsed.value);
  }
  return events;
}

function clone(event: DurableEvent): DurableEvent {
  return structuredClone(event);
}
