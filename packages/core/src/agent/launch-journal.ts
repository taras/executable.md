/**
 * Durable launch records (specs/native-agent-session-launch-spec.md
 * §Durability and replay).
 *
 * One launch is one `agent_session_launch` effect type, named from the
 * expansion identity `<Session.Launch>` derived, with one retained record per
 * phase the launch completed. Phases are separate durable operations because
 * the preparation has to be retained *before* ACP ownership is released: a
 * launch interrupted between detach and spawn has to resume against the
 * provider session it already prepared, and a record written only when the
 * whole launch settles would describe nothing at all.
 *
 * A launch phase is not a prompt, so no phase here reuses `agent_prompt`. Their
 * inputs, phases and process semantics differ, and sharing one type would make
 * a replayed prompt and a replayed launch indistinguishable in a journal.
 *
 * The one exception is the materialization turn, and it is not an exception to
 * that reasoning: it is a model turn, sent to an agent session, and it is
 * retained as an ordinary `agent_prompt` because that is what it is. What must
 * never be re-run is the sending, and `agent_prompt` is the durable operation
 * that already guarantees that — which is the whole reason the turn is retained
 * as a prompt first and as the `materialized` phase second.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { Json, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import type {
  DetachedLaunchRecord,
  ExecutableBuildBindingV1,
  ExitedLaunchRecord,
  IdentityProvenance,
  InstructionReconciliation,
  LaunchFailure,
  LaunchFailureClass,
  MaterializationPlan,
  MaterializationUsage,
  MaterializedLaunchRecord,
  PreparedLaunchRecord,
} from "./launch.ts";
import { AgentInternal } from "./internal.ts";
import { readCheckpoint } from "./checkpoint.ts";
import { persistPrompt } from "./journal.ts";
import type { PromptRecord } from "./journal.ts";
import { sourceDescription } from "../source-position.ts";
import type { SourcePosition } from "../types.ts";
import type { PermissionMode } from "./agent-api.ts";

const AGENT_SESSION_LAUNCH = "agent_session_launch";

/**
 * Everything the engine owns about a launch request, retained in the
 * preparation effect's description.
 *
 * The rendered instructions are the effect's `input`; the rest describes the
 * filesystem authority, model request and permission configuration the request
 * was made under, so a reader of the journal can tell what the native session
 * was prepared to be able to do.
 */
export interface LaunchRequestDescription {
  instructions: string;
  agent: string;
  session?: string;
  cwd: string;
  additionalDirectories: string[];
  permissionMode: PermissionMode;
  model?: string;
}

export interface LaunchIdentity {
  /** `launch:<path>:<line>:<column>#<ordinal>` — one launch's stable name. */
  name: string;
  position?: Readonly<SourcePosition>;
}

const FAILURE_CLASSES: readonly LaunchFailureClass[] = [
  "unsupported-capability",
  "identity-unavailable",
  "instructions-refused",
  "directory-authority",
  "detach-failed",
  "process-creation-failed",
  "native-exit",
  "session-busy",
  "session-recovery-required",
  "executable-binding-refused",
  "materialization-failed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailure(value: unknown): LaunchFailure | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { class: failureClass, message } = value;
  if (typeof message !== "string") {
    return undefined;
  }
  const known = FAILURE_CLASSES.find((candidate) => candidate === failureClass);
  if (!known) {
    return undefined;
  }
  return { class: known, message };
}

function serializeFailure(failure: LaunchFailure): Json {
  return { class: failure.class, message: failure.message };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    entries.push(entry);
  }
  return entries;
}

const RECONCILIATIONS: readonly InstructionReconciliation[] = ["installed", "resumed", "replaced"];

function reconciliation(value: unknown): InstructionReconciliation | undefined {
  return RECONCILIATIONS.find((candidate) => candidate === value);
}

/**
 * Who chose the identity, as the record says — or, for a record written before
 * anyone could choose, as the format itself says.
 *
 * A merged #518 record has no provenance member, and could not have been
 * client-allocated because that path did not exist in the released format. So
 * absence reads as `provider-returned`. That is the one inference this parser
 * makes, and it only ever infers the weaker claim: client allocation must say
 * so explicitly.
 */
