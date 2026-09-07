/**
 * Deciding one command, once.
 *
 * A runner that does not hear an answer cannot tell a lost question from a lost
 * answer, so it asks again. That is only safe if asking twice is the same as
 * asking once — which is what this arranges. Each command ID is decided once
 * within one acquisition, and the decision is retained beside the acquisition
 * that made it.
 *
 * Two requests are the same request when their *parsed* commands are equal.
 * Member order and equivalent encodings are not differences; a different value
 * is. Reusing an ID for a different request is not a retry, and it is refused
 * rather than answered, because answering it would mean one identifier named
 * two decisions.
 *
 * What is retained is the decision, not always the response. A read whose
 * answer is fixed by immutable state and a snapshot anchor the request already
 * carries is remembered as a decision to read again, and re-reading returns the
 * same bytes because the request names what to read. The frontier is the
 * exception and is kept whole: it is the one read whose answer would otherwise
 * move, and a retry that returned a later frontier would hand a runner a
 * snapshot it never asked for.
 *
 * The ledger is bounded and never evicts. Dropping an older ID would make a
 * retry of it look like a new command, which for a mutation is the difference
 * between doing something once and doing it twice — so a full ledger refuses
 * the new command and fails the connection closed instead.
 *
 * Everything happens inside one short synchronous transaction, and the exact
 * live acquisition is proved twice: before parsing, and again inside the
 * transaction, because a socket can close between the two and the transaction
 * is where the object actually changes.
 */

import type { AcquisitionContext } from "./acquisition.ts";
import { requireAcquisition } from "./acquisition.ts";
import {
  type CommandResult,
  CommandError,
  MAX_COMMANDS,
  MAX_CONTENT_BYTES,
  MAX_LEDGER_BYTES,
  MAX_STAGED_BYTES,
  type RunnerCommand,
} from "./commands.ts";
import { bytesOf, decodeBase64, sha256Hex } from "./encoding.ts";
import {
  readContent,
  readExecutions,
  readInvocationSnapshot,
  readFrontier,
  readJournalPage,
  readRoot,
} from "./owner-reads.ts";
import type { OwnerTransaction, OwnerTransactions } from "./owner-transaction.ts";
import {
  adoptExecution,
  COMMAND_TABLE,
  initializePrivateSchema,
  MUTATION_TABLE,
  STAGING_TABLE,
} from "./private-schema.ts";
import { applyCommit, applyRetrieval } from "./publish.ts";
import { holdsNoRun, recognizeObject } from "./recognition.ts";
import { openRun } from "./owner-open.ts";
import { beginRun, cancelRunOnOwner, settleRun } from "./owner-lifecycle.ts";
import { commitFork, discardForkParts, stageForkPart } from "./owner-fork.ts";

function requestFingerprint(command: RunnerCommand): string {
  // The command name is part of the fingerprint, so one textual id used for a
  // commit and for a retrieval replacement is two different requests rather
  // than one recognized retry.
  return sha256Hex(JSON.stringify({ kind: command.command, command }));
}

/**
 * Whether this command changes the run, and therefore whether its decision has
 * to outlive the connection that asked for it.
 *
 * A read can be asked again; a mutation cannot, so its answer is retained where
 * the next connection can find it.
 */
/**
 * Whether this command may find nothing and make the run anyway.
 *
 * A starting `begin` carries the run's whole immutable identity, and a
 * committed fork carries the destination's. Both create the schema, the run and
 * their first execution in one transaction, so both have to be allowed to
 * arrive at a store that holds nothing.
 */
function initializes(command: RunnerCommand): boolean {
  return (
    command.command === "fork" ||
    (command.command === "begin" && command.action === "start" && command.creation !== null)
  );
}

/**
 * Whether this command only offers scratch.
 *
 * A fork's parts and its content are offered to a destination that does not
 * exist yet — that is the whole point of offering them — so these have to reach
 * a store holding no run. They write nothing a reader can see: the scratch
 * tables are this adapter's own, and the command that adopts them is what makes
 * a run.
 */
function offersScratch(command: RunnerCommand): boolean {
  return command.command === "stage" || command.command === "fork-stage";
}

function mutating(command: RunnerCommand): boolean {
  return (
    command.command === "commit" ||
    command.command === "retrieval" ||
    // Each of these changes the run's own lifecycle, and each can commit
    // before its answer is observed. A retry has to find the first decision
    // rather than apply the transition again.
    command.command === "begin" ||
    command.command === "cancel" ||
    command.command === "settle" ||
    // A committed fork creates a destination run. Its decision has to outlive
    // the connection for the same reason a begin's does.
    command.command === "fork"
  );
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("private protocol storage holds a malformed count");
  }
  return value;
}

