/**
 * The harness the Repository/Worktree suites drive.
 *
 * A run here is a real `node:sqlite` WorkflowRun database, a real DOFS
 * Workspace and real `git`, because what is under test is what survives in one
 * and what native Git wrote into the other. The only substitutions are the two
 * leaf host dependencies — the Git subprocess and the temporary directory —
 * and they are substituted only where a suite needs to count invocations, hold
 * one open, or make one fail.
 */

import { scoped, type Operation } from "effection";
import { lstat, readTextFile, writeTextFile } from "@effectionx/fs";
import { pathToFileURL } from "node:url";
import { until } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { GitComposition } from "../../src/composition/git-api.ts";
import { collect, execute, inlineSource } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../../mod.ts";
import { withWorkflowWorkspace } from "../../src/deno/workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "../../src/deno/workspace/host.ts";
import {
  WORKSPACE_GIT_ADD,
  WORKSPACE_GIT_SWITCH,
  WORKSPACE_REPOSITORY,
  WORKSPACE_WORKTREE,
} from "../../src/deno/composition/provider.ts";
import { denoRepositoryHost } from "../../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../../src/deno/composition/host.ts";
import { transactWorkspaceRoots } from "../../src/deno/workspace/private.ts";
import {
  exportTree,
  importTree,
  localizeAdministration,
} from "../../src/deno/composition/materialize.ts";
import type { StoredRepository } from "../../src/deno/workspace/repositories.ts";
import type { WorktreeRecord } from "../../src/composition/records.ts";

/** What one execution did, at the boundaries a claim can be made about. */
export interface CompositionCounters {
  /** Every Git command, in order, as its argument list. */
  readonly commands: string[][];
  /** Every materialization root acquired, so a suite can prove each is gone. */
  readonly roots: string[];
  /** Durable composition effects the provider began. */
  readonly effects: string[];
  /** Ephemeral attachments the provider performed. */
  readonly attachments: string[];
}

export interface CountingHost {
  readonly host: RepositoryHost;
  readonly counters: CompositionCounters;
}

/**
 * The production host, counted.
 *
 * A decorator rather than a stand-in: every command really runs, so a suite
 * that asserts "no Git ran" is asserting about the same code path that would
 * have run it.
 */
export function countingHost(inner: RepositoryHost = denoRepositoryHost()): CountingHost {
  const counters: CompositionCounters = {
    commands: [],
    roots: [],
    effects: [],
    attachments: [],
  };
  return {
    counters,
    host: {
      git(invocation: GitInvocation): Operation<GitOutcome> {
        counters.commands.push([...invocation.args]);
        return inner.git(invocation);
      },
      *useDirectory(): Operation<string> {
        const directory = yield* inner.useDirectory();
        counters.roots.push(directory);
        return directory;
      },
    },
  };
}

export function countingOptions(counting: CountingHost): WorkflowWorkspaceOptions {
  return {
    composition: {
      host: counting.host,
      observe: {
        effect: (kind, name) => counting.counters.effects.push(`${kind}:${name}`),
        attachment: (kind, name) => counting.counters.attachments.push(`${kind}:${name}`),
      },
    },
  };
}

/** Execute `source` as this run's root document with the Workspace attached. */
export function runDocument(
  database: WorkflowRunDatabase,
  source: string,
  options: WorkflowWorkspaceOptions = {},
): Operation<Json> {
  return scoped(function* () {
    return yield* withWorkflowWorkspace(
      database,
      scoped(function* () {
        return yield* collect(
          yield* execute({ ...inlineSource(source), stream: database.journal }),
        );
      }),
      options,
    );
  });
}

/** What an operation threw, so a suite can assert on it rather than fail. */
export function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The failure of this kind somewhere in this one's causes. */
export function causedBy<T>(
  error: unknown,
  is: (candidate: unknown) => candidate is T,
): T | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (is(current)) {
      return current;
    }
    if (current instanceof Error) {
      queue.push(current.cause);
      if (current instanceof AggregateError) {
        queue.push(...current.errors);
      }
    }
  }
  return undefined;
}

export function* compositionEvents(database: WorkflowRunDatabase): Operation<DurableEvent[]> {
  const events = yield* database.journal.readAll();
  return events.filter(
    (event) =>
      event.type === "yield" &&
      (event.description.type === WORKSPACE_REPOSITORY ||
        event.description.type === WORKSPACE_WORKTREE),
  );
}

/** Every Git operation event this run journaled, in order. */
export function* gitEvents(database: WorkflowRunDatabase): Operation<DurableEvent[]> {
  const events = yield* database.journal.readAll();
  return events.filter(
    (event) =>
      event.type === "yield" &&
      (event.description.type === WORKSPACE_GIT_SWITCH ||
        event.description.type === WORKSPACE_GIT_ADD),
  );
}