function provenance(value: unknown): IdentityProvenance | undefined {
  if (value === undefined) {
    return "provider-returned";
  }
  return value === "provider-returned" || value === "client-allocated" ? value : undefined;
}

const BINDING_MEMBERS = ["schema", "reportedVersion", "executableDigest"];
const DIGEST_MEMBERS = ["algorithm", "value"];
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function exactMembers(value: Record<string, unknown>, members: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === members.length && members.every((member) => keys.includes(member));
}

/**
 * Read a retained build binding strictly.
 *
 * The member set is exact rather than minimal, because a binding is compared
 * for equality: a member this build ignores is a fact the writer thought was
 * part of the build's identity, and comparing without it would call two
 * different builds the same one.
 */
function executableBinding(value: unknown): ExecutableBuildBindingV1 | undefined {
  if (!isRecord(value) || !exactMembers(value, BINDING_MEMBERS)) {
    return undefined;
  }
  const { schema, reportedVersion, executableDigest } = value;
  if (schema !== "executable-build.v1") {
    return undefined;
  }
  if (typeof reportedVersion !== "string" || reportedVersion.length === 0) {
    return undefined;
  }
  if (!isRecord(executableDigest) || !exactMembers(executableDigest, DIGEST_MEMBERS)) {
    return undefined;
  }
  const { algorithm, value: digestValue } = executableDigest;
  if (algorithm !== "sha256") {
    return undefined;
  }
  if (typeof digestValue !== "string" || !LOWERCASE_SHA256.test(digestValue)) {
    return undefined;
  }
  return {
    schema: "executable-build.v1",
    reportedVersion,
    executableDigest: { algorithm: "sha256", value: digestValue },
  };
}

function serializeBinding(binding: ExecutableBuildBindingV1): Json {
  return {
    schema: binding.schema,
    reportedVersion: binding.reportedVersion,
    executableDigest: {
      algorithm: binding.executableDigest.algorithm,
      value: binding.executableDigest.value,
    },
  };
}

const PLAN_MEMBERS = ["promptVersion", "requestId", "prompt"];

/**
 * Read a retained materialization plan strictly.
 *
 * Exact members, like a build binding and for the same reason: the plan is what
 * a resumed launch checks the retained turn against, and a member this build
 * ignores is one the writer thought identified the turn.
 */
function materializationPlan(value: unknown): MaterializationPlan | undefined {
  if (!isRecord(value) || !exactMembers(value, PLAN_MEMBERS)) {
    return undefined;
  }
  const { promptVersion, requestId, prompt } = value;
  if (typeof promptVersion !== "string" || promptVersion.length === 0) {
    return undefined;
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return undefined;
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    return undefined;
  }
  return { promptVersion, requestId, prompt };
}

function serializePlan(plan: MaterializationPlan): Json {
  return { promptVersion: plan.promptVersion, requestId: plan.requestId, prompt: plan.prompt };
}

function permissionMode(value: unknown): PermissionMode | undefined {
  if (value === "approve-all" || value === "approve-reads" || value === "deny-all") {
    return value;
  }
  return undefined;
}

function serializePrepared(record: PreparedLaunchRecord): Json {
  const payload: Record<string, Json> = {
    phase: record.phase,
    agent: record.agent,
    sessionKey: record.sessionKey,
    provider: record.provider,
    nativeSessionId: record.nativeSessionId,
    sessionState: record.sessionState,
    instructionChannel: record.instructionChannel,
    instructionReconciliation: record.instructionReconciliation,
    identityProvenance: record.identityProvenance,
    instructionsDigest: record.instructionsDigest,
    instructions: record.instructions,
    cwd: record.cwd,
    additionalDirectories: [...record.additionalDirectories],
    permissionMode: record.permissionMode,
    launcher: record.launcher,
  };
  if (record.executableBinding !== undefined) {
    payload.executableBinding = serializeBinding(record.executableBinding);
  }
  if (record.materialization !== undefined) {
    payload.materialization = serializePlan(record.materialization);
  }
  if (record.requestedModel !== undefined) {
    payload.requestedModel = record.requestedModel;
  }
  if (record.model !== undefined) {
    payload.model = record.model;
  }
  if (record.failure !== undefined) {
    payload.failure = serializeFailure(record.failure);
  }
  return payload;
}

