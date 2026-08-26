/**
 * Tier XE — sealing one committed frontier as a portable artifact.
 *
 * Real runs, a real executor lock, a real file. What is under test is the seam
 * between a run and the container: that a frontier is chosen only while nothing
 * can append underneath it, that the source is not touched, that a closure
 * belonging to some other definition is refused, and that every refusal leaves
 * no artifact behind.
 *
 * What the container does with the snapshot afterwards is #602's suite, and is
 * not re-proved here.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { ensureDir, exists, writeTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { readXmdArtifact } from "../src/deno/artifact/mod.ts";
import type {
  VerifiedXmdArtifact,
  XmdArtifactDefinitionClosure,
  XmdArtifactDefinitionComponent,
} from "../src/deno/artifact/types.ts";
import { Err, Ok, scoped } from "effection";
import type { Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import { WorkflowLifecycle } from "../mod.ts";
import type { WorkflowDefinition, WorkflowRunDatabase } from "../mod.ts";
import type { WorkflowDefinitionSourceReader } from "../src/deno/artifact/source.ts";
import { installWorkflowLifecycle } from "../src/deno/lifecycle.ts";
import type { WorkflowExecutionTransitions } from "../deno.ts";
import { installWorkflowRunStorage } from "../src/deno/provider.ts";
import { useWorkflowRunConnections } from "../src/deno/connections.ts";
import { SavepointObservation } from "../src/deno/savepoints.ts";
import { transactWorkspaceRoots } from "../src/deno/workspace/private.ts";
import { parseWorkspaceManifest } from "../src/deno/workspace/manifest.ts";
import type { WorkspaceRootEntry } from "../src/deno/workspace/manifest.ts";
import { WorkflowRequestError } from "../src/storage/errors.ts";
import { gitBlobId } from "./support/artifact-fixture.ts";
import { runDocument } from "./support/composition.ts";
import { git, gitOutput, useBareRemote } from "./support/git-remotes.ts";
import { creation, definition, SHA1, useStorageRoot, withExecutorRun } from "./support/storage.ts";

const ROOT_DOCUMENT = "# Release\n\nnothing to see here\n";

/** The closure the fixture run's definition names, authenticated as #600 would. */
function closure(): XmdArtifactDefinitionClosure {
  return {
    root: {
      objectFormat: "sha1",
      pinnedCommit: SHA1,
      rootDocumentPath: "workflows/release.md",
      blobId: gitBlobId(ROOT_DOCUMENT),
      content: ROOT_DOCUMENT,
    },
    components: [],
  };
}

/**
 * Export through the provider-neutral surface.
 *
 * `forged` is offered on the request the way a caller holding the contextual
 * lifecycle name would offer it. The request declares no such member, and the
 * point of passing it anyway is that it reaches nothing: what gets sealed is
 * whatever the host's installed reader returns.
 */
function* exportRun(runId: string, stagingPath: string, forged?: XmdArtifactDefinitionClosure) {
  return yield* WorkflowLifecycle.operations.export({
    runId,
    stagingPath,
    ...(forged === undefined ? {} : { closure: forged }),
  });
}

/** The reader a host installs: it returns this run's real retained source. */
// deno-lint-ignore require-yield
function* honestSource(): Operation<Result<XmdArtifactDefinitionClosure>> {
  return Ok(closure());
}

/**
 * Storage and lifecycle, with the source reader this host installs.
 *
 * The reader is an installation argument, so a test that wants a different one
 * installs a different host — which is the only way to change it, and the point
 * of the boundary.
 */
function withExportHost<T>(
  root: string,
  source: WorkflowDefinitionSourceReader | undefined,
  body: (transitions: WorkflowExecutionTransitions) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const connections = yield* useWorkflowRunConnections(yield* SavepointObservation.get());
    yield* installWorkflowRunStorage({ root }, {}, connections);
    const transitions = yield* installWorkflowLifecycle(
      { root, ...(source === undefined ? {} : { definitionSource: source }) },
      connections,
    );
    return yield* body(transitions);
  });
}

