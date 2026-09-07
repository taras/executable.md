/**
 * The remote provider's half of the executor lifecycle.
 *
 * Taking the lock is opening a connection: an admitted socket *is* the
 * acquisition, so the lock this hands back is an object issued beside one exact
 * connection, held in this provider's own closure, and recognized by identity.
 * A run id, a copy of the object, another provider's lock or a lock whose
 * connection has closed authorizes nothing, and nothing about it is checked by
 * comparing fields.
 *
 * ## The connection is the lifetime
 *
 * The connection belongs to the scope that asked for it. When that scope ends —
 * normally, by cancellation, or because the socket failed — the hold is retired
 * and the connection closes once. Nothing expires: there is no lease, no
 * heartbeat and no elapsed time anywhere in this file. An acquisition ends when
 * its connection does.
 *
 * ## One acquisition begins one execution
 *
 * The hold remembers which execution this acquisition began, and so does the
 * owner. Both are needed: the runner's copy refuses a second begin before a
 * message is sent, and the owner's copy is what a settlement is actually
 * checked against, because a runner that lost track of its own hold must not be
 * able to finish an execution it never began.
 */

import { Err, ensure, Ok, type Operation, type Result, scoped } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  type ExecutorAcquisition,
  type ExecutorLock,
  WorkflowLifecycle,
} from "../lifecycle/api.ts";
import type {
  WorkflowBeginRequest,
  WorkflowExecutionBegun,
  WorkflowExecutionTransitions,
  WorkflowForkRequest,
  WorkflowRunCreation,
} from "../lifecycle/execution.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import type { DocumentExecutionCompletion, WorkflowRunRecord } from "../storage/record.ts";
import {
  WorkflowRequestError,
  WorkflowRunNotFoundError,
  type WorkflowStorageError,
} from "../storage/errors.ts";
import { useRemoteRunDatabase } from "./database.ts";
import { canonicalJson } from "../storage/record.ts";
import { definitionToJson } from "../storage/definition.ts";
import type { RemoteForkSource, RemoteReadPlane } from "./read.ts";
import { forkRunRecordEvent } from "../fork.ts";
import type {
  RemoteBegun,
  RemoteExecutorConnection,
  RemoteForkPart,
  RemoteLifecycleLink,
} from "./lifecycle-link.ts";

export type { RemoteExecutorConnection };

/**
 * What this provider needs from its host, and nothing more.
 *
 * Narrow on purpose: reaching an owner, reading a source without acquiring it,
 * and assembling a candidate somewhere local are host arrangements. None of
 * them is a registry, none enumerates anything, and none is public API.
 */
export interface RemoteLifecycleHost {
  /**
   * Admit one executor connection for this run, owned by the calling scope.
   *
   * Answers `already-running` when the owner refuses because another live
   * executor holds the run — a fact about the run, not a failure of this call.
   */
  admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">>;
  /** The no-acquisition read plane for one run, for copy and inspection only. */
  source(runId: string): Operation<Result<RemoteReadPlane>>;
  /**
   * Assemble one fork candidate in runner-local disposable storage.
   *
   * Takes no acquisition and creates nothing a host would discover. What it
   * returns belongs to the calling scope and goes when that scope ends.
   */
  stage(
    request: WorkflowForkRequest,
    source: RemoteForkSource,
    head: { readonly runRecord: DurableEvent; readonly rootImport: DurableEvent },
  ): Operation<Result<WorkflowRunDatabase>>;
  /** Fresh identities for this provider's own commands and executions. */
  readonly ids: { readonly execution: () => string; readonly command: () => string };
}

/**
 * One logical lifecycle invocation, as it is addressed and re-addressed.
 *
 * Minted once and kept by the run it belongs to rather than by the connection
 * that first sent it. A connection that died between an owner's commit and its
 * answer is exactly the case this exists for: the replacement acquisition asks
 * the same question, with the same identity and the same bytes, and the owner
 * answers with what it already decided instead of deciding again.
 */
interface Invocation {
  readonly commandId: string;
  readonly executionId: string;
  /** What this invocation asked, so a different question gets a new identity. */
  readonly shape: string;
}

