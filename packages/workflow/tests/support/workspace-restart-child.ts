/**
 * A committed Workspace, and a second process that has never seen it.
 *
 * `commit` performs two real Workspace effects through the production Deno
 * provider and exits normally, so its connection, its DOFS wrapper and every
 * cache they held are gone before anything else looks. `restore` reopens the
 * same run and answers three questions the first process cannot: whether the
 * committed filesystem, root and journal come back; whether replay performs
 * the recorded effects a second time; and whether an event's historical root
 * still materializes exactly.
 *
 * ```sh
 * deno run -A workspace-restart-child.ts commit  <root> <run-id> <marker>
 * deno run -A workspace-restart-child.ts read    <root> <run-id> <marker>
 * deno run -A workspace-restart-child.ts restore <root> <run-id> <marker> <root-id>
 * ```
 *
 * Each effect appends its name to the marker file, so "did this run again" is
 * observable from outside the process rather than inferred from its output.
 */

import { appendFileSync } from "node:fs";
import process from "node:process";
import { durableRun, type Workflow } from "@executablemd/durable-streams";
import { main, type Operation } from "effection";
import { WorkflowRunStorage, type WorkflowRunDatabase } from "../../mod.ts";
import { useWorkflowRunStorage } from "../../deno.ts";
import {
  createWorkspaceProofEffect,
  withWorkspaceEffects,
} from "../../src/deno/workspace/effect.ts";
import {
  setPrivateWorkspaceClock,
  transactWorkspaceRoots,
} from "../../src/deno/workspace/private.ts";
import {
  HISTORICAL_CONTENT,
  HISTORICAL_PATH,
  readTree,
  report,
  REVISE_CLOCK,
  SEED_CLOCK,
} from "./workspace-process.ts";

const DEFINITION = {
  version: 1,
  kind: "git",
  objectFormat: "sha1",
  objectId: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  rootDocumentPath: "workflows/release.md",
} as const;

/**
 * Two effects, so there is a history to select from.
 *
 * The first builds every topology the root format describes: a directory with
 * its own mode, a file with its own mode, a hardlink and a symbolic link. The
 * second takes all of it apart again — overwrite, mode change, rename, two
 * deletions, a different symbolic link and a new directory. Nothing the first
 * effect wrote survives at the path it wrote it to, so restoring its root
 * cannot be satisfied by whatever happens to be live.
 */
function workflow(database: WorkflowRunDatabase, marker: string, clock: { now: number }) {
  return function* (): Workflow<void> {
    yield createWorkspaceProofEffect(
      database,
      { type: "workspace-proof", name: "seed" },
      function* (filesystem) {
        appendFileSync(marker, "seed\n");
        yield* filesystem.mkdir("/tree", { mode: 0o750 });
        yield* filesystem.writeFile(HISTORICAL_PATH, HISTORICAL_CONTENT, 0o640);
        yield* filesystem.link(HISTORICAL_PATH, "/tree/hardlink.txt");
        yield* filesystem.symlink("file.txt", "/tree/current.txt");
        return null;
      },
    );
    yield createWorkspaceProofEffect(
      database,
      { type: "workspace-proof", name: "revise" },
      function* (filesystem) {
        appendFileSync(marker, "revise\n");
        clock.now = REVISE_CLOCK;
        yield* filesystem.writeFile(HISTORICAL_PATH, "later bytes");
        yield* filesystem.chmod(HISTORICAL_PATH, 0o600);
        yield* filesystem.rename(HISTORICAL_PATH, "/renamed.txt");
        yield* filesystem.remove("/tree/hardlink.txt");
        yield* filesystem.remove("/tree/current.txt");
        yield* filesystem.symlink("/renamed.txt", "/latest.txt");
        yield* filesystem.mkdir("/later", { mode: 0o700 });
        return null;
      },
    );
  };
}

function* openRun(root: string, runId: string, create: boolean): Operation<WorkflowRunDatabase> {
  yield* useWorkflowRunStorage({ root });
  const opened = create
    ? yield* WorkflowRunStorage.operations.create({
        runId,
        definition: DEFINITION,
        base: "main",
        props: { channel: "stable" },
      })
    : yield* WorkflowRunStorage.operations.lookup(runId);
  if (!opened.ok) {
    throw opened.error;
  }
  return opened.value;
}

function* observe(database: WorkflowRunDatabase): Operation<Record<string, unknown>> {
  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    throw entries.error;
  }
  const state = yield* transactWorkspaceRoots(database, function* (workspace) {
    return {
      currentRoot: yield* workspace.currentRoot(),
      tree: yield* readTree(workspace.filesystem, "/"),
    };
  });
  if (!state.ok) {
    throw state.error;
  }
  return {
    ...state.value,
    events: entries.value.map((entry) => ({
      eventId: entry.eventId,
      name: entry.event.type === "yield" ? entry.event.description.name : undefined,
    })),
  };
}

function* run(
  root: string,
  runId: string,
  marker: string,
  create: boolean,
): Operation<WorkflowRunDatabase> {
  const database = yield* openRun(root, runId, create);
  const clock = { now: SEED_CLOCK };
  yield* setPrivateWorkspaceClock(database, () => clock.now);
  yield* withWorkspaceEffects(
    database,
    durableRun(workflow(database, marker, clock), { stream: database.journal }),
  );
  return database;
}

function* commit(root: string, runId: string, marker: string): Operation<void> {
  report(yield* observe(yield* run(root, runId, marker, true)));
}

/**
 * The same workflow, in a process that never ran it.
 *
 * Every effect is already in the journal, so replay must restore each result
 * without reaching the coordinator — and the marker file is what says whether
 * it did.
 */
function* read(root: string, runId: string, marker: string): Operation<void> {
  report(yield* observe(yield* run(root, runId, marker, false)));
}

function* restore(root: string, runId: string, marker: string, rootId: string): Operation<void> {
  const database = yield* run(root, runId, marker, false);
  const committed = yield* observe(database);

  const restored = yield* transactWorkspaceRoots(database, function* (workspace) {
    let absent: string | undefined;
    try {
      yield* workspace.filesystem.readTextFile(HISTORICAL_PATH);
    } catch (error) {
      absent = error instanceof Error ? error.name : "unknown";
    }

    const selected = yield* workspace.restore(rootId, { publish: true });
    const tree = yield* readTree(workspace.filesystem, "/");
    const resnapshot = yield* workspace.capture({ publish: true });
    return {
      absent,
      selectedRoot: selected.rootId,
      manifestHashes: selected.manifestHashes,
      blobHashes: selected.blobHashes,
      resnapshotRoot: resnapshot.rootId,
      currentRoot: yield* workspace.currentRoot(),
      tree,
    };
  });
  if (!restored.ok) {
    throw restored.error;
  }

  report({ committed, restored: restored.value });
}

main(function* () {
  const [mode, root, runId, marker, rootId] = process.argv.slice(2);
  if (mode === "commit") {
    yield* commit(root, runId, marker);
    return;
  }
  if (mode === "read") {
    yield* read(root, runId, marker);
    return;
  }
  if (mode === "restore") {
    yield* restore(root, runId, marker, rootId);
    return;
  }
  throw new Error(`the Workspace restart helper has no ${mode} mode`);
});