/** One settled run, and the storage root it lives in. */
function useSettledRun(runId = "release-1.4"): Operation<string> {
  return (function* () {
    const root = yield* useStorageRoot();
    yield* withExportHost(root, honestSource, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId, action: "start", creation: creation({ definition: definition() }) },
        function* (begun, executorLock) {
          const settled = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "completed",
          });
          if (!settled.ok) {
            throw settled.error;
          }
        },
      );
    });
    return root;
  })();
}

describe("exporting a workflow run", () => {
  it("XE1 refuses while an executor holds the run, and writes nothing", function* () {
    const root = yield* useStorageRoot();
    const target = join(root, "busy.xmd");

    // A host that is configured correctly, so the refusal under test is the
    // live executor rather than a missing reader.
    yield* withExportHost(root, honestSource, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId: "release-1.4", action: "start", creation: creation() },
        function* () {
          // Inside the hold: the run has an executor right now, so it has no
          // settled frontier to choose.
          const refused = yield* exportRun("release-1.4", target);
          expect(refused.ok).toBe(false);
          expect(refused.ok ? "" : refused.error.name).toBe("WorkflowExportBusyError");
        },
      );
    });

    expect(yield* exists(target)).toBe(false);
  });

  it("XE2 seals a settled frontier and leaves the run as it was", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "evidence.xmd");

    const sealed = yield* withExportHost(root, honestSource, function* () {
      return yield* exportRun("release-1.4", target);
    });
    if (!sealed.ok) {
      throw sealed.error;
    }

    expect(sealed.value.stagingPath).toBe(target);
    expect(sealed.value.frontier.sourceRunId).toBe("release-1.4");
    expect(sealed.value.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.value.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    // Two different questions, and never the same answer by accident.
    expect(sealed.value.fileSha256).not.toBe(sealed.value.identity);

    // The artifact opens as one a stranger could open.
    const opened = yield* readXmdArtifact(target);
    if (!opened.ok) {
      throw opened.error;
    }
    expect(opened.value.identity).toBe(sealed.value.identity);
    expect(opened.value.run.runId).toBe("release-1.4");
    expect(opened.value.run.status).toBe("completed");
    expect(opened.value.definition.root.content).toBe(ROOT_DOCUMENT);
    expect(opened.value.frontier).toEqual(sealed.value.frontier);

    // The run is still there, still readable, and still says what it said.
    const after = yield* withExportHost(root, honestSource, function* () {
      return yield* WorkflowLifecycle.operations.inspect("release-1.4");
    });
    if (!after.ok) {
      throw after.error;
    }
    expect(after.value.record.status).toBe("completed");
  });

  it("XE3 refuses source the host read back that is not this run's", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "wrong-source.xmd");
    const other = closure();

    // deno-lint-ignore require-yield
    const wrongRun: WorkflowDefinitionSourceReader = function* () {
      return Ok({ ...other, root: { ...other.root, rootDocumentPath: "workflows/other.md" } });
    };
    const refused = yield* withExportHost(root, wrongRun, function* () {
      return yield* exportRun("release-1.4", target);
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.name).toBe("WorkflowRequestError");
    expect(yield* exists(target)).toBe(false);
  });

  it("XE4 seals the host's source, not a closure offered on the request", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "forged.xmd");

    // Every descriptor field the run retains, arbitrary Markdown, and the blob
    // id that Markdown really hashes to — internally consistent, and offered
    // the way anything holding the contextual lifecycle name could offer it.
    const forged = closure();
    const lie = "# Not what ran\n\nthis document never executed\n";
    const sealed = yield* withExportHost(root, honestSource, function* () {
      return yield* exportRun("release-1.4", target, {
        ...forged,
        root: { ...forged.root, blobId: gitBlobId(lie), content: lie },
      });
    });
    if (!sealed.ok) {
      throw sealed.error;
    }

    const opened = yield* readXmdArtifact(target);
    if (!opened.ok) {
      throw opened.error;
    }
    // The request reached nothing: what was sealed is what the host read.
    expect(opened.value.definition.root.content).toBe(ROOT_DOCUMENT);
    expect(opened.value.definition.root.content).not.toBe(lie);
  });

  it("XE5 refuses to export at all when the host installed no reader", function* () {
    const root = yield* useSettledRun();
    const target = join(root, "no-reader.xmd");

    const refused = yield* withExportHost(root, undefined, function* () {
      return yield* exportRun("release-1.4", target);
    });

    expect(refused.ok).toBe(false);
    expect(yield* exists(target)).toBe(false);
  });

  it("XE6 refuses an absent run without inventing one", function* () {
    const root = yield* useStorageRoot();
    const target = join(root, "absent.xmd");

    const refused = yield* withExportHost(root, honestSource, function* () {
      return yield* exportRun("no-such-run", target);
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.name).toBe("WorkflowRunNotFoundError");
    expect(yield* exists(target)).toBe(false);
  });
});