/**
 * Read a retained preparation strictly.
 *
 * Exported from this internal module so the strictness can be asserted
 * directly. It is not part of the package's public surface: `packages/core/mod.ts`
 * exports the record types, not the reader.
 */
export function parsePrepared(value: unknown): PreparedLaunchRecord | undefined {
  if (!isRecord(value) || value.phase !== "prepared") {
    return undefined;
  }
  const {
    agent,
    sessionKey,
    provider,
    nativeSessionId,
    sessionState,
    instructionChannel,
    instructionsDigest,
    instructions,
    cwd,
    additionalDirectories,
    launcher,
    requestedModel,
    model,
    failure,
  } = value;
  if (typeof agent !== "string" || typeof sessionKey !== "string") {
    return undefined;
  }
  if (typeof provider !== "string" || typeof nativeSessionId !== "string") {
    return undefined;
  }
  if (sessionState !== "created" && sessionState !== "resumed") {
    return undefined;
  }
  if (typeof instructionChannel !== "string" || typeof instructionsDigest !== "string") {
    return undefined;
  }
  if (typeof instructions !== "string" || typeof cwd !== "string") {
    return undefined;
  }
  if (typeof launcher !== "string") {
    return undefined;
  }
  const directories = stringList(additionalDirectories);
  const mode = permissionMode(value.permissionMode);
  const reconciled = reconciliation(value.instructionReconciliation);
  const provenanceValue = provenance(value.identityProvenance);
  if (!directories || !mode || !reconciled || !provenanceValue) {
    return undefined;
  }
  // A binding says which build a provider-native identity belongs to, and both
  // provenances have one to say it about: a build accepted the identity XMD
  // chose, or it issued the identity XMD was handed. So a binding is valid
  // beside either, and which agents require one is the provider's decision
  // rather than this parser's — core observes no executables and knows no
  // adapters. Absence is not refused: both paths were released before any build
  // was observed, and that history stays readable as the legacy, native-only
  // sessions it describes.
  let binding: ExecutableBuildBindingV1 | undefined;
  if (value.executableBinding !== undefined) {
    binding = executableBinding(value.executableBinding);
    if (!binding) {
      return undefined;
    }
  }
  // Absence is what says no turn is owed, so a plan that does not read back is
  // refused rather than dropped: reading it as absence would let a launch whose
  // record is damaged proceed as one that never needed a turn.
  let plan: MaterializationPlan | undefined;
  if (value.materialization !== undefined) {
    plan = materializationPlan(value.materialization);
    if (!plan) {
      return undefined;
    }
  }
  const record: PreparedLaunchRecord = {
    phase: "prepared",
    agent,
    sessionKey,
    provider,
    nativeSessionId,
    sessionState,
    instructionChannel,
    instructionReconciliation: reconciled,
    identityProvenance: provenanceValue,
    instructionsDigest,
    instructions,
    cwd,
    additionalDirectories: directories,
    permissionMode: mode,
    launcher,
  };
  if (binding !== undefined) {
    record.executableBinding = binding;
  }
  if (plan !== undefined) {
    record.materialization = plan;
  }
  if (typeof requestedModel === "string") {
    record.requestedModel = requestedModel;
  }
  if (typeof model === "string") {
    record.model = model;
  }
  if (failure !== undefined) {
    const parsed = parseFailure(failure);
    if (!parsed) {
      return undefined;
    }
    record.failure = parsed;
  }
  return record;
}

/** Every member of a usage report that is a figure rather than a currency. */
type UsageCount = Exclude<keyof MaterializationUsage, "costCurrency">;

const USAGE_COUNTS: readonly UsageCount[] = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
  "thoughtTokens",
  "totalTokens",
  "costAmount",
];

/** A figure that counts or measures, and so is finite and never negative. */
function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read what the provider reported the turn cost.
 *
 * A member this build does not know refuses the record rather than being
 * dropped, because a dropped member is displayed as `provider did not report` —
 * which would state, about a figure the provider did report, the one thing this
 * record must never say.
 */
