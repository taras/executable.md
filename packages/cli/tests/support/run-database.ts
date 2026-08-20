/**
 * Reading a run's database from outside the process that owns it.
 *
 * A reader here opens its own readonly connection on purpose: rows inside an
 * open transaction stay invisible to it, so a read reports what the run has
 * published rather than what some handle is holding. One state needs more
 * than that grant. A writer killed mid-transaction leaves a hot rollback
 * journal, and SQLite refuses to read past one on a connection that cannot
 * write the rollback — playing the journal back is a write, and it belongs to
 * the run's next owner, not to an observer.
 *
 * So the reader never writes to the store it observes. When it meets the
 * refusal, it copies the database and its journal to scratch, lets SQLite
 * play the journal back on the copy — which discards only what was never
 * committed — reads the copy, and discards it. The real store still holds its
 * hot journal afterwards, exactly as the kill left it, for whatever the test
 * does next. A hot journal also proves its writer is gone — a live writer
 * holds the lock that makes a journal merely busy — so the files are static
 * while the copy is taken.
 */

import { DatabaseSync } from "node:sqlite";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { copyFile, ensureDir, exists, rm } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function* readRunDatabase<T>(
  path: string,
  read: (database: DatabaseSync) => T,
): Operation<T> {
  try {
    return readonly(path, read);
  } catch (error) {
    if (!refusesHotJournal(error)) {
      throw error;
    }
  }
  return yield* readRecoveredCopy(path, read);
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

function readRecoveredCopy<T>(path: string, read: (database: DatabaseSync) => T): Operation<T> {
  return scoped(function* () {
    const dir = join(tmpdir(), `xmd-recovered-read-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    const copy = join(dir, "run.db");
    yield* copyFile(path, copy);
    if (yield* exists(`${path}-journal`)) {
      yield* copyFile(`${path}-journal`, `${copy}-journal`);
    }

    const database = new DatabaseSync(copy);
    try {
      return read(database);
    } finally {
      database.close();
    }
  });
}
