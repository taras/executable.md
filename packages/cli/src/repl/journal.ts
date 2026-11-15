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
 * Reading is also incremental. The file is read a record at a time and never
 * held as one string, and the records keep one instance of each large string
 * they repeat — a root close hands on every value it inherited, so the same
 * captured output recurs in every later close.
 *
 * Nothing here chooses a runtime. Reading, existence, kind and directory
 * creation are `@effectionx/fs` operations; the two this repository's portable
 * filesystem layer does not offer — creating a name exclusively and appending to
 * it — cross the contextual host boundary. The storage root arrives as an
 * argument, so the kernel never reads a home directory, an environment variable
 * or a platform name to find one.
 *
 * Writing is single-writer, which is the `DurableStream` contract and not a guarantee this feature strengthens. Two processes appending to one execution is
 * outside that contract and unsupported; no lease is taken, because a lease
 * whose crash behavior nothing here proves would be a worse answer than the
 * documented one.
 */

import { withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, stat } from "@effectionx/fs";
import { join } from "node:path";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";

import { ReplHost } from "./host.ts";
import { readRecords, ReplJournalError } from "./journal-records.ts";
export { readRecords, ReplJournalError } from "./journal-records.ts";
import { RetainedBindings } from "./retained-bindings.ts";
import { sealEvent } from "./retained-event.ts";
import { PagedHistory } from "./paged-history.ts";
import { isOpaqueExecution } from "./route.ts";

/**
 * An append-only stream that says when a record has actually been retained.
 *
 * The interface rather than the class, so a test injects an in-memory one and
 * the same corpus runs under all three runtimes without an operator's
 * filesystem being part of what is under test.
 */
export interface RetainedStream extends DurableStream {
  readonly history?: PagedHistory | undefined;
  /** Deliver the acknowledged record to the appending segment. */
  append(event: DurableEvent, retained?: (event: DurableEvent) => void): Operation<void>;
  /** Called after each append has been retained, with what was retained. */
  onAppend: ((event: DurableEvent) => void) | null;
}

/**
 * One execution's retained stream.
 *
 * An append reaches the file before its frozen record reaches the history,
 * observer or owning segment. File-backed sessions delegate retained ranges
 * to their validated catalog. An explicit full read reconstructs their events
 * from the journal. Unpaged streams retain sealed events for their readers.
 * Sealing before the write suspends keeps later caller edits out of the file
 * and every reading.
 */
export class RetainedReplStream implements RetainedStream {
  readonly path: string;
  private events: DurableEvent[];
  private readonly bindings = new RetainedBindings();

  /** Called after each append has reached the file, with what reached it. */
  onAppend: ((event: DurableEvent) => void) | null = null;

  constructor(
    path: string,
    retained: readonly DurableEvent[] = [],
    readonly history?: PagedHistory,
  ) {
    this.path = path;
    this.events = retained.map((event) => {
      const recorded = this.bindings.share(sealEvent(event));
      this.bindings.remember(recorded);
      return recorded;
    });
  }

  *readAll(): Operation<DurableEvent[]> {
    return this.history === undefined ? this.events.slice() : yield* this.history.readAll();
  }

