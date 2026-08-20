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
import { useWaitingAdvisoryLock } from "./advisory-lock.ts";

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
