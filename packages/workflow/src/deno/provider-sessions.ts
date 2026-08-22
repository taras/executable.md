/**
 * Where a run keeps what a provider retains about its Agent sessions
 * (specs/workflow-workspace-spec.md §8.5).
 *
 * A provider session outlives one execution. The conversation an Agent is in
 * belongs to the provider, not to the journal, so continuing a run means
 * reattaching the same provider-native session rather than replaying transcript
 * text into a new one. What this module owns is the small durable record that
 * makes that reattachment decidable, and the paths it lives at.
 *
 * ## A sidecar, not a table
 *
 * The workflow database is version 1, its schema verifier treats an undeclared
 * table as damage, and this project has no in-place migration contract. So this
 * state lives beside the run's file, under a name the run-discovery pattern —
 * `<hash>.sqlite` exactly — cannot match. `WorkflowDeletion` already reserves
 * the `provider-sessions` category for it.
 *
 * ## What identifies a session
 *
 * The logical key is the run, the provider, the resolved agent command and the
 * authored `<Session>` name. Every variable-length part is digested, so the key
 * stays bounded and filesystem-safe however long its inputs are, and an unnamed
 * session keeps a literal marker rather than an empty component. A directory is
 * deliberately not part of it: the provider-owned working directory is host
 * arrangement that is created empty and removed with the attachment, and a
 * session that moved with it would be a different session for no reason.
 *
 * ## What a continuation is held to
 *
 * The record carries its own version, the identity it was created under and the
 * fingerprint of the session policy in force when the provider created it. A
 * later attachment reattaches only when all three still agree and the provider
 * still holds the native session the record names. Anything else — an unreadable
 * record, a changed provider, agent or policy, a native identity the adapter
 * cannot resume — is one explicit incompatibility. None of them starts a
 * replacement session: a session created under a wider policy is exactly what
 * silently continuing would resume.
 *
 * A session may be created only when *both* sides say there is none. The logical
 * key does not depend on this mapping, so losing it does not make the provider
 * forget — and a provider still holding a session under that key would reuse its
 * persistent record and ignore the creation options this host supplies. Absent
 * here therefore means absent on both sides, and anything else is refused.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { ensure, Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import {
  ensureDir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@executablemd/runtime";
import { WorkflowStorageError } from "../storage/errors.ts";
import { hashRunId } from "./path.ts";

/** A retained provider session this host will not continue under. */
export class WorkflowAgentSessionError extends WorkflowStorageError {
  override name = "WorkflowAgentSessionError";
}

/** The version this host writes, and the only one it reads. */
const RECORD_VERSION = 1;

/** The name an unnamed `<Session>` keeps, so it is distinct from any given one. */
const UNNAMED = "default";

const UNREADABLE =
  "this run retains an Agent session record this host cannot read, so it cannot tell which " +
  "provider session to continue. Start a new run rather than continuing this one.";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * Where one run's provider sessions live.
 *
 * A suffix in the same namespace as the run's lock and fork staging, so the
 * `<hash>.sqlite` candidate pattern excludes it by construction: nothing
 * discovers it, nothing lists it, and no run id resolves to it.
 */
export function workflowProviderSessions(root: string, runId: string): string {
  return join(root, `${hashRunId(runId)}.sessions`);
}

/** Every path one run's provider sessions occupy, derived from the sidecar. */
export interface ProviderSessionPaths {
  /** The sidecar itself. Nothing below resolves outside it. */
  readonly sidecar: string;
  /** The provider's own persistent session store. */
  readonly store: string;
  /** The runtime's working directory: provider-owned, and empty. */
  readonly host: string;
  /** The retained mapping records, one per logical key. */
  readonly mappings: string;
  /** The provider-owned working directories, one per logical key. */
  readonly directories: string;
}

export function providerSessionPaths(root: string, runId: string): ProviderSessionPaths {
  const sidecar = workflowProviderSessions(root, runId);
  return {
    sidecar,
    store: join(sidecar, "store"),
    host: join(sidecar, "host"),
    mappings: join(sidecar, "keys"),
    directories: join(sidecar, "cwd"),
  };
}

/** What one logical Agent session is identified by. */
export interface ProviderSessionIdentity {
  readonly runId: string;
  /** Which provider holds the conversation, as that provider names itself. */
  readonly provider: string;
  /** The resolved agent command, not the name a document wrote. */
  readonly agentCommand: string;
  /** The authored `<Session>` name, when the document named one. */
  readonly session?: string;
}

/**
 * The key one logical session is retained under.
 *
 * Namespaced so it can never collide with a session key another consumer of the
 * same provider store derived, and digested so it stays a legal file name.
 */
export function providerSessionKey(identity: ProviderSessionIdentity): string {
  return [
    "xmd",
    "workflow",
    "v1",
    digest(identity.runId),
    digest(identity.provider),
    digest(identity.agentCommand),
    identity.session === undefined ? UNNAMED : digest(identity.session),
  ].join(":");
}

