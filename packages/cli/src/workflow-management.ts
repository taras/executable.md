/**
 * `xmd workflow status`, `list`, `history`, `cancel`, `delete` and `answer` —
 * everything a run's caller does without running it.
 *
 * The readings answer from immutable lifecycle snapshots. Nothing there opens a
 * writable database, acquires the executor lock, replays, attaches a Workspace,
 * materializes a root, imports a document or contacts a provider: what a
 * reading command may do is read.
 *
 * `answer` writes, and writes exactly one thing: the value a suspended run's
 * wait is to continue from. It takes no executor lock either, so a run that is
 * about to be resumed can still be answered — and it starts nothing, so its
 * success line reports the delivery rather than a status the run did not
 * change.
 *
 * ## Two projections of one answer
 *
 * `--json` is the contract. It writes the retained values structurally — every
 * event, its exact id, its associated Workspace root and its optional authored
 * source — so a caller parsing it sees what the run holds rather than a
 * rendering of it. Human output is a presentation over the same values: it may
 * shorten and it may leave a column out, and it can never remove an event from
 * the JSON contract or invent one.
 *
 * ## Where output goes
 *
 * The answer goes to standard output and diagnostics to standard error, so a
 * caller can pipe one without the other. An exit code describes the *request* —
 * whether this command could answer — and never the run's own outcome: a
 * completed run and a failed run both report successfully.
 */

import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { exists, rm } from "@effectionx/fs";
import { mkdtempSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gitBlobIdentity, WorkflowInputDelivery, WorkflowLifecycle } from "@executablemd/workflow";
import type { XmdArtifactDefinitionClosure } from "@executablemd/workflow";
import { loadRetainedDefinition } from "./workflow-definition.ts";
import type {
  WorkflowHistoryEntry,
  WorkflowLifecycleSnapshot,
  WorkflowRunRecord,
} from "@executablemd/workflow";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { WorkflowHost, WorkflowManagementRequest, WorkflowOutcome } from "./workflow.ts";

/**
 * Run one management command.
 *
 * The lifecycle provider is installed for this scope alone, so nothing the
 * command reached outlives the answer.
 */
export function runWorkflowManagement(
  request: WorkflowManagementRequest,
  host: WorkflowHost,
): Operation<WorkflowOutcome> {
  return scoped(function* () {
    if (request.action === "answer") {
      yield* host.useDelivery();
      const delivered = yield* WorkflowInputDelivery.operations.deliver({
        runId: request.runId,
        suspensionId: request.suspensionId,
        value: request.value,
        secretDetection: request.secretDetection,
      });
      if (!delivered.ok) {
        return refuse(delivered.error);
      }
      // The delivery, and nothing about the run. Its status is unchanged, no
      // execution began, and nothing here claims otherwise.
      write(`workflow answer: ${delivered.value.runId} (${delivered.value.suspensionId})`);
      return { exitCode: 0 };
    }

    yield* host.useLifecycle();

    switch (request.action) {
      case "status": {
        const snapshot = yield* WorkflowLifecycle.operations.inspect(request.runId);
        if (!snapshot.ok) {
          return refuse(snapshot.error);
        }
        write(request.json ? json(snapshot.value) : renderStatus(snapshot.value));
        return { exitCode: 0 };
      }
      case "list": {
        const snapshots = yield* WorkflowLifecycle.operations.list();
        if (!snapshots.ok) {
          return refuse(snapshots.error);
        }
        const selected =
          request.status === undefined
            ? snapshots.value
            : snapshots.value.filter((snapshot) => snapshot.record.status === request.status);
        write(request.json ? json(selected) : renderList(selected));
        return { exitCode: 0 };
      }
      case "history": {
        const entries = yield* WorkflowLifecycle.operations.history(request.runId);
        if (!entries.ok) {
          return refuse(entries.error);
        }
        write(request.json ? json(entries.value) : renderHistory(entries.value, request.forkable));
        return { exitCode: 0 };
      }
      case "export": {
        return yield* exportArtifact(request.runId, request.output);
      }
      case "cancel": {
        const cancelled = yield* WorkflowLifecycle.operations.cancel(request.runId);
        if (!cancelled.ok) {
          return refuse(cancelled.error);
        }
        // The command reports its own request, not the run's outcome: asking
        // for a cancellation and getting one is success, however terminal the
        // status it left behind.
        write(`workflow cancel: ${cancelled.value.runId} (${cancelled.value.status})`);
        return { exitCode: 0 };
      }
      case "delete": {
        const deleted = yield* WorkflowLifecycle.operations.delete(request.runId);
        if (!deleted.ok) {
          return refuse(deleted.error);
        }
        // Only what actually went. Nothing here claims to have undone an
        // effect the run had on anything outside itself.
        write(`workflow delete: ${request.runId} (${deleted.value.removed.join(", ")})`);
        return { exitCode: 0 };
      }
    }
  });
}

