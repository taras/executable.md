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
 * deno run -A restart-child.ts <root> <run-id> <marker-file> [channel]
 * ```
 *
 * The workflow performs one durable operation whose side effect is a line
 * appended to the marker file. Whether a second process appends a second line
 * is the restart question: a replay that re-executes a recorded operation
 * writes twice, and a replay that restores it writes once.
 *
 * `channel` exists so two processes can race to create the same run id on
 * different immutable terms. One of them must win and the other must be told
 * it conflicts.
 *
 * A storage refusal is reported on standard output rather than thrown, because
 * the caller is comparing two processes' outcomes and a refusal is one of them.
 */

import { appendFile } from "node:fs/promises";
import process from "node:process";
import { durableCall, durableRun } from "@executablemd/durable-streams";
import type { Workflow } from "@executablemd/durable-streams";
import { main, until } from "effection";
import { WorkflowLifecycle, WorkflowStorageError } from "../../mod.ts";
import { useWorkflowRunHost } from "../../deno.ts";

const ENTRYPOINT = "workflows/release.md";
const ENTRYPOINT_TEXT = "# Release\n";
const DEFINITION = {
  hashAlgorithm: "sha256",
  bundleHash: "e22b9d94280c8b07aac19569452576323e1662e729d36609f72fd8be44a74d6c",
  entrypoint: ENTRYPOINT,
  sources: [
    {
      path: ENTRYPOINT,
      sourceHash: "b78cd463c5885c1b595de07f665ce82b61df6636eb8c5f00cf11985cbfeb986d",
      byteLength: 10,
    },
  ],
} as const;

/** The snapshot those sources are; the create transition recomputes them. */
function snapshot(): { path: string; bytes: Uint8Array }[] {
  return [{ path: ENTRYPOINT, bytes: new TextEncoder().encode(ENTRYPOINT_TEXT) }];
}

/**
 * Three durable operations, so replay has an order to preserve.
 *
 * Each one's side effect is a line in the marker file, which is what makes
 * "did this run again" observable from outside the process.
 */
function work(marker: string): () => Workflow<string> {
  return function* (): Workflow<string> {
    const first = yield* durableCall("first", function* () {
      yield* until(appendFile(marker, "first\n"));
      return "one";
    });
    const second = yield* durableCall("second", function* () {
      yield* until(appendFile(marker, "second\n"));
      return "two";
    });
    const third = yield* durableCall("third", function* () {
      yield* until(appendFile(marker, "third\n"));
      return "three";
    });
    return [first, second, third].join(",");
  };
}

main(function* () {
  // `process.argv` rather than `Deno.args`: this file is Deno-only to run, and
  // still has to typecheck under the Node project like every other source.
  const [root, runId, marker, channel = "stable"] = process.argv.slice(2);

  // The whole host, because beginning a run is a lifecycle transition and the
  // executor lock is what authorizes it — here exactly as in production.
  const transitions = yield* useWorkflowRunHost({ root });

  const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
  if (!acquired.ok) {
    throw acquired.error;
  }
  if (acquired.value.kind !== "acquired") {
    console.log(JSON.stringify({ refused: "already-running" }));
    return;
  }
  const { lock: executorLock } = acquired.value;

  const opened = yield* transitions.begin(executorLock, {
    runId,
    action: "start",
    creation: { definition: DEFINITION, sourceSnapshot: snapshot(), props: { channel } },
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

  const settled = yield* transitions.settle(executorLock, {
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

  // What the winner's run was created on, so the caller can tell which of two
  // racing processes got there first.
  const record = database.record;

  console.log(
    JSON.stringify({
      value,
      // The record settlement returned, not the handle's snapshot from when the
      // execution began — that one still says `running`.
      status: settled.value.status,
      channel: record.props["channel"],
      events: entries.value.map((entry) => ({
        eventId: entry.eventId,
        type: entry.event.type,
        name: entry.event.type === "yield" ? entry.event.description.name : undefined,
      })),
    }),
  );
});