/** The provider-owned working directory one logical session runs in. */
export function providerSessionDirectory(paths: ProviderSessionPaths, key: string): string {
  return join(paths.directories, digest(key));
}

/** The retained mapping record for one logical session. */
export function providerSessionMappingPath(paths: ProviderSessionPaths, key: string): string {
  return join(paths.mappings, `${digest(key)}.json`);
}

/**
 * What this host retains about one logical Agent session.
 *
 * No prompt text and no transcript: what makes a continuation decidable is who
 * the conversation is with and under what ceiling it was created, and neither of
 * those is content.
 */
export interface ProviderSessionRecord {
  readonly version: number;
  readonly runId: string;
  readonly provider: string;
  readonly agentCommand: string;
  /** The authored `<Session>` name, or the literal marker for an unnamed one. */
  readonly session: string;
  /** The key the provider's own session store holds this conversation under. */
  readonly sessionKey: string;
  /** The session policy in force when the provider created this session. */
  readonly policy: string;
  /** The provider-native session identity, once the provider asserted one. */
  readonly nativeSessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One retained record, parsed rather than trusted.
 *
 * Durable input: a file with the right keys is not this host's record, and a
 * version this host cannot read is refused rather than treated as matching.
 */
function parseRecord(value: unknown): ProviderSessionRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, runId, provider, agentCommand, session, sessionKey, policy, nativeSessionId } =
    value;
  if (version !== RECORD_VERSION) {
    return undefined;
  }
  if (
    typeof runId !== "string" ||
    typeof provider !== "string" ||
    typeof agentCommand !== "string" ||
    typeof session !== "string" ||
    typeof sessionKey !== "string" ||
    typeof policy !== "string"
  ) {
    return undefined;
  }
  if (nativeSessionId !== undefined && typeof nativeSessionId !== "string") {
    return undefined;
  }
  const record: ProviderSessionRecord = {
    version,
    runId,
    provider,
    agentCommand,
    session,
    sessionKey,
    policy,
  };
  return nativeSessionId === undefined ? record : { ...record, nativeSessionId };
}

/**
 * The record retained for this key, or nothing when none is.
 *
 * An unreadable file answers with a refusal rather than with absence: absence
 * means a session has never been established, and treating damage as absence is
 * how a replacement session gets created for a conversation that already exists.
 */
