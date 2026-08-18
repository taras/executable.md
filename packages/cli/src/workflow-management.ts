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

import { scoped } from "effection";
import type { Operation } from "effection";
import { WorkflowInputDelivery, WorkflowLifecycle } from "@executablemd/workflow";
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
        write(request.json ? json(entries.value) : renderHistory(entries.value));
        return { exitCode: 0 };
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

function renderHistory(entries: readonly WorkflowHistoryEntry[]): string {
  const rows: string[][] = [["EVENT", "OPERATION", "SOURCE", "RESULT", "WORKSPACE"]];
  let outcome: WorkflowHistoryEntry | undefined;

  for (const entry of entries) {
    if (entry.event.type === "close" && entry.event.coroutineId === "root") {
      // The root's Close is the run's outcome rather than one more operation,
      // so it becomes the footer instead of an otherwise empty row.
      outcome = entry;
      continue;
    }
    rows.push([
      entry.eventId,
      describeOperation(entry.event),
      describeSource(entry),
      describeResult(entry.event),
      entry.workspaceRootId,
    ]);
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
