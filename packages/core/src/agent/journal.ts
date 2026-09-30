/**
 * Durable prompt records (specs/acp-client-spec.md §Journaling and replay).
 *
 * Each prompt is one durable operation. The description carries the prompt's
 * identity and input; the result record carries agent and session identity,
 * terminal status, stop reason, text (including partial text on failure), the
 * structured failure, and — for a turn that started — the one configuration the
 * conversation ran under. `sequence` records prompt execution order explicitly,
 * so restoration never depends on asynchronous completion order.
 *
 * ## What a turn retains about the permissions it was granted
 *
 * A turn that answered permission requests also retains an audit of them, so a
 * reader of the history can see what the agent was allowed to do without
 * re-running anything. An audit is a closed account of one request — its tool
 * call, the choices the provider offered, and which one answered it — assembled
 * field by field by {@link promptPermissionAudit}.
 *
 * Nothing else crosses. The request's `rawInput` is the agent's own argument
 * text, its `Session` is a live object, and a provider's callbacks, waiters and
 * errors are not data at all: a durable record that spread the request would
 * publish all of them and would keep whatever the caller mutated afterwards.
 * So the audit is copied at the moment the request arrives, and the decision is
 * added only once it has been made — by whichever policy makes it, which this
 * observation neither replaces nor delays.
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
import { createContext } from "effection";
import type { Operation } from "effection";
import { Agent } from "./agent-api.ts";
import type {
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  SessionConfiguration,
} from "./agent-api.ts";
import { readConfiguration, serializeConfiguration } from "./configuration-record.ts";
import { readCheckpoint } from "./checkpoint.ts";
import type { AgentPromptCheckpoint } from "./checkpoint.ts";
import { AgentPromptError, parsePromptFailure } from "./errors.ts";
import type { SerializedPromptFailure } from "./errors.ts";
import { AgentInternal } from "./internal.ts";
import type { AgentPromptAssociation, AgentPromptHandle } from "./publication.ts";
import { sourceDescription } from "../source-position.ts";
import type { SourcePosition } from "../types.ts";

/** The durable effect type every journaled Agent Prompt is recorded under. */
export const AGENT_PROMPT = "agent_prompt";

/**
 * One permission request a prompt's turn answered, as the journal retains it.
 *
 * The safe half of a `PermissionRequest` — which tool call asked, what the
 * provider offered, and the decision that came back. Nothing here is a live
 * object, and nothing here is the agent's own argument text.
 */
export interface PromptPermission {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly options: readonly PermissionOption[];
  readonly outcome: PermissionOutcome;
}

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
   * What the conversation this prompt ran in was running under.
   *
   * Present only once the provider said the turn started, because that is when
   * the conversation was under these settings: a prompt that failed while they
   * were still being applied ran under nothing, and one that started and then
   * failed still ran under exactly them. A prompt beneath an unconfigured
   * `<Session>` carries no member at all.
   */
  configuration?: SessionConfiguration;
  /**
   * The permission requests this turn answered, in the order they arrived.
   *
   * Arrival order rather than completion order: two overlapping requests are
   * answered whenever their policies finish, and a list ordered by that would
   * say the agent asked in an order it did not. A request that raised instead
   * of returning has no entry — nothing decided it, so there is nothing to
   * record. Absent on a turn that answered none, and on every record written
   * before this member existed.
   */
  permissions?: readonly PromptPermission[];
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

/** The safe half of one request, before its decision has been made. */
type PermissionSubject = Omit<PromptPermission, "outcome">;

interface PermissionDraft {
  readonly subject: PermissionSubject;
  outcome?: PermissionOutcome;
}

/**
 * Where one Prompt's audit goes, for whoever answers a request it made.
 *
 * A destination and nothing else: holding it says which turn a decision belongs
 * to, and grants no authority to make one. Private to this module — no caller
 * outside it can reach the context, the ledger or a reserved place.
 *
 * Scope is the correlation. A permission request raised while a Prompt's
 * provider stream is being consumed runs inside that Prompt's own scope, so it
 * inherits that Prompt's ledger and no other — never the newest turn, the turn
 * with matching text, or whichever decision settled first.
 */
const PromptAudit = createContext<PromptAuditLedger>("xmd.agent.prompt-permission-audit");

/** One Prompt's ledger: reserve a place, then complete that same place. */
interface PromptAuditLedger {
  /**
   * Take this request's place in the order, and hand back the one way to
   * complete it.
   *
   * None when the request's safe fields do not read as the closed shape a record
   * holds: retaining a half-read audit would make the record unparseable, which
   * would fail a turn over how it was watched.
   */
  reserve(request: PermissionRequest): ((outcome: PermissionOutcome) => void) | undefined;
}

