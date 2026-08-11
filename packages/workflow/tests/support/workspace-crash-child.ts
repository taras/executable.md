/**
 * The two processes a crash proof needs, and neither of them is the test.
 *
 * A cancelled task, a thrown error and a closed scope all unwind. A killed
 * process does not: its transaction is open when the signal arrives, no
 * application cleanup runs, and the operating system closes the connection and
 * releases its locks. The next connection to open the database recovers that
 * interrupted transaction to the last committed state. Proving that therefore
 * takes a process the test can kill without warning, and a second one that has
 * never seen the first — which is what these two modes are.
 *
 * ```sh
 * deno run -A workspace-crash-child.ts crash <root> <run-id>
 * deno run -A workspace-crash-child.ts inspect <root> <run-id>
 * ```
 *
 * `crash` opens the run, performs one real Workspace effect, and stops inside
 * the still-open transaction with the mutation, the immutable root, the
 * current-root pointer and the routed journal row all written and none of them
 * committed. It reports what that connection can see and then waits to be
 * killed.
 *
 * That stopping point is the connection registry's construction-time routed
 * append hook, which only a caller that builds the registry can install. So
 * `crash` assembles the same adapter modules the Deno provider installs, at the
 * path the provider derives, rather than calling `useWorkflowRunStorage`.
 * `inspect` has no such need and uses the provider itself.
 */

import process from "node:process";
import {
  durableRun,
  guardDurableStream,
  preserveJournalProvenance,
  type Workflow,
} from "@executablemd/durable-streams";
import { ensure, main, type Operation, suspend } from "effection";
import { WorkflowRunStorage } from "../../mod.ts";
import { useWorkflowRunStorage, workflowRunPath } from "../../deno.ts";
import { createWorkflowRunConnections } from "../../src/deno/connections.ts";
import { openWorkflowRunDatabase, readRunRow } from "../../src/deno/database.ts";
import { useJournalRouting } from "../../src/deno/journal-route.ts";
import { readTransaction } from "../../src/deno/reading.ts";
import { verifySchema } from "../../src/deno/schema.ts";
import {
  createWorkspaceEffect,
  useWorkspaceEffects,
  withWorkspaceEffects,
} from "../../src/deno/workspace/effect.ts";
import type { DenoWorkspaceFilesystem } from "../../src/deno/workspace/filesystem.ts";
import { currentWorkspaceRoot } from "../../src/deno/workspace/root.ts";
import {
  setPrivateWorkspaceClock,
  transactWorkspaceRoots,
  usePrivateWorkspace,
} from "../../src/deno/workspace/private.ts";
import {
  BASELINE_EFFECT,
  count,
  CRASH_CONTENT,
  CRASH_EFFECT,
  CRASH_PATH,
  readTree,
  report,
} from "./workspace-process.ts";

const CLOCK = 1_750_000_100_000;

