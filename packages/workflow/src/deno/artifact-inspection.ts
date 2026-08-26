/**
 * Reading a sealed artifact as the lifecycle evidence it holds.
 *
 * The other half of #601's boundary. `readXmdArtifact()` decides whether a file
 * is an artifact at all — recognition, manifest, inventory and every semantic
 * gate — and returns a detached, deep-frozen value or says why it will not.
 * This turns that value into the provider-neutral snapshot and history a
 * retained run already answers with, and knows nothing about containers.
 *
 * ## No live authority, at all
 *
 * Nothing here consults the provider's run root, opens a run database, takes a
 * lock, recovers a copy, attaches a Workspace, reads a definition or asks any
 * external provider. An artifact is evidence, and inspecting evidence is
 * reading: the path the caller supplied is opened once, verified completely,
 * and closed before a single value is projected.
 *
 * ## The same history, from a different source
 *
 * A run's history and an artifact's history are the same projection over the
 * same ordered rows — authored source, cumulative forkability, inherited
 * provenance — so both go through `projectHistory()`. What differs is only
 * where the rows come from: a live journal table on one side, verified journal
 * records on the other. Writing the mapping twice is how the two would quietly
 * start meaning different things.
 */

import { parseDurableEvent } from "@executablemd/durable-streams";
import { Ok } from "effection";
import type { Operation, Result } from "effection";
import type { ForkabilityCandidate } from "../lifecycle/forkability.ts";
import { projectHistory, type InheritedEventProvenance } from "../lifecycle/history.ts";
import type {
  WorkflowArtifactHistory,
  WorkflowArtifactIdentity,
  WorkflowArtifactSnapshot,
} from "../lifecycle/artifact.ts";
import { readXmdArtifact } from "./artifact/mod.ts";
import type { VerifiedXmdArtifact } from "./artifact/types.ts";

/** One artifact's lifecycle snapshot, or why this file is not one. */
export function* inspectArtifact(path: string): Operation<Result<WorkflowArtifactSnapshot>> {
  const opened = yield* readXmdArtifact(path);
  if (!opened.ok) {
    return opened;
  }
  const artifact = opened.value;
  const frontier = frontierEntry(artifact);
  return Ok(
    Object.freeze({
      record: artifact.run,
      executions: artifact.executions,
      // Absent on purpose, and absent as a fact: an artifact excludes where its
      // definition could be fetched from now, so there is nothing to project.
      ...(frontier === undefined ? {} : { journalFrontier: frontier }),
      currentWorkspaceRootId: artifact.frontier.currentWorkspaceRootId,
      ...(artifact.lineage === undefined
        ? {}
        : {
            lineage: Object.freeze({
              sourceRunId: artifact.lineage.sourceRunId,
              checkpointEventId: artifact.lineage.checkpointEventId,
              checkpointWorkspaceRootId: artifact.lineage.checkpointWorkspaceRootId,
            }),
          }),
      artifact: identityOf(artifact),
    }),
  );
}

/** Every event one artifact retains, in append order, or why this file is not one. */
export function* historyArtifact(path: string): Operation<Result<WorkflowArtifactHistory>> {
  const opened = yield* readXmdArtifact(path);
  if (!opened.ok) {
    return opened;
  }
  const artifact = opened.value;
  const candidates: ForkabilityCandidate[] = [];
  const inherited = new Map<string, InheritedEventProvenance>();
  for (const row of artifact.journal) {
    // The retained bytes, through the parser that wrote them. A verified
    // container says these records are the ones the journal's own gate
    // filtered; what they *mean* is still this parser's answer, and a record it
    // refuses is history nobody can read rather than a row to skip.
    const event = parseDurableEvent(row.record);
    if (!event.ok) {
      return event;
    }
    candidates.push({
      eventId: row.eventId,
      event: event.value,
      workspaceRootId: row.workspaceRootId,
    });
    if (row.inherited !== undefined) {
      inherited.set(row.eventId, row.inherited);
    }
  }

  return Ok(
    Object.freeze({
      artifact: identityOf(artifact),
      entries: projectHistory(candidates, {
        // Every root the artifact carries. An artifact holds the run's whole
        // retained set, so a checkpoint blocked by a missing Workspace here is
        // blocked for the same reason it would be in the run.
        retainedRoots: new Set(artifact.roots.map((root) => root.rootId)),
        inherited,
      }),
    }),
  );
}

function identityOf(artifact: VerifiedXmdArtifact): WorkflowArtifactIdentity {
  return Object.freeze({ identity: artifact.identity, frontier: artifact.frontier });
}

/**
 * The last committed event and the root that row was associated with.
 *
 * The row's own root, never the current Workspace pointer. They are two
 * retained facts and they disagree whenever the run's last event did not move
 * the Workspace — projecting one as the other would report a boundary the run
 * never had.
 */
function frontierEntry(
  artifact: VerifiedXmdArtifact,
): { readonly eventId: string; readonly workspaceRootId: string } | undefined {
  const eventId = artifact.frontier.finalEventId;
  if (eventId === undefined) {
    return undefined;
  }
  const row = artifact.journal.find((entry) => entry.eventId === eventId);
  if (row === undefined) {
    return undefined;
  }
  return Object.freeze({ eventId, workspaceRootId: row.workspaceRootId });
}
