/**
 * Who may act on a run's database and rollback journal as a pair.
 *
 * A crashed host leaves a database beside a hot journal, and the two are one
 * state: the committed contents are what the journal says to put back. Exactly
 * two callers touch that pair. A write-capable opening lets SQLite roll the
 * journal back into the database and delete it. Read-only inspection copies
 * both files so it can recover the copy instead. Either one running while the
 * other is part-way through would combine versions — a database from after the
 * rollback beside a journal from before it, or a copy of a file another process
 * is rewriting.
 *
 * So both wait for the same sidecar. This is arrangement between hosts, not
 * authority over the run: holding it proves only that nobody else is recovering
 * or copying this pair right now. It says nothing about who may advance the
 * run, which is the executor lock's separate question, in a separate file, with
 * a separate refusal. Nothing is handed back — no lock object, no run id, no
 * transition token, no connection — because there is nothing here that a later
 * call could be entitled to show.
 *
 * The sidecar's name is derived rather than registered, and lands outside the
 * `<hash>.sqlite` candidate pattern discovery matches, so it is never mistaken
 * for a run. Like the executor's, it is created if absent, left empty, and may
 * outlive the run it names.
 */

import type { Operation } from "effection";
import {
  type AdvisoryLockFile,
  releaseAdvisoryLock,
  takeAdvisoryLock,
  useWaitingAdvisoryLock,
} from "./advisory-lock.ts";

/** The sidecar two owners of one database-and-journal pair take turns on. */
export function recoveryCoordinationPath(databasePath: string): string {
  return `${databasePath}.recovery.lock`;
}

/**
 * Hold recovery coordination for `databasePath` for as long as the scope lives.
 *
 * The wait is cooperative and cancellable: whoever holds it is finishing a
 * bounded piece of work — one recovery read, or one pair of file copies — so
 * waiting is measured in milliseconds, and a caller that is cancelled while
 * waiting stops waiting.
 */
export function holdRecoveryCoordination(databasePath: string): Operation<void> {
  return useWaitingAdvisoryLock(recoveryCoordinationPath(databasePath));
}

/**
 * Hold coordination for a write-capable connection, for as long as it is open.
 *
 * A connection is the other owner of the pair, and it owns it the whole time it
 * exists rather than only while it is opening. SQLite recovers a hot journal on
 * whichever read first needs a page, and for a cached connection that read can
 * come at any moment — long after the opening, from a caller that knows nothing
 * about any of this. A hold that ended with the opening would leave exactly that
 * read free to roll the journal back into the database while an inspection was
 * copying the two, and copy and read would then describe different states.
 *
 * So the lock lives as long as the connection: taken here, released where the
 * connection closes. That is also why a cached lookup pays nothing — the
 * connection it returns is already holding it. It is shared, so connections do
 * not exclude each other; only an inspection copying the pair excludes them.
 */
export function takeConnectionCoordination(databasePath: string): Operation<AdvisoryLockFile> {
  // Shared: any number of hosts may have this run open at once, and which of
  // them may advance it is the executor lock's question, not this one. What
  // this excludes is an inspection copying the pair while any of them could
  // recover it.
  return takeAdvisoryLock(recoveryCoordinationPath(databasePath), { exclusive: false });
}

/** Give it back, which is what closing the connection means for the pair. */
export function releaseConnectionCoordination(held: AdvisoryLockFile): void {
  releaseAdvisoryLock(held);
}
