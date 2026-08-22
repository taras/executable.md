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
export interface AgentSessionOwnershipRecordV1 {
  schema: "agent-session-ownership.v1";
  keyDigest: string;
  state: "active" | "idle";
  ownerKind: AgentSessionOwnerKind;
  operationId: string;
}

const OWNER_KINDS: readonly AgentSessionOwnerKind[] = ["session", "prompt", "native-launch"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an ownership record strictly.
 *
 * An unknown schema, a missing field, or a member this build cannot account for
 * describes state it must not act on — so it is refused rather than read
 * partially, and never repaired.
 */
export function parseAgentSessionOwnership(
  value: unknown,
): AgentSessionOwnershipRecordV1 | undefined {
  if (!isRecord(value) || value.schema !== "agent-session-ownership.v1") {
    return undefined;
  }
  const allowed = ["schema", "keyDigest", "state", "ownerKind", "operationId"];
  for (const member of Object.keys(value)) {
    if (!allowed.includes(member)) {
      return undefined;
    }
  }
  const { keyDigest, state, operationId } = value;
  if (typeof keyDigest !== "string" || !/^[0-9a-f]{64}$/.test(keyDigest)) {
    return undefined;
  }
  if (state !== "active" && state !== "idle") {
    return undefined;
  }
  if (typeof operationId !== "string" || operationId.length === 0) {
    return undefined;
  }
  const ownerKind = OWNER_KINDS.find((kind) => kind === value.ownerKind);
  if (!ownerKind) {
    return undefined;
  }
  return { schema: "agent-session-ownership.v1", keyDigest, state, ownerKind, operationId };
}

export function serializeAgentSessionOwnership(record: AgentSessionOwnershipRecordV1): string {
  return `${JSON.stringify(
    {
      schema: record.schema,
      keyDigest: record.keyDigest,
      state: record.state,
      ownerKind: record.ownerKind,
      operationId: record.operationId,
    },
    null,
    2,
  )}\n`;
}
