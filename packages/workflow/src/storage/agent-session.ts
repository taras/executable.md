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
