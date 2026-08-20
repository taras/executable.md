/**
 * The two processes a hot-journal proof needs, and neither of them is the test.
 *
 * A rollback journal only exists between the moment SQLite starts writing pages
 * and the moment it commits. Nothing a test can do to itself produces one that
 * outlives the test: a thrown error, a cancelled task and a closed scope all
 * unwind, and unwinding commits or rolls back. A killed process does not, so
 * one of these modes exists to be killed.
 *
 * ```sh
 * deno run -A workflow-recovery-child.ts hot <database>
 * deno run -A workflow-recovery-child.ts open <database>
 * ```
 *
 * `hot` opens a real run database, changes committed lifecycle and journal rows
 * inside one immediate transaction, spills enough pages that the journal holds
 * real content, reports readiness and waits to be killed. What it changed is
 * never committed, so recovery must put every one of those rows back.
 *
 * `open` opens the same database through the production connection registry and
 * reports readiness only once that registry's recovery-forcing read has
 * returned. It is how a test proves the ordering it cannot see from outside: a
 * process that has not printed has not finished its first read, and therefore
 * has not touched the source pair.
 */

import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { main, type Operation, suspend } from "effection";
import { createWorkflowRunConnections } from "../../src/deno/connections.ts";

/**
 * Rows large enough, and numerous enough, to leave a journal with content.
 *
 * A one-page cache spills almost immediately, and spilling is what puts the
 * original pages into the journal. Without it a killed writer can leave a
 * journal a read-only connection walks straight past, and the condition under
 * test would never arise.
 */
const SPILL_ROWS = 64;

const FILLER = "x".repeat(4096);

/** Said on stdout, and nowhere else, once the mode has reached its point. */
const READY = "READY";

function hot(path: string): void {
  const database = new DatabaseSync(path);
  // The accepted condition is the rollback journal, so this is stated rather
  // than inherited from whatever the file was last opened with.
  database.exec("PRAGMA journal_mode = DELETE");
  database.exec("PRAGMA cache_size = 1");
  database.exec("PRAGMA foreign_keys = ON");

  const anchor = database
    .prepare("SELECT workspace_root_id AS root FROM journal_events ORDER BY sequence LIMIT 1")
    .get();
  const root = anchor?.["root"];
  if (typeof root !== "string") {
    throw new Error("the run has no retained event to anchor uncommitted rows to");
  }

  database.exec("BEGIN IMMEDIATE");
  // Valid changes to committed state, so recovery is proven by what comes back
  // rather than by a write SQLite would have refused anyway.
  database.prepare("UPDATE workflow_run SET status = ? WHERE id = 1").run("cancelled");
  database.exec(
    "DELETE FROM journal_events WHERE sequence = (SELECT MAX(sequence) FROM journal_events)",
  );
  const insert = database.prepare(
    "INSERT INTO journal_events (event_id, record, workspace_root_id) VALUES (?, ?, ?)",
  );
  for (let index = 0; index < SPILL_ROWS; index += 1) {
    insert.run(
      `uncommitted-${index}`,
      JSON.stringify({ type: "yield", coroutineId: "root", filler: FILLER }),
      root,
    );
  }

  console.log(READY);
}

function* open(path: string): Operation<void> {
  const connections = createWorkflowRunConnections();
  // Nothing is printed until this returns, and it returns only after the
  // registry's first page read has recovered whatever it found.
  yield* connections.at(path);
  console.log(READY);
}

main(function* (): Operation<void> {
  const [mode, path] = process.argv.slice(2);
  if (path === undefined) {
    throw new Error("usage: workflow-recovery-child.ts <hot|open> <database>");
  }

  if (mode === "hot") {
    hot(path);
  } else if (mode === "open") {
    yield* open(path);
  } else {
    throw new Error(`unknown mode ${JSON.stringify(mode)}`);
  }

  // Deno leaves when its event loop is empty, and a suspended Effection task
  // does not hold it. This process exists to be killed, so it stays.
  setInterval(() => {}, 1_000);
  yield* suspend();
});