  *append(event: DurableEvent, retained?: (event: DurableEvent) => void): Operation<void> {
    const recorded = this.bindings.share(sealEvent(event));

    const text = serializeDurableEvent(recorded);
    try {
      if (this.history === undefined) {
        yield* ReplHost.operations.appendRecord(this.path, text);
      } else {
        yield* ReplHost.operations.appendEntryRecord(this.path, text, this.history.checkAppend());
      }
    } catch (cause) {
      if (this.history !== undefined) {
        throw this.history.fence(cause instanceof Error ? cause : new Error(String(cause)));
      }
      throw cause;
    }

    this.bindings.remember(recorded);
    if (this.history === undefined) {
      this.events.push(recorded);
    } else {
      this.history.acknowledge(recorded, text);
    }
    this.onAppend?.(recorded);
    retained?.(recorded);
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
export function* openExecutionFile(
  root: string,
  execution: string,
  paged = false,
): Operation<ReplExecution> {
  const path = executionPath(root, execution);

  if (!(yield* exists(path))) {
    throw new ReplJournalError("this execution has no history here.");
  }
  const target = yield* stat(path);
  if (!target.isFile()) {
    throw new ReplJournalError("this execution's history is not a file.");
  }

  return { id: execution, stream: yield* openRetainedStream(path, paged) };
}

export function* openRetainedStream(path: string, paged: boolean): Operation<RetainedReplStream> {
  return paged
    ? new RetainedReplStream(path, [], yield* PagedHistory.open(path))
    : new RetainedReplStream(path, yield* readRecords(path));
}

/**
 * One stable entry writer whose file can be changed exactly once.
 *
 * Every `EntrySegmentStream` is constructed over this, so switching the target
 * inside it reaches every holder at once. That is what lets an entry that is
 * already running survive its execution's upgrade without being restarted and
 * without keeping a writer to the superseded path: it never held a path, only
 * this.
 */
export interface MovableWriter extends RetainedStream {
  /** The file appends currently reach. */
  readonly path: string;
  /** Send every later append to this stream instead. */
  redirect(next: RetainedStream): void;
  /** Whether an append is in flight right now. */
  readonly appending: boolean;
  /**
   * Return once no append is in flight.
   *
   * Waited rather than polled, and this is the acknowledgement the handoff
   * actually turns on: the root has already stopped admitting new appends, so
   * what is left is the one record that was mid-write, and the prefix cannot be
   * copied until the file holds it.
   */
  settled(): Operation<void>;
  /**
   * Hold every further record, and return once the one in flight has landed.
   *
   * What a handoff needs that `settled()` alone cannot give it. A writer that
   * has merely gone quiet can be written to again a moment later, and an entry
   * that is still running does exactly that: its next record would reach the
   * file whose bytes have already been copied, so the published pair would not
   * hold it *and* the retained origin would no longer match what it was
   * fingerprinted from — which makes the whole execution unreadable rather than
   * merely incomplete.
   *
   * Held records wait rather than fail, and are written to whichever target the
   * handoff leaves behind. Every hold has to be released, including the one a
   * failed or cancelled handoff took.
   */
  hold(): Operation<void>;
  /** Let held records through, to the target the handoff left. */
  release(): void;
}

export function movableWriter(initial: RetainedStream): MovableWriter {
  let target = initial;
  let appending = 0;
  /** Whether a handoff is holding records back right now. */
  let holding = false;
  /** Records waiting for a handoff to let them go, in the order they arrived. */
  const queued: Array<() => void> = [];
  const waiting: Array<() => void> = [];
  const release = (): void => {
    if (appending > 0) {
      return;
    }
    // Drained before any of them runs, so a waiter that starts another append
    // cannot leave a second waiter holding a resolver nobody will call.
    const settling = waiting.splice(0, waiting.length);
    for (const settle of settling) {
      settle();
    }
  };
  const facade: MovableWriter = {
    settled(): Operation<void> {
      return {
        *[Symbol.iterator]() {
          if (appending === 0) {
            return;
          }
          const reached = withResolvers<void>();
          waiting.push(reached.resolve);
          yield* reached.operation;
        },
      };
    },
    get path(): string {
      return (target as { path?: string }).path ?? "";
    },
    get history(): PagedHistory | undefined {
      return target.history;
    },
    get appending(): boolean {
      return appending > 0;
    },
    get onAppend(): ((event: DurableEvent) => void) | null {
      return target.onAppend;
    },
    set onAppend(observer: ((event: DurableEvent) => void) | null) {
      target.onAppend = observer;
    },
    *readAll(): Operation<DurableEvent[]> {
      return yield* target.readAll();
    },
    *append(event: DurableEvent, retained?: (event: DurableEvent) => void): Operation<void> {
      // Held first, and in a loop: a record released by one handoff must not
      // slip past a second one that started while it was being woken.
      while (holding) {
        const allowed = withResolvers<void>();
        queued.push(allowed.resolve);
        yield* allowed.operation;
      }
      // Counted rather than flagged: the root waits for *the* append in flight,
      // and a count says truthfully whether one is.
      appending += 1;
      try {
        yield* target.append(event, retained);
      } finally {
        appending -= 1;
        release();
      }
    },
    hold(): Operation<void> {
      return {
        *[Symbol.iterator]() {
          holding = true;
          yield* facade.settled();
        },
      };
    },
    release(): void {
      holding = false;
      // Drained before any of them runs, for the same reason the settlement
      // waiters are: a released record that starts another append must not
      // leave a later one holding a resolver nobody will call.
      const allowed = queued.splice(0, queued.length);
      for (const resume of allowed) {
        resume();
      }
    },
    redirect(next: RetainedStream): void {
      if (appending > 0) {
        // The handoff waits for the acknowledgement before it gets here. A
        // redirect while a record is in flight would leave that record's file
        // undecided, which is the one thing the ordering exists to prevent.
        throw new ReplJournalError(
          "an entry record is still being written, so the history it belongs to cannot be " +
            "changed yet.",
        );
      }
      next.onAppend = target.onAppend;
      target = next;
    },
  };
  return facade;
}
