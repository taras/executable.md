/**
 * Executor ownership, as one authenticated WebSocket.
 *
 * The acquisition *is* the connection. There is no lease, expiry, renewal,
 * heartbeat, alarm, PID or liveness poll: a healthy socket owns the run, and a
 * socket that closes stops owning it because the runtime stops listing it. That
 * is the same shape the local host has, where the operating system releases an
 * advisory lock when the executor exits, and it is why nothing here has to
 * decide whether an absent executor is slow or gone.
 *
 * Hibernation is why ownership cannot live in a field. An idle Durable Object
 * is evicted while its sockets stay open, so the object that wakes up has no
 * memory of what it admitted. The runtime hands back the live sockets and the
 * bounded attachment each was accepted with, and that pair is the authority:
 * `ctx.getWebSockets()` says which sockets are real, and the attachment says
 * what one was admitted as.
 *
 * Attachment bytes alone are not authority. A copy of them proves nothing,
 * because the check is not "does this value look right" but "is the socket this
 * message arrived on the one live socket carrying an acquisition". A second
 * connection cannot manufacture that by holding a copy.
 */

import type { OwnerStorage } from "./storage.ts";

/** What one admitted connection carries, and all it carries. */
export interface AcquisitionAttachment {
  readonly kind: "executor";
  readonly runId: string;
  readonly acquisitionId: string;
}

/** Why an acquisition was refused. */
export type AcquisitionRefusal =
  | "already-running"
  | "not-acquired"
  | "foreign-connection"
  | "wrong-run";

export class AcquisitionError extends Error {
  override name = "AcquisitionError";

  constructor(readonly refusal: AcquisitionRefusal) {
    super(`this connection does not own this run's executor (${refusal})`);
  }
}

/** The bits of a Durable Object's context this module uses. */
export interface AcquisitionContext {
  getWebSockets(tag?: string): WebSocket[];
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  readonly storage: OwnerStorage;
}

/** The tag every executor connection is accepted under. */
export const EXECUTOR_TAG = "executor";

function attachmentOf(socket: WebSocket): AcquisitionAttachment | undefined {
  const value = socket.deserializeAttachment();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const members = value as Record<string, unknown>;
  if (members["kind"] !== "executor") {
    return undefined;
  }
  const runId = members["runId"];
  const acquisitionId = members["acquisitionId"];
  if (typeof runId !== "string" || typeof acquisitionId !== "string") {
    return undefined;
  }
  return { kind: "executor", runId, acquisitionId };
}

/**
 * Every live connection currently holding an acquisition.
 *
 * A socket the runtime still lists but whose attachment was cleared is not one:
 * closing releases ownership immediately, while the runtime may take its own
 * time to stop listing the socket, and ownership must end at the earlier of the
 * two.
 */
export function acquisitionHolders(
  ctx: AcquisitionContext,
): { socket: WebSocket; held: AcquisitionAttachment }[] {
  const found: { socket: WebSocket; held: AcquisitionAttachment }[] = [];
  for (const socket of ctx.getWebSockets(EXECUTOR_TAG)) {
    const held = attachmentOf(socket);
    if (held !== undefined) {
      found.push({ socket, held });
    }
  }
  return found;
}

/**
 * Admit one connection as this run's executor.
 *
 * A second healthy executor is refused rather than followed: it cannot advance
 * the run, and the caller learns that from the refusal rather than from a
 * mutation that quietly did nothing.
 */
export function acquireExecutor(
  ctx: AcquisitionContext,
  socket: WebSocket,
  runId: string,
  acquisitionId: string,
): AcquisitionAttachment {
  if (acquisitionHolders(ctx).length > 0) {
    throw new AcquisitionError("already-running");
  }
  const attachment: AcquisitionAttachment = { kind: "executor", runId, acquisitionId };
  ctx.acceptWebSocket(socket, [EXECUTOR_TAG]);
  // Bounded, and only what admission needs to be reconstructed after an
  // eviction. Nothing here is a credential and nothing here is durable run
  // state.
  socket.serializeAttachment(attachment);
  return attachment;
}

/**
 * Prove that a message arrived on the one live acquisition.
 *
 * Called before the requested mutation is parsed, and again — by the caller —
 * inside the transaction that writes, because a socket can close between the
 * two and the transaction is where the run actually changes.
 */
export function requireAcquisition(
  ctx: AcquisitionContext,
  socket: WebSocket,
  runId: string,
): AcquisitionAttachment {
  const live = acquisitionHolders(ctx);
  if (live.length === 0) {
    throw new AcquisitionError("not-acquired");
  }
  const mine = live.find((holder) => holder.socket === socket);
  if (mine === undefined) {
    // Either this socket was never admitted, or it was superseded and closed.
    throw new AcquisitionError("foreign-connection");
  }
  if (live.length > 1) {
    // Two live holders is a state this module refuses to choose between.
    throw new AcquisitionError("already-running");
  }
  if (mine.held.runId !== runId) {
    throw new AcquisitionError("wrong-run");
  }
  return mine.held;
}

/**
 * Release ownership when a connection ends.
 *
 * The runtime has already stopped listing the socket by the time this runs, so
 * there is nothing to revoke — this exists to make the absence of a rollback
 * explicit. A closed connection invalidates the acquisition and changes no
 * committed state, and it settles no lifecycle: an executor that disappeared
 * did not decide anything.
 */
export function releaseExecutor(socket: WebSocket): void {
  socket.serializeAttachment(null);
}
