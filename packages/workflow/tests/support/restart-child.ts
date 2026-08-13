/**
 * A whole workflow run, in a process of its own.
 *
 * A scope closing inside one process is not the same claim as a process
 * ending: the connection, the page cache and every value the first run put in
 * memory go away together only in the second. Two of the acceptances need
 * that, so both run here, through the production Deno adapter, and the test
 * observes them from outside.
 *
 * ```sh
 * deno run -A restart-child.ts <root> <run-id> <marker-file> [base]
 * ```
 *
 * The workflow performs one durable operation whose side effect is a line
 * appended to the marker file. Whether a second process appends a second line
 * is the restart question: a replay that re-executes a recorded operation
 * writes twice, and a replay that restores it writes once.
 *
 * `base` exists so two processes can race to create the same run id with
 * different immutable identity. One of them must win and the other must be
 * told it conflicts.
 *
 * A storage refusal is reported on standard output rather than thrown, because
 * the caller is comparing two processes' outcomes and a refusal is one of them.
 */

import { appendFileSync } from "node:fs";
import process from "node:process";
import { durableCall, durableRun } from "@executablemd/durable-streams";
import type { Workflow } from "@executablemd/durable-streams";
import { main } from "effection";
import { WorkflowLifecycle, WorkflowStorageError } from "../../mod.ts";
import { useWorkflowRunHost } from "../../deno.ts";

const DEFINITION = {
  version: 1,
  kind: "git",
  objectFormat: "sha1",
  objectId: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  rootDocumentPath: "workflows/release.md",
} as const;

/**
 * Three durable operations, so replay has an order to preserve.
 *
 * Each one's side effect is a line in the marker file, which is what makes
 * "did this run again" observable from outside the process.
 */
function work(marker: string): () => Workflow<string> {
  return function* (): Workflow<string> {
    const first = yield* durableCall("first", function* () {
      appendFileSync(marker, "first\n");
      return "one";
    });
    const second = yield* durableCall("second", function* () {
      appendFileSync(marker, "second\n");
      return "two";
    });
    const third = yield* durableCall("third", function* () {
      appendFileSync(marker, "third\n");
      return "three";
    });
    return [first, second, third].join(",");
  };
}

main(function* () {
  // `process.argv` rather than `Deno.args`: this file is Deno-only to run, and
  // still has to typecheck under the Node project like every other source.
  const [root, runId, marker, base = "main"] = process.argv.slice(2);

  // The whole host, because beginning a run is a lifecycle transition and the
  // lease is what authorizes it — here exactly as in production.
  const authority = yield* useWorkflowRunHost({ root });

  const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
  if (!acquired.ok) {
    throw acquired.error;
  }
  if (acquired.value.kind !== "acquired") {
    console.log(JSON.stringify({ refused: "already-running" }));
    return;
  }
  const { lease } = acquired.value;

  const opened = yield* authority.begin(lease, {
    runId,
    action: "start",
    creation: { definition: DEFINITION, base, props: { channel: "stable" } },
  });
  if (!opened.ok) {
    if (opened.error instanceof WorkflowStorageError) {
      console.log(JSON.stringify({ refused: opened.error.name }));
      return;
    }
    throw opened.error;
  }
  const { database, execution } = opened.value;

  const value = yield* durableRun(work(marker), { stream: database.journal });

  const settled = yield* authority.settle(lease, {
    executionId: execution.executionId,
    status: "completed",
  });
  if (!settled.ok) {
    throw settled.error;
  }

  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    throw entries.error;
  }

  console.log(
    JSON.stringify({
      value,
      base: database.record.base,
      // The record settlement returned, not the handle's snapshot from when the
      // execution began — that one still says `running`.
      status: settled.value.status,
      events: entries.value.map((entry) => ({
        eventId: entry.eventId,
        type: entry.event.type,
        name: entry.event.type === "yield" ? entry.event.description.name : undefined,
      })),
    }),
  );
});
