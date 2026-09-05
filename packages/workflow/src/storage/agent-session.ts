/**
 * What one retained Agent session is, independent of who stores it.
 *
 * A run remembers that a `<Session>` element was attached to a provider's
 * conversation so a later execution can reattach to the same one. What it
 * remembers is deliberately thin: which provider, which resolved command, the
 * engine-derived expansion identity, the policy in force, and the provider's
 * own assertion about the session. The conversation is the provider's and is
 * never retained, sent, or reconstructed.
 *
 * Both hosts retain this, so the shape and the key derivation live here rather
 * than inside either one. A second derivation would be two keys for one
 * session, and reattachment would silently start a new conversation.
 */

import { sha256Hex } from "../workspace/sha256.ts";

/**
 * What a provider says about a session it created.
 *
 * Tagged, because "the adapter's own session id", "an ACP session id" and "a
 * record id in some store" are different claims that happen to be strings. A
 * host comparing them without the tag would accept one for another.
 */
export interface ProviderAssertion {
  readonly kind: string;
  readonly value: string;
}

/** What identifies one logical Agent session. */
export interface AgentSessionIdentity {
  /** Which provider holds the conversation, as that provider names itself. */
  readonly provider: string;
  /** The resolved agent command, not the name a document wrote. */
  readonly agentCommand: string;
  /** The engine-derived Agent/Session expansion identity. Never authored. */
  readonly sessionIdentity: string;
}

/** One retained mapping, as a run's storage holds it. */
export interface AgentSessionRecord extends AgentSessionIdentity {
  readonly sessionKey: string;
  /** The session policy in force when the provider created this session. */
  readonly policy: string;
  readonly assertion: ProviderAssertion;
  readonly createdAt: string;
}

/**
 * The key one logical session is retained under, within this run.
 *
 * The engine-derived Session expansion identity and nothing else. The provider
 * and the resolved agent command are compatibility attributes stored beside it:
 * changing either refuses reattachment rather than addressing a second mapping,
 * because a `<Session>` element that changed agent is the same element asking
 * for something this run cannot give it.
 *
 * Digested so it stays bounded, and namespaced so a row is recognizable.
 */
export function agentSessionKey(identity: AgentSessionIdentity): string {
  return ["xmd", "workflow", "v1", sha256Hex(identity.sessionIdentity).slice(0, 32)].join(":");
}

function text(found: Map<string, unknown>, name: string): string | undefined {
  const value = found.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function members(value: unknown): Map<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return new Map(Object.entries(value));
}

/**
 * Read one retained mapping out of a value nothing has checked.
 *
 * Every member, and the key recomputed from the identity rather than believed.
 * A record whose key does not follow from its own identity is a record that
 * would be retained under a name nothing could look it up by.
 */
export function parseAgentSessionRecord(value: unknown): AgentSessionRecord | undefined {
  const found = members(value);
  if (found === undefined || found.size !== 7) {
    return undefined;
  }
  const provider = text(found, "provider");
  const agentCommand = text(found, "agentCommand");
  const sessionIdentity = text(found, "sessionIdentity");
  const sessionKey = text(found, "sessionKey");
  const policy = text(found, "policy");
  const assertion = members(found.get("assertion"));
  if (
    provider === undefined ||
    agentCommand === undefined ||
    sessionIdentity === undefined ||
    sessionKey === undefined ||
    policy === undefined ||
    assertion === undefined ||
    assertion.size !== 2
  ) {
    return undefined;
  }
  const kind = text(assertion, "kind");
  const asserted = text(assertion, "value");
  if (kind === undefined || asserted === undefined) {
    return undefined;
  }
  const identity: AgentSessionIdentity = { provider, agentCommand, sessionIdentity };
  if (agentSessionKey(identity) !== sessionKey) {
    return undefined;
  }
  const createdAt = text(found, "createdAt");
  if (createdAt === undefined || new Date(createdAt).toISOString() !== createdAt) {
    return undefined;
  }
  return Object.freeze({
    ...identity,
    sessionKey,
    policy,
    assertion: Object.freeze({ kind, value: asserted }),
    createdAt,
  });
}

/** A retained Agent session this host will not continue under. */
export class WorkflowAgentSessionError extends Error {
  override name = "WorkflowAgentSessionError";
}

/** Every retained mapping one run holds, as a coordinator may reach it. */
export interface AgentSessions {
  read(sessionKey: string): AgentSessionRecord | undefined;
  commit(record: AgentSessionRecord): void;
}

/** What a continuation may do with the session a key names. */
export type AgentSessionResolution =
  | { readonly kind: "create"; readonly sessionKey: string }
  | { readonly kind: "reattach"; readonly record: AgentSessionRecord };

/**
 * Decide what this attachment may do with the session this identity names.
 *
 * `asserted` is every canonical identity the provider currently asserts for that
 * key — none, one, or more than one. It is deliberately not "does the provider
 * hold this key": occupancy says something is there, not what conversation it
 * is, and adopting one on that basis is how a run continues a session it cannot
 * name.
 */
export function resolveAgentSession(
  retained: AgentSessionRecord | undefined,
  policy: string,
  asserted: readonly ProviderAssertion[],
  identity: AgentSessionIdentity,
): AgentSessionResolution {
  const sessionKey = agentSessionKey(identity);
  if (asserted.length > 1) {
    throw new WorkflowAgentSessionError(
      "the provider asserts more than one durable identity for this run's Agent session, so " +
        "this host cannot tell which conversation it would be continuing. Start a new run " +
        "rather than continuing this one.",
    );
  }
  const current = asserted[0];

  if (retained === undefined) {
    if (current === undefined) {
      // Neither side holds anything: nothing was ever established here.
      return { kind: "create", sessionKey };
    }
    // The pre-commit window. An attempt was interrupted between the provider
    // asserting an identity and this run recording it, and exactly one
    // canonical assertion is what reconciles it — nothing else may.
    return {
      kind: "reattach",
      record: {
        sessionKey,
        ...identity,
        policy,
        assertion: current,
        createdAt: new Date().toISOString(),
      },
    };
  }

  if (
    retained.provider !== identity.provider ||
    retained.agentCommand !== identity.agentCommand ||
    retained.sessionIdentity !== identity.sessionIdentity ||
    retained.policy !== policy
  ) {
    throw new WorkflowAgentSessionError(
      "this run's Agent session was established under a different provider, agent or session " +
        "policy than this host states, and a session created under one ceiling is not " +
        "continued under another. Start a new run rather than continuing this one.",
    );
  }
  if (current === undefined) {
    throw new WorkflowAgentSessionError(
      "the provider asserts no durable identity for the Agent session this run retained, and " +
        "this host does not reconstruct a conversation by replaying it into a new session. " +
        "Start a new run rather than continuing this one.",
    );
  }
  if (current.kind !== retained.assertion.kind || current.value !== retained.assertion.value) {
    throw new WorkflowAgentSessionError(
      "the provider asserts a different durable identity than the Agent session this run " +
        "retained, so it did not resume the conversation this run was having. This host does " +
        "not continue under a replacement session.",
    );
  }
  return { kind: "reattach", record: retained };
}
