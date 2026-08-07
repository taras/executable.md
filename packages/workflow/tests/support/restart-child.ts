/**
 * The second process in the restart proof.
 *
 * A scope closing inside one process is not the same claim as a process
 * ending: the connection, the page cache and every value the first run put in
 * memory go away together only in the second. So the durable half of the
 * acceptance runs here, through the production Deno adapter, and the test
 * observes it from outside.
 *
 * ```sh
 * deno run -A restart-child.ts <root> <run-id> <marker-file>
 * ```
 *
 * The workflow performs one durable operation whose side effect is a line
 * appended to the marker file. Whether the second process appends a second
 * line is the whole question: a replay that re-executes a recorded operation
 * writes twice, and a replay that restores it writes once.
 */

import { appendFileSync } from "node:fs";
import { durableCall, durableRun } from "@executablemd/durable-streams";
import type { Workflow } from "@executablemd/durable-streams";
import { main } from "effection";
import { WorkflowRunStorage } from "../../mod.ts";
import { useWorkflowRunStorage } from "../../deno.ts";

const DEFINITION = {
  version: 1,
  kind: "git",
  objectFormat: "sha1",
  objectId: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  rootDocumentPath: "workflows/release.md",
} as const;

function work(marker: string): () => Workflow<string> {
  return function* (): Workflow<string> {
    return yield* durableCall("mark", function* () {
      appendFileSync(marker, "ran\n");
      return "marked";
    });
  };
}

main(function* () {
  const [root, runId, marker] = Deno.args;

  yield* useWorkflowRunStorage({ root });

  const opened = yield* WorkflowRunStorage.operations.create({
    runId,
    definition: DEFINITION,
    base: "main",
    props: { channel: "stable" },
  });
  if (!opened.ok) {
    throw opened.error;
  }
  const database = opened.value;

  const started = yield* database.beginDocumentExecution();
  if (!started.ok) {
    throw started.error;
  }

  const value = yield* durableRun(work(marker), { stream: database.journal });

  yield* database.finishDocumentExecution({
    executionId: started.value.executionId,
    status: "completed",
  });
  yield* database.updateRunState({ status: "completed" });

  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    throw entries.error;
  }

  console.log(
    JSON.stringify({
      value,
      status: database.record.status,
      events: entries.value.map((entry) => ({
        eventId: entry.eventId,
        type: entry.event.type,
        name: entry.event.type === "yield" ? entry.event.description.name : undefined,
      })),
    }),
  );
});
