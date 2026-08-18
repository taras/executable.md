/**
 * The two processes a Git crash proof needs, and neither of them is the test.
 *
 * A `<Git.Switch>` mutates a retained checkout, publishes a Workspace root and
 * appends its journal result inside one transaction. Whether those commit
 * together is decided by what happens when nothing gets to run: `SIGKILL`
 * performs no cleanup, no commit and no rollback, and the next connection to
 * open the database recovers the interrupted transaction to the last committed
 * state.
 *
 * ```sh
 * deno run -A git-crash-child.ts crash <root> <run-id> <locator>
 * deno run -A git-crash-child.ts inspect <root> <run-id>
 * ```
 *
 * `crash` runs a document that retains a Repository — which commits — and then
 * switches its branch, stopping inside the still-open switch transaction with
 * the imported checkout, the published root and the routed journal row all
 * written and none of them committed. It reports what that connection can see
 * and waits to be killed.
 *
 * That stopping point is the connection registry's construction-time routed
 * append hook, which only a caller that builds the registry can install, so
 * `crash` assembles the same adapter modules the Deno provider installs rather
 * than calling `useWorkflowRunStorage`. `inspect` has no such need and uses the
 * provider itself.
 */

import process from "node:process";
import { collect, execute, inlineSource } from "@executablemd/core";
import { ensure, main, type Operation, scoped, suspend } from "effection";
import { WorkflowRunStorage } from "../../mod.ts";
import { useWorkflowRunStorage, workflowRunPath } from "../../deno.ts";
import { createWorkflowRunConnections } from "../../src/deno/connections.ts";
import { openWorkflowRunDatabase, readRunRow } from "../../src/deno/database.ts";
import { useJournalRouting } from "../../src/deno/journal-route.ts";
import { readTransaction } from "../../src/deno/reading.ts";
import { verifySchema } from "../../src/deno/schema.ts";
import { WORKSPACE_GIT_SWITCH } from "../../src/deno/composition/provider.ts";
import { useWorkspaceEffects } from "../../src/deno/workspace/effect.ts";
import { withWorkflowWorkspace } from "../../src/deno/workspace/host.ts";
import { currentWorkspaceRoot } from "../../src/deno/workspace/root.ts";
import { transactWorkspaceRoots, usePrivateWorkspace } from "../../src/deno/workspace/private.ts";
import { count, report } from "./workspace-process.ts";
import { crashDocument } from "./git-crash-process.ts";

function* crash(root: string, runId: string, locator: string): Operation<void> {
  const path = workflowRunPath(root, runId);

  const connections = createWorkflowRunConnections(() => {}, {
    *afterRoutedJournalAppend(_database, event): Operation<void> {
      if (event.type !== "yield" || event.description.type !== WORKSPACE_GIT_SWITCH) {
        return;
      }
      // Every read below is on the connection that opened the transaction, so
      // it sees that transaction's own uncommitted writes. Nothing else can.
      const sqlite = connection.database;
      report({
        ready: true,
        currentRoot: currentWorkspaceRoot(sqlite, path),
        journalRows: count(
          sqlite.prepare("SELECT COUNT(*) AS count FROM journal_events").get()?.["count"],
        ),
        switchRows: count(
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM journal_events WHERE record LIKE ?")
            .get(`%"type":"${WORKSPACE_GIT_SWITCH}"%`)?.["count"],
        ),
      });
      // Deno leaves when its event loop is empty, and a suspended Effection
      // task is not on it. A timer nothing clears is what keeps this process
      // and its open transaction alive until the signal arrives.
      setInterval(() => {}, 1_000);
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

  yield* withWorkflowWorkspace(
    database,
    scoped(function* () {
      return yield* collect(
        yield* execute({ ...inlineSource(crashDocument(locator)), stream: database.journal }),
      );
    }),
  );
  report({ ready: false, reason: "the switch committed" });
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
    const [repository] = workspace.metadata.readRepositories();
    return {
      currentRoot: yield* workspace.currentRoot(),
      repositories: workspace.metadata.readRepositories().length,
      which:
        repository === undefined
          ? undefined
          : yield* workspace.filesystem.readTextFile(`${repository.record.checkoutPath}/which.txt`),
    };
  });
  if (!observed.ok) {
    throw observed.error;
  }

  report({
    ...observed.value,
    types: entries.value.map((entry) =>
      entry.event.type === "yield" ? entry.event.description.type : entry.event.type,
    ),
  });
}

main(function* () {
  // `process.argv` rather than `Deno.args`: this file is Deno-only to run, and
  // still has to typecheck under the Node project like every other source.
  const [mode, root, runId, locator] = process.argv.slice(2);
  if (mode === "crash") {
    yield* crash(root, runId, locator);
    return;
  }
  if (mode === "inspect") {
    yield* inspect(root, runId);
    return;
  }
  throw new Error(`the Git crash helper has no ${mode} mode`);
});
