/**
 * What a remote invocation owns on the runner, and when it lets go.
 *
 * Two trees, and the difference between them is the whole point. The
 * *materialization* is the accepted root: what the owner last confirmed this
 * run is at, restored so native tools can work in it. The *attempt* is where a
 * mutation actually happens, and it is disposable by construction — until the
 * owner performs the commit, nothing that happened in it has happened.
 *
 * Keeping them apart is what makes a documented failure ordinary. A Workspace
 * effect that fails is a fact the run records against the root it started from,
 * so the attempt is thrown away and the accepted tree is still exactly what the
 * owner confirmed. Working directly in the accepted tree would mean a failed
 * effect had already changed the only local copy of the run's Workspace, and
 * the next attempt would start somewhere nobody chose.
 *
 * Both are Effection resources, so their lifetimes are their scopes'. Normal
 * return, a raised failure, cancellation, a refusal from the owner and a lost
 * response all leave nothing behind, because none of them skips teardown. Only
 * a performed owner answer promotes an attempt, and promotion is a decision
 * this module is told about rather than one it infers.
 */

import { ensure, type Operation, resource } from "effection";
import type { WorkspaceRejection } from "../workspace/root-manifest.ts";
import {
  captureWorkspace,
  type CapturedWorkspace,
  type HostPath,
  materializeWorkspaceRoot,
  type RunnerFiles,
} from "./materialize.ts";
import type { RemoteReadLink } from "./read.ts";

/** A directory this invocation owns for as long as it needs one. */
export interface TemporaryTrees {
  /** A fresh empty directory, removed when the calling scope ends. */
  create(purpose: string): Operation<string>;
  /** Remove one, before its scope would. */
  remove(path: string): Operation<void>;
}

/** The accepted local copy of the root the owner last confirmed. */
export interface Materialization {
  /** The root this tree is, as the owner confirmed it. */
  readonly workspaceRootId: string;
  /** Where a logical Workspace path sits in this tree. */
  readonly at: HostPath;
  /**
   * Record which root this tree now is.
   *
   * Called by a promoted attempt and by nothing else. It moves no bytes: the
   * attempt did that, and this says what they are.
   */
  accept(workspaceRootId: string): void;
}

/** One disposable place to make a mutation, and the way to keep it. */
export interface Attempt {
  readonly at: HostPath;
  /** What the attempt now describes, captured and checked locally. */
  capture(): Operation<CapturedWorkspace>;
  /**
   * Make this attempt the accepted materialization.
   *
   * Called only after the owner reports the commit performed. Anything else —
   * a refusal, a lost response, a local failure — leaves the accepted tree
   * where it was, because until the owner says otherwise the run is still at
   * the root it started from.
   */
  promote(): Operation<void>;
}

/**
 * Restore the admitted root into a tree this invocation owns.
 *
 * The tree is created, filled and proved before anything else runs against it:
 * `materializeWorkspaceRoot` refuses a host that cannot reproduce the retained
 * modes, times or topology, so an invocation either has the Workspace the owner
 * described or does not start.
 */
export function useMaterialization(
  files: RunnerFiles,
  trees: TemporaryTrees,
  reads: RemoteReadLink,
  workspaceRootId: string,
  reject: WorkspaceRejection,
): Operation<Materialization> {
  return resource(function* (provide) {
    const root = yield* trees.create("accepted");
    const at: HostPath = (logical) => join(root, logical);
    yield* materializeWorkspaceRoot(files, reads, at, workspaceRootId, reject);
    let accepted = workspaceRootId;
    yield* provide({
      get workspaceRootId(): string {
        return accepted;
      },
      at,
      accept(next: string): void {
        accepted = next;
      },
    });
  });
}

/**
 * A disposable copy of the accepted tree, for one mutation.
 *
 * Materialized from the owner rather than copied from the accepted tree: the
 * owner's copy is the one that is authoritative, and reading it again is how an
 * attempt starts from what the run actually is rather than from whatever the
 * last attempt happened to leave behind.
 */
export function useAttempt(
  files: RunnerFiles,
  trees: TemporaryTrees,
  reads: RemoteReadLink,
  materialization: Materialization,
  reject: WorkspaceRejection,
): Operation<Attempt> {
  return resource(function* (provide) {
    const root = yield* trees.create("attempt");
    const at: HostPath = (logical) => join(root, logical);
    yield* materializeWorkspaceRoot(files, reads, at, materialization.workspaceRootId, reject);

    let promoted = false;
    // Registered before the attempt is handed over, so every exit removes it —
    // including the ones that never reach the end of the calling scope.
    yield* ensure(function* () {
      if (!promoted) {
        yield* trees.remove(root);
      }
    });

    yield* provide({
      at,
      *capture(): Operation<CapturedWorkspace> {
        return yield* captureWorkspace(files, at, reject);
      },
      *promote(): Operation<void> {
        const captured = yield* captureWorkspace(files, at, reject);
        promoted = true;
        materialization.accept(captured.root.rootId);
      },
    });
  });
}

/**
 * One logical Workspace path under a host directory.
 *
 * Kept here rather than imported from a path module because it is the only
 * place the two vocabularies meet, and because a shared module may not name a
 * host's path conventions. The logical root is `/` and everything under it is
 * relative to the tree this invocation was given.
 */
function join(root: string, logical: string): string {
  return logical === "/" ? root : `${root}/${logical.slice(1)}`;
}