function parseUsage(value: unknown): MaterializationUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage: { -readonly [K in keyof MaterializationUsage]: MaterializationUsage[K] } = {};
  for (const [member, entry] of Object.entries(value)) {
    if (member === "costCurrency") {
      if (typeof entry !== "string" || entry.length === 0) {
        return undefined;
      }
      usage.costCurrency = entry;
      continue;
    }
    const known = USAGE_COUNTS.find((candidate) => candidate === member);
    const count = nonNegative(entry);
    if (known === undefined || count === undefined) {
      return undefined;
    }
    usage[known] = count;
  }
  return usage;
}

function serializeUsage(usage: MaterializationUsage): Json {
  const payload: Record<string, Json> = {};
  for (const member of USAGE_COUNTS) {
    const entry = usage[member];
    if (entry !== undefined) {
      payload[member] = entry;
    }
  }
  if (usage.costCurrency !== undefined) {
    payload.costCurrency = usage.costCurrency;
  }
  return payload;
}

function serializeMaterialized(record: MaterializedLaunchRecord): Json {
  const payload: Record<string, Json> = {
    phase: record.phase,
    promptVersion: record.promptVersion,
    requestId: record.requestId,
    response: record.response,
    usage: serializeUsage(record.usage),
  };
  if (record.turn !== undefined) {
    payload.turn = {
      provider: record.turn.provider,
      kind: record.turn.kind,
      value: record.turn.value,
    };
  }
  if (record.nativeSessionId !== undefined) {
    payload.nativeSessionId = record.nativeSessionId;
  }
  if (record.durationMs !== undefined) {
    payload.durationMs = record.durationMs;
  }
  if (record.stopReason !== undefined) {
    payload.stopReason = record.stopReason;
  }
  if (record.failure !== undefined) {
    payload.failure = serializeFailure(record.failure);
  }
  return payload;
}

export function parseMaterialized(value: unknown): MaterializedLaunchRecord | undefined {
  if (!isRecord(value) || value.phase !== "materialized") {
    return undefined;
  }
  const { promptVersion, requestId, response, nativeSessionId, durationMs, stopReason, failure } =
    value;
  // The plan these name is what a replay looks the turn up by, so a record that
  // identifies it as nothing identifies no turn at all.
  if (typeof promptVersion !== "string" || promptVersion.length === 0) {
    return undefined;
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return undefined;
  }
  if (typeof response !== "string") {
    return undefined;
  }
  const usage = parseUsage(value.usage);
  if (!usage) {
    return undefined;
  }
  const record: MaterializedLaunchRecord = {
    phase: "materialized",
    promptVersion,
    requestId,
    usage,
    response,
  };
  if (nativeSessionId !== undefined) {
    // An empty one is the absence of an identity written down, and a launch
    // reading it back would hand a native UI a name for nothing.
    if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0) {
      return undefined;
    }
    record.nativeSessionId = nativeSessionId;
  }
  if (value.turn !== undefined) {
    const turn = readCheckpoint(value.turn);
    if (!turn) {
      return undefined;
    }
    record.turn = turn;
  }
  if (durationMs !== undefined) {
    const elapsed = nonNegative(durationMs);
    if (elapsed === undefined) {
      return undefined;
    }
    record.durationMs = elapsed;
  }
  if (typeof stopReason === "string") {
    record.stopReason = stopReason;
  }
  if (failure !== undefined) {
    const parsed = parseFailure(failure);
    if (!parsed) {
      return undefined;
    }
    record.failure = parsed;
  }
  return record;
}

function parseDetached(value: unknown): DetachedLaunchRecord | undefined {
  if (!isRecord(value) || value.phase !== "detached") {
    return undefined;
  }
  const record: DetachedLaunchRecord = { phase: "detached" };
  if (value.failure !== undefined) {
    const parsed = parseFailure(value.failure);
    if (!parsed) {
      return undefined;
    }
    record.failure = parsed;
  }
  return record;
}

function parseExited(value: unknown): ExitedLaunchRecord | undefined {
  if (!isRecord(value) || value.phase !== "exited") {
    return undefined;
  }
  const { exitCode, signal, failure } = value;
  const record: ExitedLaunchRecord = { phase: "exited" };
  if (typeof exitCode === "number") {
    record.exitCode = exitCode;
  }
  if (typeof signal === "string") {
    record.signal = signal;
  }
  if (failure !== undefined) {
    const parsed = parseFailure(failure);
    if (!parsed) {
      return undefined;
    }
    record.failure = parsed;
  }
  return record;
}