/**
 * Tier XE — one representative run, sealed and read back family by family.
 *
 * The cases above hold the seam between a run and the container still. This one
 * holds what the *selection* put in: a run that really executed, exported
 * through the same lifecycle operation the command calls, opened as a stranger
 * would open it, and compared against what the run actually produced — not
 * against a snapshot handed to the writer, which would prove the container and
 * say nothing about what an export chooses to carry.
 *
 * So every comparison below has a source outside the artifact. The Workspace is
 * compared against the run's own live filesystem, walked path by path. The
 * definition is compared against the objects Git holds. The Repository and
 * Worktree rows are compared against the remote the run cloned and the commit
 * its own history records making. The retained history is compared against the
 * journal the run committed.
 *
 * The awkward cases are deliberate: several Workspace roots rather than one, a
 * committed symbolic link, a non-default file mode, one declared component the
 * run never expanded, and two paths holding identical bytes — which is content
 * the store shares and *not* a hard link, a distinction a summary would lose.
 */

/** The declared component this run is closed over and never reaches. */
const UNEXPANDED = "never expanded\n";

/**
 * What the representative run does, as the document that is also its definition.
 *
 * The bytes committed at `flows/rich.md` and the bytes executed are one string,
 * so "the artifact carries the document that ran" is a comparison rather than
 * an arrangement.
 */
function richDocument(locator: string): string {
  return [
    "# Rich",
    "",
    `<Repository name="project" url="${locator}">`,
    '<Git.Switch branch="work/1" />',
    '<File path="notes.md">rich evidence</File>',
    '<Git.Add paths="notes.md" />',
    '<Git.Commit message="notes" as="commit" />',
    '<Worktree name="review" branch="review/1" as="review" />',
    "</Repository>",
    "",
  ].join("\n");
}

/** One committed object, as the repository holds it. */
interface CommittedSource {
  readonly path: string;
  readonly content: string;
  readonly blobId: string;
}

/** The repository a run's definition names, and the objects it pins. */
interface DefinitionRepository {
  readonly path: string;
  readonly commit: string;
  readonly root: CommittedSource;
  readonly unexpanded: CommittedSource;
}

/** One object read back out of a commit, by identity and by bytes. */
function committed(repository: string, commit: string, path: string): CommittedSource {
  return {
    path,
    // Untrimmed: the trailing newline is part of the document.
    content: gitOutput(["cat-file", "blob", `${commit}:${path}`], repository, repository),
    blobId: git(["rev-parse", `${commit}:${path}`], repository, repository),
  };
}

/** A real repository holding the root document and one component beside it. */
function useDefinitionRepository(source: string): Operation<DefinitionRepository> {
  return (function* () {
    const path = yield* useTempDirectory("xmd-export-definition-");
    yield* ensureDir(join(path, "flows"));
    yield* writeTextFile(join(path, "flows/rich.md"), source);
    yield* writeTextFile(join(path, "flows/Unused.md"), UNEXPANDED);
    git(["init", "--initial-branch=main"], path, path);
    git(["add", "--all", "--", "."], path, path);
    git(["commit", "--message", "definition"], path, path);
    const commit = git(["rev-parse", "HEAD"], path, path);
    return {
      path,
      commit,
      root: committed(path, commit, "flows/rich.md"),
      unexpanded: committed(path, commit, "flows/Unused.md"),
    };
  })();
}

