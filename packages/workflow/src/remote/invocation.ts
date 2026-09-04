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
import type { CommitDecision, ProposedContent, RetainedMapping } from "./publication.ts";
import type { WorkspaceEnlistment } from "./collector.ts";

/** A directory this invocation owns for as long as it needs one. */
export interface TemporaryTrees {
  /** A fresh empty directory, removed when the calling scope ends. */
  create(purpose: string): Operation<string>;
  /** Remove one, before its scope would. */
  remove(path: string): Operation<void>;
}

/**
 * The capability to move the accepted tree, which is not part of reading it.
 *
 * A symbol because a symbol cannot be written down by anyone who does not
 * already have it. Everything that merely reads the Workspace receives a
 * `Materialization` and can see no way to change which Workspace it is
 * reading; only an attempt, created by this module, is handed the key.
 */
const ACCEPT: unique symbol = Symbol("executablemd.workflow.remote.accept");

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

/** The accepted materialization as this module alone sees it. */
interface AcceptedMaterialization extends Materialization {
  readonly [ACCEPT]: (next: { root: string; workspaceRootId: string }) => Operation<void>;
}

/**
 * One disposable place to make a mutation, and the way to offer it.
 *
 * There is no `promote()`. Promotion is not something a caller does at the
 * right moment; it is what happens inside the transaction when the owner
 * performs the exact commit that proposed this attempt. An attempt offers a
 * proposal, the transaction sends it, and only the transaction — holding the
 * answer it just validated — transfers the tree.
 */
export interface Attempt {
  readonly at: HostPath;
  /** What the attempt now describes, captured and checked locally. */
  capture(): Operation<CapturedWorkspace>;
  /**
   * Offer this attempt's captured Workspace to the active transaction.
   *
   * The value it returns carries a way back to this attempt that nothing else
   * can construct. A caller may build an enlistment by hand, but it will carry
   * no attempt, and so it can move no accepted materialization — which is the
   * point: a value shaped like an owner's decision is not authority, and there
   * is nowhere to hand one.
   */
  propose(
    captured: CapturedWorkspace,
    mappings: readonly RetainedMapping[],
  ): Operation<WorkspaceEnlistment>;
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
    yield* materializeWorkspaceRoot(files, reads, at(root), workspaceRootId, reject);
    let accepted = { root, workspaceRootId };
    const materialization: AcceptedMaterialization = {
      get workspaceRootId(): string {
        return accepted.workspaceRootId;
      },
      at(logical: string): string {
        return at(accepted.root)(logical);
      },
      *[ACCEPT](next: { root: string; workspaceRootId: string }): Operation<void> {
        const previous = accepted.root;
        accepted = next;
        // The tree the run used to be at is removed once nothing points at it.
        // Leaving it would keep a second copy of the Workspace on disk that
        // nothing can reach and nothing will clean up until the invocation ends.
        yield* trees.remove(previous);
      },
    };
    yield* provide(materialization);
  });
}

/**
 * The accepted materialization, with the capability an attempt needs.
 *
 * The declared type hides it, so this is where the two views meet. A value that
 * did not come from `useMaterialization()` carries no such key and cannot be
 * mistaken for one.
 */
function accepting(materialization: Materialization, reject: WorkspaceRejection) {
  const accept = (materialization as Partial<AcceptedMaterialization>)[ACCEPT];
  if (accept === undefined) {
    reject("this is not an accepted materialization this invocation owns");
  }
  return accept;
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
    const accept = accepting(materialization, reject);
    const root = yield* trees.create("attempt");
    yield* materializeWorkspaceRoot(
      files,
      reads,
      at(root),
      materialization.workspaceRootId,
      reject,
    );

    let transferred = false;
    // Registered before the attempt is handed over, so every exit removes it —
    // including the ones that never reach the end of the calling scope.
    yield* ensure(function* () {
      if (!transferred) {
        yield* trees.remove(root);
      }
    });

    /**
     * Make this attempt the accepted materialization.
     *
     * Reached only through the enlistment `propose()` produced, and only by the
     * transaction that has just validated the owner's answer for this exact
     * proposal. The decision is compared with what this attempt captured, so an
     * answer about some other Workspace transfers nothing.
     */
    function* transfer(decision: CommitDecision, captured: CapturedWorkspace): Operation<void> {
      if (transferred) {
        reject("this attempt has already been transferred");
      }
      if (decision.workspaceRootId !== captured.root.rootId) {
        reject("the owner's decision names a root this attempt did not capture");
      }
      transferred = true;
      yield* accept({ root, workspaceRootId: captured.root.rootId });
    }

    yield* provide({
      at: at(root),
      *capture(): Operation<CapturedWorkspace> {
        return yield* captureWorkspace(files, at(root), reject);
      },
      // deno-lint-ignore require-yield
      *propose(
        captured: CapturedWorkspace,
        mappings: readonly RetainedMapping[],
      ): Operation<WorkspaceEnlistment> {
        return {
          publication: {
            proposedWorkspaceRootId: captured.root.rootId,
            proposedManifest: captured.root.manifest,
            content: inventoryOf(captured),
          },
          mappings,
          bytes: bytesOf(captured),
          transfer: (decision) => transfer(decision, captured),
        };
      },
    });
  });
}

/** The exact closure a captured root names, in canonical order. */
function inventoryOf(captured: CapturedWorkspace): ProposedContent[] {
  return [
    ...captured.root.manifests.map((digest) => ({
      kind: "manifest" as const,
      digest,
      size: captured.contents.get(digest)?.manifestBytes.length ?? 0,
    })),
    ...captured.root.blobs.map((digest) => ({
      kind: "blob" as const,
      digest,
      size: captured.blobs.get(digest)?.length ?? 0,
    })),
  ];
}

/** Every piece the capture can supply, by identity. */
function bytesOf(captured: CapturedWorkspace): Map<string, Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  for (const [digest, content] of captured.contents) {
    bytes.set(digest, content.manifestBytes);
  }
  for (const [digest, blob] of captured.blobs) {
    bytes.set(digest, blob);
  }
  return bytes;
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
