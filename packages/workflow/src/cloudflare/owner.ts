/**
 * The Durable Object that owns one workflow run.
 *
 * One run, one object, selected arithmetically from the public run ID. It holds
 * the WorkflowRun record and its filtered journal, the immutable Workspace roots
 * and their content, and executor ownership — and it holds them in one embedded
 * SQLite database, because a second store would be a second thing to keep in
 * agreement with the first.
 *
 * What it does *not* do is as much of the contract as what it does. It runs no
 * native client: no Git, no evidence process, no Agent. Those live on the
 * ephemeral runner against disposable materialization, and what crosses the
 * connection is a proposal this object validates and publishes. The runner
 * performs; the owner decides.
 *
 * Three planes reach it and only one of them can advance a run. The executor
 * plane is one authenticated WebSocket whose lifetime is the acquisition.
 * Delivery and inspection arrive over ordinary requests, take no acquisition,
 * and cannot move the lifecycle — which is why they are separate methods here
 * rather than commands on the socket.
 */

import { DurableObject } from "cloudflare:workers";
import {
  acquireExecutor,
  type AcquisitionAttachment,
  AcquisitionError,
  releaseExecutor,
  requireAcquisition,
} from "./acquisition.ts";
import { admitClaims, type AdmissionPolicy, AdmissionError, parseClaims } from "./admission.ts";
import { CommandError, type CommandResult, parseCommand, type RunnerCommand } from "./commands.ts";
import {
  declaredObjects,
  initializeObject,
  isPristine,
  recognizeObject,
  WorkflowObjectStorageError,
} from "./recognition.ts";
import { ReleaseIdentityError, requireSameRelease } from "./release.ts";
import { admitRunId, RunIdError } from "./routing.ts";
import type { OwnerStorage } from "./storage.ts";

/** What one admission presents. */
export interface AdmissionRequest {
  readonly runId: unknown;
  readonly release: unknown;
  /** Claims a verifier has already authenticated. */
  readonly claims: unknown;
}

/** Everything a deployment must state before this object admits anybody. */
export interface OwnerConfiguration {
  readonly policy: AdmissionPolicy;
}

/** Name a refusal without repeating what caused it. */
export function refusalOf(error: unknown): string {
  if (error instanceof AcquisitionError) {
    return `acquisition:${error.refusal}`;
  }
  if (error instanceof AdmissionError) {
    return `admission:${error.refusal}`;
  }
  if (error instanceof ReleaseIdentityError) {
    return `release:${error.refusal}`;
  }
  if (error instanceof RunIdError) {
    return `run-id:${error.refusal}`;
  }
  if (error instanceof CommandError) {
    return `command:${error.refusal}`;
  }
  if (error instanceof WorkflowObjectStorageError) {
    return `storage:${error.failure.kind}`;
  }
  return "internal";
}

/**
 * The owner, minus the deployment's own configuration.
 *
 * Subclassed rather than configured through a binding because the policy is
 * trusted host state: a value a request could supply would be a runner naming
 * the identities it must satisfy.
 */
export abstract class WorkflowOwnerObject extends DurableObject {
  protected abstract configuration(): OwnerConfiguration;

  /** This object's storage, as the shared modules expect to see it. */
  protected get owned(): OwnerStorage {
    return this.ctx.storage;
  }

  /**
   * Admit one executor connection.
   *
   * The order is the contract: the build is compared before the token is read,
   * the token before the run is touched, and the acquisition is taken last. A
   * refusal at any step leaves no acquisition and no object state — which is
   * what makes "a mismatched build cannot reach run state" a fact about the
   * code rather than a hope about it.
   */
  admit(
    request: AdmissionRequest,
    socket: WebSocket,
    acquisitionId: string,
  ): AcquisitionAttachment {
    const { policy } = this.configuration();
    requireSameRelease(policy.release, request.release);
    admitClaims(policy, parseClaims(request.claims));
    const runId = admitRunId(request.runId);
    return acquireExecutor(this.ctx, socket, runId, acquisitionId);
  }

  /**
   * Handle one message from an admitted connection.
   *
   * Acquisition is proved before the message is parsed, so a superseded or
   * foreign socket never reaches the command reader — and proved again by
   * whatever writes, inside the transaction that writes.
   */
  onRunnerMessage(socket: WebSocket, runId: string, raw: string): CommandResult {
    let command: RunnerCommand | undefined;
    try {
      requireAcquisition(this.ctx, socket, runId);
      command = parseCommand(raw);
      return { id: command.id, outcome: "performed", value: this.perform(socket, runId, command) };
    } catch (error) {
      return { id: command?.id ?? "", outcome: "refused", refusal: refusalOf(error) };
    }
  }

  /** What each command does. Subclasses supply the behavior this owner has. */
  protected abstract perform(socket: WebSocket, runId: string, command: RunnerCommand): unknown;

  /** A connection that ended owns nothing, and rolled nothing back. */
  webSocketClose(socket: WebSocket): void {
    releaseExecutor(socket);
  }

  webSocketError(socket: WebSocket): void {
    releaseExecutor(socket);
  }

  /**
   * Create this run's storage, or recognize what is already there.
   *
   * Pristine is asked first rather than inferred from a refusal: storage that
   * holds nothing is the only storage this build may write into, and every
   * other state — foreign, damaged, a version this build does not implement —
   * is recognition's to refuse rather than initialization's to overwrite.
   */
  open(runId: string, initializeRun: () => void): void {
    admitRunId(runId);
    if (isPristine(declaredObjects(this.owned))) {
      initializeObject(this.owned, initializeRun);
      return;
    }
    recognizeObject(this.owned);
  }
}