/** What one issued lock is allowed to do, and what it has already done. */
interface Hold {
  readonly runId: string;
  readonly connection: RemoteExecutorConnection;
  /** Which execution this acquisition began, once it has begun one. */
  execution: string | undefined;
  /** Whether the connection this lock was issued beside is still open. */
  live: boolean;
}

/**
 * Install the remote executor lifecycle, and hand back its transitions.
 *
 * The transitions are returned rather than installed: they hand out an open
 * database, which is a transport, and a capability like that belongs to the
 * executor that already holds the lock rather than to a contextual surface
 * anything in the process can reach.
 */
export function* useRemoteLifecycle(
  host: RemoteLifecycleHost,
): Operation<WorkflowExecutionTransitions> {
  // Keyed by the object itself: two locks are the same lock when they are the
  // same object, and nothing about their fields is consulted.
  const held = new Map<ExecutorLock, Hold>();
  // Keyed by the run and the question asked, so the same question after a lost
  // answer is the same invocation. Not authority: what it carries is an
  // identity, and the owner decides what that identity already means.
  const invocations = new Map<string, Invocation>();

  function invocation(runId: string, shape: string): Invocation {
    const key = `${runId}\u0000${shape}`;
    const found = invocations.get(key);
    if (found !== undefined) {
      return found;
    }
    const minted: Invocation = {
      commandId: host.ids.command(),
      executionId: host.ids.execution(),
      shape,
    };
    invocations.set(key, minted);
    return minted;
  }

  function settled(runId: string, shape: string): void {
    invocations.delete(`${runId}\u0000${shape}`);
  }

  function hold(lock: ExecutorLock): Hold | undefined {
    // Fabricated, copied, foreign, released and closed locks all answer
    // `undefined` here — before a read plane, an owner command or a database is
    // touched.
    const found = held.get(lock);
    return found === undefined || !found.live ? undefined : found;
  }

  function* acquireExecutor(runId: string): Operation<Result<ExecutorAcquisition>> {
    if (runId === "") {
      return Err(new WorkflowRequestError("a workflow run id cannot be empty."));
    }
    const admitted = yield* host.admit(runId);
    if (!admitted.ok) {
      return admitted;
    }
    if (admitted.value === "already-running") {
      return Ok({ kind: "already-running" });
    }
    const connection = admitted.value;
    const lock: ExecutorLock = Object.freeze({ runId });
    const record: Hold = {
      runId,
      connection,
      execution: undefined,
      live: true,
    };
    held.set(lock, record);
    // Registered before it is returned, and retired when the scope that asked
    // for it ends — the same scope that owns the connection underneath.
    yield* ensure(function* () {
      record.live = false;
      held.delete(lock);
    });
    return Ok({ kind: "acquired", lock });
  }

  function* cancel(runId: string): Operation<Result<WorkflowRunRecord>> {
    if (runId === "") {
      return Err(new WorkflowRequestError("a workflow run id cannot be empty."));
    }
    // Cancellation takes an acquisition of its own for exactly this operation
    // and gives it back. It never reads the no-acquisition plane to decide
    // whether it may proceed: that plane holds no authority.
    return yield* scoped(function* () {
      const admitted = yield* host.admit(runId);
      if (!admitted.ok) {
        return admitted;
      }
      if (admitted.value === "already-running") {
        return Err(
          new WorkflowRequestError(
            "a live workflow executor holds this run, so it cannot be cancelled from here.",
          ),
        );
      }
      const shape = questionOf(["cancel"]);
      const addressed = invocation(runId, shape);
      const answered = yield* admitted.value.lifecycle.cancel(addressed.commandId, runId);
      if (!answered.ok) {
        return answered;
      }
      settled(runId, shape);
      if (answered.value.kind === "refused") {
        return Err(
          new WorkflowRequestError(
            answered.value.refusal === "terminal"
              ? "this run already reached a terminal outcome, so it cannot be cancelled."
              : "this run cannot be cancelled from the state it is in.",
          ),
        );
      }
      return Ok(answered.value.value);
    });
  }

  yield* WorkflowLifecycle.around(
    {
      *acquireExecutor([runId]): Operation<Result<ExecutorAcquisition>> {
        return yield* acquireExecutor(runId);
      },
      *cancel([runId]): Operation<Result<WorkflowRunRecord>> {
        return yield* cancel(runId);
      },
    },
    // Nearest wins, the same way storage and the read provider install: a
    // scope that installed this one answers with it, not with whatever an
    // enclosing scope happened to install first.
    { at: "min" },
  );

  return transitions(host, hold, invocation, settled);
}

