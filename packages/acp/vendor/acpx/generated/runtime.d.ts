import { AcpAgentInspection, AcpAgentInspectionOptions, AcpAgentRegistry, AcpInspectableAgentRegistry, DEFAULT_AGENT_NAME, createAgentRegistry } from "./agent-registry.d.ts";
import { C as PermissionPolicy, E as PromptInput, S as PermissionMode, T as SessionRecord, _ as AcpProcessSpawnFailure, a as AcpElicitationHandler, b as McpServer$1, c as AcpElicitationResponse, d as AcpPermissionHandler, f as AcpPermissionRequest, g as AcpProcessLifecycle, h as AcpProcessLaunchScope, i as AcpElicitationContext, l as AcpJsonRpcMessage, m as AcpProcessLaunch, n as SystemPromptOption, o as AcpElicitationMode, p as AcpProcessExit, s as AcpElicitationRequest, t as SessionAgentOptions, u as AcpPermissionDecision, v as AcpProcessStarted, x as NonInteractivePermissionPolicy, y as AuthPolicy } from "./session-options-BlnP3WAc.d.ts";
import { n as AcpControlAuthority, t as AcpClient } from "./client-D12zqSyN.d.ts";
import { z } from "zod";
import { SetSessionConfigOptionResponse, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
export declare const REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE: "ACP_MODEL_UNSUPPORTED";
type RequestedModelUnsupportedErrorCode = typeof REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE;
export declare const REQUESTED_MODEL_UNSUPPORTED_REASONS: readonly ["missing-capability", "unadvertised-model"];
type RequestedModelUnsupportedReason = (typeof REQUESTED_MODEL_UNSUPPORTED_REASONS)[number];
export declare class RequestedModelUnsupportedError extends Error {
  readonly code: "ACP_MODEL_UNSUPPORTED";
  readonly reason: RequestedModelUnsupportedReason;
  readonly ambiguous?: true;
  constructor(message: string, reason: RequestedModelUnsupportedReason, details?: {
    ambiguous?: true;
  });
}
export declare function isRequestedModelUnsupportedError(value: unknown): value is RequestedModelUnsupportedError;
type SessionWatchResult = {
  status: "completed" | "cancelled";
  stopReason?: string;
  _meta?: Record<string, unknown> | null;
} | {
  status: "failed";
  error: {
    message: string;
    code?: string;
    detailCode?: string;
    retryable?: boolean;
  };
};
type SessionWatchEvent = {
  cursor: string;
} & ({
  type: "message";
  requestId: string | null;
  message: AcpJsonRpcMessage;
} | {
  type: "turn_started";
  requestId: string;
} | {
  type: "turn_result";
  requestId: string;
  result: SessionWatchResult;
});
/**
 * ACP has no mid-turn steering request. In-process runtimes admit a "steer"
 * turn like "prompt": it waits behind any active turn on the same session and
 * does not change that turn. Shared runtimes reject "steer".
 */
type AcpRuntimePromptMode = "prompt" | "steer";
type AcpRuntimeSessionMode = "persistent" | "oneshot";
type AcpSessionUpdateTag = "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "usage_update" | "available_commands_update" | "current_mode_update" | "config_option_update" | "session_info_update" | "plan" | (string & {});
type AcpRuntimeControl = "session/set_mode" | "session/set_model" | "session/set_config_option" | "session/status";
type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};
type AcpRuntimeEnsureInput = {
  materialization?: "first-turn-acceptance";
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  cwd?: string;
  /**
   * Per-session agent options applied when a fresh ACP session is created.
   * Threaded into `_meta.systemPrompt` (and `_meta.claudeCode.options.*`)
   * on the underlying `session/new` request, and persisted onto the new
   * record. Ignored when an existing persistent session is reused — system
   * prompts are fixed at `newSession` time, so changing them requires a
   * different sessionKey or prepareFreshSession on the prior record first.
   */
  sessionOptions?: SessionAgentOptions;
};
type AcpRuntimeTurnAttachment = {
  /**
   * Media type for binary prompt attachments. The runtime currently maps
   * image/* and audio/* attachments to ACP prompt content blocks.
   */
  mediaType: string;
  data: string;
};
/**
 * In-process turns check synchronous host authority before prompt dispatch.
 * A throwing assertActive rejects admission without aborting the signal.
 */
