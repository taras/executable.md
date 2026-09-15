/**
 * Tier WFK — what a fork may inherit, decided before anything exists.
 *
 * Two questions, both answered from retained values alone: whether a checkpoint
 * can be forked at all, and which events a fork that selects it takes with it.
 * Neither opens a database, so both are exercised here against retained shapes
 * a run could hold rather than against a run that had to be produced.
 *
 * The blockers are the reason this tier is not folded into the CLI's: an Agent
 * turn and an effect a later build wrote are histories this build cannot
 * produce on purpose, and a test that waited for one would assert nothing on
 * the days it did not arrive. The Git-host pair is here for the opposite
 * reason — both sides of that boundary can be stated exactly — and Tier WFF
 * proves them end to end against a real `<Git.Push>`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import {
  classifyForkability,
  forkJournal,
  isRootImportEvent,
  isRunRecordEvent,
  selectForkPrefix,
} from "@executablemd/workflow";
import type { ForkCandidate } from "@executablemd/workflow";
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

const ROOT_A = "a".repeat(64);
const ROOT_B = "b".repeat(64);

function retained(type: string, name = type, result: Json = null): DurableEvent {
  return {
    type: "yield",
    coroutineId: "root",
    description: { type, name },
    result: { status: "ok", value: result },
  };
}

function closed(coroutineId: string): DurableEvent {
  return { type: "close", coroutineId, result: { status: "ok", value: null } };
}

/** One history, classified against the roots the run still holds. */
function classify(
  events: readonly { id: string; event: DurableEvent; root?: string }[],
  retainedRoots: readonly string[] = [ROOT_A, ROOT_B],
) {
  return classifyForkability(
    events.map((entry) => ({
      eventId: entry.id,
      event: entry.event,
      workspaceRootId: entry.root ?? ROOT_A,
    })),
    { retainedRoots: new Set(retainedRoots) },
  );
}

/** The same history, as fork selection reads it. */
function candidates(
  events: readonly { id: string; event: DurableEvent; root?: string }[],
): ForkCandidate[] {
  const forkability = classify(events);
  return events.map((entry, index) => ({
    eventId: entry.id,
    event: entry.event,
    workspaceRootId: entry.root ?? ROOT_A,
    forkability: forkability[index] ?? { forkable: false, blockers: [] },
  }));
}

const RUN_RECORD = retained("workflow_run", "workflow_run", {
  runId: "source-1",
  base: "main",
  pinnedCommit: "abc",
});
const ROOT_IMPORT = retained("import_component", "__root__", {
  kind: "repository",
  path: "flows/release.md",
  content: "# Release\n",
});