function* persistPhase<T>(
  identity: LaunchIdentity,
  phase: string,
  description: Record<string, Json>,
  live: () => Operation<T>,
  serialize: (record: T) => Json,
  parse: (value: unknown) => T | undefined,
): Workflow<T> {
  const name = `${identity.name}/${phase}`;
  const stored = yield createDurableOperation<Json>(
    {
      type: AGENT_SESSION_LAUNCH,
      name,
      ...description,
      ...sourceDescription(identity.position),
    },
    function* (): Operation<Json> {
      return serialize(yield* live());
    },
  );
  const parsed = parse(stored);
  if (!parsed) {
    throw new Error(`journaled ${AGENT_SESSION_LAUNCH} "${name}" has an unexpected shape`);
  }
  return parsed;
}

export function persistPreparation(
  identity: LaunchIdentity,
  request: LaunchRequestDescription,
  live: () => Operation<PreparedLaunchRecord>,
): Workflow<PreparedLaunchRecord> {
  const description: Record<string, Json> = {
    input: request.instructions,
    agent: request.agent,
    cwd: request.cwd,
    additionalDirectories: [...request.additionalDirectories],
    permissionMode: request.permissionMode,
  };
  if (request.session !== undefined) {
    description.session = request.session;
  }
  if (request.model !== undefined) {
    description.model = request.model;
  }
  return persistPhase(identity, "prepared", description, live, serializePrepared, parsePrepared);
}

/** The materialization turn as the durable prompt it is. */
function promptOfMaterialization(
  prepared: PreparedLaunchRecord,
  sequence: number,
  record: MaterializedLaunchRecord,
): PromptRecord {
  const prompt: PromptRecord = {
    sequence,
    agent: prepared.agent,
    sessionKey: prepared.sessionKey,
    // The identity the turn made real, because that is the conversation it was
    // sent to. A launch that owes a turn prepares none, so a turn that failed
    // reports the empty one it was still standing on.
    agentSessionId: record.nativeSessionId ?? prepared.nativeSessionId,
    status: record.failure ? "failed" : "completed",
    text: record.response,
  };
  if (record.stopReason !== undefined) {
    prompt.stopReason = record.stopReason;
  }
  if (record.failure !== undefined) {
    prompt.error = { message: record.failure.message };
  }
  if (record.turn !== undefined && prompt.status === "completed") {
    prompt.checkpoint = record.turn;
  }
  return prompt;
}

/**
 * The materialized phase rebuilt from the durable prompt alone.
 *
 * Reached when a run stopped between appending the prompt and appending the
 * phase. The turn was spent, and the only thing that could say otherwise is a
 * second one — so this reconstructs rather than re-runs, from the prompt's own
 * outcome, the checkpoint the provider named it with, and the session it was
 * sent to. What the reconstruction cannot recover is what the turn cost: those
 * figures were observed once and lost, and an unreported figure is reported as
 * unreported.
 */
function materializedFromPrompt(
  plan: MaterializationPlan,
  prompt: PromptRecord,
): MaterializedLaunchRecord {
  const record: MaterializedLaunchRecord = {
    phase: "materialized",
    promptVersion: plan.promptVersion,
    requestId: plan.requestId,
    usage: {},
    response: prompt.text,
  };
  if (prompt.stopReason !== undefined) {
    record.stopReason = prompt.stopReason;
  }
  if (
    prompt.status === "completed" &&
    prompt.checkpoint !== undefined &&
    prompt.agentSessionId !== undefined &&
    prompt.agentSessionId.length > 0
  ) {
    record.turn = prompt.checkpoint;
    // The conversation the turn was sent to, which for a launch that owed one
    // is the only place the identity was ever written down before this phase.
    record.nativeSessionId = prompt.agentSessionId;
    return record;
  }
  record.failure = {
    class: "materialization-failed",
    message:
      prompt.error?.message ??
      `the materialization turn ${prompt.status} without naming both the turn it was and the ` +
        `session it made openable`,
  };
  return record;
}

