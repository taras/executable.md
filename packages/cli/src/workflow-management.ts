/**
 * `xmd workflow status`, `list`, `history`, `cancel`, `delete`, `answer` and
 * `export` — everything a run's caller does without running it.
 *
 * `status` and `history` each take one of two sources. A run id addresses this
 * host's retained storage; `--artifact=<path.xmd>` addresses a sealed file,
 * which is completely verified before any of it is presented. The two answer
 * with the same lifecycle and history values, and the artifact forms add which
 * artifact answered and the boundary it was sealed at.
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

import { ensure, Err, Ok, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { exists, rm } from "@effectionx/fs";
import { linkSync, mkdtempSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WorkflowInputDelivery, WorkflowLifecycle } from "@executablemd/workflow";
import type {
  DefinitionRetrieval,
  WorkflowArtifactIdentity,
  WorkflowHistoryEntry,
  WorkflowInspectionSnapshot,
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
        if (request.source.kind === "artifact") {
          const { path } = request.source;
          const snapshot = yield* WorkflowLifecycle.operations.inspectArtifact(path);
          if (!snapshot.ok) {
            return refuse(snapshot.error);
          }
          // The path is in the human heading and nowhere in the JSON: two
          // copies of one artifact are one answer, and a value that named where
          // it was read from would make them two.
          write(
            request.json
              ? json(snapshot.value)
              : `${renderArtifact(path, snapshot.value.artifact)}\n${renderStatus(snapshot.value)}`,
          );
          return { exitCode: 0 };
        }
        const snapshot = yield* WorkflowLifecycle.operations.inspect(request.source.runId);
        if (!snapshot.ok) {
          return refuse(snapshot.error);
        }
        write(
          request.json
            ? json(snapshot.value)
            : renderStatus(snapshot.value, snapshot.value.retrieval),
        );
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
        if (request.source.kind === "artifact") {
          const { path } = request.source;
          const history = yield* WorkflowLifecycle.operations.historyArtifact(path);
          if (!history.ok) {
            return refuse(history.error);
          }
          write(
            request.json
              ? json(history.value)
              : `${renderArtifact(path, history.value.artifact)}\n${renderHistory(
                  history.value.entries,
                  request.forkable,
                )}`,
          );
          return { exitCode: 0 };
        }
        const entries = yield* WorkflowLifecycle.operations.history(request.source.runId);
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

/**
 * Which file answered, which artifact it holds, and the boundary it was sealed
 * at — above the same rendering a retained run gets.
 *
 * The path is here and only here. It is where this caller found the evidence,
 * which is a fact about the invocation rather than about the artifact, so it
 * never reaches the structural answer.
 */
function renderArtifact(path: string, artifact: WorkflowArtifactIdentity): string {
  const { frontier } = artifact;
  return [
    `artifact: ${path}`,
    `artifact identity: ${artifact.identity}`,
    `artifact frontier: run ${frontier.sourceRunId}, event ${
      frontier.finalEventId ?? "none"
    }, Workspace ${frontier.currentWorkspaceRootId}`,
  ].join("\n");
}

/**
 * The lines every snapshot has, and the retrieval line only a retained run does.
 *
 * `retrieval` arrives as its own argument rather than off the snapshot, because
 * it is not a member of the shared inspection shape: a retained run has one and
 * an artifact has none, and reading it from the value would make this renderer
 * expect a member half its callers cannot supply.
 */
