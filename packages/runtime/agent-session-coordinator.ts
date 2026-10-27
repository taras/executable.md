/**
 * Exclusive ownership of one logical agent session
 * (specs/native-agent-session-launch-spec.md §Ownership and concurrency).
 *
 * An advertised provider-returned session can be handed to a native UI, and a
 * native UI is a live owner nothing on the XMD side can observe. So every
 * operation that could act on such a session — establishing it, running a turn,
 * launching into it — enters here first, and a host that cannot answer the
 * ownership question refuses rather than guessing.
 *
 * This is a plain capability, injected directly by the host into the provider
 * that needs it. It is deliberately not a contextual Api: ownership is a
 * security decision, and a decision document middleware can replace is not one.
 *
 * Acquisition never waits. A native UI may stay open for hours, and a caller
 * that queued would hold the reader's terminal while offering no way to reach
 * the owner it waits for.
 */

import type { Operation, Result } from "effection";
import { createHash } from "node:crypto";

/** Which logical session is being owned. Never an authored alias. */
export interface AgentSessionKey {
  provider: string;
  agent: string;
  sessionKey: string;
}

/** What is asking. Recorded so a tombstone says what failed to finish. */
export type AgentSessionOwnerKind = "session" | "prompt" | "native-launch";

export interface AgentSessionOwner {
  kind: AgentSessionOwnerKind;
  /** A fresh opaque id per live attempt. Never a launch or native identity. */
  operationId: string;
}

/**
 * The acknowledgement a body gives when its session can no longer be acted on.
 *
 * One use, and only from inside the body. Returning without it — by success,
 * failure or cancellation — leaves the durable marker active, because what it
 * acknowledges is not "I finished" but "nothing I started can still touch this
 * session".
 */
export interface AgentSessionOwnership {
  quiesced(): void;
}

/** Another live owner holds this session right now. */
export class AgentSessionBusy extends Error {
  override name = "AgentSessionBusy";
}

/**
 * The last owner never proved it stopped.
 *
 * A crash releases the kernel lock but not this: nothing observable afterwards
 * distinguishes a session whose owner died mid-turn from one it left cleanly,
 * so the conservative answer stands until someone recovers it deliberately.
 */
export class AgentSessionRecoveryRequired extends Error {
  override name = "AgentSessionRecoveryRequired";
  readonly keyDigest?: string;
  readonly recordRevision?: string;
  constructor(message: string, metadata?: { keyDigest: string; recordRevision: string }) {
    super(message);
    this.keyDigest = metadata?.keyDigest;
    this.recordRevision = metadata?.recordRevision;
  }
}

export interface AgentSessionCoordinator {
  /**
   * Run `body` while holding exclusive ownership of `key`.
   *
   * The body runs only once ownership is established. Busy and
   * recovery-required arrive on the failure channel of the `Result`; an
   * unexpected filesystem or protocol failure raises, having preserved the
   * conservative marker.
   */
  coordinate<T>(
    key: AgentSessionKey,
    owner: AgentSessionOwner,
    body: (ownership: AgentSessionOwnership) => Operation<T>,
  ): Operation<Result<T>>;
}

/**
 * The digest that names one session's sidecar and ownership record.
 *
 * Canonical, so every process derives the same name, and a digest, so the
 * coordination namespace holds no agent name, session name, path or authored
 * value.
 */
export function agentSessionKeyDigest(key: AgentSessionKey): string {
  return createHash("sha256")
    .update(JSON.stringify([key.provider, key.agent, key.sessionKey]), "utf8")
    .digest("hex");
}

/** The exact durable record one owner writes. No other member is accepted. */
export interface AgentSessionOwnershipRecord {
  keyDigest: string;
  state: "active" | "idle";
  ownerKind: AgentSessionOwnerKind;
  operationId: string;
  release: "none" | "quiesced" | "forced";
  lastForcedRecovery: AgentSessionForcedRecovery | null;
}