/**
 * What a launch retains when it cannot tell whether the turn was already spent.
 *
 * The preparation is retained immediately before the turn is sent, so a run that
 * replays `prepared` and then finds no outcome for the turn is looking at a run
 * that reached the sending point and never recorded what happened there. Nothing
 * reachable from here separates a turn that was never sent from one the backend
 * accepted and the interrupted run never saw — and sending now, if it is the
 * second, spends a turn in someone's conversation to learn that.
 *
 * So the launch stops. This is retained rather than raised bare, so every later
 * replay says the same thing without reconsidering it.
 */
function unrecoverable(plan: MaterializationPlan): MaterializedLaunchRecord {
  return {
    phase: "materialized",
    promptVersion: plan.promptVersion,
    requestId: plan.requestId,
    usage: {},
    response: "",
    failure: {
      class: "session-recovery-required",
      message:
        `this launch prepared a session and then stopped without recording what the turn ` +
        `that would make it openable did, so whether that turn was spent is not knowable ` +
        `here — resolve the session by hand rather than letting a resume send a second one`,
    },
  };
}

/**
 * Retain the one turn a launch may owe, as a prompt and then as a phase.
 *
 * Two durable operations, in this order, because they answer different
 * questions: the prompt says the turn was spent, and the phase says the launch
 * may go on. A run that stopped between them replays the first and rebuilds the
 * second, which is the whole reason the prompt is appended first.
 *
 * `preparedThisRun` says whether this run is the one that prepared the session,
 * rather than a resume reading a preparation an earlier run retained. It decides
 * the one thing a resume must not decide for itself: reaching the live path of a
 * turn whose preparation replayed means an earlier run already stood where this
 * one is standing, so this run refuses instead of sending.
 *
 * The prompt is issued either way, including when it is refused. Skipping it
 * would leave two runs disagreeing about which durable operation comes after
 * `prepared`, and a journal read against the wrong one diverges.
 *
 * The sequence is allocated outside the live work, so a replay that spends no
 * turn still numbers this run's prompts the way the first attempt did.
 */
export function* persistMaterialization(
  identity: LaunchIdentity,
  prepared: PreparedLaunchRecord,
  plan: MaterializationPlan,
  live: () => Operation<MaterializedLaunchRecord>,
  preparedThisRun: boolean,
): Operation<MaterializedLaunchRecord> {
  const sequence = yield* AgentInternal.operations.nextPromptSequence();
  let spent: MaterializedLaunchRecord | undefined;
  const promptIdentity: { name: string; input: string; position?: Readonly<SourcePosition> } = {
    name: `${identity.name}/materialization`,
    input: plan.prompt,
  };
  if (identity.position) {
    promptIdentity.position = identity.position;
  }
  const prompt = yield* persistPrompt(promptIdentity, function* () {
    spent = preparedThisRun ? yield* live() : unrecoverable(plan);
    return promptOfMaterialization(prepared, sequence, spent);
  });
  return yield* persistPhase(
    identity,
    "materialized",
    { input: plan.prompt, promptVersion: plan.promptVersion, requestId: plan.requestId },
    // deno-lint-ignore require-yield
    function* () {
      return spent ?? materializedFromPrompt(plan, prompt);
    },
    serializeMaterialized,
    parseMaterialized,
  );
}

export function persistDetach(
  identity: LaunchIdentity,
  live: () => Operation<DetachedLaunchRecord>,
): Workflow<DetachedLaunchRecord> {
  return persistPhase(
    identity,
    "detached",
    {},
    live,
    (record) => {
      const payload: Record<string, Json> = { phase: record.phase };
      if (record.failure !== undefined) {
        payload.failure = serializeFailure(record.failure);
      }
      return payload;
    },
    parseDetached,
  );
}

export function persistExit(
  identity: LaunchIdentity,
  live: () => Operation<ExitedLaunchRecord>,
): Workflow<ExitedLaunchRecord> {
  return persistPhase(
    identity,
    "exited",
    {},
    live,
    (record) => {
      const payload: Record<string, Json> = { phase: record.phase };
      if (record.exitCode !== undefined) {
        payload.exitCode = record.exitCode;
      }
      if (record.signal !== undefined) {
        payload.signal = record.signal;
      }
      if (record.failure !== undefined) {
        payload.failure = serializeFailure(record.failure);
      }
      return payload;
    },
    parseExited,
  );
}