/**
 * The host's reader, reading this run's definition back out of Git.
 *
 * Authenticated the way a host authenticates: the component's object id is
 * taken from the commit and compared with the identity the definition retains,
 * and a source that is not the one the definition names is refused rather than
 * carried. The root's own identity is derived from the bytes that came back,
 * because a definition pins a commit and a path and never the document's hash.
 */
function repositorySource(repository: DefinitionRepository): WorkflowDefinitionSourceReader {
  // deno-lint-ignore require-yield
  return function* (retained: WorkflowDefinition) {
    const root = committed(repository.path, retained.objectId, retained.rootDocumentPath);
    const components: XmdArtifactDefinitionComponent[] = [];
    for (const declared of retained.components ?? []) {
      const source = committed(repository.path, retained.objectId, declared.path);
      if (source.blobId !== declared.sourceHash) {
        return Err(
          new WorkflowRequestError(
            `the component "${declared.name}" is no longer the object this run's definition names.`,
          ),
        );
      }
      components.push({
        name: declared.name,
        path: declared.path,
        blobId: source.blobId,
        content: source.content,
      });
    }
    return Ok({
      root: {
        objectFormat: retained.objectFormat,
        pinnedCommit: retained.objectId,
        rootDocumentPath: retained.rootDocumentPath,
        ...(retained.targetPath === undefined ? {} : { targetPath: retained.targetPath }),
        blobId: gitBlobId(root.content),
        content: root.content,
      },
      components,
    });
  };
}

/** One node of a Workspace, as either side of the comparison describes it. */
interface WorkspaceNode {
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly size?: number;
  readonly target?: string;
}

/**
 * Every path the run's live Workspace holds, read through its own filesystem.
 *
 * The independent side of the Workspace comparison. This walks DOFS directly —
 * `lstat`, `readlink`, `readFile` — rather than reading the retained root
 * manifests, which is the reader an export already uses: comparing a manifest
 * against itself would agree however wrong both were.
 */
function* observeWorkspace(
  database: WorkflowRunDatabase,
): Operation<{ nodes: Map<string, WorkspaceNode>; bytes: Map<string, string> }> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    const nodes = new Map<string, WorkspaceNode>();
    const bytes = new Map<string, string>();
    const walk = function* (current: string): Operation<void> {
      for (const entry of yield* workspace.filesystem.readdir(current)) {
        const child = current === "/" ? `/${entry.name}` : `${current}/${entry.name}`;
        const stat = yield* workspace.filesystem.lstat(child);
        if (entry.kind === "directory") {
          nodes.set(child, { kind: "directory", mode: stat.mode });
          yield* walk(child);
          continue;
        }
        if (entry.kind === "symlink") {
          nodes.set(child, {
            kind: "symlink",
            mode: stat.mode,
            target: yield* workspace.filesystem.readlink(child),
          });
          continue;
        }
        nodes.set(child, { kind: "file", mode: stat.mode, size: stat.size });
        bytes.set(child, base64(yield* workspace.filesystem.readFile(child)));
      }
    };
    yield* walk("/");
    return { nodes, bytes };
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

function base64(content: Uint8Array): string {
  return Buffer.from(content).toString("base64");
}

/** The same description, taken from one retained Workspace root of an artifact. */
function artifactWorkspace(
  artifact: VerifiedXmdArtifact,
  rootId: string,
): { nodes: Map<string, WorkspaceNode>; entries: WorkspaceRootEntry[] } {
  const root = artifact.roots.find((candidate) => candidate.rootId === rootId);
  if (root === undefined) {
    throw new Error(`the artifact holds no Workspace root ${rootId}`);
  }
  // Parsed by the same canonical parser a live run holds its roots to, so a
  // manifest that survived transport but stopped being one fails here.
  const entries = parseWorkspaceManifest(root.manifest, "the sealed artifact").entries;
  const nodes = new Map<string, WorkspaceNode>();
  for (const entry of entries) {
    if (entry.path === "/") {
      continue;
    }
    nodes.set(
      entry.path,
      entry.kind === "file"
        ? { kind: "file", mode: entry.mode, size: entry.size }
        : entry.kind === "symlink"
          ? { kind: "symlink", mode: entry.mode, target: entry.target }
          : { kind: "directory", mode: entry.mode },
    );
  }
  return { nodes, entries };
}