/** What one turn observed of the permission requests made while it ran. */
export interface PromptPermissionAudit {
  /**
   * Run this Prompt's provider work with this ledger in place, and only it.
   *
   * A bracket rather than a marker: the ledger exists for exactly as long as
   * `body` runs, descendants inherit it, and it is restored when `body`
   * finishes however it finishes — returning, raising or being cancelled. There
   * is no way to install the ledger without naming the work it governs, so it
   * cannot be left behind for sibling work to inherit.
   */
  within<T>(body: () => Operation<T>): Operation<T>;
  /** The requests that were decided, in the order they arrived. */
  completed(): readonly PromptPermission[];
}

/**
 * Observe every permission decision, from outside every policy that makes one.
 *
 * At `max`, which is the outermost position there is: a policy decides without
 * delegating — that is what deciding means — so an observer anywhere inside one
 * never sees the call it exists to record. The REPL's own authority is installed
 * at the ordinary position and is therefore inside this, which is the whole
 * point: its outcome is the one this copies.
 *
 * It decides nothing, substitutes nothing and swallows nothing. A policy that
 * raises raises through here, and the place it was answering is simply never
 * completed.
 */
export function* observePermissionDecisions(): Operation<void> {
  yield* Agent.around(
    {
      *requestPermission([request], next) {
        const ledger = yield* PromptAudit.get();
        // Reserved on the way in, because a caller is free to reuse or rewrite the
        // request object it passed once the answer is in hand.
        const complete = ledger?.reserve(request);
        const outcome = yield* next(request);
        complete?.(outcome);
        return outcome;
      },
    },
    { at: "max" },
  );
}

/**
 * The audit one prompt turn keeps of the permission requests made while it ran.
 *
 * The turn owns the ledger and the observer is somewhere else entirely — outside
 * every policy, installed once for the execution. What connects them is scope:
 * this ledger is placed where the provider's stream is consumed, and a request
 * raised from in there finds it.
 *
 * Only completed places are published. A decision still being made, and one
 * whose policy was cancelled before it answered, are both absent — an audit
 * naming an outcome nobody reached would be a record of something that did not
 * happen.
 */
export function promptPermissionAudit(): PromptPermissionAudit {
  const drafts: PermissionDraft[] = [];
  const ledger: PromptAuditLedger = {
    reserve(request: PermissionRequest) {
      const subject = permissionSubject(request);
      if (subject === undefined) {
        return undefined;
      }
      // The place is taken now and completed later, so two requests from one
      // turn keep the order they arrived in however their answers interleave.
      const draft: PermissionDraft = { subject };
      drafts.push(draft);
      return (outcome: PermissionOutcome) => {
        draft.outcome = permissionDecision(outcome);
      };
    },
  };
  return {
    within<T>(body: () => Operation<T>): Operation<T> {
      return PromptAudit.with(ledger, () => body());
    },
    completed() {
      return drafts.flatMap((draft) => {
        if (draft.outcome === undefined) {
          return [];
        }
        const permission: PromptPermission & { title?: string; kind?: string } = {
          toolCallId: draft.subject.toolCallId,
          options: draft.subject.options,
          outcome: draft.outcome,
        };
        if (draft.subject.title !== undefined) {
          permission.title = draft.subject.title;
        }
        if (draft.subject.kind !== undefined) {
          permission.kind = draft.subject.kind;
        }
        return [Object.freeze(permission)];
      });
    },
  };
}

function isPermissionOptionKind(value: unknown): value is PermissionOption["kind"] {
  return (
    value === "allow_once" ||
    value === "allow_always" ||
    value === "reject_once" ||
    value === "reject_always"
  );
}

/**
 * The safe fields of one live request, named one at a time.
 *
 * Named rather than spread: a spread would carry `rawInput` and every member a
 * provider added to the object, and the next member somebody adds to
 * `PermissionRequest` would join the journal without anyone deciding it should.
 */
function permissionSubject(request: PermissionRequest): PermissionSubject | undefined {
  const { toolCallId, title, kind } = request.toolCall;
  if (typeof toolCallId !== "string") {
    return undefined;
  }
  if (title !== undefined && typeof title !== "string") {
    return undefined;
  }
  if (kind !== undefined && typeof kind !== "string") {
    return undefined;
  }
  const options: PermissionOption[] = [];
  for (const option of request.options) {
    if (typeof option.optionId !== "string" || typeof option.name !== "string") {
      return undefined;
    }
    if (!isPermissionOptionKind(option.kind)) {
      return undefined;
    }
    options.push(
      Object.freeze({ optionId: option.optionId, name: option.name, kind: option.kind }),
    );
  }
  const subject: PermissionSubject & { title?: string; kind?: string } = {
    toolCallId,
    options: Object.freeze(options),
  };
  if (title !== undefined) {
    subject.title = title;
  }
  if (kind !== undefined) {
    subject.kind = kind;
  }
  return Object.freeze(subject);
}