/** What an unrecognized lock answers, wherever one is offered. */
function unauthorized(): WorkflowRequestError {
  return new WorkflowRequestError(
    "this executor lock was not issued by this provider, or its acquisition has ended.",
  );
}

function transitions(
  host: RemoteLifecycleHost,
  hold: (lock: ExecutorLock) => Hold | undefined,
  invocation: (runId: string, shape: string) => Invocation,
  settled: (runId: string, shape: string) => void,
): WorkflowExecutionTransitions {
  return {
    *begin(
      lock: ExecutorLock,
      request: WorkflowBeginRequest,
    ): Operation<Result<WorkflowExecutionBegun>> {
      const held = hold(lock);
      if (held === undefined) {
        return Err(unauthorized());
      }
      if (request.runId !== held.runId) {
        return Err(
          new WorkflowRequestError("this executor lock was issued for a different workflow run."),
        );
      }
      if (held.execution !== undefined) {
        return Err(
          new WorkflowRequestError(
            "this executor lock has already begun a document execution. One acquisition begins one.",
          ),
        );
      }
      if (request.action === "resume" && request.creation !== undefined) {
        return Err(new WorkflowRequestError("a resume does not carry a creation."));
      }
      // Minted once for this question, outside anything that could retry: the
      // owner recognizes a repeat by this identity, and a fresh one would be a
      // second execution. A later acquisition asking the same question finds
      // the same identity and re-observes the decision.
      const creation = creationOf(request.runId, request.creation);
      const shape = questionOf([
        "begin",
        request.action,
        creation === null ? null : creationShape(creation),
        request.creation?.retrieval === undefined
          ? null
          : canonicalJson(request.creation.retrieval),
      ]);
      const addressed = invocation(request.runId, shape);
      const answered = yield* held.connection.lifecycle.begin({
        commandId: addressed.commandId,
        runId: request.runId,
        action: request.action,
        creation,
        retrieval: request.creation?.retrieval,
        executionId: addressed.executionId,
      });
      if (!answered.ok) {
        // The answer is lost, not the question. The identity stays, so the
        // next acquisition asks the same one.
        return answered;
      }
      if (answered.value.kind === "refused") {
        settled(request.runId, shape);
        return Err(refusalError(answered.value.refusal, request.runId));
      }
      settled(request.runId, shape);
      held.execution = answered.value.value.execution.executionId;
      return Ok(yield* begun(held, answered.value.value));
    },

    *settle(
      lock: ExecutorLock,
      completion: DocumentExecutionCompletion,
    ): Operation<Result<WorkflowRunRecord>> {
      const held = hold(lock);
      if (held === undefined) {
        return Err(unauthorized());
      }
      if (held.execution !== completion.executionId) {
        // Nothing is sent. An execution this acquisition did not begin is not
        // this acquisition's to finish, and asking would be asking about
        // somebody else's work.
        return Err(
          new WorkflowRequestError(
            "this executor lock did not begin the document execution it is settling.",
          ),
        );
      }
      // The root the owner is held to comes from the same connection-owned
      // frontier the execution ran against, after the host has torn down.
      const frontier = yield* held.connection.link.frontierSnapshot();
      const shape = questionOf([
        "settle",
        completion.executionId,
        completion.status,
        frontier.workspaceRootId,
      ]);
      const addressed = invocation(held.runId, shape);
      const answered = yield* held.connection.lifecycle.settle(
        addressed.commandId,
        completion,
        frontier.workspaceRootId,
      );
      if (!answered.ok) {
        return answered;
      }
      settled(held.runId, shape);
      held.execution = undefined;
      return Ok(answered.value.record);
    },

    *fork(
      lock: ExecutorLock,
      request: WorkflowForkRequest,
    ): Operation<Result<WorkflowExecutionBegun>> {
      const held = hold(lock);
      if (held === undefined) {
        return Err(unauthorized());
      }
      if (request.runId !== held.runId) {
        return Err(
          new WorkflowRequestError("this executor lock was issued for a different workflow run."),
        );
      }
      if (held.execution !== undefined) {
        return Err(
          new WorkflowRequestError(
            "this executor lock has already begun a document execution. One acquisition begins one.",
          ),
        );
      }
      const source = yield* readSource(host, request);
      if (!source.ok) {
        return source;
      }
      const staged = yield* offer(host, held.connection.lifecycle, source.value);
      if (!staged.ok) {
        return staged;
      }
      const shape = questionOf([
        "fork",
        request.runId,
        source.value.anchor,
        source.value.checkpointEventId,
      ]);
      const addressed = invocation(request.runId, shape);
      const answered = yield* held.connection.lifecycle.commitFork({
        commandId: addressed.commandId,
        runId: request.runId,
        retrieval: request.creation.retrieval,
        creation: creationRequest(request.runId, request.creation),
        origin: {
          sourceRunId: source.value.sourceRunId,
          checkpointEventId: source.value.checkpointEventId,
          checkpointWorkspaceRootId: source.value.checkpointWorkspaceRootId,
          runRecordWorkspaceRootId: source.value.runRecordWorkspaceRootId,
          rootImportWorkspaceRootId: source.value.rootImportWorkspaceRootId,
          anchor: source.value.anchor,
        },
        counts: {
          inherited: source.value.inherited.length,
          roots: source.value.roots.length,
          manifests: source.value.manifests.length,
          blobs: source.value.blobs.length,
          checkouts: source.value.checkouts.length,
        },
        runRecord: headOf(request).runRecord,
        rootImport: request.rootImport,
        executionId: addressed.executionId,
      });
      if (!answered.ok) {
        return answered;
      }
      if (answered.value.kind === "refused") {
        settled(request.runId, shape);
        return Err(refusalError(answered.value.refusal, request.runId));
      }
      settled(request.runId, shape);
      held.execution = answered.value.value.execution.executionId;
      return Ok(yield* begun(held, answered.value.value));
    },

    *stageFork(request: WorkflowForkRequest): Operation<Result<WorkflowRunDatabase>> {
      const source = yield* readSource(host, request);
      if (!source.ok) {
        return source;
      }
      // No destination acquisition, no destination owner, nothing a host would
      // discover: the candidate is assembled locally and belongs to the scope
      // that asked for it.
      return yield* host.stage(request, source.value, headOf(request));
    },
  };
}

