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
import { readContent, readFrontier, readJournalPage, readRoot } from "./owner-reads.ts";
import type { OwnerTransactions } from "./owner-transaction.ts";
import { COMMAND_TABLE, MUTATION_TABLE, STAGING_TABLE } from "./private-schema.ts";
import { applyCommit } from "./publish.ts";
import { recognizeObject } from "./recognition.ts";

function requestFingerprint(command: RunnerCommand): string {
  return sha256Hex(JSON.stringify(command));
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("private protocol storage holds a malformed count");
  }
  return value;
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

function retainedDecision(command: RunnerCommand, result: CommandResult): string {
  if (
    result.outcome === "performed" &&
    (command.command === "journal" || command.command === "root" || command.command === "content")
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
  const fingerprint = requestFingerprint(command);
  return transactions.run(ctx.storage, () => {
    const inside = requireAcquisition(ctx, socket, runId);
    if (inside.acquisitionId !== held.acquisitionId) {
      throw new CommandError("duplicate-conflict");
    }
    recognizeObject(ctx.storage);

    // A mutation's decision is looked for by the run, not by the connection.
    // The case this exists for is the one where the connection that asked is
    // gone: the owner committed, the answer never arrived, and the runner
    // reconnected to ask the same question again.
    if (command.command === "commit") {
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
        return decision;
      }
    }

    const previous = ctx.storage.sql
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
        ? perform(ctx, runId, held.acquisitionId, command)
        : decision;
    }
    const usage = ctx.storage.sql
      .exec(
        `SELECT count(*) AS commands, coalesce(sum(response_bytes), 0) AS bytes
           FROM ${COMMAND_TABLE} WHERE acquisition_id = ?`,
        held.acquisitionId,
      )
      .toArray()[0];
    if (
      integer(usage?.["commands"]) >= MAX_COMMANDS ||
      integer(usage?.["bytes"]) >= MAX_LEDGER_BYTES
    ) {
      throw new CommandError("capacity");
    }
    const result = perform(ctx, runId, held.acquisitionId, command);
    const encoded = retainedDecision(command, result);
    const responseBytes = new TextEncoder().encode(encoded).length;
    if (integer(usage?.["bytes"]) + responseBytes > MAX_LEDGER_BYTES) {
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
    if (command.command === "commit") {
      // Recorded in this same transaction as the mutation it describes, so a
      // crash cannot leave one without the other.
      const mutations = ctx.storage.sql
        .exec(`SELECT count(*) AS decided FROM ${MUTATION_TABLE}`)
        .toArray()[0];
      if (integer(mutations?.["decided"]) >= MAX_COMMANDS) {
        throw new CommandError("capacity");
      }
      ctx.storage.sql.exec(
        `INSERT INTO ${MUTATION_TABLE}
          (command_id, request_fingerprint, response, response_bytes)
          VALUES (?, ?, ?, ?)`,
        command.id,
        fingerprint,
        encoded,
        responseBytes,
      );
    }
    return result;
  });
}