type AcpRuntimeTurnInput = AcpControlAuthority & {
  handle: AcpRuntimeHandle;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  timeoutMs?: number;
  /**
   * Overrides the client's default callback for this prompt turn. Throwing or
   * returning undefined falls through to configured permission policy, not the
   * default callback.
   */
  onPermissionRequest?: AcpPermissionHandler;
  /** Handles ACP elicitation requests owned by this prompt turn. */
  onElicitation?: AcpElicitationHandler;
};
/** Caller-owned snapshot; local mutations do not change runtime capabilities. */
type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  configOptionKeys?: string[];
};
type AcpRuntimeSessionModels = {
  currentModelId?: string;
  availableModelIds: string[];
  /** Native display names, when retained by the session snapshot. */
  availableModels?: Array<{
    modelId: string;
    name: string;
  }>;
};
/**
 * Cumulative session cost as reported by the agent. Mirrors ACP's
 * `Cost`, but both fields are optional here because not every adapter
 * populates them on every event.
 */
type AcpRuntimeUsageCost = {
  amount?: number;
  currency?: string;
};
/**
 * Per-turn token breakdown. Sourced from final prompt response usage or
 * `UsageUpdate._meta.usage` on adapters that populate it. All fields optional —
 * consumers should treat missing fields as "unknown", not "zero".
 */
type AcpRuntimeUsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};
/**
 * Agent-advertised slash command. The runtime only surfaces enough to
 * drive a picker UI ("does the agent advertise /compact?"). The full
 * `AvailableCommandInput` schema from ACP is intentionally not plumbed
 * through.
 */
type AcpRuntimeAvailableCommand = {
  name: string;
  description?: string;
  /** True/false when ACP advertised whether this command has an input schema. */
  hasInput?: boolean;
};
/**
 * An entry in an ACP plan snapshot. Each update replaces the previous list.
 * Priority is omitted unless the agent advertises a valid value.
 */
type AcpRuntimePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
};
/**
 * Session-level usage roll-up surfaced through `getStatus()`. The
 * reducer persists the breakdowns onto the session record; this type
 * exposes them on the runtime contract.
 */
type AcpRuntimeSessionUsage = {
  cumulative?: AcpRuntimeUsageBreakdown;
  /** Cumulative session cost when the agent reported it. */
  cost?: AcpRuntimeUsageCost;
  /** Keyed by user-message id, matching the persisted reducer state. */
  perRequest?: Record<string, AcpRuntimeUsageBreakdown>;
};
type AcpRuntimeStatus = {
  /** Most recent host request id admitted for a prompt on this session. */
  lastRequestId?: string;
  summary?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  models?: AcpRuntimeSessionModels;
  /** Token usage and cost from the persisted session record. */
  usage?: AcpRuntimeSessionUsage;
  /**
   * Commands the agent advertised via `available_commands_update`.
   * Sourced from the persisted record — older session files only
   * preserve `name`, so `description` and `hasInput` may be undefined
   * even when a more recent live event would have carried both.
   */
  availableCommands?: AcpRuntimeAvailableCommand[];
  details?: Record<string, unknown>;
};
type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};
/**
 * Fail-closed origin metadata on `text_delta` events.
 * Only these optional string fields are preserved from ACP wire `_meta`.
 */
