/**
 * Assembling a remote fork's candidate on this runner's own disk.
 *
 * A fork is admitted by replaying it, and a replay needs the fork's own
 * Workspace: a `<File>` resolves through the run's filesystem, and a candidate
 * without one produces effects of a different kind and diverges for a reason
 * that has nothing to do with the candidate. So the snapshot read from a remote
 * source is assembled here, in full, at a staging path — and thrown away when
 * the scope that asked for it ends.
 *
 * This is the same assembly a committed fork gets. It is the local host's own
 * `stageFork()` kernel, handed the same snapshot shape it always takes; nothing
 * here writes a second fork writer, and nothing re-reads the source. What this
 * module is, is the translation: a `RemoteForkSource` says its digests in hex
 * because that is what crossed a wire, and the local snapshot says them in
 * bytes because that is what SQLite holds.
 */

import { type Operation, type Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { WorkflowForkRequest } from "../lifecycle/execution.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import type { RemoteForkSource } from "../remote/read.ts";
import type { ForkSourceSnapshot } from "./fork-source.ts";
import type { WorkflowRunConnections } from "./connections.ts";
import { stageFork } from "./transitions.ts";
import { workflowForkStaging } from "./path.ts";

/** One digest, as the store holds it rather than as a wire spells it. */
function bytesOfHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The same snapshot, said the way this host says it.
 *
 * Nothing is recomputed and nothing is dropped: the retained record strings
 * cross byte for byte, the roots keep their canonical reference arrays, the
 * content keeps the watermarks copied beside it, and the checkouts keep every
 * member the destination will retain.
 */
export function localForkSnapshot(source: RemoteForkSource): ForkSourceSnapshot {
  return {
    sourceRunId: source.sourceRunId,
    checkpointEventId: source.checkpointEventId,
    checkpointWorkspaceRootId: source.checkpointWorkspaceRootId,
    runRecordWorkspaceRootId: source.runRecordWorkspaceRootId,
    rootImportWorkspaceRootId: source.rootImportWorkspaceRootId,
    inherited: source.inherited.map((row) => ({
      eventId: row.eventId,
      record: row.record,
      workspaceRootId: row.workspaceRootId,
    })),
    roots: source.roots.map((root) => ({
      rootId: root.rootId,
      formatVersion: root.formatVersion,
      manifest: root.manifest,
      manifestHashes: [...root.manifestHashes],
      blobHashes: [...root.blobHashes],
    })),
    manifests: source.manifests.map((manifest) => ({
      hash: bytesOfHex(manifest.hash),
      size: manifest.size,
      encoded: manifest.encoded,
      lastSeen: manifest.lastSeen,
    })),
    blobs: source.blobs.map((blob) => ({
      hash: bytesOfHex(blob.hash),
      size: blob.size,
      lastSeen: blob.lastSeen,
      content: blob.content,
    })),
    repositories: source.checkouts.flatMap((checkout) =>
      checkout.kind === "repository"
        ? [
            {
              name: checkout.name,
              locator: checkout.locator,
              locatorFingerprint: checkout.locatorFingerprint,
              requestedBase: checkout.requestedBase,
              creationCommit: checkout.creationCommit,
              primaryBranch: checkout.primaryBranch,
              objectFormat: checkout.objectFormat,
              checkoutPath: checkout.checkoutPath,
            },
          ]
        : [],
    ),
    worktrees: source.checkouts.flatMap((checkout) =>
      checkout.kind === "worktree"
        ? [
            {
              repositoryName: checkout.repositoryName,
              name: checkout.name,
              requestedBranch: checkout.requestedBranch,
              requestedBase: checkout.requestedBase,
              creationCommit: checkout.creationCommit,
              checkoutPath: checkout.checkoutPath,
            },
          ]
        : [],
    ),
  };
}

/**
 * Build one remote fork's candidate locally, owned by the calling scope.
 *
 * The staging file is scratch: a leftover from an attempt that did not finish
 * is replaced rather than continued, and whatever happens — success, failure or
 * cancellation — it goes when the scope ends. Nothing about it is a run: no
 * lock is taken anywhere, no owner is contacted, and no host discovers it.
 */
export function stageRemoteFork(
  connections: WorkflowRunConnections,
  root: string,
  request: WorkflowForkRequest,
  source: RemoteForkSource,
  head: { readonly runRecord: DurableEvent; readonly rootImport: DurableEvent },
): Operation<Result<WorkflowRunDatabase>> {
  return stageFork(
    connections,
    workflowForkStaging(root, request.runId),
    request,
    localForkSnapshot(source),
    head,
  );
}
