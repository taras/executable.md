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
  ExecutableBuildBindingV1,
  ExitedLaunchRecord,
  IdentityProvenance,
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
  "session-busy",
  "session-recovery-required",
  "executable-binding-refused",
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
  // A binding says which build accepted a client-allocated identity, so a
  // record that chose no identity cannot have one. Absence is not refused: the
  // client-allocated path was released before any build was observed, and that
  // history stays readable as the legacy, native-only session it is. Whether a
  // legacy record may still do live work is the provider's decision, not this
  // parser's — core observes no executables.
  let binding: ExecutableBuildBindingV1 | undefined;
  if (value.executableBinding !== undefined) {
    if (provenanceValue !== "client-allocated") {
      return undefined;
    }
    binding = executableBinding(value.executableBinding);
    if (!binding) {
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