type AcpTextDeltaOriginMeta = {
  origin?: string;
  kind?: string;
  source?: string;
};
type AcpRuntimeEvent = {
  type: "text_delta";
  text: string;
  stream?: "output" | "thought";
  tag?: AcpSessionUpdateTag;
  /**
   * Present when the originating ACP session update carried a non-empty
   * `messageId`. Absent when the wire payload had no id.
   * Opaque producer-supplied routing hint only: ACPX does not authenticate
   * this value. Do not treat it as proof of authorship or as an
   * authorization boundary. Useful for correlating chunks from the same
   * producer message when the adapter includes an id.
   */
  messageId?: string;
  /**
   * Allowlisted origin fields from the ACP update `_meta`.
   * Only the documented string keys `origin`, `kind`, and `source` are
   * preserved. All other keys (including nested objects and secret-like
   * producer-controlled names) are dropped. Omitted when none remain.
   * These values are opaque producer-supplied routing hints, not
   * authenticated authorship or provenance. Consumers must not use them
   * as an authorization boundary.
   */
  meta?: AcpTextDeltaOriginMeta;
} | {
  type: "status";
  text: string;
  tag?: AcpSessionUpdateTag;
  used?: number;
  size?: number;
  /** Populated on `usage_update` events when the agent reported a cost. */
  cost?: AcpRuntimeUsageCost;
  /**
   * Populated on `usage_update` events when the agent attached a
   * per-turn breakdown via `_meta.usage` (Claude Code does this; not
   * every adapter does).
   */
  breakdown?: AcpRuntimeUsageBreakdown;
  /**
   * Populated on `available_commands_update` events. The list is a
   * normalized view of the wire payload — names, descriptions, and
   * a `hasInput` flag derived from whether the agent advertised a
   * non-null `input` schema.
   */
  availableCommands?: AcpRuntimeAvailableCommand[];
  /**
   * Normalized entries on `plan` events; malformed entries are skipped.
   * Replace the displayed plan when present, including clearing it for [].
   */
  entries?: AcpRuntimePlanEntry[];
} | {
  type: "tool_call";
  text: string;
  tag?: AcpSessionUpdateTag;
  toolCallId?: string;
  status?: string;
  title?: string;
  kind?: ToolKind;
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
} |
/**
 * Compatibility terminal event emitted by runTurn(...). startTurn(...).events
 * does not emit terminal events; use AcpRuntimeTurn.result instead.
 */
{
  type: "done";
  stopReason?: string;
  _meta?: Record<string, unknown> | null;
} |
/**
 * Compatibility failure event emitted by runTurn(...). startTurn(...).events
 * does not emit terminal events; use AcpRuntimeTurn.result instead.
 */
{
  type: "error";
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};
type AcpRuntimeTurnResultError = {
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};
type AcpRuntimeTurnResult = {
  status: "completed";
  stopReason?: string;
  _meta?: Record<string, unknown> | null;
} | {
  status: "cancelled";
  stopReason?: string;
  _meta?: Record<string, unknown> | null;
} | {
  status: "failed";
  error: AcpRuntimeTurnResultError;
};
type AcpRuntimeMaterialization = { acpxRecordId: string; agentSessionId?: string };
interface AcpRuntimeTurn {
  readonly materialized: Promise<AcpRuntimeMaterialization>;
  readonly requestId: string;
  /** Resolves after the underlying writable transport accepts the prompt request. */
  readonly promptStarted: Promise<void>;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  /**
   * Canonical completion signal for the turn. Resolves only after final record
   * checkpoint/persistence and runtime client pooling or close cleanup attempts
   * have settled.
   */
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: {
    reason?: string;
  }): Promise<void>;
  closeStream(input?: {
    reason?: string;
  }): Promise<void>;
}
interface AcpRuntime {
  /** Passively replays and follows recorded turns when the backend supports a shared journal. */
  watchSession?(input: {
    handle: AcpRuntimeHandle;
    cursor?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SessionWatchEvent>;
  /** Stops owned connections and joins admitted work; stored sessions remain resumable. */
  shutdown?(): Promise<void>;
  /** Finds a persistent session handle without starting or reconnecting an agent. */
  findSession?(input: {
    sessionKey: string;
    agent: string;
  }): Promise<AcpRuntimeHandle | undefined>;
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  /**
   * Compatibility adapter for consumers that expect terminal status in the
   * event stream. Prefer startTurn(...), which separates live events from the
   * terminal result.
   */
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus?(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus>;
  /** Authority gates dispatch; an issued control still settles its response and saved state. */
  setMode?(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    mode: string;
  }): Promise<void>;
  setModel?(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    model: string;
  }): Promise<void>;
  setConfigOption?(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<SetSessionConfigOptionResponse | void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  cancel(input: {
    handle: AcpRuntimeHandle;
    reason?: string;
  }): Promise<void>;
  /** Locally closes the session and persists fresh creation on the next ensure without resumeSessionId. */
  prepareFreshSession?(input: {
    handle: AcpRuntimeHandle;
  }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void>;
}
type AcpSessionRecord = SessionRecord;
interface AcpSessionStore {
  load(sessionId: string): Promise<AcpSessionRecord | undefined>;
  save(record: AcpSessionRecord): Promise<void>;
}
type AcpRuntimeSessionContext = {
  sessionKey: string;
  cwd: string;
  agentCommand: string;
  agentArgv?: string[];
};
type AcpRuntimeSessionPermissions = Partial<Pick<AcpRuntimeOptions, "permissionMode" | "nonInteractivePermissions" | "permissionPolicy" | "onPermissionRequest">>;
type AcpRuntimeOptions = {
  cwd: string;
  /** Trusted child-only environment, snapshotted at construction and never persisted. */
  agentProcessEnv?: Record<string, string>;
  /**
   * Opt-in allowlist for agent children, command probes and ACP terminals: when set, they
   * inherit only process essentials, these parent names and `ACPX_AUTH_*` grants.
   * Snapshotted at construction. Explicit grants and overlays still apply.
   */
  agentProcessEnvAllow?: readonly string[];
  /**
   * Parent environment names withheld from agent children, command probes and ACP
   * terminals, applied after `agentProcessEnvAllow` and snapshotted at construction.
   * Explicit grants and overlays still apply.
   */
  agentProcessEnvBlock?: readonly string[];
  sessionStore: AcpSessionStore;
  agentRegistry: AcpAgentRegistry;
  /**
   * Servers for new and reconnected session clients. A resolver runs at connection
   * creation with the session's stored identity; its result is never persisted.
   * Retained connections keep their original servers. Initialization-only health
   * probes do not call the resolver.
   */
  mcpServers?: McpServer$1[] | ((session: AcpRuntimeSessionContext) => McpServer$1[]);
  /**
   * Client permissions for new and reconnected sessions, resolved from stored
   * identity. Unspecified fields inherit runtime defaults. Retained clients keep
   * their original policy; health probes do not call this resolver. Neither the
   * policy nor its callback is persisted.
   */
  sessionPermissions?: (session: AcpRuntimeSessionContext) => AcpRuntimeSessionPermissions | undefined;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  timeoutMs?: number;
  probeAgent?: string;
  verbose?: boolean;
  /** ACP elicitation modes the embedding host can render for prompt turns. */
  elicitationModes?: readonly AcpElicitationMode[];
  /** Optional lifecycle observer for ACP agent processes owned by this runtime. */
  processLifecycle?: AcpProcessLifecycle;
  onPermissionRequest?: AcpPermissionHandler;
  /**
   * ACP filesystem callback capability for new and reconnected session clients.
   * Omitted defaults to enabled, matching `AcpClientOptions`. Retained clients
   * keep their original capability. Health probes disable filesystem callbacks
   * and ignore this option. Disabling is a protocol callback policy, not an OS
   * sandbox for the agent's own filesystem access. The setting is not persisted.
   */
  fs?: boolean;
  /**
   * ACP terminal callback capability for new and reconnected session clients.
   * Omitted defaults to enabled, matching `AcpClientOptions`. Retained clients
   * keep their original capability. Health probes disable terminal callbacks
   * and ignore this option. Disabling is a protocol callback policy, not an OS
   * sandbox for the agent's own process access. The setting is not persisted.
   */
  terminal?: boolean;
};
type AcpFileSessionStoreOptions = {
  stateDir: string;
};
type RuntimeHealthReport = {
  ok: boolean;
  message: string;
  details?: string[];
};
type InspectAgentModelsOptions = {
  agentCommand: string[];
  cwd: string;
  signal?: AbortSignal;
  /** Positive startup/session discovery deadline; defaults to 120 seconds. Cleanup is awaited. */
  timeoutMs?: number;
  /** Trusted child-only environment overlay; never persisted. */
  agentProcessEnv?: Record<string, string>;
  /** Opt-in allowlist of parent environment names the inspected agent inherits. */
  agentProcessEnvAllow?: readonly string[];
  /** Parent environment names the inspected agent does not inherit. */
  agentProcessEnvBlock?: readonly string[];
};
/**
 * Inspect session model metadata without a runtime store or prompt. The agent
 * may create native session history; only its owned transport is closed.
 */
export declare function inspectAgentModels(options: InspectAgentModelsOptions): Promise<AcpRuntimeSessionModels | undefined>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
declare class AsyncEventQueue {
  private readonly items;
  private readonly waits;
  private closed;
  push(item: AcpRuntimeEvent): void;
  close(): void;
  clear(): void;
  next(): Promise<AcpRuntimeEvent | null>;
  iterate(): AsyncIterable<AcpRuntimeEvent>;
}
type AcpRuntimeManagerDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};
type ActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string, authority?: AcpControlAuthority) => Promise<void>;
  setSessionModel: (modelId: string, authority?: AcpControlAuthority) => ReturnType<AcpClient["setSessionModel"]>;
  setSessionConfigOption: (configId: string, value: string, authority?: AcpControlAuthority) => ReturnType<AcpClient["setSessionConfigOption"]>;
  setResolvedSessionConfigOption: (configId: string, value: string, authority?: AcpControlAuthority) => Promise<{
    configId: string;
    response: Awaited<ReturnType<AcpClient["setSessionConfigOption"]>>;
  }>;
};
type RuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  resumeSessionId?: string;
  sessionOptions?: SessionAgentOptions;
};
type RuntimeTurnTaskState = {
  pendingCancel: boolean;
  turnActive: boolean;
  activeController: ActiveSessionController | null;
};
type RuntimeTurnTask = {
  input: AcpRuntimeTurnInput & {
    sessionMode: "persistent" | "oneshot";
  };
  promptInput: PromptInput | string;
  queue: AsyncEventQueue;
  promptStarted: Deferred<void>;
  sessionReady: Deferred<void>;
  sessionMaterialization: Deferred<AcpRuntimeMaterialization>;
  state: RuntimeTurnTaskState;
  settleResult: (next: AcpRuntimeTurnResult) => void;
  abortHandler: () => void;
};
declare class AcpRuntimeManager {
  private readonly options;
  private readonly deps;
  private readonly activeControllers;
  private readonly controlSessionRecords;
  private readonly retainedSessionOwners;
  private readonly retiringSessionOwners;
  private readonly pendingOneShotRecordIds;
  private readonly ensureSessionLocks;
  private readonly runtimeOperationLocks;
  private readonly sessionTasks;
  private readonly closingActiveRecords;
  private readonly liveClients;
  private readonly pendingTasks;
  private shuttingDown;
  private shutdownTask?;
  constructor(options: AcpRuntimeOptions, deps?: AcpRuntimeManagerDeps);
  private createClient;
  probe(): Promise<RuntimeHealthReport>;
  private assertOpen;
  shutdown(): Promise<void>;
  private shutdownOwnedClients;
  private trackTask;
  private queueSessionTask;
  private cancelSessionTasks;
  private closeClient;
  private createSessionOwner;
  private saveSessionOwner;
  private routeOwnedSessionUpdate;
  private routeOwnedClientOperation;
  private attachIdleProjection;
  private drainPendingSessionUpdates;
  private flushSessionOwner;
  private removeRetainedSessionOwner;
  private readRetainedSessionOwner;
  private closeRetainedSessionOwner;
  private stopSessionOwner;
  private retrySessionCleanup;
  private refreshClosedState;
  private retainPersistentSessionOwnerAfterTurn;
  private canRetainPersistentSessionOwner;
  private resolveMcpServers;
  private resolveSessionPermissions;
  private resolveClientCapabilities;
  private withRuntimeControlSession;
  private refreshOwnedRecordLifecycle;
  ensureSession(input: RuntimeEnsureInput): Promise<SessionRecord>;
  private withEnsureSessionLock;
  private withManagerLock;
  private serializeManagerOperation;
  private ensureSessionWithOwnership;
  private reuseCompatiblePersistentSession;
  private acquireRuntimeSession;
  private loadExistingRuntimeSession;
  findSession(sessionKey: string): Promise<SessionRecord | undefined>;
  private canReuseRuntimeSession;
  private assertRuntimeSessionIdle;
  private reuseRuntimeSession;
  private closeConflictingPersistentSession;
  private createOwnedRuntimeSession;
  private abandonInitializingSessionOwner;
  private settleRetiredSessionRecord;
  private prepareInitialRuntimeRecord;
  private retainInitializedSessionOwner;
  startTurn(input: RuntimeTurnTask["input"]): AcpRuntimeTurn;
  private closeRetainedOneShotHandle;
  private runRuntimeTurnTask;
  private runRuntimePrompt;
  private prepareRuntimeTurn;
  private prepareRuntimeTurnWithOwnership;
  private prepareRuntimeTurnState;
  private acquireRuntimeTurnState;
  private restoreBufferedSessionOwner;
  private resolveRuntimeTurnOwner;
  private createRunningRuntimeTurn;
  private activateRuntimeTurn;
  private createTurnClient;
  private buildRuntimeTurnController;
  private waitForRuntimeControlSession;
  private requestRuntimeTurnCancel;
  private setRuntimeResolvedSessionConfigOption;
  private emitRuntimeTurnEvent;
  private connectRuntimeTurn;
  private connectRuntimeTurnClient;
  private publishRuntimeTurnController;
  private resolveRuntimeTurnReady;
  private cancelRuntimeTurnBeforePrompt;
  private updateCompletedRuntimeTurn;
  private handleRuntimeTurnFailure;
  private failRuntimeTurn;
  private finalizeRuntimeTurn;
  private discardRetainedRuntimeTurnOwner;
  private attachFinalRuntimeProjection;
  private closeRuntimeTurnClient;
  private cleanupRuntimeTurn;
  private finalizeRuntimeTurnRecord;
  runTurn(input: RuntimeTurnTask["input"]): AsyncIterable<AcpRuntimeEvent>;
  getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus>;
  private readStatus;
  setMode(handle: AcpRuntimeHandle, mode: string, sessionMode?: "persistent" | "oneshot", authority?: AcpControlAuthority): Promise<void>;
  private setModeWithOwnership;
  setModel(handle: AcpRuntimeHandle, model: string, sessionMode?: "persistent" | "oneshot", authority?: AcpControlAuthority): Promise<void>;
  private setModelWithOwnership;
  setConfigOption(handle: AcpRuntimeHandle, key: string, value: string, sessionMode?: "persistent" | "oneshot", authority?: AcpControlAuthority): Promise<SetSessionConfigOptionResponse>;
  private setConfigOptionWithOwnership;
  cancel(handle: AcpRuntimeHandle): Promise<void>;
  prepareFreshSession(handle: AcpRuntimeHandle): Promise<void>;
  close(handle: AcpRuntimeHandle, options?: {
    discardPersistentState?: boolean;
  }): Promise<void>;
  private closeRuntimeSession;
  private saveClosedRuntimeRecord;
  private resolveRuntimeRecordForClose;
  private markActiveRuntimeRecordClosing;
  private closeRuntimeRecordOwnership;
  private closeBackendSession;
  private finalizeSessionConnection;
  private acquireBackendCloseConnection;
  private requestBackendSessionClose;
  private handleBackendSessionCloseError;
  private requireRecord;
}
export declare function createFileSessionStore(options: AcpFileSessionStoreOptions): AcpSessionStore;
declare const ACP_ERROR_CODES: readonly ["ACP_BACKEND_MISSING", "ACP_BACKEND_UNAVAILABLE", "ACP_BACKEND_UNSUPPORTED_CONTROL", "ACP_DISPATCH_DISABLED", "ACP_INVALID_RUNTIME_OPTION", "ACP_SESSION_INIT_FAILED", "ACP_TURN_FAILED"];
type AcpRuntimeErrorCode = (typeof ACP_ERROR_CODES)[number];
export declare class AcpRuntimeError extends Error {
  readonly code: AcpRuntimeErrorCode;
  readonly cause?: unknown;
  constructor(code: AcpRuntimeErrorCode, message: string, options?: {
    cause?: unknown;
  });
}
export declare function isAcpRuntimeError(value: unknown): value is AcpRuntimeError;
type AcpxHandleState = {
  name: string;
  agent: string;
  cwd: string;
  mode: "persistent" | "oneshot";
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};
export declare function encodeAcpxRuntimeHandleState(state: AcpxHandleState): string;
export declare function decodeAcpxRuntimeHandleState(runtimeSessionName: string): AcpxHandleState | null;
type SharedAcpRuntimeOptions = {
  cwd: string;
  agentRegistry?: AcpAgentRegistry;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  timeoutMs?: number;
  ttlMs?: number;
};
/** A client of the CLI's local session owner. Shutdown detaches this client. */
export declare class SharedAcpRuntime {
  private readonly registry;
  private readonly options;
  private readonly disconnect;
  private readonly pending;
  private readonly controlChains;
  constructor(options: SharedAcpRuntimeOptions);
  private assertOpen;
  private track;
  private sessionOptions;
  findSession(input: {
    sessionKey: string;
    agent: string;
    cwd?: string;
  }): Promise<AcpRuntimeHandle | undefined>;
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  runTurn(input: AcpRuntimeTurnInput): AsyncGenerator<AcpRuntimeEvent, void, any>;
  getStatus(input: {
    handle: AcpRuntimeHandle;
  }): Promise<AcpRuntimeStatus>;
  getCapabilities(input?: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities>;
  /**
   * Preserves this client's control order, including caller-side persistence
   * when talking to older owners. Updated owners checkpoint accepted controls
   * themselves; serialization here cannot coordinate other legacy callers.
   */
  private chainControl;
  /**
   * Checks this client's authority locally, then hands the control to the
   * running owner. The check gates this client's dispatch only; it cannot gate
   * controls other clients of the same owner send, and it cannot recall a
   * control the owner already accepted.
   */
  private dispatchControl;
  setMode(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    mode: string;
  }): Promise<void>;
  setModel(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    model: string;
  }): Promise<void>;
  setConfigOption(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<SetSessionConfigOptionResponse>;
  watchSession(input: {
    handle: AcpRuntimeHandle;
    cursor?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SessionWatchEvent>;
  cancel(input: {
    handle: AcpRuntimeHandle;
    reason?: string;
  }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
  }): Promise<void>;
  shutdown(): Promise<void>;
}
export declare function createSharedAcpRuntime(options: SharedAcpRuntimeOptions): SharedAcpRuntime;
export declare const ACPX_BACKEND_ID = "acpx";
type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor(): Promise<AcpRuntimeDoctorReport>;
};
export declare class AcpxRuntime implements AcpxRuntimeLike {
  private readonly options;
  private readonly testOptions?;
  private healthy;
  private shutdownTask?;
  private readonly probeTasks;
  private manager;
  private managerPromise;
  constructor(options: AcpRuntimeOptions, testOptions?: {
    managerFactory?: (options: AcpRuntimeOptions) => AcpRuntimeManager;
    probeRunner?: (options: AcpRuntimeOptions) => Promise<{
      ok: boolean;
      message: string;
      details?: unknown[];
    }>;
  } | undefined);
  isHealthy(): boolean;
  probeAvailability(): Promise<void>;
  doctor(): Promise<AcpRuntimeDoctorReport>;
  private resolveSessionIdentity;
  findSession(input: {
    sessionKey: string;
    agent: string;
  }): Promise<AcpRuntimeHandle | undefined>;
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  private createSessionHandle;
  startTurn(input: AcpRuntimeTurnInput): {
    requestId: string;
    readonly materialized: Promise<AcpRuntimeMaterialization>;
    readonly promptStarted: Promise<void>;
    events: {
      [Symbol.asyncIterator](): AsyncGenerator<AcpRuntimeEvent, void, any>;
    };
    readonly result: Promise<AcpRuntimeTurnResult>;
    cancel(inputArgs?: {
      reason?: string;
    }): Promise<void>;
    closeStream(inputArgs?: {
      reason?: string;
    }): Promise<void>;
  };
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities(input?: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities>;
  getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus>;
  setMode(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    mode: string;
  }): Promise<void>;
  setModel(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    model: string;
  }): Promise<void>;
  setConfigOption(input: AcpControlAuthority & {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<SetSessionConfigOptionResponse>;
  cancel(input: {
    handle: AcpRuntimeHandle;
    reason?: string;
  }): Promise<void>;
  prepareFreshSession(input: {
    handle: AcpRuntimeHandle;
  }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void>;
  shutdown(): Promise<void>;
  private getManager;
  private runProbe;
  private resolveManagerHandle;
  private resolveHandleState;
}
export declare function createAcpRuntime(options: AcpRuntimeOptions): AcpxRuntime;
export declare function createRuntimeStore(options: {
  stateDir: string;
}): AcpSessionStore;
export { type AcpAgentInspection, type AcpAgentInspectionOptions, type AcpAgentRegistry, type AcpElicitationContext, type AcpElicitationHandler, type AcpElicitationMode, type AcpElicitationRequest, type AcpElicitationResponse, type AcpFileSessionStoreOptions, type AcpInspectableAgentRegistry, type AcpPermissionDecision, type AcpPermissionHandler, type AcpPermissionRequest, type AcpProcessExit, type AcpProcessLaunch, type AcpProcessLaunchScope, type AcpProcessLifecycle, type AcpProcessSpawnFailure, type AcpProcessStarted, type AcpRuntime, type AcpRuntimeMaterialization, type AcpRuntimeAvailableCommand, type AcpRuntimeCapabilities, type AcpRuntimeDoctorReport, type AcpRuntimeEnsureInput, type AcpRuntimeErrorCode, type AcpRuntimeEvent, type AcpRuntimeHandle, type AcpRuntimeOptions, type AcpRuntimePlanEntry, type AcpRuntimePromptMode, type AcpRuntimeSessionContext, type AcpRuntimeSessionMode, type AcpRuntimeSessionModels, type AcpRuntimeSessionPermissions, type AcpRuntimeSessionUsage, type AcpRuntimeStatus, type AcpRuntimeTurn, type AcpRuntimeTurnAttachment, type AcpRuntimeTurnInput, type AcpRuntimeTurnResult, type AcpRuntimeTurnResultError, type AcpRuntimeUsageBreakdown, type AcpRuntimeUsageCost, type AcpSessionRecord, type AcpSessionStore, type AcpSessionUpdateTag, type AcpTextDeltaOriginMeta, DEFAULT_AGENT_NAME, type InspectAgentModelsOptions, type PermissionPolicy, type RequestedModelUnsupportedErrorCode, type RequestedModelUnsupportedReason, type SessionAgentOptions, type SessionWatchEvent, type SessionWatchResult, type SharedAcpRuntimeOptions, type SystemPromptOption, createAgentRegistry };