function renderStatus(
  snapshot: WorkflowInspectionSnapshot,
  retrieval?: DefinitionRetrieval,
): string {
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
  if (retrieval !== undefined) {
    lines.push(`retrieval: revision ${retrieval.revision} at ${retrieval.updatedAt}`);
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

function describeDefinition(snapshot: WorkflowInspectionSnapshot): string {
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
 * What an export does to the filesystem, so a test can make each step fail.
 *
 * Plain functions passed in, defaulting to the real ones. Not a contextual name
 * and not a new dependency: publication and cleanup are filesystem races that
 * do not reproduce by waiting, and the only honest way to see what an export
 * leaves behind when one of them fails is to make it fail on purpose.
 *
 * Two of them are synchronous, and the interface says so. Publication is the
 * commit point, and a commit nobody recorded is worse than one that never
 * happened.
 */
export interface ExportFilesystem {
  /** Move the finished artifact out of staging, onto the entry it publishes from. */
  reserve(staging: string, hidden: string): Operation<void>;
  /** Remove a directory and everything under it. */
  remove(directory: string): Operation<void>;
  /** Create `output` as a second name for `hidden`, or fail if it is taken. */
  link(hidden: string, output: string): void;
  /** Remove the private entry the artifact was published from. */
  unlink(hidden: string): void;
}

const REAL_FILESYSTEM: ExportFilesystem = {
  *reserve(staging: string, hidden: string): Operation<void> {
    yield* until(rename(staging, hidden));
  },
  *remove(directory: string): Operation<void> {
    yield* rm(directory, { recursive: true, force: true });
  },
  link(hidden: string, output: string): void {
    // Synchronous because this is the commit point. An operation can be halted
    // between the kernel creating the entry and the caller learning that it
    // did, and an export that published without recording it would tear down
    // believing it had not — the one state this contract has no answer for.
    // oxlint-disable-next-line local/no-sync-filesystem
    linkSync(hidden, output);
  },
  unlink(hidden: string): void {
    // Synchronous for the same reason: nothing may suspend between the commit
    // and the outcome this command reports, and this runs after the commit.
    // oxlint-disable-next-line local/no-sync-filesystem
    rmSync(hidden, { force: true });
  },
};

/**
 * Seal one run at `output`, and put nothing there unless it worked.
 *
 * The provider chooses a frontier under the executor lock, reads the run's own
 * definition source through the reader this host installed into it, and writes
 * the container. Nothing about the source travels from here.
 *
 * ## Publication is the commit point
 *
 * Everything private happens first. The finished artifact is moved out of its
 * staging directory onto one hidden entry beside the destination, and the
 * directory is removed — so by the time the destination is touched there is
 * nothing left whose cleanup could fail. A failure or a cancellation up to that
 * moment leaves no file where the caller asked for one.
 *
 * Then the destination is linked. A link is the no-clobber move: it creates the
 * name or fails because something took it, in one step nothing can happen in
 * the middle of, and what appears there is the complete artifact rather than a
 * file being written. **That link is irreversible.** Once it succeeds the export
 * has happened, and nothing below unlinks the caller's file — not a failed
 * cleanup, not a cancellation, not an error on the way to printing the report.
 *
 * What is left afterwards is one private entry nobody was told about. Removing
 * it is best effort: it is the artifact's own inode under a second name, so
 * failing to remove it costs a hidden file and changes nothing about the file
 * the caller asked for. That failure is a warning beside a success, because
 * calling it a failed export would mean reporting that nothing was published
 * while a complete artifact sits at the path.
 */
export function* exportArtifact(
  runId: string,
  output: string,
  filesystem: ExportFilesystem = REAL_FILESYSTEM,
): Operation<WorkflowOutcome> {
  // Asked early so an obvious mistake costs nothing, and asked again by the
  // link below, which is the one that actually decides.
  if (yield* exists(output)) {
    return refuse(
      new Error(
        `xmd workflow export will not replace ${output}. Remove it, or name a path that does ` +
          "not exist yet.",
      ),
    );
  }

  return yield* scoped(function* (): Operation<WorkflowOutcome> {
    const staging = yield* useExportStaging(output, filesystem);
    const sealed = yield* WorkflowLifecycle.operations.export({
      runId,
      stagingPath: staging.path,
    });
    if (!sealed.ok) {
      return refuse(sealed.error);
    }

    // Everything private, finished, before the destination is touched.
    const detached = yield* staging.detach();
    if (!detached.ok) {
      return refuse(detached.error);
    }

    const published = publish(filesystem, staging.hidden, output);
    if (!published.ok) {
      return refuse(published.error);
    }
    // Recorded with nothing suspended in between, so no cancellation can arrive
    // between the artifact becoming visible and this export knowing it did.
    staging.commit();

    const removed = discard(filesystem, staging.hidden);
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
    if (!removed.ok) {
      // Beside the success, never instead of it. The artifact is published and
      // complete; what is left over is a hidden file the caller now knows about.
      console.error(removed.error.message);
    }
    return { exitCode: 0 };
  });
}

/**
 * Give the finished artifact its name, or refuse because something took it.
 *
 * `link` is the no-clobber move: it creates the destination and fails with
 * `EEXIST` if the name already exists, in one step nothing can happen in the
 * middle of.
 */
function publish(filesystem: ExportFilesystem, hidden: string, output: string): Result<void> {
  try {
    filesystem.link(hidden, output);
    return Ok();
  } catch (error) {
    const taken = error instanceof Error && "code" in error && error.code === "EEXIST";
    return Err(
      new Error(
        taken
          ? `xmd workflow export will not replace ${output}, which something created while the ` +
              "artifact was being written. It is left exactly as it is."
          : `xmd workflow export could not put the artifact at ${output}. Nothing was published.`,
        { cause: error },
      ),
    );
  }
}

/** Remove the entry the artifact was published from, or say what was left. */
function discard(filesystem: ExportFilesystem, hidden: string): Result<void> {
  try {
    filesystem.unlink(hidden);
    return Ok();
  } catch (error) {
    return Err(
      new Error(
        `xmd workflow export published the artifact and could not remove the temporary file ` +
          `${hidden} it published from. The artifact is complete. Remove that file when you no ` +
          "longer need it.",
        { cause: error },
      ),
    );
  }
}

/**
 * A directory beside the destination, and the private name published from.
 *
 * Beside it because a rename is atomic only within one filesystem, and the only
 * directory guaranteed to share one with the target is the target's own. What
 * is left behind on failure is a temporary directory nobody was told about,
 * rather than a file at the path a user will go looking at.
 *
 * The hidden name is the directory's own, with the artifact's suffix. It is
 * unique because the directory's name was, and it sits in the destination's
 * directory so the move onto it is a rename within one filesystem.
 */
function useExportStaging(output: string, filesystem: ExportFilesystem): Operation<ExportStaging> {
  return resource(function* (provide) {
    // Created and named in one step, with the ensure registered before anything
    // can suspend, so nothing is left by a cancellation between the two.
    // oxlint-disable-next-line local/no-sync-filesystem
    const directory = mkdtempSync(join(dirname(resolve(output)), ".xmd-export-"));
    const hidden = `${directory}.xmd`;
    let committed = false;
    // The backstop, for everything before the commit. A failure, a refusal or a
    // cancellation all reach this and take both private names with them.
    yield* ensure(function* () {
      if (!committed) {
        // Cancellation reaches this too, which is what leaves nothing behind
        // when an export is interrupted before it published.
        yield* rm(directory, { recursive: true, force: true });
        yield* rm(hidden, { force: true });
      }
    });
    yield* provide({
      path: join(directory, "artifact.xmd"),
      hidden,
      *detach(): Operation<Result<void>> {
        try {
          yield* filesystem.reserve(join(directory, "artifact.xmd"), hidden);
        } catch (error) {
          return Err(
            new Error(
              "xmd workflow export could not move the finished artifact out of the temporary " +
                `directory ${directory}. Nothing was published.`,
              { cause: error },
            ),
          );
        }
        try {
          yield* filesystem.remove(directory);
        } catch (error) {
          return Err(
            new Error(
              `xmd workflow export could not remove the temporary directory ${directory}, so it ` +
                "stopped before publishing anything.",
              { cause: error },
            ),
          );
        }
        return Ok();
      },
      commit(): void {
        committed = true;
      },
    });
  });
}

/** A place to build the artifact, the name it publishes from, and the commit. */
interface ExportStaging {
  readonly path: string;
  /** The private entry the finished artifact is published from. */
  readonly hidden: string;
  /** Move the artifact onto `hidden` and remove the directory, before publishing. */
  detach(): Operation<Result<void>>;
  /**
   * Record that the artifact is published.
   *
   * Synchronous and argumentless: it runs immediately after the link, with
   * nothing suspended in between, and after it this scope's teardown removes
   * nothing.
   */
  commit(): void;
}