/**
 * Which execution one performed mutation began, if it began one.
 *
 * Read from the command rather than from the answer: what the runner asked to
 * begin is what the owner began, and a decision that refused began nothing.
 */
function begunExecution(command: RunnerCommand, result: CommandResult): string | null {
  if (result.outcome !== "performed") {
    return null;
  }
  if (command.command === "begin" || command.command === "fork") {
    return command.executionId;
  }
  return null;
}

/** What this acquisition has already spent of its own ledger. */
function ledgerUsage(
  storage: AcquisitionContext["storage"],
  acquisitionId: string,
): { commands: number; bytes: number } {
  const row = storage.sql
    .exec(
      `SELECT count(*) AS commands, coalesce(sum(response_bytes), 0) AS bytes
         FROM ${COMMAND_TABLE} WHERE acquisition_id = ?`,
      acquisitionId,
    )
    .toArray()[0];
  return { commands: integer(row?.["commands"]), bytes: integer(row?.["bytes"]) };
}

function storedDecision(value: unknown, id: string): CommandResult | "reconstruct" {
  if (typeof value !== "string") {
    throw new Error("private protocol storage holds a malformed result");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("private protocol storage holds a malformed result");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("private protocol storage holds a malformed result");
  }
  const members = new Map(Object.entries(parsed));
  if (members.get("id") !== id) {
    throw new Error("private protocol storage holds a result for another command");
  }
  const outcome = members.get("outcome");
  if (outcome === "reconstruct" && members.size === 2) {
    return "reconstruct";
  }
  if (outcome === "performed" && members.size === 3 && members.has("value")) {
    return { id, outcome, value: members.get("value") };
  }
  const refusal = members.get("refusal");
  if (outcome === "refused" && members.size === 3 && typeof refusal === "string") {
    return { id, outcome, refusal };
  }
  throw new Error("private protocol storage holds a malformed result");
}

/**
 * A fresh opaque identity for one retained event.
 *
 * Minted by the owner inside the transaction that writes the row. An id the
 * runner chose would be a runner deciding what a retained event is called, and
 * two runners could choose the same one.
 */
function mintEventId(): string {
  return crypto.randomUUID();
}

/**
 * The moment the owner records against a mutation it just made.
 *
 * The owner's clock, not the runner's. A time a runner supplied would be a
 * caller deciding when the run's history happened.
 */
function ownerTime(): string {
  return new Date().toISOString();
}

