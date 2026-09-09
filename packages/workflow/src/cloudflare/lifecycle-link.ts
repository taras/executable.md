/**
 * The lifecycle commands, spelled for this owner.
 *
 * The same connection that reads a run and commits to it is the one that
 * begins, settles, cancels and forks it: the authority is the socket, and
 * splitting the lifecycle onto a second link would be a second authority. So
 * this is built from the same connection as the Workspace half and composed
 * with it, never paired from somewhere else.
 *
 * Everything an owner answers is parsed before it becomes a value. A begin that
 * says it began an execution has to say which one, against a frontier that
 * describes this run; a refusal has to be one of the three conditions this
 * build knows; and anything else is an answer this build cannot read, reported
 * as damage rather than guessed at.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type {
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  WorkflowRunRecord,
} from "../storage/record.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import type { RemoteFrontierSnapshot } from "../remote/read.ts";
import type {
  RemoteBeginCommand,
  RemoteBegun,
  RemoteForkCommit,
  RemoteForkContinuation,
  RemoteForkPart,
  RemoteLifecycleAnswer,
  RemoteLifecycleLink,
} from "../remote/lifecycle-link.ts";
import type { RemoteLifecycleRefusal } from "../remote/lifecycle-link.ts";
import { WorkflowRecordMalformedError, WorkflowRunConflictError } from "../storage/errors.ts";
import { parseRemoteExecution } from "../remote/records.ts";
import type { AnchoringReadLink, OwnerConnection } from "./client.ts";
import { privateRefusal, storageFailure, translate } from "./client.ts";

/** The conditions an owner may name, and the only ones this build reads. */
const REFUSALS: readonly RemoteLifecycleRefusal[] = [
  "cancelled",
  "resume-failed",
  "terminal",
  "damaged-terminal",
];

function refusalOf(value: unknown): RemoteLifecycleRefusal | undefined {
  return REFUSALS.find((refusal) => refusal === value);
}

function fail(reason: string): never {
  throw new WorkflowRecordMalformedError("lifecycle answer this run's owner returned", reason);
}

function members(value: unknown, names: readonly string[]): Map<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("it was not one object");
  }
  const found = new Map(Object.entries(value));
  if (found.size !== names.length || names.some((name) => !found.has(name))) {
    return fail("it did not carry the members this build reads");
  }
  return found;
}

/** The three fields a lifecycle answer is one of, and never two of. */
function answered<T>(
  value: unknown,
  runId: string,
  read: (value: unknown) => T,
): RemoteLifecycleAnswer<T> {
  const found = members(value, ["conflict", "refusal", "value"]);
  const conflict = found.get("conflict");
  const refusal = found.get("refusal");
  const held = found.get("value");
  const present = [conflict, refusal, held].filter((member) => member !== null).length;
  if (present !== 1) {
    return fail("it did not answer exactly one way");
  }
  if (conflict !== null) {
    if (!Array.isArray(conflict) || conflict.length === 0) {
      return fail("it named no differing field");
    }
    throw new WorkflowRunConflictError(
      runId,
      conflict.map((field) => (typeof field === "string" ? field : fail("it named no field"))),
    );
  }
  if (refusal !== null) {
    const named = refusalOf(refusal);
    if (named === undefined) {
      return fail("it named no condition this build reads");
    }
    return { kind: "refused", refusal: named };
  }
  return { kind: "performed", value: read(held) };
}

function execution(value: unknown): DocumentExecutionRecord {
  return parseRemoteExecution(value);
}

/**
 * One lifecycle link over an admitted connection.
 *
 * `reads` is the same anchoring read link the Workspace half uses, so a
 * frontier this returns is assembled exactly the way every other frontier is.
 */