function* begun(held: Hold, answer: RemoteBegun): Operation<WorkflowExecutionBegun> {
  const database = yield* useRemoteRunDatabase(held.connection.link, answer.frontier);
  return {
    database,
    record: answer.frontier.record,
    execution: answer.execution,
    replay: answer.replay,
    ...(answer.recovered === null ? {} : { recovered: answer.recovered }),
  };
}

/**
 * The two records a fork writes for itself.
 *
 * Its own run record, because the fork is its own run and the source's record
 * describes the source; and the root import its own definition produced,
 * because a fork that inherited the source's would run the source's document.
 */
function headOf(request: WorkflowForkRequest): {
  readonly runRecord: DurableEvent;
  readonly rootImport: DurableEvent;
} {
  return {
    runRecord: forkRunRecordEvent({
      runId: request.runId,
      base: request.creation.base,
      pinnedCommit: request.creation.definition.objectId,
    }),
    rootImport: request.rootImport,
  };
}

/** One creation, as text: the fields a run's identity is compared by. */
function creationShape(creation: CreateWorkflowRunRequest): string {
  return canonicalJson({
    runId: creation.runId,
    definition: definitionToJson(creation.definition),
    base: creation.base,
    props: creation.props,
  });
}

/**
 * What one invocation is asking, as text two calls can be compared by.
 *
 * Canonical, so the same question always spells the same way, and a different
 * one never spells like it. This decides only whether a retry is the same
 * logical invocation; what that identity already means is the owner's to say.
 */
