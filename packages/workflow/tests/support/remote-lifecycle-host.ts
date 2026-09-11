/**
 * A scripted host for the remote lifecycle provider.
 *
 * Stands in for reaching an owner, not for the owner: what it proves is what
 * the provider decides before and after a command — which lock authorizes,
 * which run is addressed, what reaches the transport at all. Whether an owner
 * transaction is atomic, whether admission contends, and whether an association
 * survives hibernation are owner facts and are proved against a real Durable
 * Object instead.
 */

import { ensure, Err, Ok, type Operation, type Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import type {
  RemoteBeginCommand,
  RemoteForkContinuation,
  RemoteBegun,
  RemoteExecutorConnection,
  RemoteForkCommit,
  RemoteForkPart,
  RemoteLifecycleAnswer,
  RemoteLifecycleLink,
} from "../../src/remote/lifecycle-link.ts";
import type { RemoteLifecycleHost } from "../../src/remote/lifecycle.ts";
import type {
  RemoteForkSource,
  RemoteFrontierSnapshot,
  RemoteReadPlane,
} from "../../src/remote/read.ts";
import type { WorkflowRunDatabase } from "../../src/storage/api.ts";
import type { WorkflowForkRequest } from "../../src/lifecycle/execution.ts";
import type {
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../../src/storage/record.ts";
import {
  WorkflowRequestError,
  WorkflowRunConflictError,
  WorkflowTransactionError,
} from "../../src/storage/errors.ts";
import type { RemoteWorkspaceLink } from "../../src/remote/database.ts";
import type { RemoteRetainedAnswer } from "../../src/remote/answer-link.ts";

export const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";
export const ROOT = "a".repeat(64);

/** What this host does when it is asked, and what it records while it does. */
export interface Script {
  /** Every command the provider actually sent. */
  readonly asked?: string[];
  /** Every run an acquisition was opened for. */
  readonly opened?: string[];
  /** Every run an acquisition was given back for at scope exit. */
  readonly closed?: string[];
  /** Every run whose connection was ended early, before its scope did. */
  readonly retired?: string[];
  /** Answer admission with a live executor rather than a connection. */
  readonly admit?: "already-running";
  /** Answer a begin with one of the run's own conditions. */
  readonly begin?: "cancelled" | "resume-failed";
  /** Report that recovery closed this execution on the way in. */
  readonly recovered?: string;
  /** Answer a begin with a run that kept its terminal state. */
  readonly replay?: boolean;
  /** Answer a fork commit with a conflict. */
  readonly forkConflict?: readonly string[];
  /** The source snapshot a fork reads, when a test supplies one. */
  readonly source?: RemoteForkSource;
  /** Every fork part the provider offered, in the order it offered them. */
  readonly staged?: RemoteForkPart[];
  /** Every fork commit the provider asked for. */
  readonly commits?: RemoteForkCommit[];
  /** Every command identity the provider addressed, in order. */
  readonly commands?: string[];
  /** Every command identity one staged fork part was offered under. */
  readonly parts?: string[];
  /** Every retrieval value a begin carried. */
  readonly retrievals?: (unknown | null)[];
  /** Answer every fork commit with a definitive conflict. */
  readonly forkRefuses?: boolean;
  /** Answer the first fork commit by saying its transfer is not here. */
  readonly needsTransfer?: Set<string>;
  /**
   * Held open until a test releases it, so a begin can be caught in flight.
   *
   * The owner has already decided by the time this is reached: what is caught
   * is the answer on its way back, which is the only moment an interrupted
   * mutation is genuinely ambiguous.
   */
  readonly gate?: { wait(): Operation<void> };
  /** The same, for a fork's final mutation: decided, and answer in flight. */
  readonly commitGate?: { wait(): Operation<void> };
  /** The same, for reading the source — where nothing has been mutated yet. */
  readonly sourceGate?: { wait(): Operation<void> };
  /** The same, for offering a staged part. */
  readonly stageGate?: { wait(): Operation<void> };
  /** Every execution this owner actually began, as opposed to re-answered. */
  readonly decided?: string[];
  /** Every run whose source was resolved. */
  readonly sourced?: string[];
  /** Whether a destination already holds this fork, so no source is needed. */
  readonly continues?: boolean;
  /** Command identities whose first answer is lost after the owner commits. */
  readonly loseAnswer?: Set<string>;
  /** What an owner decided for a command identity, once it has decided. */
  readonly committed?: Map<string, RemoteBegun>;
  /**
   * Every identity this host was asked to carry twice on one connection.
   *
   * The real client refuses that before the owner sees it, so a provider that
   * reuses an answered name gets a channel failure instead of a decision. This
   * host holds the same rule, and records every violation so a test can say
   * that none happened rather than only that the call came out right.
   */
  readonly reused?: string[];
}

export function record(): WorkflowRunRecord {
  return {
    runId: RUN_ID,
    definition: {
      version: 1,
      kind: "git",
      objectFormat: "sha1",
      objectId: "0".repeat(40),
      rootDocumentPath: "README.md",
    },
    base: "main",
    props: {},
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function frontier(): RemoteFrontierSnapshot {
  return {
    record: record(),
    retrieval: undefined,
    workspaceRootId: ROOT,
    journalEventId: null,
    entries: [],
  };
}

function execution(executionId: string): DocumentExecutionRecord {
  return { executionId, startedAt: "2026-01-01T00:00:00.000Z" };
}

function begun(executionId: string, script: Script = {}): RemoteBegun {
  return {
    frontier: frontier(),
    execution: execution(executionId),
    replay: script.replay === true,
    recovered: script.recovered === undefined ? null : execution(script.recovered),
  };
}

/** A link that answers the one read the provider makes of it. */
function link(): RemoteWorkspaceLink {
  const unsupported = () => {
    throw new WorkflowRequestError("this scripted link answers no such operation");
  };
  return {
    // deno-lint-ignore require-yield
    *frontierSnapshot(): Operation<RemoteFrontierSnapshot> {
      return frontier();
    },
    // deno-lint-ignore require-yield
    *pendingAnswer(): Operation<Result<RemoteRetainedAnswer | undefined>> {
      // These are lifecycle scripts. Nothing is delivered to their runs, and a
      // link that answered otherwise would end a wait no script reaches.
      return Ok(undefined);
    },
    // deno-lint-ignore require-yield
    *frontier(): Operation<never> {
      return unsupported();
    },
    // deno-lint-ignore require-yield
    *commit(): Operation<never> {
      return unsupported();
    },
    // deno-lint-ignore require-yield
    *replaceRetrieval(): Operation<never> {
      return unsupported();
    },
    // deno-lint-ignore require-yield
    *readExecutions(): Operation<never> {
      return unsupported();
    },
    // deno-lint-ignore require-yield
    *open(): Operation<never> {
      return unsupported();
    },
    // deno-lint-ignore require-yield
    *invocationSnapshot(): Operation<never> {
      return unsupported();
    },
    // deno-lint-ignore require-yield
    *root(): Operation<never> {
      return unsupported();
    },
    // deno-lint-ignore require-yield
    *content(): Operation<never> {
      return unsupported();
    },
  };
}

function lifecycle(script: Script): RemoteLifecycleLink {
  let minted = 0;
  // One connection's own correlation ids. The real client keeps exactly this
  // set — the ids it is waiting on and the ids it has already settled — and
  // refuses to send either again, so an identity that has been answered can
  // never carry another question on this connection.
  const spoken = new Set<string>();
  function reused<T>(commandId: string): Result<T> | undefined {
    if (!spoken.has(commandId)) {
      spoken.add(commandId);
      return undefined;
    }
    script.reused?.push(commandId);
    // What `OwnerConnection.ask()` raises for a duplicate id, as the adapter
    // translates it: the command never reaches an owner, and the caller is
    // told only that the channel could not carry it.
    return Err(new WorkflowTransactionError("this run's owner could not be reached."));
  }
  return {
    // deno-lint-ignore require-yield
    *begin(request: RemoteBeginCommand): Operation<Result<RemoteLifecycleAnswer<RemoteBegun>>> {
      const again = reused<RemoteLifecycleAnswer<RemoteBegun>>(request.commandId);
      if (again !== undefined) {
        return again;
      }
      script.asked?.push("begin");
      script.commands?.push(request.commandId);
      script.retrievals?.push(request.retrieval ?? null);
      if (script.loseAnswer?.has(request.commandId) === true) {
        // The owner committed and the answer never arrived.
        script.loseAnswer.delete(request.commandId);
        script.decided?.push(request.executionId);
        script.committed?.set(request.commandId, begun(request.executionId, script));
        return Err(new WorkflowTransactionError("the connection ended before it answered."));
      }
      const already = script.committed?.get(request.commandId);
      if (already !== undefined) {
        // The same question again: the decision it already made.
        return Ok({ kind: "performed", value: already });
      }
      if (script.begin !== undefined) {
        return Ok({ kind: "refused", refusal: script.begin });
      }
      minted += 1;
      const decided = begun(request.executionId, script);
      script.decided?.push(request.executionId);
      // Decided, and retained under the identity it was asked by, before the
      // answer starts back. A gate here catches the one moment that matters:
      // the owner has committed and the caller does not know it yet.
      script.committed?.set(request.commandId, decided);
      if (script.gate !== undefined) {
        yield* script.gate.wait();
      }
      return Ok({ kind: "performed", value: decided });
    },
    // deno-lint-ignore require-yield
    *settle(
      commandId: string,
      _completion: DocumentExecutionCompletion,
    ): Operation<Result<RemoteFrontierSnapshot>> {
      const again = reused<RemoteFrontierSnapshot>(commandId);
      if (again !== undefined) {
        return again;
      }
      script.asked?.push("settle");
      script.commands?.push(commandId);
      return Ok(frontier());
    },
    // deno-lint-ignore require-yield
    *cancel(commandId: string): Operation<Result<RemoteLifecycleAnswer<WorkflowRunRecord>>> {
      const again = reused<RemoteLifecycleAnswer<WorkflowRunRecord>>(commandId);
      if (again !== undefined) {
        return again;
      }
      script.asked?.push("cancel");
      script.commands?.push(commandId);
      if (script.loseAnswer?.has(commandId) === true) {
        script.loseAnswer.delete(commandId);
        return Err(new WorkflowTransactionError("the connection ended before it answered."));
      }
      return Ok({ kind: "performed", value: record() });
    },
    *stageForkPart(commandId: string, part: RemoteForkPart): Operation<Result<void>> {
      const again = reused<void>(commandId);
      if (again !== undefined) {
        return again;
      }
      script.asked?.push("fork-stage");
      script.staged?.push(part);
      script.parts?.push(commandId);
      if (script.stageGate !== undefined) {
        yield* script.stageGate.wait();
      }
      return Ok(undefined);
    },
    // deno-lint-ignore require-yield
    // deno-lint-ignore require-yield
    *continueFork(
      continuation: RemoteForkContinuation,
    ): Operation<Result<RemoteLifecycleAnswer<RemoteBegun> | "absent">> {
      const again = reused<RemoteLifecycleAnswer<RemoteBegun> | "absent">(continuation.commandId);
      if (again !== undefined) {
        return again;
      }
      script.asked?.push("fork-continue");
      script.commands?.push(continuation.commandId);
      const held = script.continues;
      if (held === undefined) {
        // Nothing there to continue, which sends the caller to the source.
        return Ok("absent");
      }
      return Ok({ kind: "performed", value: begun(continuation.executionId, script) });
    },

    *commitFork(
      commit: RemoteForkCommit,
    ): Operation<Result<RemoteLifecycleAnswer<RemoteBegun> | "needs-transfer">> {
      const again = reused<RemoteLifecycleAnswer<RemoteBegun> | "needs-transfer">(commit.commandId);
      if (again !== undefined) {
        return again;
      }
      script.asked?.push("fork");
      script.commits?.push(commit);
      if (script.forkConflict !== undefined) {
        return Err(new WorkflowRequestError("this destination is another run"));
      }
      void minted;
      script.commands?.push(commit.commandId);
      if (script.loseAnswer?.has(commit.commandId) !== true) {
        // Everything below either re-answers a decision this owner already
        // made or makes one now. A gate belongs after that, for the same
        // reason a begin's does.
        const already = script.committed?.get(commit.commandId);
        const answering =
          script.needsTransfer?.has(commit.commandId) === true || script.forkRefuses === true;
        if (already === undefined && !answering) {
          script.decided?.push(commit.executionId);
          script.committed?.set(commit.commandId, begun(commit.executionId, script));
        }
        if (script.commitGate !== undefined) {
          yield* script.commitGate.wait();
        }
      }
      if (script.loseAnswer?.has(commit.commandId) === true) {
        script.loseAnswer.delete(commit.commandId);
        // The mutation committed unless this scenario says it never did.
        if (script.needsTransfer?.has(commit.commandId) !== true) {
          script.decided?.push(commit.executionId);
          script.committed?.set(commit.commandId, begun(commit.executionId, script));
        }
        return Err(new WorkflowTransactionError("the connection ended before it answered."));
      }
      if (script.needsTransfer?.has(commit.commandId) === true) {
        script.needsTransfer.delete(commit.commandId);
        return Ok<RemoteLifecycleAnswer<RemoteBegun> | "needs-transfer">("needs-transfer");
      }
      if (script.forkRefuses === true) {
        return Err(new WorkflowRunConflictError(commit.runId, ["definition"]));
      }
      const already = script.committed?.get(commit.commandId);
      if (already !== undefined) {
        return Ok({ kind: "performed", value: already });
      }
      return Ok({ kind: "performed", value: begun(commit.executionId, script) });
    },
  };
}

/** The provider's host, scripted. */
export function installedHost(script: Script): RemoteLifecycleHost {
  let executions = 0;
  let commands = 0;
  return {
    *admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">> {
      if (script.admit === "already-running") {
        return Ok("already-running");
      }
      script.opened?.push(runId);
      const connection: RemoteExecutorConnection = {
        link: link(),
        lifecycle: lifecycle(script),
        // deno-lint-ignore require-yield
        *close(): Operation<void> {
          script.retired?.push(runId);
        },
      };
      yield* ensureClosed(script, runId);
      return Ok(connection);
    },
    // deno-lint-ignore require-yield
    *source(runId: string): Operation<Result<RemoteReadPlane>> {
      script.sourced?.push(runId);
      const held = script.source;
      if (held === undefined) {
        return Err(new WorkflowRequestError("this scripted host holds no source"));
      }
      return Ok({
        runId,
        // deno-lint-ignore require-yield
        *inspect(): Operation<Result<never>> {
          throw new WorkflowRequestError("this scripted plane answers no inspection");
        },
        // deno-lint-ignore require-yield
        *history(): Operation<Result<never>> {
          throw new WorkflowRequestError("this scripted plane answers no history");
        },
        *forkSource(): Operation<Result<RemoteForkSource>> {
          if (script.sourceGate !== undefined) {
            yield* script.sourceGate.wait();
          }
          return Ok(held);
        },
      });
    },
    // deno-lint-ignore require-yield
    *stage(
      _request: WorkflowForkRequest,
      _source: RemoteForkSource,
      _head: { readonly runRecord: DurableEvent; readonly rootImport: DurableEvent },
    ): Operation<Result<WorkflowRunDatabase>> {
      return Err(new WorkflowRequestError("this scripted host stages nothing"));
    },
    ids: {
      execution: () => {
        executions += 1;
        return `execution-${executions}`;
      },
      command: () => {
        commands += 1;
        return `command-${commands}`;
      },
    },
  };
}

function* ensureClosed(script: Script, runId: string): Operation<void> {
  yield* ensure(function* () {
    script.closed?.push(runId);
  });
}