export function cloudflareLifecycleLink(
  connection: OwnerConnection,
  reads: AnchoringReadLink,
  nextId: () => string,
): RemoteLifecycleLink {
  function* frontierOf(value: unknown): Operation<RemoteFrontierSnapshot> {
    return yield* reads.anchored(reads.parseHeader(value));
  }

  function* begun(value: unknown): Operation<RemoteBegun> {
    const found = members(value, ["frontier", "execution", "replay", "recovered"]);
    if (typeof found.get("replay") !== "boolean") {
      return fail("it did not say whether the run replayed");
    }
    const recovered = found.get("recovered");
    return {
      frontier: yield* frontierOf(found.get("frontier")),
      execution: execution(found.get("execution")),
      replay: found.get("replay") === true,
      recovered: recovered === null ? null : execution(recovered),
    };
  }

  return {
    *begin(request: RemoteBeginCommand): Operation<Result<RemoteLifecycleAnswer<RemoteBegun>>> {
      try {
        const offered = yield* connection.ask(
          request.commandId,
          {
            command: "begin",
            runId: request.runId,
            action: request.action,
            creation: request.creation,
            retrieval: request.retrieval ?? null,
            executionId: request.executionId,
          },
          (value: unknown) => value,
          privateRefusal,
        );
        if (offered.outcome === "refused") {
          return Err(storageFailure(privateRefusal(offered.refusal)));
        }
        // Parsed outside the answer callback because assembling a frontier is
        // more owner reads, and those belong to this operation rather than to
        // the one message that carried the header.
        const decided = answered(offered.value, request.runId, (value) => value);
        if (decided.kind === "refused") {
          return Ok(decided);
        }
        return Ok({ kind: "performed", value: yield* begun(decided.value) });
      } catch (error) {
        return Err(translate(error));
      }
    },

    *settle(
      commandId: string,
      completion: DocumentExecutionCompletion,
      expectedWorkspaceRootId: string,
    ): Operation<Result<RemoteFrontierSnapshot>> {
      try {
        const offered = yield* connection.ask(
          commandId,
          { command: "settle", completion, expectedWorkspaceRootId },
          (value: unknown) => value,
          privateRefusal,
        );
        if (offered.outcome === "refused") {
          return Err(storageFailure(privateRefusal(offered.refusal)));
        }
        return Ok(yield* frontierOf(offered.value));
      } catch (error) {
        return Err(translate(error));
      }
    },

    *cancel(
      commandId: string,
      runId: string,
    ): Operation<Result<RemoteLifecycleAnswer<WorkflowRunRecord>>> {
      try {
        const offered = yield* connection.ask(
          commandId,
          { command: "cancel", runId },
          (value: unknown) => value,
          privateRefusal,
        );
        if (offered.outcome === "refused") {
          return Err(storageFailure(privateRefusal(offered.refusal)));
        }
        const decided = answered(offered.value, runId, (value) => value);
        if (decided.kind === "refused") {
          return Ok(decided);
        }
        const frontier = yield* frontierOf(decided.value);
        return Ok({ kind: "performed", value: frontier.record });
      } catch (error) {
        return Err(translate(error));
      }
    },

    *stageForkPart(commandId: string, part: RemoteForkPart): Operation<Result<void>> {
      try {
        const offered = yield* connection.ask(
          commandId,
          {
            command: "fork-stage",
            section: part.section,
            position: part.position,
            part: part.part,
          },
          (value: unknown) => members(value, ["staged"]).get("staged"),
          privateRefusal,
        );
        if (offered.outcome === "refused") {
          return Err(storageFailure(privateRefusal(offered.refusal)));
        }
        return Ok(undefined);
      } catch (error) {
        return Err(translate(error));
      }
    },

    *continueFork(
      continuation: RemoteForkContinuation,
    ): Operation<Result<RemoteLifecycleAnswer<RemoteBegun> | "absent">> {
      try {
        const offered = yield* connection.ask(
          continuation.commandId,
          {
            command: "fork-continue",
            runId: continuation.runId,
            creation: continuation.creation,
            origin: continuation.origin,
            runRecord: record(continuation.runRecord),
            rootImport: record(continuation.rootImport),
            executionId: continuation.executionId,
          },
          (value: unknown) => value,
          privateRefusal,
        );
        if (offered.outcome === "refused") {
          const refusal = privateRefusal(offered.refusal);
          if (refusal === "command:absent") {
            // Nothing there to continue. Not a failure: the caller's next move
            // is the source copy it has not needed until now.
            return Ok<RemoteLifecycleAnswer<RemoteBegun> | "absent">("absent");
          }
          return Err(storageFailure(refusal));
        }
        const decided = yield* forked(offered.value, continuation.runId);
        return decided.ok
          ? Ok<RemoteLifecycleAnswer<RemoteBegun> | "absent">(decided.value)
          : decided;
      } catch (error) {
        return Err(translate(error));
      }
    },
    *commitFork(
      commit: RemoteForkCommit,
    ): Operation<Result<RemoteLifecycleAnswer<RemoteBegun> | "needs-transfer">> {
      try {
        const offered = yield* connection.ask(
          commit.commandId,
          {
            command: "fork",
            runId: commit.runId,
            creation: commit.creation,
            retrieval: commit.retrieval ?? null,
            origin: commit.origin,
            counts: commit.counts,
            runRecord: record(commit.runRecord),
            rootImport: record(commit.rootImport),
            executionId: commit.executionId,
          },
          (value: unknown) => value,
          privateRefusal,
        );
        if (offered.outcome === "refused") {
          const refusal = privateRefusal(offered.refusal);
          if (refusal === "command:needs-transfer") {
            // The destination is empty and this connection offered it nothing.
            // A closed outcome, not a failure: the caller copies the source.
            const outcome: RemoteLifecycleAnswer<RemoteBegun> | "needs-transfer" = "needs-transfer";
            return Ok(outcome);
          }
          return Err(storageFailure(refusal));
        }
        const decided = yield* forked(offered.value, commit.runId);
        return decided.ok
          ? Ok<RemoteLifecycleAnswer<RemoteBegun> | "needs-transfer">(decided.value)
          : decided;
      } catch (error) {
        return Err(translate(error));
      }
    },
  };

  /** One fork answer: a conflict, a condition, or the destination it made. */
  function* forked(
    value: unknown,
    runId: string,
  ): Operation<Result<RemoteLifecycleAnswer<RemoteBegun>>> {
    const found = members(value, ["conflict", "refusal", "value"]);
    const refusal = found.get("refusal");
    if (refusal !== null) {
      const named = refusalOf(refusal);
      if (named === undefined) {
        return Err(
          new WorkflowRecordMalformedError(
            "lifecycle answer this run's owner returned",
            "it named no condition this build reads",
          ),
        );
      }
      return Ok({ kind: "refused", refusal: named });
    }
    const conflict = found.get("conflict");
    if (conflict !== null) {
      if (!Array.isArray(conflict) || conflict.length === 0) {
        return Err(
          new WorkflowRecordMalformedError(
            "lifecycle answer this run's owner returned",
            "it named no differing field",
          ),
        );
      }
      return Err(
        new WorkflowRunConflictError(
          runId,
          conflict.map((field) => (typeof field === "string" ? field : "definition")),
        ),
      );
    }
    const held = members(found.get("value"), ["frontier", "execution", "replay", "recovered"]);
    if (typeof held.get("replay") !== "boolean") {
      return Err(
        new WorkflowRecordMalformedError(
          "lifecycle answer this run's owner returned",
          "it did not say whether the destination replayed",
        ),
      );
    }
    const recovered = held.get("recovered");
    return Ok({
      kind: "performed",
      value: {
        frontier: yield* frontierOf(held.get("frontier")),
        execution: execution(held.get("execution")),
        replay: held.get("replay") === true,
        recovered: recovered === null ? null : execution(recovered),
      },
    });
  }
}

/** One head record, in the canonical spelling a journal retains. */
function record(event: DurableEvent): string {
  return serializeDurableEvent(event);
}