function* crash(root: string, runId: string): Operation<void> {
  const path = workflowRunPath(root, runId);
  let filesystem: DenoWorkspaceFilesystem | undefined;
  let gateCalls = 0;
  let baselineExecutions = 0;

  const connections = createWorkflowRunConnections(() => {}, {
    *afterRoutedJournalAppend(_database, event): Operation<void> {
      if (event.type !== "yield" || filesystem === undefined) {
        return;
      }
      // Every read below is on the connection that opened the transaction, so
      // it sees that transaction's own uncommitted writes. Nothing else can.
      const sqlite = connection.database;
      const currentRoot = currentWorkspaceRoot(sqlite, path);
      const journalRow = sqlite
        .prepare(
          `SELECT event_id, workspace_root_id FROM journal_events
             WHERE record LIKE ? ORDER BY sequence DESC LIMIT 1`,
        )
        .get(`%"name":"${CRASH_EFFECT}"%`);
      report({
        ready: true,
        content: yield* filesystem.readTextFile(CRASH_PATH),
        currentRoot,
        retainedRoots: count(
          sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_roots").get()?.["count"],
        ),
        currentRootRetained: count(
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM workspace_roots WHERE root_id = ?")
            .get(currentRoot)?.["count"],
        ),
        journalEventId: journalRow?.["event_id"],
        journalRootId: journalRow?.["workspace_root_id"],
        journalRows: count(
          sqlite.prepare("SELECT COUNT(*) AS count FROM journal_events").get()?.["count"],
        ),
        gateCalls,
        baselineExecutions,
      });
      // Deno leaves when its event loop is empty, and a suspended Effection
      // task is not on it. A timer nothing clears is what keeps this process
      // and its open transaction alive until the signal arrives.
      setInterval(() => {}, 1_000);
      // The transaction stays open from here until the operating system takes
      // this process away, which is what the process is for.
      yield* suspend();
    },
  });
  yield* ensure(() => connections.close());

  const connection = connections.at(path);
  readTransaction(connection.database, () => {
    verifySchema(connection.database, path, connection.dofs);
  });
  const record = readRunRow(connection.database, path);

  yield* useJournalRouting(connections);
  yield* usePrivateWorkspace(connections);
  yield* useWorkspaceEffects(connections);
  const database = yield* openWorkflowRunDatabase({ connection, connections, record });
  yield* setPrivateWorkspaceClock(database, () => CLOCK);

  // The secret filter the CLI installs, as the core policy composes it: the
  // guard is policy-neutral, and preservation at the wrapping site is what
  // lets the filtered journal still publish into this run.
  const guarded = preserveJournalProvenance(
    database.journal,
    guardDurableStream(database.journal, function* (event) {
      if (event.type === "yield") {
        gateCalls += 1;
      }
    }),
  );

  function* workflow(): Workflow<void> {
    // The run this process resumes already holds this effect's result, so it
    // replays. Executing it would mean the crash effect below is not the
    // first live work of the process, and the count says which happened.
    yield createWorkspaceEffect(
      database,
      { type: "workspace-proof", name: BASELINE_EFFECT },
      // deno-lint-ignore require-yield
      function* () {
        baselineExecutions += 1;
        return null;
      },
    );
    yield createWorkspaceEffect(
      database,
      { type: "workspace-proof", name: CRASH_EFFECT },
      function* (selected) {
        filesystem = selected;
        yield* selected.writeFile(CRASH_PATH, CRASH_CONTENT, 0o640);
        return null;
      },
    );
  }

  yield* withWorkspaceEffects(database, durableRun(workflow, { stream: guarded }));
  report({ ready: false, reason: "the crash effect committed" });
}

function* inspect(root: string, runId: string): Operation<void> {
  yield* useWorkflowRunStorage({ root });
  const opened = yield* WorkflowRunStorage.operations.lookup(runId);
  if (!opened.ok) {
    throw opened.error;
  }
  const database = opened.value;

  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    throw entries.error;
  }

  const observed = yield* transactWorkspaceRoots(database, function* (workspace) {
    return {
      currentRoot: yield* workspace.currentRoot(),
      tree: yield* readTree(workspace.filesystem, "/"),
    };
  });
  if (!observed.ok) {
    throw observed.error;
  }

  report({
    ...observed.value,
    events: entries.value.map((entry) => ({
      eventId: entry.eventId,
      name: entry.event.type === "yield" ? entry.event.description.name : undefined,
    })),
  });
}

main(function* () {
  // `process.argv` rather than `Deno.args`: this file is Deno-only to run, and
  // still has to typecheck under the Node project like every other source.
  const [mode, root, runId] = process.argv.slice(2);
  if (mode === "crash") {
    yield* crash(root, runId);
    return;
  }
  if (mode === "inspect") {
    yield* inspect(root, runId);
    return;
  }
  throw new Error(`the Workspace crash helper has no ${mode} mode`);
});
