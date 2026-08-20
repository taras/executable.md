/**
 * Reading a run's database from outside the process that owns it.
 *
 * A reader here opens its own readonly connection on purpose: rows inside an
 * open transaction stay invisible to it, so a read reports what the run has
 * published rather than what some handle is holding. One state needs more
 * than that grant. A writer killed mid-transaction leaves a hot rollback
 * journal, and SQLite refuses to read past one on a connection that cannot
 * write the rollback. The next write-capable owner of the run performs that
 * rollback on its first read — discarding only what was never committed — so
 * a reader that meets the refusal recovers the same way, then reads on a
 * fresh readonly connection.
 */

import { DatabaseSync } from "node:sqlite";

export function readRunDatabase<T>(path: string, read: (database: DatabaseSync) => T): T {
  try {
    return readonly(path, read);
  } catch (error) {
    if (!refusesHotJournal(error)) {
      throw error;
    }
    rollBackHotJournal(path);
    return readonly(path, read);
  }
}

function readonly<T>(path: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function refusesHotJournal(error: unknown): boolean {
  return error instanceof Error && error.message.includes("attempt to write a readonly database");
}

function rollBackHotJournal(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
  } finally {
    database.close();
  }
}
