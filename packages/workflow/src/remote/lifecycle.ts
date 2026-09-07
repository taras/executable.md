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
  WorkflowTransactionError,
} from "../storage/errors.ts";
import { useRemoteRunDatabase } from "./database.ts";
import { canonicalJson } from "../storage/record.ts";
import { definitionToJson } from "../storage/definition.ts";
import type { RemoteForkSource, RemoteReadPlane } from "./read.ts";
import { forkRunRecordEvent } from "../fork.ts";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type {
  RemoteBegun,
  RemoteExecutorConnection,
  RemoteForkCommit,
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
 * One logical lifecycle call, as this provider owns it.
 *
 * A call is not the same call as another because their arguments compare equal:
 * two identical `begin()` calls are two calls, and the second must be refused
 * rather than handed the first one's execution. What may reuse an identity is
 * one narrow thing — the continuation of a call whose answer was lost after the
 * owner may already have committed — and that is what this records.
 *
 * `in flight` is held by the acquisition, so a second transition under one live
 * lock is refused before anything is sent. `ambiguous` outlives the connection
 * it was sent on, because the whole point is that a replacement acquisition
 * asks the same question. A definitive answer — a decision, a conflict, an
 * owner refusal — retires the record: it has been answered, and a later
 * corrected request is a new call with new identities.
 */
interface Ambiguous {
  readonly commandId: string;
  readonly executionId: string;
  /** The complete canonical request this identity belongs to. */
  readonly question: string;
  /**
   * Which phase of its call this identity belongs to.
   *
   * A fork can be told, definitively, that the destination holds nothing and
   * was offered nothing — `needs-transfer`. That answer finishes the identity
   * it was given: the owner has answered it, and the same name may never carry
   * a question again. What follows is a second transfer of the same logical
   * fork under an identity of its own, and this says which of the two an
   * invocation is, so a retry resumes the phase it is in rather than reaching
   * back for a name that has already been answered.
   */
  readonly phase: "initial" | "retransfer";
  /** The exact command that was sent, resent verbatim on continuation. */
  readonly command: RemoteForkCommit | undefined;
}

/** What one issued lock is allowed to do, and what it has already done. */
interface Hold {
  readonly runId: string;
  readonly connection: RemoteExecutorConnection;
  /** Which execution this acquisition began, once it has begun one. */
  execution: string | undefined;
  /**
   * Whether a transition is in flight on this acquisition.
   *
   * One acquisition begins one execution, and it has to be refused while the
   * first call is still waiting as well as after it returns — otherwise two
   * identical calls both pass the check and both send.
   */
  busy: boolean;
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
  const ambiguous = new Map<string, Ambiguous>();

  /**
   * The identity this call carries.
   *
   * A fresh identity, unless this is the continuation of a call whose answer
   * was lost and whose question is exactly this one.
   */
  function identify(runId: string, question: string): Ambiguous {
    const found = ambiguous.get(runId);
    if (found !== undefined && found.question === question) {
      return found;
    }
    return {
      commandId: host.ids.command(),
      executionId: host.ids.execution(),
      question,
      phase: "initial",
      command: undefined,
    };
  }

  /** Remember a call whose answer never arrived, with what it sent. */
  function unanswered(runId: string, held: Ambiguous, command?: RemoteForkCommit): void {
    ambiguous.set(runId, { ...held, command: command ?? held.command });
  }

  /** Retire a call that was answered, whatever the answer was. */
  function answeredNow(runId: string, held: Ambiguous): void {
    const found = ambiguous.get(runId);
    if (found?.commandId === held.commandId) {
      ambiguous.delete(runId);
    }
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
      busy: false,
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
      const question = questionOf(["cancel"]);
      const addressed = identify(runId, question);
      // The same line the transitions draw, on a call that has no acquisition
      // of its own to retire: if this is interrupted after the command went
      // out, the question is retained so a later attempt asks that one rather
      // than a new one. The connection ends with this scope either way.
      let outstanding = false;
      // deno-lint-ignore require-yield
      yield* ensure(function* () {
        if (outstanding) {
          unanswered(runId, addressed);
        }
      });
      outstanding = true;
      const answered = yield* admitted.value.lifecycle.cancel(
        commandOf(addressed, "cancel"),
        runId,
      );
      outstanding = false;
      if (!answered.ok) {
        // The same distinction the other mutations make. A cancellation may
        // have committed before its answer was lost, and the next attempt has
        // to ask that question rather than a new one.
        if (lost(answered.error)) {
          unanswered(runId, addressed);
        } else {
          answeredNow(runId, addressed);
        }
        return answered;
      }
      answeredNow(runId, addressed);
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

  return transitions(host, hold, identify, unanswered, answeredNow);
}

/**
 * One transition's grip on its acquisition, ended however the transition ends.
 *
 * An outstanding command is the line between two very different cancellations.
 * Before one has gone out, nothing can have happened, so the guard simply
 * lifts. After one has gone out and no answer came back, the owner's decision
 * is unknown — so the exact question is retained first, and then the
 * acquisition is retired rather than freed, because a fresh mutation racing an
 * unknown decision is the one thing that must not happen. Whoever wants to
 * continue takes a new acquisition and asks the retained question again.
 *
 * A transition sends more than one command, and only the last of them is in
 * flight at a time. So `sending` and `answered` bracket one command each,
 * while `done` is what says the whole public transition has returned. A
 * preliminary answer in the middle of a fork is not the end of the fork, and
 * treating it as one is how a cancellation during the source read used to slip
 * past cleanup entirely.
 */
interface Grip {
  /**
   * One command is going out now.
   *
   * `retain` is what to remember if this call is interrupted before the answer
   * arrives: the exact identity, and the exact bytes when there are any. It
   * runs only on that path, because a command that was answered is not
   * ambiguous however the answer read.
   */
  sending(retain: () => void): void;
  /** Say that the command in flight was answered, whatever the answer was. */
  answered(): void;
  /** Say that this public transition has returned. */
  done(): void;
}

/**
 * Take this acquisition for one transition, or say why it cannot be taken.
 *
 * One acquisition begins one execution. Two identical calls are two calls, so
 * the second is refused while the first is still in flight as well as after it
 * has returned.
 */
function engage(held: Hold): WorkflowRequestError | undefined {
  if (held.execution !== undefined || held.busy) {
    return new WorkflowRequestError(
      "this executor lock has already begun a document execution. One acquisition begins one.",
    );
  }
  held.busy = true;
  return undefined;
}

/**
 * Register how this transition lets go, before it can be interrupted.
 *
 * `ensure` runs on every exit — a return, a raise, or cancellation while an
 * owner answer is still outstanding — so no path can leave the guard held or
 * leave a sent command unaccounted for.
 */
function* gripped(held: Hold, guard: boolean): Operation<Grip> {
  let outstanding: (() => void) | undefined;
  let finished = false;
  const release = () => {
    if (guard) {
      held.busy = false;
    }
  };
  yield* ensure(function* () {
    if (finished) {
      return;
    }
    const retain = outstanding;
    if (retain !== undefined) {
      // A command went out and nothing came back. What it was asking is
      // retained first — a cancellation unwinds past the branches that would
      // have retained it, and an identity nobody kept is one no replacement
      // can ask under. Then this acquisition is retired rather than released:
      // its authority ends with it, and nothing new can be sent on it while
      // the first outcome is unknown. The connection goes with it, because a
      // lock nobody may use whose socket still holds the run would leave the
      // run unreachable by anyone at all.
      retain();
      held.live = false;
      yield* held.connection.close();
      return;
    }
    release();
  });
  return {
    sending(retain: () => void) {
      outstanding = retain;
    },
    answered() {
      outstanding = undefined;
    },
    done() {
      finished = true;
      release();
    },
  };
}

/**
 * Run one public transition holding this acquisition.
 *
 * The grip is taken before the body starts and given back when the body
 * returns, however many commands the body sent on the way. A body that is
 * interrupted never reaches the release, which is exactly the point: what
 * happens then is the cleanup `gripped` registered, decided by whether a
 * command was outstanding at the moment of the interruption.
 */
function* holding<T>(held: Hold, guard: boolean, body: (grip: Grip) => Operation<T>): Operation<T> {
  const grip = yield* gripped(held, guard);
  const outcome = yield* body(grip);
  grip.done();
  return outcome;
}

/**
 * Whether a failure left the owner's decision unknown.
 *
 * A refusal or a conflict is an answer: the owner decided, and the question is
 * finished. A transport that ended without answering is not, and the same
 * question has to be asked again rather than replaced by a new one.
 */
function lost(error: WorkflowStorageError): boolean {
  return error instanceof WorkflowTransactionError;
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
  identify: (runId: string, question: string) => Ambiguous,
  unanswered: (runId: string, held: Ambiguous, command?: RemoteForkCommit) => void,
  answeredNow: (runId: string, held: Ambiguous) => void,
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
      const busy = engage(held);
      if (busy !== undefined) {
        return Err(busy);
      }
      return yield* holding(held, true, function* (grip) {
        if (request.action === "resume" && request.creation !== undefined) {
          return Err(new WorkflowRequestError("a resume does not carry a creation."));
        }
        // Minted once for this question, outside anything that could retry: the
        // owner recognizes a repeat by this identity, and a fresh one would be a
        // second execution. A later acquisition asking the same question finds
        // the same identity and re-observes the decision.
        const creation = creationOf(request.runId, request.creation);
        const question = questionOf([
          "begin",
          request.action,
          creation === null ? null : creationShape(creation),
          request.creation?.retrieval === undefined
            ? null
            : canonicalJson(request.creation.retrieval),
        ]);
        const addressed = identify(request.runId, question);
        grip.sending(() => unanswered(request.runId, addressed));
        const answered = yield* held.connection.lifecycle.begin({
          commandId: commandOf(addressed, "begin"),
          runId: request.runId,
          action: request.action,
          creation,
          retrieval: request.creation?.retrieval,
          executionId: addressed.executionId,
        });
        grip.answered();
        if (!answered.ok) {
          // Which kind of failure decides whether the question survives it. An
          // answer that was lost leaves the identity standing, so a replacement
          // acquisition asks the same one; anything the owner actually decided
          // retires it.
          if (lost(answered.error)) {
            unanswered(request.runId, addressed);
          } else {
            answeredNow(request.runId, addressed);
          }
          return answered;
        }
        answeredNow(request.runId, addressed);
        if (answered.value.kind === "refused") {
          return Err(refusalError(answered.value.refusal, request.runId));
        }
        held.execution = answered.value.value.execution.executionId;
        return Ok(yield* begun(held, answered.value.value));
      });
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
      // A settlement runs on an acquisition that already holds its execution,
      // so it takes no one-execution guard — but it sends a mutation, and an
      // interrupted mutation is retained and retires its acquisition exactly
      // the way begin's is.
      return yield* holding(held, false, function* (grip) {
        // The root the owner is held to comes from the same connection-owned
        // frontier the execution ran against, after the host has torn down.
        const frontier = yield* held.connection.link.frontierSnapshot();
        const question = questionOf([
          "settle",
          completion.executionId,
          completion.status,
          // The whole completion, stop reason included: a settlement that named
          // a different reason is a different settlement.
          canonicalJson(completion.reason ?? null),
          frontier.workspaceRootId,
        ]);
        const addressed = identify(held.runId, question);
        grip.sending(() => unanswered(held.runId, addressed));
        const answered = yield* held.connection.lifecycle.settle(
          commandOf(addressed, "settle"),
          completion,
          frontier.workspaceRootId,
        );
        grip.answered();
        if (!answered.ok) {
          if (lost(answered.error)) {
            unanswered(held.runId, addressed);
          } else {
            answeredNow(held.runId, addressed);
          }
          return answered;
        }
        answeredNow(held.runId, addressed);
        held.execution = undefined;
        return Ok(answered.value.record);
      });
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
      const busy = engage(held);
      if (busy !== undefined) {
        return Err(busy);
      }
      return yield* holding(held, true, function* (grip) {
        const head = headOf(request);
        const creation = creationRequest(request.runId, request.creation);
        const question = questionOf([
          "fork",
          request.runId,
          creationShape(creation),
          request.creation.retrieval === undefined
            ? null
            : canonicalJson(request.creation.retrieval),
          request.selection.sourceRunId,
          request.selection.checkpointEventId,
          serializeDurableEvent(head.runRecord),
          serializeDurableEvent(request.rootImport),
        ]);
        let addressed = identify(request.runId, question);

        // Before the source: a destination that already holds this fork can be
        // continued from what it retains, and a decision this owner already made
        // can be re-observed. Either way the source is not needed, and it may not
        // be there any more.
        const outstanding = addressed.command;
        if (outstanding !== undefined) {
          // An exact command was sent once and never answered. It is resent
          // verbatim, and every outcome is classified here: nothing else is
          // tried until this one's is known.
          const resent = addressed;
          grip.sending(() => unanswered(request.runId, resent, outstanding));
          const retained = yield* held.connection.lifecycle.commitFork(outstanding);
          grip.answered();
          if (!retained.ok) {
            if (lost(retained.error)) {
              // Ambiguous again. The claim stands, and no other command is sent.
              unanswered(request.runId, resent, outstanding);
            } else {
              answeredNow(request.runId, resent);
            }
            return retained;
          }
          if (retained.value !== "needs-transfer") {
            answeredNow(request.runId, resent);
            if (retained.value.kind === "refused") {
              return Err(refusalError(retained.value.refusal, request.runId));
            }
            held.execution = retained.value.value.execution.executionId;
            return Ok(yield* begun(held, retained.value.value));
          }
          // The one outcome that sends this same logical fork back to its
          // source: the destination holds nothing, and the parts this command
          // names went with the connection that offered them.
          answeredNow(request.runId, resent);
          if (resent.phase !== "initial") {
            // This was already the second transfer. Offering the same snapshot a
            // third time would meet the same answer.
            return Err(
              new WorkflowRequestError("this fork's transfer did not reach its destination."),
            );
          }
          // That answer finished the identity it was asked under, and a name the
          // owner has answered may never carry another question. The rest of
          // this call is a second transfer, under an identity of its own.
          addressed = retransfer(host, question);
        }
        if (addressed.phase === "initial") {
          // Whether the destination already holds this fork. A second transfer
          // never asks: the destination answered that question by saying it
          // holds nothing and was offered nothing.
          const asking = addressed;
          grip.sending(() => unanswered(request.runId, asking));
          const continued = yield* held.connection.lifecycle.continueFork({
            commandId: commandOf(asking, "continue"),
            runId: request.runId,
            creation,
            // What this request names, which the destination proves against what
            // it retained. Nothing here was read from the source.
            origin: {
              sourceRunId: request.selection.sourceRunId,
              checkpointEventId: request.selection.checkpointEventId,
            },
            runRecord: head.runRecord,
            rootImport: request.rootImport,
            executionId: asking.executionId,
          });
          grip.answered();
          if (!continued.ok) {
            if (lost(continued.error)) {
              unanswered(request.runId, asking);
            } else {
              answeredNow(request.runId, asking);
            }
            return continued;
          }
          if (continued.value !== "absent") {
            answeredNow(request.runId, asking);
            if (continued.value.kind === "refused") {
              return Err(refusalError(continued.value.refusal, request.runId));
            }
            held.execution = continued.value.value.execution.executionId;
            return Ok(yield* begun(held, continued.value.value));
          }
        }

        // Nothing there. Making a fork needs the whole source, staged under this
        // acquisition and committed in one transaction.
        // Nothing has been mutated yet, so the guard is simply held across the
        // source read and the staging: a cancellation here retains no question
        // and leaves the acquisition usable.
        const source = yield* readSource(host, request);
        if (!source.ok) {
          answeredNow(request.runId, addressed);
          return source;
        }
        const staged = yield* offer(addressed, held.connection.lifecycle, source.value);
        if (!staged.ok) {
          return staged;
        }
        const command: RemoteForkCommit = {
          commandId: commandOf(addressed, "commit"),
          runId: request.runId,
          retrieval: request.creation.retrieval,
          creation,
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
          runRecord: head.runRecord,
          rootImport: request.rootImport,
          executionId: addressed.executionId,
        };
        const committing = addressed;
        // Kept with the exact bytes it was sent with, so a replacement
        // acquisition resends this command rather than reading the source again.
        grip.sending(() => unanswered(request.runId, committing, command));
        const answered = yield* held.connection.lifecycle.commitFork(command);
        grip.answered();
        if (!answered.ok) {
          if (lost(answered.error)) {
            unanswered(request.runId, committing, command);
          } else {
            answeredNow(request.runId, committing);
          }
          return answered;
        }
        answeredNow(request.runId, committing);
        if (answered.value === "needs-transfer") {
          // Offered and still not there. Repeating the same transfer would meet
          // the same answer.
          return Err(
            new WorkflowRequestError("this fork's transfer did not reach its destination."),
          );
        }
        if (answered.value.kind === "refused") {
          return Err(refusalError(answered.value.refusal, request.runId));
        }
        held.execution = answered.value.value.execution.executionId;
        return Ok(yield* begun(held, answered.value.value));
      });
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
 * One internal command's own identity within a logical call.
 *
 * A fork asks the destination more than one question — whether it already
 * holds this fork, and then to commit the transfer — and the owner keys a
 * retained decision by the identity it was asked under. One identity naming
 * two different requests would meet its own earlier fingerprint and be refused
 * as a repeat of something else, so each kind gets its own, derived from the
 * call so that a retry spells it the same way.
 */
function commandOf(invocation: Ambiguous, kind: string): string {
  return `${invocation.commandId}:${kind}`;
}

/**
 * The identity the second transfer of one fork is carried under.
 *
 * `needs-transfer` is an answer: the destination holds no run and was offered
 * no parts, and the command that asked has been answered by name. Every
 * command of what follows — the offers and the commit — is a question that
 * name has never carried, so it takes a whole new identity rather than a
 * variation on the answered one. The execution identity is new for the same
 * reason: the answered decision began nothing, so there is nothing to inherit.
 */
function retransfer(host: RemoteLifecycleHost, question: string): Ambiguous {
  return {
    commandId: host.ids.command(),
    executionId: host.ids.execution(),
    question,
    phase: "retransfer",
    command: undefined,
  };
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
  invocation: Ambiguous,
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
    // Named by the call and the place in it, so restaging the same logical
    // fork offers the same parts under the same identities.
    const staged = yield* lifecycle.stageForkPart(
      commandOf(invocation, `part:${part.section}:${part.position}`),
      part,
    );
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
