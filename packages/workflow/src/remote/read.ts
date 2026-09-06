/**
 * What a runner may read from the owner of its run.
 *
 * Semantic values, not messages. The seam speaks in workflow records, Workspace
 * roots and content identities; how those are asked for, what a page is, and
 * which refusals exist are the adapter's, below this line. That division is
 * what lets a second host implement the same reads without this module learning
 * anything about it — and what stops paging mechanics leaking into the code
 * that only wanted the frontier.
 *
 * The frontier snapshot is deliberately richer than `StartingFrontier`. A
 * transaction needs the root, the anchor and the events; a database handle will
 * also need the run record and its retrieval snapshot. Modelling both as one
 * value would make the collector carry members it has no business reading, so
 * the richer value is separate and maps down to the smaller one.
 *
 * Nothing here is exported from the package. A read seam a document or a runner
 * could name would be a second place deciding what a run may see.
 */

import type { Operation } from "effection";
import type { RemoteInvocationSnapshot } from "./records.ts";
import type { Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { JournalEntry } from "../storage/api.ts";
import type {
  DefinitionRetrieval,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";
import type { WorkspaceRootManifest } from "../workspace/root-manifest.ts";
import type { StartingFrontier } from "./collector.ts";

export interface RemoteFrontierSnapshot {
  readonly record: WorkflowRunRecord;
  readonly retrieval: DefinitionRetrieval | undefined;
  readonly workspaceRootId: string;
  readonly journalEventId: string | null;
  readonly entries: readonly JournalEntry[];
}

export interface RemoteContent {
  readonly kind: "manifest" | "blob";
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export type RemoteContentRequest =
  | { readonly kind: "manifest"; readonly digest: string }
  | { readonly kind: "blob"; readonly digest: string; readonly manifestDigest: string };

export interface RemoteReadLink {
  frontier(): Operation<RemoteFrontierSnapshot>;
  /** The one coherent admitted state a Workspace invocation begins from. */
  invocationSnapshot(): Operation<RemoteInvocationSnapshot>;
  root(workspaceRootId: string): Operation<WorkspaceRootManifest>;
  content(workspaceRootId: string, request: RemoteContentRequest): Operation<RemoteContent>;
}

export function startingFrontier(snapshot: RemoteFrontierSnapshot): StartingFrontier {
  return {
    workspaceRootId: snapshot.workspaceRootId,
    journalEventId: snapshot.journalEventId,
    events: snapshot.entries.map((entry) => structuredClone(entry.event)),
  };
}

/** Where one inherited row came from. Rows a run wrote itself have none. */
export interface RetainedProvenance {
  readonly sourceRunId: string;
  readonly sourceEventId: string;
}

/** One retained journal row, parsed but not yet projected. */
export interface RetainedRow {
  readonly eventId: string;
  readonly event: DurableEvent;
  readonly workspaceRootId: string;
}

/** Everything one anchored history sequence produced, once it terminated. */
export interface RetainedHistory {
  readonly entries: readonly RetainedRow[];
  readonly retainedRoots: ReadonlySet<string>;
  readonly inherited: ReadonlyMap<string, RetainedProvenance>;
}

/** One run's committed state, as the owner reported it. */
export interface RetainedInspection {
  readonly record: WorkflowRunRecord;
  readonly executions: readonly DocumentExecutionRecord[];
  readonly retrieval?: DefinitionRetrieval;
  readonly journalFrontier?: { readonly eventId: string; readonly workspaceRootId: string };
  readonly currentWorkspaceRootId: string;
  readonly lineage?: {
    readonly sourceRunId: string;
    readonly checkpointEventId: string;
    readonly checkpointWorkspaceRootId: string;
  };
}

/**
 * What the runner may ask this owner for, without taking it.
 *
 * Both answer with parsed retained values rather than public projections: the
 * projection is provider-neutral and belongs on the runner, so there is one
 * meaning of a history rather than one per adapter.
 */
export interface RemoteReadPlane {
  /**
   * The one run this plane was opened for.
   *
   * Descriptive, and compared rather than trusted: it lets a provider refuse a
   * request for another run before it reaches the owner. It authorizes
   * nothing — the plane can only ever answer about the run it was built with.
   */
  readonly runId: string;
  inspect(): Operation<Result<RetainedInspection>>;
  history(): Operation<Result<RetainedHistory>>;
  /**
   * Everything a fork must copy out of this run at one checkpoint.
   *
   * Private: a destination transition calls it through a narrow internal
   * accessor. It is copy data and not authority — the destination still needs
   * its own live acquisition and its own atomic commit.
   */
  forkSource(checkpointEventId: string): Operation<Result<RemoteForkSource>>;
}

/**
 * One inherited row, as a fork must copy it.
 *
 * The exact retained record string, not only the event it parses to. A record
 * is validated before it is accepted, but two different spellings can parse to
 * one event, and a destination inserting a reconstructed spelling would retain
 * history that is not the history it inherited. A destination writes this
 * string into its journal as it stands, with nothing re-encoded. Public
 * history projects the parsed event and never carries it.
 */
export interface RemoteForkRow {
  readonly eventId: string;
  /** The retained record, byte for byte. */
  readonly record: string;
  readonly workspaceRootId: string;
}

/** One DOFS manifest, as content a fork must hold for itself. */
export interface RemoteManifest {
  readonly hash: string;
  readonly size: number;
  readonly lastSeen: number;
  readonly encoded: Uint8Array;
}

/** One DOFS blob and its bytes. */
export interface RemoteBlob {
  readonly hash: string;
  readonly size: number;
  readonly lastSeen: number;
  readonly content: Uint8Array;
}

/** One immutable Workspace root the selected prefix requires. */
export interface RemoteStoredRoot {
  readonly rootId: string;
  readonly formatVersion: number;
  readonly manifest: string;
  readonly manifestHashes: readonly string[];
  readonly blobHashes: readonly string[];
}

/** One checkout the checkpoint's Workspace holds, as a fork inherits it. */
export type RemoteCheckout =
  | {
      readonly kind: "repository";
      readonly name: string;
      readonly locator: string;
      readonly locatorFingerprint: string;
      readonly requestedBase: string | null;
      readonly creationCommit: string;
      readonly primaryBranch: string;
      readonly objectFormat: string;
      readonly checkoutPath: string;
    }
  | {
      readonly kind: "worktree";
      readonly repositoryName: string;
      readonly name: string;
      readonly requestedBranch: string;
      readonly requestedBase: string | null;
      readonly creationCommit: string;
      readonly checkoutPath: string;
    };

/** Everything one checkpoint hands a fork, read in one committed selection. */
export interface RemoteForkSource {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly checkpointWorkspaceRootId: string;
  readonly runRecordWorkspaceRootId: string;
  readonly rootImportWorkspaceRootId: string;
  /** The prefix without the two rows the fork writes for itself. */
  readonly inherited: readonly RemoteForkRow[];
  readonly roots: readonly RemoteStoredRoot[];
  readonly manifests: readonly RemoteManifest[];
  readonly blobs: readonly RemoteBlob[];
  readonly checkouts: readonly RemoteCheckout[];
}
