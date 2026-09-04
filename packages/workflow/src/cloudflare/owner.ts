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
import type { Operation } from "effection";
import { OwnerTransactions } from "./owner-transaction.ts";
import {
  acquireExecutor,
  type AcquisitionAttachment,
  AcquisitionError,
  releaseExecutor,
  requireAcquisition,
  requireExecutorSocket,
} from "./acquisition.ts";
import { admitToken, type AdmissionPolicy, AdmissionError } from "./admission.ts";
import { TokenError, type TokenVerification } from "./token.ts";
import { CommandError, type CommandResult, parseCommand, type RunnerCommand } from "./commands.ts";
import { dispatchCommand } from "./dispatcher.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { discardPriorAcquisitions, PRIVATE_OBJECT_NAMES } from "./private-schema.ts";
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

/**
 * What one admission presents.
 *
 * Bytes and identifiers, all of them untrusted. There is deliberately no member
 * for a verified result, a claim set, an acquisition identity or verification
 * material: a request that could name any of those would be a request choosing
 * what it is allowed to be.
 */
export interface AdmissionRequest {
  readonly runId: unknown;
  readonly release: unknown;
  /** The raw short-lived OIDC token, exactly as presented. */
  readonly token: unknown;
}

/** Everything a deployment must state before this object admits anybody. */
export interface OwnerConfiguration {
  readonly policy: AdmissionPolicy;
  /** The issuer's keys and clock. Trusted closure state, never request data. */
  readonly verification: TokenVerification;
}

/** Name a refusal without repeating what caused it. */
export function refusalOf(error: unknown): string {
  if (error instanceof AcquisitionError) {
    return `acquisition:${error.refusal}`;
  }
  if (error instanceof AdmissionError) {
    return `admission:${error.refusal}`;
  }
  if (error instanceof TokenError) {
    return `token:${error.refusal}`;
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
    if (error.failure.kind === "unsupported-version") {
      // The version travels in the category rather than beside it, because the
      // answer envelope carries a refusal and nothing else. It is the one fact
      // a host needs to decide whether this build may open the store, and a
      // public error that guessed it would state something untrue.
      return `storage:unsupported-version-v${error.failure.schemaVersion}`;
    }
    return `storage:${error.failure.kind}`;
  }
  if (error instanceof WorkflowRecordMalformedError) {
    return "storage:corrupt";
  }
  if (
    error instanceof Error &&
    (error.message.startsWith("private protocol storage") ||
      error.message.startsWith("private staging") ||
      error.message.startsWith("stored bytes"))
  ) {
    return "storage:corrupt";
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
  /**
   * This object's claim on its own storage.
   *
   * One per Durable Object, so a transaction here cannot refuse one in another
   * object and no table outlives the object that owns it.
   */
  protected readonly transactions: OwnerTransactions = new OwnerTransactions();

  protected abstract configuration(): OwnerConfiguration;

  /** This object's storage, as the shared modules expect to see it. */
  protected get owned(): OwnerStorage {
    return this.ctx.storage;
  }

  /**
   * Admit one executor connection.
   *
   * The order is the contract: the build is compared before any token work, the
   * token is verified before the run is touched, and the acquisition is taken
   * last. A refusal at any step leaves no acquisition and no object state.
   *
   * The correlation value is minted here, after both checks pass, and never
   * taken from the request. A caller-selected one would let a later connection
   * reuse an abandoned identifier and collide with the private staging that
   * identifier partitions.
   */
  *admit(request: AdmissionRequest, socket: WebSocket): Operation<AcquisitionAttachment> {
    const { policy, verification } = this.configuration();
    requireSameRelease(policy.release, request.release);
    yield* admitToken(policy, verification, request.token);
    const runId = admitRunId(request.runId);
    const acquisitionId = mintAcquisitionId();
    return acquireExecutor(this.ctx, socket, runId, acquisitionId, () => {
      const names = new Set(declaredObjects(this.owned).map((object) => object.name));
      if (PRIVATE_OBJECT_NAMES.every((name) => names.has(name))) {
        recognizeObject(this.owned);
        this.transactions.run(this.owned, () => {
          discardPriorAcquisitions(this.owned, acquisitionId);
        });
      }
    });
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
      return dispatchCommand(this.ctx, this.transactions, socket, runId, command);
    } catch (error) {
      return { id: command?.id ?? "", outcome: "refused", refusal: refusalOf(error) };
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    let answer: CommandResult;
    if (typeof message !== "string") {
      answer = { id: "", outcome: "refused", refusal: "command:malformed-member" };
    } else {
      try {
        const held = requireExecutorSocket(this.ctx, socket);
        answer = this.onRunnerMessage(socket, held.runId, message);
      } catch (error) {
        answer = { id: "", outcome: "refused", refusal: refusalOf(error) };
      }
    }
    try {
      socket.send(JSON.stringify(answer));
    } catch {
      releaseExecutor(socket);
      socket.close(1011, "send failed");
      return;
    }
    if (fatal(answer)) {
      releaseExecutor(socket);
      socket.close(1002, "protocol refused");
    }
  }

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
      initializeObject(this.owned, this.transactions, initializeRun);
      return;
    }
    recognizeObject(this.owned);
  }
}

/**
 * A fresh correlation value for one acquisition.
 *
 * Bounded and unpredictable, and used only to partition acquisition-private
 * staging and duplicate handling. It is not a bearer credential, a lease, a
 * generation record or a durable identity: what proves a message may act is the
 * exact live socket, and this value proves nothing on its own.
 */
function mintAcquisitionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a refusal means the connection itself is finished.
 *
 * Two kinds of refusal reach here and they deserve opposite treatment. One says
 * the channel or the store is not what it claims — a message that would not
 * parse, an acquisition this socket does not hold, storage that is damaged —
 * and carrying on would mean guessing what the other side meant.
 *
 * The other is an answer about the request. A duplicate id, a frontier that has
 * moved, a mapping that disagrees with what is already retained, and a command
 * this release does not implement are all decisions the runner can act on: read
 * the frontier again, propose against it, or stop. Closing the connection on
 * those would turn every ordinary disagreement into a lost acquisition and make
 * the runner reconnect to be told the same thing.
 */
const ANSWERED: readonly string[] = [
  "command:duplicate-conflict",
  "command:unavailable",
  "command:stale-root",
  "command:stale-journal",
  "command:mapping-conflict",
];

function fatal(answer: CommandResult): boolean {
  if (answer.outcome === "performed") {
    return false;
  }
  return !ANSWERED.includes(answer.refusal);
}