function refuse(error: Error): WorkflowOutcome {
  console.error(error.message);
  return { exitCode: 1 };
}

function write(text: string): void {
  console.log(text);
}

/** One JSON value and the newline that ends it. `console.log` supplies the newline. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

function renderStatus(snapshot: WorkflowLifecycleSnapshot): string {
  const { record } = snapshot;
  const lines = [
    `run: ${record.runId}`,
    `status: ${record.status}`,
    `definition: ${describeDefinition(snapshot)}`,
    `base: ${record.base}`,
    `props: ${JSON.stringify(record.props)}`,
    `created: ${record.createdAt}`,
    `updated: ${record.updatedAt}`,
  ];
  if (record.stopReason !== undefined) {
    lines.push(`stop reason: ${describeReason(record)}`);
  }
  if (snapshot.retrieval !== undefined) {
    lines.push(
      `retrieval: revision ${snapshot.retrieval.revision} at ${snapshot.retrieval.updatedAt}`,
    );
  }
  if (snapshot.lineage !== undefined) {
    lines.push(
      `forked from: ${snapshot.lineage.sourceRunId} at ${snapshot.lineage.checkpointEventId} ` +
        `(Workspace ${snapshot.lineage.checkpointWorkspaceRootId})`,
    );
  }
  lines.push(`workspace: ${snapshot.currentWorkspaceRootId}`);
  lines.push(
    snapshot.journalFrontier === undefined
      ? "journal frontier: none"
      : `journal frontier: ${snapshot.journalFrontier.eventId} (Workspace ${
          snapshot.journalFrontier.workspaceRootId
        })`,
  );
  lines.push(`executions: ${snapshot.executions.length}`);
  for (const execution of snapshot.executions) {
    const ended =
      execution.stoppedAt === undefined
        ? "unfinished"
        : `${execution.stopStatus ?? "unknown"} at ${execution.stoppedAt}`;
    lines.push(`  ${execution.executionId} started ${execution.startedAt}, ${ended}`);
  }
  return lines.join("\n");
}

function renderList(snapshots: readonly WorkflowLifecycleSnapshot[]): string {
  if (snapshots.length === 0) {
    return "no workflow runs";
  }
  const rows = [
    ["RUN", "STATUS", "UPDATED", "DEFINITION", "WORKSPACE"],
    ...snapshots.map((snapshot) => [
      snapshot.record.runId,
      snapshot.record.status,
      snapshot.record.updatedAt,
      describeDefinition(snapshot),
      snapshot.currentWorkspaceRootId,
    ]),
  ];
  return table(rows);
}

/**
 * The retained events, and — when the caller asked — whether each is a
 * checkpoint a fork may select.
 *
 * `--forkable` adds two columns and removes nothing: a caller reading history
 * to choose a checkpoint needs to see the events it cannot select as much as
 * the ones it can. The columns carry stable codes and retained event ids and
 * nothing else, so an unforkable Agent turn says `agent-state-unavailable`
 * rather than repeating what the provider said about the session.
 */
function renderHistory(entries: readonly WorkflowHistoryEntry[], forkable: boolean): string {
  const header = ["EVENT", "OPERATION", "SOURCE", "RESULT", "WORKSPACE"];
  const rows: string[][] = [forkable ? [...header, "FORKABLE", "BLOCKERS"] : header];
  let outcome: WorkflowHistoryEntry | undefined;

  for (const entry of entries) {
    if (entry.event.type === "close" && entry.event.coroutineId === "root") {
      // The root's Close is the run's outcome rather than one more operation,
      // so it becomes the footer instead of an otherwise empty row.
      outcome = entry;
      continue;
    }
    const row = [
      entry.eventId,
      describeOperation(entry.event),
      describeSource(entry),
      describeResult(entry.event),
      entry.workspaceRootId,
    ];
    rows.push(forkable ? [...row, ...describeForkability(entry)] : row);
  }

  const footer =
    outcome === undefined
      ? "Outcome: no canonical document outcome was recorded."
      : `Outcome: ${describeResult(outcome.event)} at ${outcome.eventId}, Workspace ${
          outcome.workspaceRootId
        }`;

  if (rows.length === 1) {
    return footer;
  }
  return `${table(rows)}\n\n${footer}`;
}

/**
 * What one row did, without repeating the protocol's own word for it.
 *
 * A Yield is its durable operation. A child Close is that coroutine ending, and
 * stays associated with the coroutine it belongs to so nesting remains visible.
 */
function describeOperation(event: DurableEvent): string {
  if (event.type === "yield") {
    return event.description.type;
  }
  return `end of ${event.coroutineId}`;
}

/**
 * The two forkability cells: whether this checkpoint may be selected, and the
 * stable codes that say why not.
 *
 * Cumulative through this event, so a blocker introduced earlier is still named
 * here — a caller choosing a later checkpoint is choosing the whole prefix.
 */
