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

/**
 * The shape and the key derivation are the shared rule, not this adapter's.
 *
 * Both hosts retain these mappings, and two derivations would be two keys for
 * one session — reattachment would quietly start a new conversation instead of
 * finding the old one. What stays here is the storage: the columns, the
 * statements, and the transaction they run in.
 */
import {
  type AgentSessionRecord,
  type AgentSessions,
  WorkflowAgentSessionError,
} from "../../storage/agent-session.ts";

export {
  agentSessionKey,
  parseAgentSessionRecord,
  resolveAgentSession,
  WorkflowAgentSessionError,
} from "../../storage/agent-session.ts";
export type { AgentSessionResolution, AgentSessions } from "../../storage/agent-session.ts";
export type {
  AgentSessionIdentity,
  AgentSessionRecord,
  ProviderAssertion,
} from "../../storage/agent-session.ts";

const COLUMNS = `session_key, provider, agent_command, session_identity, policy,
  assertion_kind, assertion_value, created_at`;

const SELECT = `SELECT ${COLUMNS} FROM agent_sessions WHERE session_key = ?`;

const SELECT_ALL = `SELECT ${COLUMNS} FROM agent_sessions ORDER BY session_key`;

const INSERT = `INSERT INTO agent_sessions (session_key, provider, agent_command,
  session_identity, policy, assertion_kind, assertion_value, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

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