function retainedDecision(command: RunnerCommand, result: CommandResult): string {
  if (
    result.outcome === "performed" &&
    (command.command === "journal" ||
      command.command === "root" ||
      command.command === "content" ||
      command.command === "executions" ||
      command.command === "mappings")
  ) {
    return JSON.stringify({ id: command.id, outcome: "reconstruct" });
  }
  return JSON.stringify(result);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function stage(
  ctx: AcquisitionContext,
  acquisitionId: string,
  command: Extract<RunnerCommand, { command: "stage" }>,
): { kind: "manifest" | "blob"; digest: string; size: number } {
  const bytes = decodeBase64(command.bytes);
  if (bytes.length === 0 || bytes.length > MAX_CONTENT_BYTES) {
    throw new CommandError(bytes.length === 0 ? "malformed-member" : "too-large");
  }
  if (sha256Hex(bytes) !== command.digest) {
    throw new CommandError("malformed-member");
  }
  const existing = ctx.storage.sql
    .exec(
      `SELECT size, bytes FROM ${STAGING_TABLE}
        WHERE acquisition_id = ? AND kind = ? AND digest = ?`,
      acquisitionId,
      command.kind,
      command.digest,
    )
    .toArray()[0];
  if (existing !== undefined) {
    const retained = bytesOf(existing["bytes"]);
    if (!sameBytes(retained, bytes)) {
      throw new Error("private staging disagrees with its content identity");
    }
    return { kind: command.kind, digest: command.digest, size: bytes.length };
  }
  const total = ctx.storage.sql
    .exec(
      `SELECT coalesce(sum(size), 0) AS total FROM ${STAGING_TABLE} WHERE acquisition_id = ?`,
      acquisitionId,
    )
    .toArray()[0];
  if (integer(total?.["total"]) + bytes.length > MAX_STAGED_BYTES) {
    throw new CommandError("capacity");
  }
  ctx.storage.sql.exec(
    `INSERT INTO ${STAGING_TABLE} (acquisition_id, kind, digest, size, bytes)
      VALUES (?, ?, ?, ?, ?)`,
    acquisitionId,
    command.kind,
    command.digest,
    bytes.length,
    new Uint8Array(bytes),
  );
  return { kind: command.kind, digest: command.digest, size: bytes.length };
}

function perform(
  ctx: AcquisitionContext,
  runId: string,
  acquisitionId: string,
  command: RunnerCommand,
  transaction: OwnerTransaction,
): CommandResult {
  if (command.command === "frontier") {
    return { id: command.id, outcome: "performed", value: readFrontier(ctx.storage, runId) };
  }
  if (command.command === "journal") {
    return {
      id: command.id,
      outcome: "performed",
      value: readJournalPage(ctx.storage, command.anchorEventId, command.afterEventId),
    };
  }
  if (command.command === "root") {
    return {
      id: command.id,
      outcome: "performed",
      value: readRoot(ctx.storage, command.workspaceRootId),
    };
  }
  if (command.command === "content") {
    return {
      id: command.id,
      outcome: "performed",
      value: readContent(
        ctx.storage,
        command.workspaceRootId,
        command.kind,
        command.digest,
        command.sourceManifest,
      ),
    };
  }
  if (command.command === "stage") {
    return { id: command.id, outcome: "performed", value: stage(ctx, acquisitionId, command) };
  }
  if (command.command === "commit") {
    return {
      id: command.id,
      outcome: "performed",
      value: applyCommit(ctx.storage, acquisitionId, command, mintEventId),
    };
  }
  if (command.command === "retrieval") {
    return {
      id: command.id,
      outcome: "performed",
      value: applyRetrieval(ctx.storage, command, ownerTime),
    };
  }
  if (command.command === "executions") {
    return {
      id: command.id,
      outcome: "performed",
      value: readExecutions(ctx.storage, runId, command.anchor, command.after),
    };
  }
  if (command.command === "begin") {
    return {
      id: command.id,
      outcome: "performed",
      value: beginRun(
        ctx.storage,
        transaction,
        acquisitionId,
        command.runId,
        command.action,
        command.creation,
        command.retrieval,
        command.executionId,
        ownerTime,
      ),
    };
  }
  if (command.command === "fork-stage") {
    return {
      id: command.id,
      outcome: "performed",
      value: stageForkPart(ctx.storage, acquisitionId, {
        section: command.section,
        position: command.position,
        part: command.part,
      }),
    };
  }
  if (command.command === "fork") {
    const forked = commitFork(
      ctx.storage,
      transaction,
      acquisitionId,
      {
        runId: command.runId,
        creation: command.creation,
        retrieval: command.retrieval,
        origin: command.origin,
        counts: command.counts,
        runRecord: command.runRecord,
        rootImport: command.rootImport,
        executionId: command.executionId,
      },
      mintEventId,
      ownerTime,
    );
    if (forked.value !== null) {
      // Adopted, so the parts are no longer anything. What they described is
      // the run now.
      discardForkParts(ctx.storage, acquisitionId);
    }
    return { id: command.id, outcome: "performed", value: forked };
  }
  if (command.command === "cancel") {
    return {
      id: command.id,
      outcome: "performed",
      value: cancelRunOnOwner(ctx.storage, command.runId, ownerTime),
    };
  }
  if (command.command === "settle") {
    return {
      id: command.id,
      outcome: "performed",
      value: settleRun(
        ctx.storage,
        acquisitionId,
        runId,
        command.completion,
        command.expectedWorkspaceRootId,
        ownerTime,
      ),
    };
  }
  if (command.command === "mappings") {
    return {
      id: command.id,
      outcome: "performed",
      value: readInvocationSnapshot(ctx.storage, runId),
    };
  }
  // `settle` is a later checkpoint's. It parses strictly and is declined,
  // because a placeholder that reported success is the one answer a runner
  // cannot recover from.
  return { id: command.id, outcome: "refused", refusal: "command:unavailable" };
}

export function dispatchCommand(
  ctx: AcquisitionContext,
  transactions: OwnerTransactions,
  socket: WebSocket,
  runId: string,
  command: RunnerCommand,
): CommandResult {
  const held = requireAcquisition(ctx, socket, runId);
  if (command.command === "open") {
    // Outside the dispatcher's transaction, because creating owns one of its
    // own: initialization writes the schema, the run and the starting
    // Workspace together, and nesting that inside another transaction would
    // be a second one on the same storage.
    //
    // It needs no retained decision either. A repeat finds the run the first
    // call created and compares immutable identity, which is the same answer;
    // there is no pristine store left to fill twice.
    return {
      id: command.id,
      outcome: "performed",
      value: openRun(ctx.storage, transactions, command.runId, command.creation, ownerTime),
    };
  }
  const fingerprint = requestFingerprint(command);
  return transactions.run(ctx.storage, (transaction) => {
    const inside = requireAcquisition(ctx, socket, runId);
    if (inside.acquisitionId !== held.acquisitionId) {
      throw new CommandError("duplicate-conflict");
    }
    // Almost every command that reaches here is asked of a run that already
    // exists, so the store is held to this build's schema before it is read.
    // The exceptions are the two that create one: a starting `begin` and a
    // committed `fork` reach pristine storage on purpose and initialize it
    // inside this same transaction. Recognizing first would refuse them for
    // holding nothing at all, and there would be no way to start a remote run.
    const empty = holdsNoRun(ctx.storage);
    const creating = initializes(command) && empty;
    const offering = offersScratch(command) && empty;
    if (offering) {
      // The scratch this command needs, and nothing else: no schema, no run, no
      // marker. What is here after it is still a store holding no run.
      initializePrivateSchema(ctx.storage);
    }
    if (!creating && !offering) {
      recognizeObject(ctx.storage);
    }

    // A mutation's decision is looked for by the run, not by the connection.
    // The case this exists for is the one where the connection that asked is
    // gone: the owner committed, the answer never arrived, and the runner
    // reconnected to ask the same question again. Pristine storage retains no
    // decision, and its private substrate does not exist yet to be asked.
    if (mutating(command) && !creating) {
      const decided = ctx.storage.sql
        .exec(
          `SELECT request_fingerprint, response FROM ${MUTATION_TABLE} WHERE command_id = ?`,
          command.id,
        )
        .toArray()[0];
      if (decided !== undefined) {
        if (decided.request_fingerprint !== fingerprint) {
          throw new CommandError("duplicate-conflict");
        }
        const decision = storedDecision(decided.response, command.id);
        if (decision === "reconstruct") {
          // A mutation's decision is always retained whole. Reconstructing one
          // would mean applying it again.
          throw new Error("private protocol storage holds a malformed result");
        }
        // The answer was lost, not the fact. If this decision began an
        // execution and nobody live holds it, it becomes this acquisition's —
        // otherwise the caller would be handed a run it could not settle.
        adoptExecution(ctx.storage, held.acquisitionId, command.id);
        return decision;
      }
    }

    const previous =
      creating && !offering
        ? undefined
        : ctx.storage.sql
            .exec(
              `SELECT request_fingerprint, response FROM ${COMMAND_TABLE}
            WHERE acquisition_id = ? AND command_id = ?`,
              held.acquisitionId,
              command.id,
            )
            .toArray()[0];
    if (previous !== undefined) {
      if (previous.request_fingerprint !== fingerprint) {
        throw new CommandError("duplicate-conflict");
      }
      const decision = storedDecision(previous.response, command.id);
      return decision === "reconstruct"
        ? perform(ctx, runId, held.acquisitionId, command, transaction)
        : decision;
    }
    // A store with no run has spent nothing this ledger knows about, and until
    // the scratch exists there is nothing to ask.
    const usage =
      creating && !offering
        ? { commands: 0, bytes: 0 }
        : ledgerUsage(ctx.storage, held.acquisitionId);
    if (usage.commands >= MAX_COMMANDS || usage.bytes >= MAX_LEDGER_BYTES) {
      throw new CommandError("capacity");
    }
    const result = perform(ctx, runId, held.acquisitionId, command, transaction);
    const encoded = retainedDecision(command, result);
    const responseBytes = new TextEncoder().encode(encoded).length;
    if (usage.bytes + responseBytes > MAX_LEDGER_BYTES) {
      throw new CommandError("capacity");
    }
    ctx.storage.sql.exec(
      `INSERT INTO ${COMMAND_TABLE}
        (acquisition_id, command_id, request_fingerprint, response, response_bytes)
        VALUES (?, ?, ?, ?, ?)`,
      held.acquisitionId,
      command.id,
      fingerprint,
      encoded,
      responseBytes,
    );
    if (mutating(command)) {
      // Recorded in this same transaction as the mutation it describes, so a
      // crash cannot leave one without the other.
      const mutations = creating
        ? undefined
        : ctx.storage.sql.exec(`SELECT count(*) AS decided FROM ${MUTATION_TABLE}`).toArray()[0];
      if (mutations !== undefined && integer(mutations["decided"]) >= MAX_COMMANDS) {
        throw new CommandError("capacity");
      }
      ctx.storage.sql.exec(
        `INSERT INTO ${MUTATION_TABLE}
          (command_id, request_fingerprint, response, response_bytes, execution_id)
          VALUES (?, ?, ?, ?, ?)`,
        command.id,
        fingerprint,
        encoded,
        responseBytes,
        // Which execution this decision began, when it began one, so a
        // replacement acquisition re-observing it can adopt the run rather
        // than being told about an execution it may not touch.
        begunExecution(command, result),
      );
    }
    return result;
  });
}
