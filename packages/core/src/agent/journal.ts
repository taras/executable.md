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
 *
 * ## Where a prompt publishes
 *
 * The record above is the whole of what a journal holds about a prompt, on
 * every host. What differs is where the event is appended from. An ordinary run
 * appends it through the durable machinery's own path. A host that retains
 * something beside it — a workflow run keeping which provider turn this was —
 * installs a publisher, and the append happens inside the transaction that
 * publisher opened, so the event and the association commit together or not at
 * all.
 *
 * The prompt itself has already finished by then. Talking to a provider happens
 * outside all of this, and only its outcome reaches a publisher.
 *
 * Replay reaches none of it. A retained entry answers before the live path
 * exists, so a replayed prompt contacts no provider, opens no transaction and
 * associates nothing.
 */

import { createDurableOperation, serializeError } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  DurableStream,
  Json,
  LiveDurableOperationCoordinator,
  Result as DurableResult,
  Workflow,
} from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { readCheckpoint } from "./checkpoint.ts";
import type { AgentPromptCheckpoint } from "./checkpoint.ts";
import { AgentPromptError, parsePromptFailure } from "./errors.ts";
import type { SerializedPromptFailure } from "./errors.ts";
import { AgentInternal } from "./internal.ts";
import type { AgentPromptAssociation } from "./publication.ts";
import { sourceDescription } from "../source-position.ts";
import type { SourcePosition } from "../types.ts";

/** The durable effect type every journaled Agent Prompt is recorded under. */
export const AGENT_PROMPT = "agent_prompt";

export interface PromptRecord {
  sequence: number;
  agent: string;
  sessionKey: string;
  agentSessionId?: string;
  status: "completed" | "failed" | "cancelled";
  stopReason?: string;
  text: string;
  error?: SerializedPromptFailure;
  /**
   * True only for failed prompts thrown through `throwOnError`. Replay
   * uses the stored marker: a partial replay re-throws, and a full
   * replay omits the failure from aggregate restoration because the
   * throw was already handled where it happened (e.g. by a failing
   * test). Missing in older records — parsed as absent, never inferred.
   */
  raised?: boolean;
  /**
   * The provider's own name for this completed turn, when the retaining caller
   * asked for it to be kept.
   *
   * Ordinarily a checkpoint is not journalled at all: it is associated with one
   * terminal event and published through a host's own transaction, because what
   * a host keeps beside a Prompt is that host's business. A launch is the one
   * caller that has to keep it here — the turn it owes is retained so a replay
   * never spends a second one, and the record of the turn is only evidence that
   * it happened if it names which turn it was.
   */
  checkpoint?: AgentPromptCheckpoint;
}

export function* persistPrompt(
  identity: { name: string; input: string; position?: Readonly<SourcePosition> },
  live: () => Operation<PromptRecord>,
  association: () => AgentPromptAssociation | undefined = () => undefined,
): Workflow<PromptRecord> {
  const stored = yield createDurableOperation<Json>(
    {
      type: AGENT_PROMPT,
      name: identity.name,
      input: identity.input,
      ...sourceDescription(identity.position),
    },
    function* (): Operation<Json> {
      return serializePromptRecord(yield* live());
    },
    { coordinator: promptPublication(association) },
  );
  const parsed = parsePromptRecord(stored);
  if (!parsed) {
    throw new Error(`journaled agent_prompt "${identity.name}" has an unexpected shape`);
  }
  return parsed;
}

/** A publisher that returned without appending has published nothing. */
class AgentPromptPublicationError extends Error {
  override name = "AgentPromptPublicationError";
}

/**
 * The live boundary between running a prompt and retaining it.
 *
 * With no publisher installed this is the ordinary path exactly: execute,
 * capture, append. With one installed the append moves inside that publisher,
 * which is what lets a host commit an association in the same transaction.
 *
 * The association is offered only for a prompt that succeeded. A failed,
 * cancelled or refused turn describes a conversation nothing can be continued
 * from, so there is nothing to retain beside it however the provider answered.
 *
 * A publisher that raises activates the run's durability failure rather than
 * returning: the prompt's result is not in the journal, and a run that carried
 * on would be continuing from a history missing the turn it just had.
 */
function promptPublication(
  association: () => AgentPromptAssociation | undefined,
): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: DurableResult) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
    ): Operation<DurableResult> {
      let result: DurableResult;
      try {
        result = { status: "ok", value: yield* execute() };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        result = { status: "err", error: serializeError(failure) };
      }

      const publisher = yield* AgentInternal.operations.promptPublisher;
      if (publisher === undefined) {
        yield* publish(result);
        return result;
      }

      const published = result;
      let appended = false;
      try {
        yield* publisher.publish({
          association: published.status === "ok" ? association() : undefined,
          *append(): Operation<void> {
            if (appended) {
              throw new AgentPromptPublicationError(
                "this prompt is already appended, and a second append would journal it twice",
              );
            }
            appended = true;
            yield* publish(published);
          },
        });
      } catch (error) {
        throw activateFailure(error);
      }
      if (!appended) {
        throw activateFailure(
          new AgentPromptPublicationError(
            "the installed prompt publisher returned without appending this prompt, so nothing " +
              "retains the turn it just had",
          ),
        );
      }
      return result;
    },
  };
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
      if (parsed && parsed.raised !== true) {
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
  if (record.raised === true) {
    payload.raised = true;
  }
  if (record.checkpoint !== undefined) {
    payload.checkpoint = {
      provider: record.checkpoint.provider,
      kind: record.checkpoint.kind,
      value: record.checkpoint.value,
    };
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One durable `agent_prompt` result, as the record it claims to be.
 *
 * Pure and total: it reads a value nobody has authenticated and answers with
 * the record or with nothing, so a caller that has only retained bytes — a
 * sealed artifact's verifier, for one — asks the same question a live run
 * asks rather than spelling the shape a second time.
 */
export function parsePromptRecord(value: unknown): PromptRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const {
    sequence,
    agent,
    sessionKey,
    agentSessionId,
    status,
    stopReason,
    text,
    error,
    raised,
    checkpoint,
  } = value;
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
  if (raised === true && record.status !== "completed") {
    record.raised = true;
  }
  if (checkpoint !== undefined) {
    // A checkpoint names a turn something can be continued from, so a record
    // carrying one for a turn that did not complete contradicts itself.
    const parsed = readCheckpoint(checkpoint);
    if (!parsed || record.status !== "completed") {
      return undefined;
    }
    record.checkpoint = parsed;
  }
  return record;
}