/** One retained effect's durable description type, in journal order. */
function effectTypes(events: readonly DurableEvent[]): string[] {
  return events
    .filter((event) => event.type === "yield")
    .map((event) => String(event.description.type))
    .filter((type) => type.startsWith("workspace_"));
}

/** What the run's own history says one effect retained. */
function retainedRecord(events: readonly DurableEvent[], type: string): Record<string, unknown> {
  const event = events.find((entry) => entry.type === "yield" && entry.description.type === type);
  if (event === undefined || event.result.status !== "ok") {
    throw new Error(`the run journaled no successful ${type}`);
  }
  return Object(Reflect.get(Object(event.result.value), "record"));
}

describe("exporting a run that really ran", () => {
  it("XE7 seals every retained family of one representative run", function* () {
    const store = yield* useStorageRoot();
    // A remote with the entries a summary would lose: a committed symbolic
    // link and a file whose executable bit is content as far as Git is
    // concerned.
    const remote = yield* useBareRemote({
      commits: [
        {
          message: "seed",
          entries: [
            { path: "docs/a.md", content: "alpha\n" },
            { path: "tool.sh", content: "#!/bin/sh\necho hi\n", mode: 0o755 },
            { path: "link.md", symlink: "docs/a.md" },
          ],
        },
      ],
    });
    const source = richDocument(remote.locator);
    const repository = yield* useDefinitionRepository(source);
    const retained = definition({
      objectId: repository.commit,
      rootDocumentPath: repository.root.path,
      components: [
        {
          name: "Unused",
          path: repository.unexpanded.path,
          sourceHash: repository.unexpanded.blobId,
        },
      ],
    });

    const target = join(store, "representative.xmd");
    let live: { nodes: Map<string, WorkspaceNode>; bytes: Map<string, string> } | undefined;
    let history: DurableEvent[] = [];

    yield* withExportHost(store, repositorySource(repository), function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId: "rich-1", action: "start", creation: creation({ definition: retained }) },
        function* (begun, executorLock) {
          yield* runDocument(begun.database, source);
          // Taken while the run is still open, because these are the only
          // values in this test that do not come out of the artifact.
          live = yield* observeWorkspace(begun.database);
          history = yield* begun.database.journal.readAll();
          const settled = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "completed",
          });
          if (!settled.ok) {
            throw settled.error;
          }
        },
      );
    });

    const sealed = yield* withExportHost(store, repositorySource(repository), function* () {
      return yield* WorkflowLifecycle.operations.export({ runId: "rich-1", stagingPath: target });
    });
    if (!sealed.ok) {
      throw sealed.error;
    }
    const opened = yield* readXmdArtifact(target);
    if (!opened.ok) {
      throw opened.error;
    }
    const artifact = opened.value;
    const observed = live;
    if (observed === undefined) {
      throw new Error("the representative run produced no Workspace observation");
    }

    // The run itself, and the one execution that produced it.
    expect(artifact.run.runId).toBe("rich-1");
    expect(artifact.run.status).toBe("completed");
    expect(artifact.executions).toHaveLength(1);

    // --- Retained history --------------------------------------------------
    // Six Workspace effects, in the order the document writes them. Asserted
    // before the state they produced, so a run that silently did less than the
    // document says fails here rather than passing a thinner comparison.
    expect(effectTypes(history)).toEqual([
      "workspace_repository",
      "workspace_git_switch",
      "workspace_file",
      "workspace_git_add",
      "workspace_git_commit",
      "workspace_worktree",
    ]);
    // Every committed row, byte for byte, as the run wrote it.
    expect(artifact.journal.map((row) => JSON.parse(row.record))).toEqual(history);
    expect(artifact.frontier.sourceRunId).toBe("rich-1");
    expect(artifact.frontier.finalEventId).toBe(artifact.journal.at(-1)?.eventId);
    // The component the definition declares is nowhere in what ran.
    expect(artifact.journal.some((row) => row.record.includes("Unused"))).toBe(false);

    // --- Multiple Workspace roots -----------------------------------------
    const rootIds = artifact.roots.map((root) => root.rootId);
    expect(new Set(rootIds).size).toBe(rootIds.length);
    expect(rootIds.length).toBeGreaterThan(1);
    expect(rootIds).toContain(artifact.frontier.currentWorkspaceRootId);
    // Every root the history refers to travelled with it, and the history
    // really does refer to more than one.
    const referenced = new Set(artifact.journal.map((row) => row.workspaceRootId));
    expect(referenced.size).toBeGreaterThan(1);
    for (const rootId of referenced) {
      expect(rootIds).toContain(rootId);
    }

    // --- File bytes, mode, symlink and hardlink state ---------------------
    const current = artifactWorkspace(artifact, artifact.frontier.currentWorkspaceRootId);
    // Whole tree, path by path: kind, mode and link target for every node the
    // run's own filesystem holds.
    expect(current.nodes).toEqual(observed.nodes);

    const checkout = artifact.repositories[0]?.checkoutPath ?? "";
    const worktree = artifact.worktrees[0]?.checkoutPath ?? "";
    expect(current.nodes.get(`${checkout}/notes.md`)).toEqual({
      kind: "file",
      mode: 0o644,
      size: "rich evidence".length,
    });
    // The executable bit came from the commit and survived the clone, the
    // Workspace and the container.
    expect(current.nodes.get(`${checkout}/tool.sh`)?.mode).toBe(0o755);
    expect(current.nodes.get(`${checkout}/link.md`)).toEqual({
      kind: "symlink",
      mode: 0o777,
      target: "docs/a.md",
    });

    // Hard links: this run makes none, and the artifact says so on every file
    // rather than inferring one from shared content. The two `notes.md` copies
    // hold identical bytes and are still two files — the content store shares,
    // the manifest does not.
    const files = current.entries.filter((entry) => entry.kind === "file");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((entry) => entry.kind === "file" && entry.hardlink === null)).toBe(true);
    expect(observed.bytes.get(`${checkout}/notes.md`)).toBe(
      observed.bytes.get(`${worktree}/notes.md`),
    );

    // Bytes: every file the live Workspace holds is in the artifact's content
    // store, exactly.
    const stored = new Set(artifact.blobs.map((blob) => base64(blob.content)));
    for (const [path, content] of observed.bytes) {
      expect([path, stored.has(content)]).toEqual([path, true]);
    }
    expect(observed.bytes.get(`${checkout}/notes.md`)).toBe(
      Buffer.from("rich evidence").toString("base64"),
    );

    // --- Repository and Worktree ------------------------------------------
    expect(artifact.repositories).toHaveLength(1);
    expect(artifact.repositories[0]).toMatchObject({
      name: "project",
      locator: remote.locator,
      requestedBase: null,
      primaryBranch: "main",
      objectFormat: "sha1",
      // The commit the remote actually had when the run cloned it.
      creationCommit: remote.heads.get("main"),
    });
    expect(artifact.worktrees).toHaveLength(1);
    expect(artifact.worktrees[0]).toMatchObject({
      repositoryName: "project",
      name: "review",
      requestedBranch: "review/1",
      requestedBase: null,
      // The commit this run's own history records making, a moment earlier.
      creationCommit: retainedRecord(history, "workspace_git_commit")["commit"],
    });
    expect(artifact.worktrees[0]?.checkoutPath).toBe(
      retainedRecord(history, "workspace_worktree")["checkoutPath"],
    );

    // --- The definition, and the component nothing expanded ---------------
    expect(artifact.definition.root).toEqual({
      objectFormat: "sha1",
      pinnedCommit: repository.commit,
      rootDocumentPath: "flows/rich.md",
      blobId: repository.root.blobId,
      content: source,
    });
    // The bytes that were sealed are the bytes that executed.
    expect(artifact.definition.root.content).toBe(source);
    expect(artifact.definition.components).toEqual([
      {
        name: "Unused",
        path: "flows/Unused.md",
        blobId: repository.unexpanded.blobId,
        content: UNEXPANDED,
      },
    ]);
  });
});