/** What one Git operation settled as, and what it retained when it settled `ok`. */
export interface GitOutcomeRecord {
  readonly status: string;
  readonly name: string;
  readonly message: string;
  readonly record: unknown;
}

export function* gitOutcomes(database: WorkflowRunDatabase): Operation<GitOutcomeRecord[]> {
  return (yield* gitEvents(database)).map((event) => {
    const result = Object(Reflect.get(event, "result"));
    const error = Object(Reflect.get(result, "error"));
    return {
      status: String(Reflect.get(result, "status")),
      name: String(Reflect.get(error, "name") ?? ""),
      message: String(Reflect.get(error, "message") ?? ""),
      record: Reflect.get(Object(Reflect.get(result, "value")), "record"),
    };
  });
}

export function* retainedRepositories(
  database: WorkflowRunDatabase,
): Operation<StoredRepository[]> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    return workspace.metadata.readRepositories();
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

export function* retainedWorktrees(
  database: WorkflowRunDatabase,
  repositoryName: string,
): Operation<WorktreeRecord[]> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    return workspace.metadata.readWorktreesForRepository(repositoryName);
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

/** What the Workspace holds at one path, as text. */
export function* workspaceText(database: WorkflowRunDatabase, path: string): Operation<string> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    return yield* workspace.filesystem.readTextFile(path);
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

export interface WorkspaceEntryInfo {
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly target?: string;
}

/** What the Workspace holds at one path, without following a link. */
export function* workspaceEntry(
  database: WorkflowRunDatabase,
  path: string,
): Operation<WorkspaceEntryInfo> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    const info = yield* workspace.filesystem.lstat(path);
    if (info.kind === "symlink") {
      return {
        kind: info.kind,
        mode: info.mode,
        target: yield* workspace.filesystem.readlink(path),
      };
    }
    return { kind: info.kind, mode: info.mode };
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

/** Every regular file beneath one Workspace path, with its bytes. */
export function* workspaceTree(
  database: WorkflowRunDatabase,
  path: string,
): Operation<Map<string, Uint8Array>> {
  const read = yield* transactWorkspaceRoots(database, function* (workspace) {
    const found = new Map<string, Uint8Array>();
    const walk = function* (current: string): Operation<void> {
      for (const entry of yield* workspace.filesystem.readdir(current)) {
        const child = `${current}/${entry.name}`;
        if (entry.kind === "directory") {
          yield* walk(child);
          continue;
        }
        if (entry.kind === "file") {
          found.set(child, yield* workspace.filesystem.readFile(child));
        }
      }
    };
    yield* walk(path);
    return found;
  });
  if (!read.ok) {
    throw read.error;
  }
  return read.value;
}

/**
 * What the index of one retained checkout holds staged, as native Git reads it.
 *
 * The direct observation a staging claim needs. Index trees say *that* something
 * changed; this says *what*, by exporting the retained family into a disposable
 * host tree — the same way the provider does — and asking Git.
 */
export function* stagedPaths(
  database: WorkflowRunDatabase,
  workspacePath: string,
): Operation<string[]> {
  return yield* scoped(function* () {
    const host = denoRepositoryHost();
    const root = yield* host.useDirectory();
    const exported = yield* transactWorkspaceRoots(database, function* (workspace) {
      const [repository] = workspace.metadata.readRepositories();
      if (repository === undefined) {
        throw new Error("the run retains no repository to read an index from");
      }
      const repositoryDirectory = yield* exportTree(
        workspace.filesystem,
        root,
        repository.record.checkoutPath,
        "inspection",
      );
      const worktrees: string[] = [];
      for (const worktree of workspace.metadata.readWorktreesForRepository(
        repository.record.name,
      )) {
        worktrees.push(
          yield* exportTree(workspace.filesystem, root, worktree.checkoutPath, "inspection"),
        );
      }
      yield* localizeAdministration(root, repositoryDirectory, worktrees, "inspection");
      return `${root}${workspacePath}`;
    });
    if (!exported.ok) {
      throw exported.error;
    }
    const outcome = yield* host.git({
      args: ["diff", "--cached", "--name-only"],
      cwd: exported.value,
      home: root,
    });
    if (outcome.code !== 0) {
      throw new Error(`git diff --cached exited ${outcome.code}: ${outcome.stderr}`);
    }
    return outcome.stdout.split("\n").filter((line) => line !== "");
  });
}

export interface LoadedGitApi {
  GitComposition: typeof GitComposition;
}

function loadedGitApi(value: unknown): value is LoadedGitApi {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "GitComposition") === "object"
  );
}

