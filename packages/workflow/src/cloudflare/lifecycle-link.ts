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
  RemoteBegun,
  RemoteForkCommit,
  RemoteForkPart,
  RemoteLifecycleAnswer,
  RemoteLifecycleLink,
} from "../remote/lifecycle-link.ts";
import { WorkflowRecordMalformedError, WorkflowRunConflictError } from "../storage/errors.ts";
import { parseRemoteExecution } from "../remote/records.ts";
import type { AnchoringReadLink, OwnerConnection } from "./client.ts";
import { privateRefusal, storageFailure, translate } from "./client.ts";

const REFUSALS = new Set(["cancelled", "resume-failed", "terminal"]);

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
    if (typeof refusal !== "string" || !REFUSALS.has(refusal)) {
      return fail("it named no condition this build reads");
    }
    if (refusal !== "cancelled" && refusal !== "resume-failed" && refusal !== "terminal") {
      return fail("it named no condition this build reads");
    }
    return { kind: "refused", refusal };
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
    *begin(request: {
      readonly runId: string;
      readonly action: "start" | "resume";
      readonly creation: CreateWorkflowRunRequest | null;
      readonly executionId: string;
    }): Operation<Result<RemoteLifecycleAnswer<RemoteBegun>>> {
      try {
        const offered = yield* connection.ask(
          nextId(),
          {
            command: "begin",
            runId: request.runId,
            action: request.action,
            creation: request.creation,
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
      completion: DocumentExecutionCompletion,
      expectedWorkspaceRootId: string,
    ): Operation<Result<RemoteFrontierSnapshot>> {
      try {
        const offered = yield* connection.ask(
          nextId(),
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

    *cancel(runId: string): Operation<Result<RemoteLifecycleAnswer<WorkflowRunRecord>>> {
      try {
        const offered = yield* connection.ask(
          nextId(),
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

    *stageForkPart(part: RemoteForkPart): Operation<Result<void>> {
      try {
        const offered = yield* connection.ask(
          nextId(),
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

    *commitFork(commit: RemoteForkCommit): Operation<Result<RemoteBegun>> {
      try {
        const offered = yield* connection.ask(
          nextId(),
          {
            command: "fork",
            runId: commit.runId,
            creation: commit.creation,
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
          return Err(storageFailure(privateRefusal(offered.refusal)));
        }
        const found = members(offered.value, ["conflict", "value"]);
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
              commit.runId,
              conflict.map((field) => (typeof field === "string" ? field : "definition")),
            ),
          );
        }
        const held = members(found.get("value"), ["frontier", "execution"]);
        return Ok({
          frontier: yield* frontierOf(held.get("frontier")),
          execution: execution(held.get("execution")),
          replay: false,
          recovered: null,
        });
      } catch (error) {
        return Err(translate(error));
      }
    },
  };
}

/** One head record, in the canonical spelling a journal retains. */
function record(event: DurableEvent): string {
  return serializeDurableEvent(event);
}