describe("Tier WFK — forkability and fork selection", () => {
  it("WFK1: a history of inheritable effects is forkable at every event", function* () {
    const forkability = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: ROOT_IMPORT },
      { id: "e3", event: retained("workspace_file", "write:x:/notes.md"), root: ROOT_B },
      { id: "e4", event: retained("exec", "exec:echo hi"), root: ROOT_B },
      { id: "e5", event: closed("root"), root: ROOT_B },
    ]);

    expect(forkability.map((entry) => entry.forkable)).toEqual([true, true, true, true, true]);
    // Empty exactly when forkable, which is the shape the CLI contract states.
    expect(forkability.every((entry) => entry.blockers.length === 0)).toBe(true);
  });

  it("WFK2: a blocker is cumulative and names the earliest event that introduced it", function* () {
    const forkability = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: retained("agent_prompt", "prompt:1") },
      { id: "e3", event: retained("exec", "exec:echo hi") },
      { id: "e4", event: retained("agent_prompt", "prompt:2") },
    ]);

    expect(forkability[0]?.forkable).toBe(true);
    for (const entry of forkability.slice(1)) {
      expect(entry.forkable).toBe(false);
      // The second Agent turn adds no second blocker: the code is already
      // introduced, and it names the turn that introduced it.
      expect(entry.blockers).toEqual([{ code: "agent-state-unavailable", eventId: "e2" }]);
    }
  });

  it("WFK3: each stable code has its own retained cause", function* () {
    const forkability = classify(
      [
        { id: "e1", event: RUN_RECORD },
        // A Git-host event holding no completed reconciliation record: the run
        // stopped without establishing what happened at the remote.
        { id: "e2", event: retained("git_host_effect", "git-push:1") },
        { id: "e3", event: retained("something_a_later_build_wrote", "whatever") },
        { id: "e4", event: retained("exec", "exec:echo hi"), root: "c".repeat(64) },
      ],
      [ROOT_A],
    );

    expect(forkability[1]?.blockers).toEqual([
      { code: "external-state-unavailable", eventId: "e2" },
    ]);
    expect(forkability[2]?.blockers).toEqual([
      { code: "external-state-unavailable", eventId: "e2" },
      { code: "unsupported-effect", eventId: "e3" },
    ]);
    expect(forkability[3]?.blockers).toEqual([
      { code: "external-state-unavailable", eventId: "e2" },
      { code: "unsupported-effect", eventId: "e3" },
      { code: "workspace-root-unavailable", eventId: "e4" },
    ]);
    // Codes and event ids, and nothing a retained description held.
    for (const entry of forkability) {
      for (const blocker of entry.blockers) {
        expect(JSON.stringify(blocker)).not.toContain("git-push");
        expect(JSON.stringify(blocker)).not.toContain("whatever");
      }
    }
  });

  it("WFK3b: a completed Git-host record is inherited, not refused", function* () {
    // What decides a Git-host event is what the history holds about it, not its
    // type. A completed reconciliation record carries the pre-state, the
    // observations, the decision and the result, and replays without
    // contacting a provider at all.
    const completed = retained("git_host_effect", "git-push:1", {
      request: {
        identity: { runId: "source-1", expansionId: "x" },
        kind: "git-push",
        inputs: { remote: "origin" },
        naturalKey: { destinationRef: "refs/heads/publish/1" },
      },
      preState: { remoteCommit: null },
      observations: { remoteCommit: "abc" },
      decision: "performed",
      result: { remoteCommit: "abc" },
    });

    const forkability = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: completed },
      { id: "e3", event: retained("exec", "exec:echo hi") },
    ]);

    expect(forkability.map((entry) => entry.forkable)).toEqual([true, true, true]);
    expect(forkability.every((entry) => entry.blockers.length === 0)).toBe(true);

    // A record that is nearly one is still not one: a member the shape does not
    // declare describes something else, and a fork does not guess at it.
    const nearly = retained("git_host_effect", "git-push:2", {
      request: {
        identity: { runId: "source-1", expansionId: "y" },
        kind: "git-push",
        inputs: {},
        naturalKey: {},
      },
      preState: null,
      observations: null,
      decision: "performed",
      result: null,
      extra: "a member this shape does not declare",
    });
    const refused = classify([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: nearly },
    ]);
    expect(refused[1]?.blockers).toEqual([{ code: "external-state-unavailable", eventId: "e2" }]);
  });

  it("WFK4: selection takes the prefix and leaves the two records a fork writes", function* () {
    const history = candidates([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: ROOT_IMPORT },
      { id: "e3", event: retained("import_component", "File") },
      { id: "e4", event: retained("workspace_file", "write:x:/notes.md"), root: ROOT_B },
      { id: "e5", event: retained("exec", "exec:echo hi"), root: ROOT_B },
      { id: "e6", event: closed("root"), root: ROOT_B },
    ]);

    const selected = selectForkPrefix(history, "e4");
    expect(selected.ok).toBe(true);
    if (!selected.ok) {
      return;
    }
    expect(selected.value.inherited.map((entry) => entry.eventId)).toEqual(["e3", "e4"]);
    expect(selected.value.checkpointWorkspaceRootId).toBe(ROOT_B);

    // The fork's journal is its own two records and then what it inherited.
    const journal = forkJournal(
      { runId: "fork-1", base: "main", pinnedCommit: "def" },
      ROOT_IMPORT,
      selected.value,
    );
    expect(journal).toHaveLength(4);
    expect(isRunRecordEvent(journal[0] as DurableEvent)).toBe(true);
    expect(isRootImportEvent(journal[1] as DurableEvent)).toBe(true);
    expect(journal[2]).toEqual(history[2]?.event);
    expect(journal[3]).toEqual(history[3]?.event);
  });

  it("WFK5: a checkpoint nobody retained, an outcome and a blocked prefix are refused", function* () {
    const history = candidates([
      { id: "e1", event: RUN_RECORD },
      { id: "e2", event: ROOT_IMPORT },
      { id: "e3", event: retained("agent_prompt", "prompt:1") },
      { id: "e4", event: closed("root") },
    ]);

    const missing = selectForkPrefix(history, "nowhere");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.message).toContain("nowhere");
    }

    const outcome = selectForkPrefix(history, "e4");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("canonical outcome");
    }

    const blocked = selectForkPrefix(history, "e3");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      // The stable code, and the event that introduced it.
      expect(blocked.error.message).toContain("agent-state-unavailable");
      expect(blocked.error.message).toContain("e3");
      expect(blocked.error.message).not.toContain("prompt:1");
    }
  });
});

/**
 * Tier WFK — admitting a fork of a retained source bundle.
 *
 * A fork's candidate is its own definition, so a version-2 fork is created from
 * its own exact bytes exactly as a version-2 start is: the snapshot is copied
 * and held to the descriptor before the destination exists, and what the fork
 * retains afterwards is the store's copy rather than the caller's array.
 *
 * The same reader gate applies to every version-1 lifecycle admission. `begin`,
 * `fork` and the private staging path each obtain and validate the Markdown a
 * Git definition names before they write, so a host that cannot obtain it
 * leaves no destination behind at all.
 */
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