/**
 * A second physical module holding the same Api name.
 *
 * Only the Api module is copied. Its imports are rewritten to the originals, so
 * what differs between the two is module identity and nothing else — which is
 * exactly the variable under test.
 */
export function* physicalGitApiCopy(): Operation<LoadedGitApi> {
  // The shared fixture rather than the runtime's own temporary-directory API:
  // this file only *runs* under Deno, and it is typechecked under the Node
  // project like every other source here.
  const directory = yield* useTempDirectory("xmd-git-api-copy-");
  const source = new URL("../../src/composition/", import.meta.url);
  const text = (yield* readTextFile(new URL("git-api.ts", source)))
    .replace('"./errors.ts"', JSON.stringify(new URL("errors.ts", source).href))
    .replace('"./git-records.ts"', JSON.stringify(new URL("git-records.ts", source).href));
  const destination = pathToFileURL(`${directory}/git-api.ts`);
  yield* writeTextFile(destination, text);
  const loaded = yield* until(import(destination.href));
  if (!loadedGitApi(loaded)) {
    throw new Error("the physical Git Api copy did not export its Api");
  }
  return loaded;
}

/** Whether every materialization this run acquired has been removed. */
export function* survivingRoots(counters: CompositionCounters): Operation<string[]> {
  const surviving: string[] = [];
  for (const root of counters.roots) {
    try {
      yield* lstat(root);
      surviving.push(root);
    } catch {
      // Gone, which is what every caller is asserting.
    }
  }
  return surviving;
}

/** The Git subcommands this run ran, in order. */
export function subcommands(counters: CompositionCounters): string[] {
  return counters.commands.map((command) => command[0] ?? "");
}

/**
 * Put what a host directory holds at one Workspace path, and publish the result.
 *
 * The test-only storage fixture the substitution suites need. It reaches past
 * every component to make the authoritative filesystem hold something the run
 * never put there — a valid checkout of a different repository, say — while the
 * metadata and the journal keep saying what they always said. No supported
 * operation can produce that state, which is exactly why attachment has to be
 * able to notice it.
 */
export function* replaceWorkspaceTree(
  database: WorkflowRunDatabase,
  hostRoot: string,
  workspacePath: string,
): Operation<void> {
  const replaced = yield* transactWorkspaceRoots(database, function* (workspace) {
    yield* importTree(workspace.filesystem, hostRoot, workspacePath);
    const captured = yield* workspace.capture();
    yield* workspace.publish(captured.rootId);
  });
  if (!replaced.ok) {
    throw replaced.error;
  }
}

/**
 * Replace one Workspace path with a symbolic link, and publish the result.
 *
 * The other test-only storage fixture. A checkout root is always a directory
 * when this provider writes one, so the only way to reach the indirection case
 * is to write the link past every component — which is what a tampered or
 * hand-built database would hold.
 */
export function* linkWorkspacePath(
  database: WorkflowRunDatabase,
  target: string,
  workspacePath: string,
): Operation<void> {
  const linked = yield* transactWorkspaceRoots(database, function* (workspace) {
    yield* workspace.filesystem.remove(workspacePath, { recursive: true, force: true });
    yield* workspace.filesystem.symlink(target, workspacePath);
    const captured = yield* workspace.capture();
    yield* workspace.publish(captured.rootId);
  });
  if (!linked.ok) {
    throw linked.error;
  }
}

/**
 * Write arbitrary bytes to one Workspace path, and publish the result.
 *
 * The third test-only storage fixture. Git's control plane is written by Git,
 * so the only way to retain a pointer Git would never have produced is to write
 * it past every component.
 */
export function* writeWorkspaceFile(
  database: WorkflowRunDatabase,
  workspacePath: string,
  content: string,
): Operation<void> {
  const written = yield* transactWorkspaceRoots(database, function* (workspace) {
    yield* workspace.filesystem.remove(workspacePath, { recursive: true, force: true });
    yield* workspace.filesystem.writeFile(workspacePath, content);
    const captured = yield* workspace.capture();
    yield* workspace.publish(captured.rootId);
  });
  if (!written.ok) {
    throw written.error;
  }
}

/**
 * Remove one path from the Workspace and publish the result.
 *
 * A test-only storage fixture: it reaches past every component to make the
 * authoritative filesystem disagree with what the run recorded, which is the
 * only way to reach the stale-state condition without waiting for a disk to
 * fail.
 */
export function* removeWorkspacePath(database: WorkflowRunDatabase, path: string): Operation<void> {
  const removed = yield* transactWorkspaceRoots(database, function* (workspace) {
    yield* workspace.filesystem.remove(path, { recursive: true, force: true });
    const captured = yield* workspace.capture();
    yield* workspace.publish(captured.rootId);
  });
  if (!removed.ok) {
    throw removed.error;
  }
}
