/**
 * Durable prompt records (specs/acp-client-spec.md §Journaling and replay).
 *
 * Each prompt is one durable operation. The description carries the
 * prompt's identity and input; the result record carries agent and session
 * identity, terminal status, stop reason, text (including partial text on
 * failure), and the structured failure. `sequence` records prompt
 * execution order explicitly, so restoration never depends on asynchronous
 * completion order.
 *
 * On a full replay (journal already holds the root Close), durableRun
 * returns the stored root result without re-expanding, so the failed
 * records are restored from the stream instead of re-recording.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { DurableStream, Json, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { AgentPromptError, parsePromptFailure } from "./errors.ts";
import type { SerializedPromptFailure } from "./errors.ts";

const AGENT_PROMPT = "agent_prompt";

export interface PromptRecord {
  sequence: number;
  agent: string;
  sessionKey: string;
  agentSessionId?: string;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  text: string;
  error?: SerializedPromptFailure;
}

export function* persistPrompt(
  identity: { name: string; input: string },
  live: () => Operation<PromptRecord>,
): Workflow<PromptRecord> {
  const stored = yield createDurableOperation<Json>(
    { type: AGENT_PROMPT, name: identity.name, input: identity.input },
    function* (): Operation<Json> {
      return serializePromptRecord(yield* live());
    },
  );
  const parsed = parsePromptRecord(stored);
  if (!parsed) {
    throw new Error(`journaled agent_prompt "${identity.name}" has an unexpected shape`);
  }
  return parsed;
}

/**
 * Read prompt records from a journal that already holds a root Close event
 * — the confirmed-full-replay case. Returns undefined for a live or
 * partial journal, where expansion itself (re)records each prompt.
 */
export function* readCompletedPrompts(
  stream: DurableStream,
): Operation<PromptRecord[] | undefined> {
  const events = yield* stream.readAll();
  const completed = events.some((event) => event.type === "close" && event.coroutineId === "root");
  if (!completed) {
    return undefined;
  }

  const records: PromptRecord[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.result.status !== "ok") {
      continue;
    }
    if (event.description.type === AGENT_PROMPT) {
      const parsed = parsePromptRecord(event.result.value);
      if (parsed) {
        records.push(parsed);
      }
    }
  }
  return records;
}

/**
 * The public AgentPromptError for an unsuccessful record, or undefined
 * for a completed one. Constructed from the persisted (or replayed)
 * record, never from live provider state.
 */
export function promptFailureFromRecord(record: PromptRecord): AgentPromptError | undefined {
  if (record.status === "completed") {
    return undefined;
  }
  const message =
    record.error?.message ??
    (record.stopReason
      ? `agent prompt failed with stop reason "${record.stopReason}"`
      : `agent prompt ${record.status}`);
  const options: {
    agent: string;
    sessionKey: string;
    stopReason?: string;
    cause?: unknown;
  } = { agent: record.agent, sessionKey: record.sessionKey };
  if (record.stopReason !== undefined) {
    options.stopReason = record.stopReason;
  }
  if (record.error?.cause !== undefined) {
    options.cause = record.error.cause;
  }
  return new AgentPromptError(message, options);
}

function serializePromptRecord(record: PromptRecord): Json {
  const payload: Record<string, Json> = {
    sequence: record.sequence,
    agent: record.agent,
    sessionKey: record.sessionKey,
    status: record.status,
    text: record.text,
  };
  if (record.agentSessionId !== undefined) {
    payload.agentSessionId = record.agentSessionId;
  }
  if (record.stopReason !== undefined) {
    payload.stopReason = record.stopReason;
  }
  if (record.error !== undefined) {
    payload.error = record.error;
  }
  return payload;
}

function parsePromptRecord(value: unknown): PromptRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { sequence, agent, sessionKey, agentSessionId, status, stopReason, text, error } =
    value as Record<string, unknown>;
  if (typeof sequence !== "number" || typeof agent !== "string") {
    return undefined;
  }
  if (typeof sessionKey !== "string" || typeof text !== "string") {
    return undefined;
  }
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return undefined;
  }
  const record: PromptRecord = { sequence, agent, sessionKey, status, text };
  if (typeof agentSessionId === "string") {
    record.agentSessionId = agentSessionId;
  }
  if (typeof stopReason === "string") {
    record.stopReason = stopReason;
  }
  if (error !== undefined) {
    const parsed = parsePromptFailure(error);
    if (!parsed) {
      return undefined;
    }
    record.error = parsed;
  }
  return record;
}
