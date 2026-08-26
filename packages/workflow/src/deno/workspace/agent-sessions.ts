/**
 * What a run retains about the Agent sessions it is having
 * (specs/workflow-workspace-spec.md §8.5).
 *
 * A provider session outlives one execution, so continuing a run means
 * reattaching the conversation it was having rather than replaying transcript
 * text into a new one. What makes that decidable is one row in the run's own
 * database, written in the run's own transaction — beside the journal it
 * belongs to, for the same reason retained Repository identity lives there: a
 * conversation and the record naming it are one fact, and a record that could
 * commit without the run committing would describe a session this run never had.
 *
 * ## Identity is the engine's, not the document's
 *
 * Within one run a session is identified by the trusted Agent/Session expansion
 * identity the engine derived, and by nothing else. The authored
 * `<Session name>` is descriptive and takes no part in it: two sibling
 * `<Session name="review">` elements are two sessions, and a document that
 * reuses a name cannot make them one.
 *
 * The provider and the resolved agent command are stored beside that identity as
 * compatibility attributes. Changing either refuses reattachment rather than
 * addressing a second mapping — a `<Session>` element that changed agent is the
 * same element asking for something this run cannot give it.
 *
 * ## A canonical assertion, before the mapping
 *
 * The order is provider creation, then the provider's canonical assertion of a
 * durable identity, then this commit, then the first Prompt. Holding a key in a
 * provider's own store is *not* an assertion: it says something is there, not
 * what conversation it is. So a mapping is committed only from one canonical,
 * tagged assertion, and an interruption before that commit is reconciled only
 * the same way. Missing, conflicting, replaced and ambiguous assertions each
 * refuse; none of them starts a replacement session.
 *
 * Once the mapping has committed, a restart compares the provider's current
 * assertion against it before continuing.
 */

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

/** A retained Agent session this host will not continue under. */
export class WorkflowAgentSessionError extends Error {
  override name = "WorkflowAgentSessionError";
}

/**
 * One durable identity a provider asserted, and what kind of thing it is.
 *
 * Tagged, because "the adapter's own session id" and "an ACP session id" and "a
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

/** One retained mapping, as the run's database holds it. */
export interface AgentSessionRecord extends AgentSessionIdentity {
  readonly sessionKey: string;
  /** The session policy in force when the provider created this session. */
  readonly policy: string;
  readonly assertion: ProviderAssertion;
  readonly createdAt: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
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
  return ["xmd", "workflow", "v1", digest(identity.sessionIdentity)].join(":");
}

const COLUMNS = `session_key, provider, agent_command, session_identity, policy,
  assertion_kind, assertion_value, created_at`;

const SELECT = `SELECT ${COLUMNS} FROM agent_sessions WHERE session_key = ?`;

const SELECT_ALL = `SELECT ${COLUMNS} FROM agent_sessions ORDER BY session_key`;

const INSERT = `INSERT INTO agent_sessions (session_key, provider, agent_command,
  session_identity, policy, assertion_kind, assertion_value, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** Every retained mapping this run holds. Reading is not a transaction. */
export interface AgentSessions {
  read(sessionKey: string): AgentSessionRecord | undefined;
  commit(record: AgentSessionRecord): void;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readRow(database: DatabaseSync, sessionKey: string): AgentSessionRecord | undefined {
  const row = database.prepare(SELECT).get(sessionKey);
  return row === undefined ? undefined : parseSessionRow(row);
}

/**
 * Every mapping this run holds, in one deterministic order.
 *
 * What an export seals. Reading them all goes through the same parse one key
 * does, so a row an export accepts is a row a continuation would have accepted.
 */
export function readAllAgentSessions(database: DatabaseSync): AgentSessionRecord[] {
  return database.prepare(SELECT_ALL).all().map(parseSessionRow);
}

function parseSessionRow(row: Record<string, unknown>): AgentSessionRecord {
  const sessionKey = text(row["session_key"]);
  const provider = text(row["provider"]);
  const agentCommand = text(row["agent_command"]);
  const sessionIdentity = text(row["session_identity"]);
  const policy = text(row["policy"]);
  const kind = text(row["assertion_kind"]);
  const value = text(row["assertion_value"]);
  const createdAt = text(row["created_at"]);
  if (
    sessionKey === undefined ||
    provider === undefined ||
    agentCommand === undefined ||
    sessionIdentity === undefined ||
    policy === undefined ||
    kind === undefined ||
    value === undefined ||
    createdAt === undefined
  ) {
    // The table's own constraints make this unreachable through this host. A
    // row that reached it anyway is damage, and damage is not a mapping.
    throw new WorkflowAgentSessionError(
      "this run holds an Agent session row this host cannot read, so it cannot tell which " +
        "provider session to continue.",
    );
  }
  return {
    sessionKey,
    provider,
    agentCommand,
    sessionIdentity,
    policy,
    assertion: { kind, value },
    createdAt,
  };
}

export function createAgentSessions(database: DatabaseSync, authorize: () => void): AgentSessions {
  return {
    read(sessionKey) {
      authorize();
      return readRow(database, sessionKey);
    },
    commit(record) {
      authorize();
      database
        .prepare(INSERT)
        .run(
          record.sessionKey,
          record.provider,
          record.agentCommand,
          record.sessionIdentity,
          record.policy,
          record.assertion.kind,
          record.assertion.value,
          record.createdAt,
        );
    },
  };
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
