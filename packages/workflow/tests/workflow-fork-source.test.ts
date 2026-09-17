/**
 * Tier WFK — admitting a fork of a retained source bundle.
 *
 * Deno-only, and deliberately its own file: every case here takes the run's
 * executor lock, which `packages/workflow/src/deno/advisory-lock.ts` reaches
 * through the `Deno` global. The provider-neutral half of the same contract —
 * forkability and fork selection, which opens no database — stays in
 * `workflow-fork.test.ts` and runs under all three runtimes.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  forkRunRecordEvent,
  LegacyWorkflowSourceReaderUnavailableError,
  WorkflowLifecycle,
  WorkflowRequestError,
} from "@executablemd/workflow";
import type { ExecutorLock } from "@executablemd/workflow";
import type { WorkflowExecutionBegun, WorkflowExecutionTransitions } from "../deno.ts";
import { useWorkflowRunConnections } from "../src/deno/connections.ts";
import { SavepointObservation } from "../src/deno/savepoints.ts";
import { installWorkflowRunStorage } from "../src/deno/provider.ts";
import { installWorkflowLifecycle } from "../src/deno/lifecycle.ts";
import { legacySourceReader } from "./support/legacy-source.ts";
import {
  BUNDLE_ENTRYPOINT,
  BUNDLE_SOURCE,
  creation,
  runPath,
  SHA1,
  sourceBundleCreation,
  storedBytes,
  tamper,
  useStorageRoot,
  withExecutor,
  withExecutorRun,
  withRunHost,
} from "./support/storage.ts";
import { DatabaseSync } from "node:sqlite";
import { workflowForkStaging } from "../deno.ts";

/** One retained yield, as the journal holds it. */
function retained(type: string, name = type, result: Json = null): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name },
    result: { status: "ok", value: result },
  };
}

