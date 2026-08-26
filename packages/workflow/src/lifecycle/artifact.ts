/**
 * What inspecting a sealed artifact answers with.
 *
 * A retained run and an artifact are addressed differently on purpose. A run id
 * names live lifecycle authority — something a caller may still advance, cancel
 * or delete — while an artifact path names immutable evidence that left the
 * machine which produced it. So they are sibling operations rather than one
 * operation over a union: widening `inspect()` to accept either would make the
 * question "which of these two things am I holding" a detail of a parameter.
 *
 * The values are the same values. An artifact carries the run's own record, its
 * executions, its journal and the Workspace roots it was associated with, so
 * inspection projects exactly the lifecycle and history shapes a retained run
 * projects, plus the two facts only an artifact has: which artifact this is, and
 * the committed boundary it was sealed at.
 *
 * Nothing here names a container, a path, a database or a byte. This module is
 * the provider-neutral half of the boundary: the Deno adapter opens the file and
 * verifies it, and hands back these values. The retained record shapes an
 * artifact holds — DOFS manifests, DOFS blobs, SQLite rows — stay with that
 * adapter, because a host that cannot open one has no use for their names.
 */

import type { XmdArtifactFrontier } from "./export.ts";
import type { WorkflowHistoryEntry } from "./history.ts";
import type { WorkflowLifecycleSnapshot } from "./api.ts";

/**
 * Which artifact answered, and the boundary it holds.
 *
 * The path is deliberately absent. An artifact is the same evidence wherever
 * somebody put the file, so two copies answer identically and neither describes
 * where it was read from. Where a caller found it is presentation, and belongs
 * to whoever did the finding.
 */
export interface WorkflowArtifactIdentity {
  /** The lowercase SHA-256 the artifact manifest derives. */
  readonly identity: string;
  /** The exact committed boundary the artifact records. */
  readonly frontier: XmdArtifactFrontier;
}

/**
 * One artifact's lifecycle snapshot: the run's own, and whose evidence it is.
 *
 * `retrieval` is absent, and absent as a fact rather than as an omission. An
 * artifact excludes where its definition could be fetched from now, because
 * that is authority belonging to the machine that exported rather than
 * something true about the run.
 */
export interface WorkflowArtifactSnapshot extends WorkflowLifecycleSnapshot {
  readonly artifact: WorkflowArtifactIdentity;
}

/**
 * One artifact's history, and whose history it is.
 *
 * An envelope rather than the bare array a retained run answers with, because
 * there is nowhere else for the identity and the frontier to go: repeating them
 * on every row would make one fact into many, and reporting them beside the
 * result would put them outside the value a caller parses.
 */
export interface WorkflowArtifactHistory {
  readonly artifact: WorkflowArtifactIdentity;
  readonly entries: readonly WorkflowHistoryEntry[];
}