/** One decision, as this record retains it, or nothing that is one. */
function permissionDecision(outcome: PermissionOutcome): PermissionOutcome | undefined {
  if (outcome.outcome === "cancelled") {
    return Object.freeze({ outcome: "cancelled" });
  }
  if (outcome.outcome === "selected" && typeof outcome.optionId === "string") {
    return Object.freeze({ outcome: "selected", optionId: outcome.optionId });
  }
  return undefined;
}

export function* persistPrompt(
  identity: { name: string; input: string; position?: Readonly<SourcePosition> },
  live: () => Operation<PromptRecord>,
  association: () => AgentPromptAssociation | undefined = () => undefined,
  begun: () => AgentPromptHandle = () => undefined,
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
    { coordinator: promptPublication(association, begun) },
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
  begun: () => AgentPromptHandle,
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
          // Carried whatever this turn did: a failed or cancelled Prompt still
          // ends the live turn that began, so the handoff is the same one.
          begun: begun(),
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
  if (record.permissions !== undefined) {
    payload.permissions = record.permissions.map(serializePermission);
  }
  Object.assign(payload, serializeConfiguration(record.configuration));
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

/** One audit as the journal writes it, member by named member. */
function serializePermission(permission: PromptPermission): Json {
  const payload: Record<string, Json> = {
    toolCallId: permission.toolCallId,
    options: permission.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
    outcome:
      permission.outcome.outcome === "selected"
        ? { outcome: "selected", optionId: permission.outcome.optionId }
        : { outcome: "cancelled" },
  };
  if (permission.title !== undefined) {
    payload.title = permission.title;
  }
  if (permission.kind !== undefined) {
    payload.kind = permission.kind;
  }
  return payload;
}

/** What a retained audit that does not read back is, as distinct from none. */
const UNREADABLE = Symbol("unreadable permission audit");

/**
 * The audits one durable record carries, read as the closed shape they claim.
 *
 * Closed in both directions: every member is checked, and a member nothing here
 * defines refuses the whole record rather than being read past. An audit is
 * evidence about what an agent was permitted to do, and a reader that ignored
 * the parts it did not recognize would be reporting a decision it had not read.
 */
function readPermissions(value: unknown): readonly PromptPermission[] | typeof UNREADABLE {
  if (!Array.isArray(value)) {
    return UNREADABLE;
  }
  const permissions: PromptPermission[] = [];
  for (const member of value) {
    if (!isRecord(member)) {
      return UNREADABLE;
    }
    const { toolCallId, title, kind, options, outcome, ...rest } = member;
    if (Object.keys(rest).length > 0) {
      return UNREADABLE;
    }
    if (typeof toolCallId !== "string") {
      return UNREADABLE;
    }
    if (title !== undefined && typeof title !== "string") {
      return UNREADABLE;
    }
    if (kind !== undefined && typeof kind !== "string") {
      return UNREADABLE;
    }
    const offered = readPermissionOptions(options);
    if (offered === UNREADABLE) {
      return UNREADABLE;
    }
    const decided = readPermissionOutcome(outcome);
    if (decided === undefined) {
      return UNREADABLE;
    }
    const permission: PromptPermission & { title?: string; kind?: string } = {
      toolCallId,
      options: offered,
      outcome: decided,
    };
    if (title !== undefined) {
      permission.title = title;
    }
    if (kind !== undefined) {
      permission.kind = kind;
    }
    permissions.push(permission);
  }
  return permissions;
}

function readPermissionOptions(value: unknown): readonly PermissionOption[] | typeof UNREADABLE {
  if (!Array.isArray(value)) {
    return UNREADABLE;
  }
  const options: PermissionOption[] = [];
  for (const member of value) {
    if (!isRecord(member)) {
      return UNREADABLE;
    }
    const { optionId, name, kind, ...rest } = member;
    if (Object.keys(rest).length > 0) {
      return UNREADABLE;
    }
    if (typeof optionId !== "string" || typeof name !== "string") {
      return UNREADABLE;
    }
    if (!isPermissionOptionKind(kind)) {
      return UNREADABLE;
    }
    options.push({ optionId, name, kind });
  }
  return options;
}

function readPermissionOutcome(value: unknown): PermissionOutcome | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { outcome, optionId, ...rest } = value;
  if (Object.keys(rest).length > 0) {
    return undefined;
  }
  if (outcome === "cancelled" && optionId === undefined) {
    return { outcome: "cancelled" };
  }
  if (outcome === "selected" && typeof optionId === "string") {
    return { outcome: "selected", optionId };
  }
  return undefined;
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
    permissions,
    raised,
    checkpoint,
  } = value;
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    typeof agent !== "string"
  ) {
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
  if (permissions !== undefined) {
    const audited = readPermissions(permissions);
    if (audited === UNREADABLE) {
      return undefined;
    }
    record.permissions = audited;
  }
  // Refused rather than read past: a record whose configuration does not read
  // back is not describing work this build can say anything about.
  const configuration = readConfiguration(value);
  if (!configuration.ok) {
    return undefined;
  }
  if (configuration.value !== undefined) {
    record.configuration = configuration.value;
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