function describeForkability(entry: WorkflowHistoryEntry): [string, string] {
  const { forkability } = entry;
  return [
    forkability.forkable ? "yes" : "no",
    forkability.blockers.length === 0
      ? "-"
      : forkability.blockers.map((blocker) => `${blocker.code}@${blocker.eventId}`).join(", "),
  ];
}

function describeSource(entry: WorkflowHistoryEntry): string {
  const { source } = entry;
  if (source === undefined) {
    return "-";
  }
  const at = `${source.line}:${source.column}`;
  return source.path === undefined ? at : `${source.path}:${at}`;
}

function describeResult(event: DurableEvent): string {
  switch (event.result.status) {
    case "ok":
      return "completed";
    case "err":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function describeDefinition(snapshot: WorkflowLifecycleSnapshot): string {
  const { definition } = snapshot.record;
  const target = definition.targetPath === undefined ? "" : `#${definition.targetPath}`;
  return `${definition.objectId} ${definition.rootDocumentPath}${target}`;
}

function describeReason(record: WorkflowRunRecord): string {
  const reason = record.stopReason;
  if (reason === undefined) {
    return "none";
  }
  return reason.kind === "host" ? `host ${reason.code}` : `journal event ${reason.eventId}`;
}

/**
 * Columns wide enough for what they hold.
 *
 * Deterministic for one answer and derived from it, so spacing describes this
 * output rather than becoming a format anything can depend on.
 */
function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Seal one run at `output`, and put nothing there unless it worked.
 *
 * Three steps that each refuse on their own terms. The run's own snapshot says
 * what definition it retains and where that definition could be fetched from;
 * the repository turns that back into the exact Markdown and proves it against
 * the identities the definition holds; and the provider chooses a frontier
 * under the executor lock and writes the container.
 *
 * The artifact is built beside its destination and moved onto it. A rename
 * within one directory is atomic, so an onlooker sees the finished file or no
 * file — never a half-written one wearing the name a user asked for. Building
 * somewhere else and copying would give up exactly that.
 */
function* exportArtifact(runId: string, output: string): Operation<WorkflowOutcome> {
  if (yield* exists(output)) {
    return refuse(
      new Error(
        `xmd workflow export will not replace ${output}. Remove it, or name a path that does ` +
          "not exist yet.",
      ),
    );
  }

  const snapshot = yield* WorkflowLifecycle.operations.inspect(runId);
  if (!snapshot.ok) {
    return refuse(snapshot.error);
  }
  const definition = snapshot.value.record.definition;
  const sources = yield* loadRetainedDefinition(definition, snapshot.value.retrieval?.metadata);
  if (!sources.ok) {
    return refuse(sources.error);
  }

  const closure: XmdArtifactDefinitionClosure = {
    root: {
      objectFormat: definition.objectFormat,
      pinnedCommit: definition.objectId,
      rootDocumentPath: definition.rootDocumentPath,
      ...(definition.targetPath === undefined ? {} : { targetPath: definition.targetPath }),
      // Derived from the bytes the repository just handed back, and compared
      // with them again by the container. A definition pins a commit and a
      // path, never the document's own identity.
      blobId: gitBlobIdentity(sources.value.source, definition.objectFormat),
      content: sources.value.source,
    },
    components: sources.value.components.map((component) => ({
      name: component.name,
      path: component.path,
      blobId: component.sourceHash,
      content: component.content,
    })),
  };

  return yield* scoped(function* (): Operation<WorkflowOutcome> {
    const staging = yield* useExportStaging(output);
    const sealed = yield* WorkflowLifecycle.operations.export({
      runId,
      stagingPath: staging,
      closure,
    });
    if (!sealed.ok) {
      return refuse(sealed.error);
    }
    yield* until(rename(staging, output));

    write(
      [
        `workflow artifact: ${output}`,
        `workflow run: ${sealed.value.frontier.sourceRunId}`,
        `workflow frontier: ${sealed.value.frontier.finalEventId ?? "(no committed event)"}`,
        `workflow root: ${sealed.value.frontier.currentWorkspaceRootId}`,
        // Two digests, and the labels say which question each answers.
        `workflow artifact identity: ${sealed.value.identity}`,
        `workflow artifact sha256: ${sealed.value.fileSha256}`,
      ].join("\n"),
    );
    return { exitCode: 0 };
  });
}

/**
 * A directory beside the destination, removed with this scope.
 *
 * Beside it because a rename is atomic only within one filesystem, and the only
 * directory guaranteed to share one with the target is the target's own. What
 * is left behind on failure is a temporary directory nobody was told about,
 * rather than a file at the path a user will go looking at.
 */
function useExportStaging(output: string): Operation<string> {
  return resource(function* (provide) {
    // oxlint-disable-next-line local/no-sync-filesystem
    const directory = mkdtempSync(join(dirname(resolve(output)), ".xmd-export-"));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    yield* provide(join(directory, "artifact.xmd"));
  });
}