function questionOf(parts: readonly (string | null)[]): string {
  return canonicalJson([...parts]);
}

/** Read one source through the accepted no-acquisition plane. */
function* readSource(
  host: RemoteLifecycleHost,
  request: WorkflowForkRequest,
): Operation<Result<RemoteForkSource>> {
  if (request.selection.sourceRunId === "" || request.selection.checkpointEventId === "") {
    return Err(new WorkflowRequestError("a fork names one source run and one checkpoint."));
  }
  const plane = yield* host.source(request.selection.sourceRunId);
  if (!plane.ok) {
    return plane;
  }
  if (plane.value.runId !== request.selection.sourceRunId) {
    return Err(new WorkflowRunNotFoundError(request.selection.sourceRunId));
  }
  return yield* plane.value.forkSource(request.selection.checkpointEventId);
}

/**
 * Offer the whole snapshot as bounded parts, in the order it will be read back.
 *
 * Content crosses through the staging the publication path already uses, and
 * the rest — the roots, the inherited rows, the checkouts — crosses as parts
 * that name where they belong. Nothing here is a run: the final command decides
 * whether these add up to one.
 */
function* offer(
  host: RemoteLifecycleHost,
  lifecycle: RemoteLifecycleLink,
  source: RemoteForkSource,
): Operation<Result<void>> {
  const parts: RemoteForkPart[] = [];
  source.roots.forEach((root, position) => {
    parts.push({
      section: "roots",
      position,
      part: {
        rootId: root.rootId,
        formatVersion: root.formatVersion,
        manifest: root.manifest,
        manifestHashes: [...root.manifestHashes],
        blobHashes: [...root.blobHashes],
      },
    });
  });
  source.manifests.forEach((manifest, position) => {
    // The metadata, not the bytes: the bytes cross through the content staging
    // the publication path already uses, and what a digest cannot stand for is
    // the watermark copied beside it.
    parts.push({
      section: "manifests",
      position,
      part: { hash: manifest.hash, size: manifest.size, lastSeen: manifest.lastSeen },
    });
  });
  source.blobs.forEach((blob, position) => {
    parts.push({
      section: "blobs",
      position,
      part: { hash: blob.hash, size: blob.size, lastSeen: blob.lastSeen },
    });
  });
  source.inherited.forEach((row, position) => {
    parts.push({
      section: "inherited",
      position,
      part: { eventId: row.eventId, record: row.record, workspaceRootId: row.workspaceRootId },
    });
  });
  source.checkouts.forEach((checkout, position) => {
    parts.push({ section: "checkouts", position, part: { ...checkout } });
  });
  for (const part of parts) {
    const staged = yield* lifecycle.stageForkPart(host.ids.command(), part);
    if (!staged.ok) {
      return staged;
    }
  }
  return Ok(undefined);
}

function creationOf(
  runId: string,
  creation: WorkflowBeginRequest["creation"],
): CreateWorkflowRunRequest | null {
  return creation === undefined ? null : creationRequest(runId, creation);
}

/**
 * One creation, as the request storage retains.
 *
 * The definition and the props travel as the caller built them; what this adds
 * is the run they belong to. Normalizing them is the owner's, through the same
 * shared parser every host uses, so a remote run's identity is computed exactly
 * where a local one's is.
 */
function creationRequest(runId: string, creation: WorkflowRunCreation): CreateWorkflowRunRequest {
  return {
    runId,
    definition: creation.definition,
    base: creation.base,
    props: creation.props,
  };
}

function refusalError(
  refusal: "cancelled" | "resume-failed" | "terminal",
  runId: string,
): WorkflowStorageError {
  if (refusal === "cancelled") {
    return new WorkflowRequestError(`workflow run ${JSON.stringify(runId)} was cancelled.`);
  }
  if (refusal === "resume-failed") {
    return new WorkflowRequestError(
      `workflow run ${JSON.stringify(runId)} failed, so it cannot be resumed.`,
    );
  }
  return new WorkflowRequestError(
    `workflow run ${JSON.stringify(runId)} already reached a terminal outcome.`,
  );
}