describe("Tier WFK — a source-bundle fork", () => {
  /** One settled source run, and the checkpoint a fork of it may select. */
  function* useForkSource(
    root: string,
    transitions: WorkflowExecutionTransitions,
  ): Operation<{ checkpointEventId: string; rootImport: DurableEvent }> {
    const creation = yield* sourceBundleCreation();
    return yield* withExecutorRun(
      transitions,
      { runId: "fork-source", action: "start", creation },
      function* (begun, executorLock) {
        const rootImport: DurableEvent = {
          type: "yield",
          coroutineId: "root",
          description: { type: "import_component", name: "__root__" },
          result: { status: "ok", value: { source: BUNDLE_SOURCE } },
        };
        yield* begun.database.journal.append(
          forkRunRecordEvent({
            runId: "fork-source",
            definitionVersion: 2,
            bundleHash: creation.definition.bundleHash,
          }),
        );
        yield* begun.database.journal.append(rootImport);
        yield* begun.database.journal.append(retained("checkpoint"));

        const entries = yield* begun.database.readJournalEntries();
        if (!entries.ok) {
          throw entries.error;
        }
        const last = entries.value.at(-1);
        if (last === undefined) {
          throw new Error("the source run retained no checkpoint");
        }
        const settled = yield* transitions.settle(executorLock, {
          executionId: begun.execution.executionId,
          status: "suspended",
        });
        if (!settled.ok) {
          throw settled.error;
        }
        void root;
        return { checkpointEventId: last.eventId, rootImport };
      },
    );
  }

  it("WFK40: a fork is admitted from its own bytes, and retains its own copy", function* () {
    const root = yield* useStorageRoot();
    const candidate = yield* sourceBundleCreation({ content: "# Forked\n\nits own bytes\n" });

    yield* withRunHost(root, function* (transitions) {
      const source = yield* useForkSource(root, transitions);
      const forked = yield* withExecutor("fork-destination", function* (executorLock) {
        return yield* transitions.fork(executorLock, {
          runId: "fork-destination",
          selection: { sourceRunId: "fork-source", checkpointEventId: source.checkpointEventId },
          creation: candidate,
          rootImport: source.rootImport,
        });
      });
      if (!forked.ok) {
        throw forked.error;
      }

      // The fork's own definition, and the closure it returns is the one its
      // store now holds rather than the buffers the caller supplied.
      expect(forked.value.record.definition.kind).toBe("source-bundle");
      const sources = forked.value.sources;
      expect(sources.definitionVersion).toBe(2);
      if (sources.definitionVersion !== 2) {
        throw new Error("expected a source bundle");
      }
      expect(new TextDecoder().decode(sources.sources[0]?.bytes)).toBe(
        "# Forked\n\nits own bytes\n",
      );
      expect(sources.definition.bundleHash).toBe(candidate.definition.bundleHash);
      expect(sources.definition.bundleHash).not.toBe(
        (yield* sourceBundleCreation()).definition.bundleHash,
      );
    });

    // Its schema is version 2, with the source store beside it.
    tamper(runPath(root, "fork-destination"), (database) => {
      expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
      const stored = database.prepare("SELECT content FROM workflow_definition_blob").get();
      expect(new TextDecoder().decode(storedBytes(stored, "content"))).toBe(
        "# Forked\n\nits own bytes\n",
      );
    });
  });

  it("WFK41: a candidate snapshot that is not its descriptor's leaves no fork", function* () {
    const root = yield* useStorageRoot();
    const honest = yield* sourceBundleCreation();
    const lying = {
      ...honest,
      sourceSnapshot: [
        { path: BUNDLE_ENTRYPOINT, bytes: new TextEncoder().encode("# Something else\n") },
      ],
    };

    yield* withRunHost(root, function* (transitions) {
      const source = yield* useForkSource(root, transitions);
      const refused = yield* withExecutor("fork-lying", function* (executorLock) {
        return yield* transitions.fork(executorLock, {
          runId: "fork-lying",
          selection: { sourceRunId: "fork-source", checkpointEventId: source.checkpointEventId },
          creation: lying,
          rootImport: source.rootImport,
        });
      });

      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error).toBeInstanceOf(WorkflowRequestError);
      const found = yield* WorkflowLifecycle.operations.inspect("fork-lying");
      expect(found.ok).toBe(false);
    });
  });

  it("WFK42: a staged fork retains the candidate's own bytes, discoverable by nobody", function* () {
    const root = yield* useStorageRoot();
    const staging = "# Staged\n\nthe candidate's own bytes\n";
    const candidate = yield* sourceBundleCreation({ content: staging });

    yield* withRunHost(root, function* (transitions) {
      const source = yield* useForkSource(root, transitions);
      const staged = yield* transitions.stageFork({
        runId: "fork-staged",
        selection: { sourceRunId: "fork-source", checkpointEventId: source.checkpointEventId },
        creation: candidate,
        rootImport: source.rootImport,
      });
      if (!staged.ok) {
        throw staged.error;
      }
      expect(staged.value.record.definition.kind).toBe("source-bundle");

      // What it assembled, read out of the staging file while the resource that
      // owns it is still alive. The kind alone would be satisfied by a staging
      // copy that retained some other document; the bytes are what a
      // compatibility replay would actually run.
      const database = new DatabaseSync(workflowForkStaging(root, "fork-staged"), {
        readOnly: true,
      });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
        const blob = database.prepare("SELECT content FROM workflow_definition_blob").get();
        expect(new TextDecoder().decode(storedBytes(blob, "content"))).toBe(staging);

        const manifest = database
          .prepare("SELECT path FROM workflow_definition_source")
          .all()
          .map((row) => row["path"]);
        expect(manifest).toEqual([BUNDLE_ENTRYPOINT]);
      } finally {
        database.close();
      }

      // And none of it is a run: staging assembles a Workspace to replay
      // against, not a destination a host would find.
      const found = yield* WorkflowLifecycle.operations.inspect("fork-staged");
      expect(found.ok).toBe(false);
    });
  });

  it("WFK43: every v1 admission is reader-gated, and leaves no destination", function* () {
    const root = yield* useStorageRoot();

    yield* scoped(function* () {
      const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
      yield* installWorkflowRunStorage({ root }, {}, connections);
      // A host with the reader, so a version-1 source run can exist to fork.
      const capable = yield* installWorkflowLifecycle(
        { root, legacySource: legacySourceReader() },
        connections,
      );
      const source = yield* withExecutorRun(
        capable,
        { runId: "git-source", action: "start", creation: creation() },
        function* (begun, executorLock) {
          const rootImport: DurableEvent = {
            type: "yield",
            coroutineId: "root",
            description: { type: "import_component", name: "__root__" },
            result: { status: "ok", value: { source: "# Release\n" } },
          };
          yield* begun.database.journal.append(
            forkRunRecordEvent({ runId: "git-source", base: "main", pinnedCommit: SHA1 }),
          );
          yield* begun.database.journal.append(rootImport);
          yield* begun.database.journal.append(retained("checkpoint"));
          const entries = yield* begun.database.readJournalEntries();
          if (!entries.ok) {
            throw entries.error;
          }
          const last = entries.value.at(-1);
          if (last === undefined) {
            throw new Error("the source run retained no checkpoint");
          }
          const settled = yield* transitionsSettle(capable, executorLock, begun);
          void settled;
          return { checkpointEventId: last.eventId, rootImport };
        },
      );

      // And a second host over the same storage with no reader at all.
      const blind = yield* installWorkflowLifecycle({ root }, connections);
      const request = {
        selection: { sourceRunId: "git-source", checkpointEventId: source.checkpointEventId },
        creation: creation(),
        rootImport: source.rootImport,
      };

      const resumed = yield* withExecutor("git-source", function* (executorLock) {
        return yield* blind.begin(executorLock, { runId: "git-source", action: "resume" });
      });
      expect(resumed.ok).toBe(false);
      expect(!resumed.ok && resumed.error).toBeInstanceOf(
        LegacyWorkflowSourceReaderUnavailableError,
      );

      const forked = yield* withExecutor("git-fork", function* (executorLock) {
        return yield* blind.fork(executorLock, { ...request, runId: "git-fork" });
      });
      expect(forked.ok).toBe(false);
      expect(!forked.ok && forked.error).toBeInstanceOf(LegacyWorkflowSourceReaderUnavailableError);

      const staged = yield* blind.stageFork({ ...request, runId: "git-staged" });
      expect(staged.ok).toBe(false);
      expect(!staged.ok && staged.error).toBeInstanceOf(LegacyWorkflowSourceReaderUnavailableError);

      // None of the three left a destination anything recognizes, and the
      // source run is exactly as it was.
      for (const runId of ["git-fork", "git-staged"]) {
        const found = yield* WorkflowLifecycle.operations.inspect(runId);
        expect({ runId, found: found.ok }).toEqual({ runId, found: false });
      }
      const intact = yield* WorkflowLifecycle.operations.inspect("git-source");
      expect(intact.ok).toBe(true);
    });
  });
});

/** Settle one begun execution, so a source run stops before it is forked. */
function* transitionsSettle(
  transitions: WorkflowExecutionTransitions,
  executorLock: ExecutorLock,
  begun: WorkflowExecutionBegun,
): Operation<void> {
  const settled = yield* transitions.settle(executorLock, {
    executionId: begun.execution.executionId,
    status: "suspended",
  });
  if (!settled.ok) {
    throw settled.error;
  }
}