const OWNER_KINDS: readonly AgentSessionOwnerKind[] = ["session", "prompt", "native-launch"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AgentSessionForcedRecovery {
  recoveryId: string;
  abandonedOwnerKind: AgentSessionOwnerKind;
  abandonedOperationId: string;
  expectedRevision: string;
  backendQuiescenceProved: false;
  interruptedOutcome: "unknown";
}

export interface AgentSessionOwnershipInspection {
  keyDigest: string;
  recordRevision: string;
  record: AgentSessionOwnershipRecord;
}
export interface AgentSessionForceRecoveryReceipt {
  keyDigest: string;
  previousRecordRevision: string;
  recordRevision: string;
  recoveryId: string;
  release: "forced";
  backendQuiescenceProved: false;
  interruptedOutcome: "unknown";
  providerRequestSent: false;
}
export interface AgentSessionOwnershipAdministration {
  inspectOwnership(keyDigest: string): Operation<Result<AgentSessionOwnershipInspection>>;
  forceRecoverOwnership(request: {
    keyDigest: string;
    expectedRevision: string;
    force: true;
  }): Operation<Result<AgentSessionForceRecoveryReceipt>>;
}
export interface AgentSessionHost {
  coordinator: AgentSessionCoordinator;
  ownershipAdministration: AgentSessionOwnershipAdministration;
}
export type AgentSessionOwnershipFailureCode =
  | "busy"
  | "stale-expectation"
  | "not-found"
  | "not-recovery-required"
  | "record-invalid"
  | "unsupported-capability"
  | "publication-unknown"
  | "io-failure";
const FAILURE_MESSAGES: Record<AgentSessionOwnershipFailureCode, string> = {
  busy: "another live owner holds this session",
  "stale-expectation": "the ownership record changed; this expectation authorizes no recovery",
  "not-found": "no ownership record exists for this digest",
  "not-recovery-required": "this record does not require recovery",
  "record-invalid": "the ownership record or request is invalid",
  "unsupported-capability": "this host cannot administer session ownership",
  "publication-unknown": "ownership publication is UNKNOWN; do not repeat recovery automatically",
  "io-failure": "ownership IO failed",
};
export class AgentSessionOwnershipError extends Error {
  override name = "AgentSessionOwnershipError";
  constructor(
    readonly code: AgentSessionOwnershipFailureCode,
    options?: ErrorOptions,
  ) {
    super(FAILURE_MESSAGES[code], options);
  }
}

/** Read only the complete current ownership shape; incomplete or extra fields refuse. */
export function parseAgentSessionOwnership(
  value: unknown,
): AgentSessionOwnershipRecord | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !==
      ["keyDigest", "state", "ownerKind", "operationId", "release", "lastForcedRecovery"]
        .sort()
        .join()
  ) {
    return undefined;
  }
  const { keyDigest, state, operationId, release } = value;
  const ownerKind = OWNER_KINDS.find((kind) => kind === value.ownerKind);
  if (
    typeof keyDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(keyDigest) ||
    (state !== "active" && state !== "idle") ||
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    !ownerKind ||
    (release !== "none" && release !== "quiesced" && release !== "forced") ||
    (state === "active") !== (release === "none")
  ) {
    return undefined;
  }
  const lastForcedRecovery =
    value.lastForcedRecovery === null ? null : parseForcedRecovery(value.lastForcedRecovery);
  if (
    lastForcedRecovery === undefined ||
    (release === "forced" &&
      (lastForcedRecovery === null ||
        ownerKind !== lastForcedRecovery.abandonedOwnerKind ||
        operationId !== lastForcedRecovery.abandonedOperationId))
  ) {
    return undefined;
  }
  return { keyDigest, state, ownerKind, operationId, release, lastForcedRecovery };
}

function parseForcedRecovery(last: unknown): AgentSessionForcedRecovery | undefined {
  if (
    !isRecord(last) ||
    Object.keys(last).sort().join() !==
      [
        "recoveryId",
        "abandonedOwnerKind",
        "abandonedOperationId",
        "expectedRevision",
        "backendQuiescenceProved",
        "interruptedOutcome",
      ]
        .sort()
        .join()
  ) {
    return undefined;
  }
  const abandonedOwnerKind = OWNER_KINDS.find((kind) => kind === last.abandonedOwnerKind);
  if (
    !abandonedOwnerKind ||
    typeof last.abandonedOperationId !== "string" ||
    last.abandonedOperationId.length === 0 ||
    typeof last.recoveryId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      last.recoveryId,
    ) ||
    typeof last.expectedRevision !== "string" ||
    !/^[0-9a-f]{64}$/.test(last.expectedRevision) ||
    last.backendQuiescenceProved !== false ||
    last.interruptedOutcome !== "unknown"
  ) {
    return undefined;
  }
  return {
    recoveryId: last.recoveryId,
    abandonedOwnerKind,
    abandonedOperationId: last.abandonedOperationId,
    expectedRevision: last.expectedRevision,
    backendQuiescenceProved: false,
    interruptedOutcome: "unknown",
  };
}

export function serializeAgentSessionOwnership(record: AgentSessionOwnershipRecord): string {
  return `${JSON.stringify({ keyDigest: record.keyDigest, state: record.state, ownerKind: record.ownerKind, operationId: record.operationId, release: record.release, lastForcedRecovery: record.lastForcedRecovery }, null, 2)}\n`;
}
