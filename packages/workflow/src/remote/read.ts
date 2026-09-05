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
import type { JournalEntry } from "../storage/api.ts";
import type { DefinitionRetrieval, WorkflowRunRecord } from "../storage/record.ts";
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