export function* readProviderSession(
  paths: ProviderSessionPaths,
  key: string,
): Operation<Result<ProviderSessionRecord | undefined>> {
  const path = providerSessionMappingPath(paths, key);
  const present = yield* stat(path);
  if (!present.exists) {
    return Ok(undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(yield* readTextFile(path));
  } catch {
    return Err(new WorkflowAgentSessionError(UNREADABLE));
  }
  const record = parseRecord(parsed);
  if (record === undefined) {
    return Err(new WorkflowAgentSessionError(UNREADABLE));
  }
  return Ok(record);
}

/**
 * Retain what the provider asserted about this session.
 *
 * Written whole and renamed over the destination, so a reader sees either the
 * previous record or this one — never half of either.
 */
export function* writeProviderSession(
  paths: ProviderSessionPaths,
  record: ProviderSessionRecord,
): Operation<void> {
  yield* ensureDir(paths.mappings);
  const path = providerSessionMappingPath(paths, record.sessionKey);
  const staging = `${path}.writing`;
  yield* writeTextFile(staging, `${JSON.stringify(record, undefined, 2)}\n`);
  yield* rename(staging, path);
}

/** What a continuation may do with the session this key names. */
export type ProviderSessionResolution =
  | { readonly kind: "create"; readonly record: ProviderSessionRecord }
  | { readonly kind: "reattach"; readonly record: ProviderSessionRecord };

/** What the provider still holds for a retained session key. */
export interface ProviderSessionState {
  readonly agentCommand: string;
  readonly nativeSessionId?: string;
}

/** Asks the provider what it retains for one of its own session keys. */
export type ProviderSessionProbe = (
  sessionKey: string,
) => Operation<ProviderSessionState | undefined>;

/**
 * Decide whether this attachment may continue the session this key names.
 *
 * The comparison is whole: the record's identity, its policy fingerprint and the
 * native session the provider still holds all have to agree. A record that
 * disagrees anywhere is refused as one explicit incompatibility, and no branch
 * here answers `create` for a key that already has a record — a replacement
 * session started under a different ceiling is the outcome this exists to stop.
 */
export function* resolveProviderSession(
  paths: ProviderSessionPaths,
  identity: ProviderSessionIdentity,
  policy: string,
  probe: ProviderSessionProbe,
): Operation<Result<ProviderSessionResolution>> {
  const key = providerSessionKey(identity);
  const intended: ProviderSessionRecord = {
    version: RECORD_VERSION,
    runId: identity.runId,
    provider: identity.provider,
    agentCommand: identity.agentCommand,
    session: identity.session ?? UNNAMED,
    sessionKey: key,
    policy,
  };

  const retained = yield* readProviderSession(paths, key);
  if (!retained.ok) {
    return retained;
  }
  if (retained.value === undefined) {
    // Absent is only "never established" when the provider agrees. The logical
    // key is derived from the run, the provider and the agent alone, so it
    // survives losing this mapping — and a provider still holding a session
    // under it would have `ensureSession()` reuse that persistent record and
    // ignore the creation options handed to it. This host would then be talking
    // to a session whose ceiling it cannot name, which is the one outcome the
    // policy fingerprint exists to make impossible.
    const orphaned = yield* probe(key);
    if (orphaned !== undefined) {
      return Err(
        new WorkflowAgentSessionError(
          "the provider already holds an Agent session under this run's key, and this run " +
            "retains nothing about it — so this host cannot tell what ceiling it was created " +
            "under. Start a new run rather than continuing this one.",
        ),
      );
    }
    return Ok({ kind: "create", record: intended });
  }

  const record = retained.value;
  if (
    record.runId !== intended.runId ||
    record.provider !== intended.provider ||
    record.agentCommand !== intended.agentCommand ||
    record.session !== intended.session ||
    record.policy !== intended.policy
  ) {
    return Err(
      new WorkflowAgentSessionError(
        "this run's Agent session was established under a different provider, agent or session " +
          "policy than this host states, and a session created under one ceiling is not " +
          "continued under another. Start a new run rather than continuing this one.",
      ),
    );
  }

  const held = yield* probe(record.sessionKey);
  if (held === undefined || held.agentCommand !== record.agentCommand) {
    return Err(
      new WorkflowAgentSessionError(
        "the provider no longer holds the Agent session this run retained, and this host does " +
          "not reconstruct a conversation by replaying it into a new session. Start a new run " +
          "rather than continuing this one.",
      ),
    );
  }
  if (record.nativeSessionId !== undefined && held.nativeSessionId !== record.nativeSessionId) {
    return Err(
      new WorkflowAgentSessionError(
        "the provider cannot resume the native Agent session this run retained, and this host " +
          "does not reconstruct a conversation by replaying it into a new session. Start a new " +
          "run rather than continuing this one.",
      ),
    );
  }
  return Ok({ kind: "reattach", record });
}

/**
 * Retain the native identity the provider asserted for this session.
 *
 * The first assertion is recorded; a later one has to be the same. An adapter
 * that answered with a different native session did not resume the retained
 * conversation — it started another one — and continuing against it while
 * claiming continuity is exactly what this refuses.
 */
export function* retainProviderSessionIdentity(
  paths: ProviderSessionPaths,
  sessionKey: string,
  nativeSessionId: string,
): Operation<Result<void>> {
  const retained = yield* readProviderSession(paths, sessionKey);
  if (!retained.ok) {
    return retained;
  }
  const record = retained.value;
  if (record === undefined) {
    return Err(
      new WorkflowAgentSessionError(
        "the provider established an Agent session this run retains nothing about, so this " +
          "host cannot tell whether it is the conversation this run was having.",
      ),
    );
  }
  if (record.nativeSessionId === undefined) {
    yield* writeProviderSession(paths, { ...record, nativeSessionId });
    return Ok(undefined);
  }
  if (record.nativeSessionId !== nativeSessionId) {
    return Err(
      new WorkflowAgentSessionError(
        "the provider answered with a different native Agent session than this run retained, " +
          "so it did not resume the conversation this run was having. This host does not " +
          "continue under a replacement session.",
      ),
    );
  }
  return Ok(undefined);
}

/**
 * The provider-owned working directory for this key, empty.
 *
 * Emptied rather than reused: the same path can hold residue after an
 * unstructured process death, and an Agent that starts in one is reading
 * something no attachment put there.
 */
export function* useEmptyDirectory(path: string): Operation<string> {
  yield* remove(path, { recursive: true, force: true });
  yield* ensureDir(path);
  return path;
}

/**
 * Own this run's provider-session sidecar for one attachment.
 *
 * It creates nothing. A run whose document never prompts an Agent allocates no
 * sidecar at all, which is what keeps "this run had no agent" a fact about the
 * filesystem rather than a claim: the directories below appear when a session is
 * placed and a record is written, and not before.
 *
 * What it does own is the end. The retained half — the mapping records and the
 * provider's own session store — outlives the attachment, because that is what a
 * continuation reads. The working directories do not, and their removal is
 * registered before anything is installed over this, so it runs after provider
 * teardown: whatever was standing in them has stopped by then.
 */
export function* useProviderSessions(root: string, runId: string): Operation<ProviderSessionPaths> {
  const paths = providerSessionPaths(root, runId);
  yield* ensure(function* () {
    yield* remove(paths.directories, { recursive: true, force: true });
    yield* remove(paths.host, { recursive: true, force: true });
  });
  return paths;
}

/** Remove one run's provider sessions, and say whether there were any. */
export function* removeProviderSessions(root: string, runId: string): Operation<boolean> {
  const sidecar = workflowProviderSessions(root, runId);
  const present = yield* stat(sidecar);
  if (!present.exists) {
    return false;
  }
  yield* remove(sidecar, { recursive: true, force: true });
  return true;
}
