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
 * A launch is not a prompt, so nothing here reuses `agent_prompt`. Their
 * inputs, phases and process semantics differ, and sharing one type would make
 * a replayed prompt and a replayed launch indistinguishable in a journal.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { Json, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import type {
  DetachedLaunchRecord,
  ExitedLaunchRecord,
  InstructionReconciliation,
  LaunchFailure,
  LaunchFailureClass,
  PreparedLaunchRecord,
} from "./launch.ts";
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

const RECONCILIATIONS: readonly InstructionReconciliation[] = [
  "installed",
  "resumed",
  "replaced",
  "recreated",
];

function reconciliation(value: unknown): InstructionReconciliation | undefined {
  return RECONCILIATIONS.find((candidate) => candidate === value);
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
    instructionsDigest: record.instructionsDigest,
    instructions: record.instructions,
    cwd: record.cwd,
    additionalDirectories: [...record.additionalDirectories],
    permissionMode: record.permissionMode,
    launcher: record.launcher,
  };
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

function parsePrepared(value: unknown): PreparedLaunchRecord | undefined {
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
  if (!directories || !mode || !reconciled) {
    return undefined;
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
    instructionsDigest,
    instructions,
    cwd,
    additionalDirectories: directories,
    permissionMode: mode,
    launcher,
  };
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
