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
import type { CommitDecision } from "./publication.ts";

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
  /**
   * Where a logical Workspace path sits in the accepted tree.
   *
   * Resolved on each call rather than closed over one directory, because
   * promotion replaces the tree: after it, this has to answer with the promoted
   * bytes. A path captured once would keep pointing at the Workspace the run
   * used to be at while the identity said otherwise.
   */
  at(logical: string): string;
}

/** One disposable place to make a mutation, and the way to keep it. */
export interface Attempt {
  readonly at: HostPath;
  /** What the attempt now describes, captured and checked locally. */
  capture(): Operation<CapturedWorkspace>;
  /**
   * Make this attempt the accepted materialization.
   *
   * It takes the owner's performed decision because that decision is the
   * authority: nothing else may promote, and a decision naming a different root
   * than this attempt captured is not this attempt's decision. Passing it is
   * the proof, which is why there is no argument-free way to do this — a
   * refusal, an ambiguous loss and a local failure all leave the caller with
   * nothing to pass.
   */
  promote(decision: CommitDecision): Operation<void>;
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
): Operation<AcceptedMaterialization> {
  return resource(function* (provide) {
    const root = yield* trees.create("accepted");
    yield* materializeWorkspaceRoot(files, reads, at(root), workspaceRootId, reject);
    let accepted = { root, workspaceRootId };
    yield* provide({
      get workspaceRootId(): string {
        return accepted.workspaceRootId;
      },
      at(logical: string): string {
        return at(accepted.root)(logical);
      },
      *replace(next: { root: string; workspaceRootId: string }): Operation<void> {
        const previous = accepted.root;
        accepted = next;
        // The tree the run used to be at is removed once nothing points at it.
        // Leaving it would keep a second copy of the Workspace on disk that
        // nothing can reach and nothing will clean up until the invocation ends.
        yield* trees.remove(previous);
      },
    });
  });
}

/**
 * The accepted materialization, plus the one operation that may move it.
 *
 * `replace` is not on `Materialization` because everything that merely reads
 * the Workspace should not be able to change which Workspace it is reading.
 * Only an attempt holding a performed decision reaches this.
 */
export interface AcceptedMaterialization extends Materialization {
  replace(next: { root: string; workspaceRootId: string }): Operation<void>;
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
  materialization: AcceptedMaterialization,
  reject: WorkspaceRejection,
): Operation<Attempt> {
  return resource(function* (provide) {
    const root = yield* trees.create("attempt");
    yield* materializeWorkspaceRoot(
      files,
      reads,
      at(root),
      materialization.workspaceRootId,
      reject,
    );

    let promoted = false;
    // Registered before the attempt is handed over, so every exit removes it —
    // including the ones that never reach the end of the calling scope.
    yield* ensure(function* () {
      if (!promoted) {
        yield* trees.remove(root);
      }
    });

    yield* provide({
      at: at(root),
      *capture(): Operation<CapturedWorkspace> {
        return yield* captureWorkspace(files, at(root), reject);
      },
      *promote(decision: CommitDecision): Operation<void> {
        if (promoted) {
          // One decision promotes one attempt once. A second promotion would be
          // moving the accepted tree somewhere it has already been moved from.
          reject("this attempt has already been promoted");
        }
        const captured = yield* captureWorkspace(files, at(root), reject);
        if (decision.workspaceRootId !== captured.root.rootId) {
          // The owner published something other than what this attempt holds.
          // Promoting would label these bytes with a root they are not.
          reject("the owner's decision names a root this attempt did not capture");
        }
        promoted = true;
        // The tree itself becomes the accepted one. Recording the identity
        // without moving the bytes would leave the invocation reading the
        // Workspace it used to be at under the name of the one it is now at.
        yield* materialization.replace({ root, workspaceRootId: captured.root.rootId });
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
function at(root: string): HostPath {
  return (logical) => (logical === "/" ? root : `${root}/${logical.slice(1)}`);
}
