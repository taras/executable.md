import { a as AcpPermissionRequest, c as NonInteractivePermissionPolicy, f as SessionRecord, i as AcpPermissionDecision, l as PermissionMode, n as SystemPromptOption, s as McpServer$1, t as SessionAgentOptions } from "./session-options-jkYbBxGE.js";
import { a as RequestedModelUnsupportedErrorCode, i as RequestedModelUnsupportedError, n as REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE, o as RequestedModelUnsupportedReason, r as REQUESTED_MODEL_UNSUPPORTED_REASONS, s as isRequestedModelUnsupportedError, t as AcpClient } from "./client-DwNyFauq.js";
import fs from "node:fs";
import { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

//#region src/agent-registry.d.ts
declare const DEFAULT_AGENT_NAME = "codex";
//#endregion
//#region src/runtime/public/contract.d.ts
type AcpRuntimePromptMode = "prompt" | "steer";
type AcpRuntimeSessionMode = "persistent" | "oneshot";
type AcpSessionUpdateTag = "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "usage_update" | "available_commands_update" | "current_mode_update" | "config_option_update" | "session_info_update" | "plan" | (string & {});
type AcpRuntimeControl = "session/set_mode" | "session/set_config_option" | "session/status";
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
   * different sessionKey or closing the prior record first.
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
type AcpRuntimeTurnInput = {
  handle: AcpRuntimeHandle;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};
type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  configOptionKeys?: string[];
};
type AcpRuntimeSessionModels = {
  currentModelId?: string;
  availableModelIds: string[];
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
  description?: string; /** True/false when ACP advertised whether this command has an input schema. */
  hasInput?: boolean;
};
/**
 * Session-level usage roll-up surfaced through `getStatus()`. The
 * reducer persists the breakdowns onto the session record; this type
 * exposes them on the runtime contract.
 */
type AcpRuntimeSessionUsage = {
  cumulative?: AcpRuntimeUsageBreakdown; /** Cumulative session cost when the agent reported it. */
  cost?: AcpRuntimeUsageCost; /** Keyed by user-message id, matching the persisted reducer state. */
  perRequest?: Record<string, AcpRuntimeUsageBreakdown>;
};
type AcpRuntimeStatus = {
  summary?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  models?: AcpRuntimeSessionModels; /** Token usage and cost from the persisted session record. */
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
type AcpRuntimeEvent = {
  type: "text_delta";
  text: string;
  stream?: "output" | "thought";
  tag?: AcpSessionUpdateTag;
} | {
  type: "status";
  text: string;
  tag?: AcpSessionUpdateTag;
  used?: number;
  size?: number; /** Populated on `usage_update` events when the agent reported a cost. */
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
}
/**
 * Compatibility terminal event emitted by runTurn(...). startTurn(...).events
 * does not emit terminal events; use AcpRuntimeTurn.result instead.
 */
| {
  type: "done";
  stopReason?: string;
}
/**
 * Compatibility failure event emitted by runTurn(...). startTurn(...).events
 * does not emit terminal events; use AcpRuntimeTurn.result instead.
 */
| {
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
} | {
  status: "cancelled";
  stopReason?: string;
} | {
  status: "failed";
  error: AcpRuntimeTurnResultError;
};
interface AcpRuntimeTurn {
  readonly requestId: string;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: {
    reason?: string;
  }): Promise<void>;
  closeStream(input?: {
    reason?: string;
  }): Promise<void>;
}
interface AcpRuntime {
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
  setMode?(input: {
    handle: AcpRuntimeHandle;
    mode: string;
  }): Promise<void>;
  setConfigOption?(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  cancel(input: {
    handle: AcpRuntimeHandle;
    reason?: string;
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
interface AcpAgentRegistry {
  resolve(agentName: string): string;
  list(): string[];
}
type AcpRuntimeOptions = {
  cwd: string;
  sessionStore: AcpSessionStore;
  agentRegistry: AcpAgentRegistry;
  mcpServers?: McpServer$1[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  timeoutMs?: number;
  probeAgent?: string;
  verbose?: boolean;
  onPermissionRequest?: (req: AcpPermissionRequest, ctx: {
    signal: AbortSignal;
  }) => Promise<AcpPermissionDecision | undefined>;
};
type AcpFileSessionStoreOptions = {
  stateDir: string;
};
//#endregion
//#region src/runtime/engine/manager.d.ts
type AcpRuntimeManagerDeps = {
  clientFactory?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
};
declare class AcpRuntimeManager {
  private readonly options;
  private readonly deps;
  private readonly activeControllers;
  private readonly pendingPersistentClients;
  private readonly closingActiveRecords;
  constructor(options: AcpRuntimeOptions, deps?: AcpRuntimeManagerDeps);
  private createClient;
  private readPendingPersistentClient;
  private closePendingPersistentClient;
  private refreshClosedState;
  private retainPersistentClientAfterTurn;
  private withRuntimeControlSession;
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
    sessionOptions?: SessionAgentOptions;
  }): Promise<SessionRecord>;
  private createAndSaveRuntimeRecord;
  private keepPersistentClient;
  startTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    attachments?: AcpRuntimeTurnAttachment[];
    mode: AcpRuntimePromptMode;
    sessionMode: "persistent" | "oneshot";
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): AcpRuntimeTurn;
  private runRuntimeTurnTask;
  private prepareRuntimeTurn;
  private createTurnClient;
  private createRuntimeTurnCheckpoint;
  private buildRuntimeTurnController;
  private waitForRuntimeControlSession;
  private requestRuntimeTurnCancel;
  private setRuntimeResolvedSessionConfigOption;
  private applyRuntimeConfigOptionState;
  private installRuntimeTurnEventHandlers;
  private emitRuntimeTurnEvent;
  private connectRuntimeTurn;
  private connectRuntimeTurnClient;
  private publishRuntimeTurnController;
  private resolveRuntimeTurnReady;
  private emitRuntimeTurnLoadStatus;
  private cancelRuntimeTurnBeforePrompt;
  private applyPendingRuntimeTurnCancel;
  private saveCompletedRuntimeTurn;
  private failRuntimeTurn;
  private finalizeRuntimeTurn;
  private finalizeRuntimeTurnRecord;
  runTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    attachments?: AcpRuntimeTurnAttachment[];
    mode: AcpRuntimePromptMode;
    sessionMode: "persistent" | "oneshot";
    requestId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AcpRuntimeEvent>;
  getStatus(handle: AcpRuntimeHandle): Promise<AcpRuntimeStatus>;
  setMode(handle: AcpRuntimeHandle, mode: string, sessionMode?: "persistent" | "oneshot"): Promise<void>;
  setConfigOption(handle: AcpRuntimeHandle, key: string, value: string, sessionMode?: "persistent" | "oneshot"): Promise<void>;
  cancel(handle: AcpRuntimeHandle): Promise<void>;
  close(handle: AcpRuntimeHandle, options?: {
    discardPersistentState?: boolean;
  }): Promise<void>;
  private closeBackendSession;
  private requireRecord;
}
//#endregion
//#region src/runtime/public/file-session-store.d.ts
declare function createFileSessionStore(options: AcpFileSessionStoreOptions): AcpSessionStore;
//#endregion
//#region src/runtime/public/errors.d.ts
declare const ACP_ERROR_CODES: readonly ["ACP_BACKEND_MISSING", "ACP_BACKEND_UNAVAILABLE", "ACP_BACKEND_UNSUPPORTED_CONTROL", "ACP_DISPATCH_DISABLED", "ACP_INVALID_RUNTIME_OPTION", "ACP_SESSION_INIT_FAILED", "ACP_TURN_FAILED"];
type AcpRuntimeErrorCode = (typeof ACP_ERROR_CODES)[number];
declare class AcpRuntimeError extends Error {
  readonly code: AcpRuntimeErrorCode;
  readonly cause?: unknown;
  constructor(code: AcpRuntimeErrorCode, message: string, options?: {
    cause?: unknown;
  });
}
declare function isAcpRuntimeError(value: unknown): value is AcpRuntimeError;
//#endregion
//#region src/runtime/public/shared.d.ts
type AcpxHandleState = {
  name: string;
  agent: string;
  cwd: string;
  mode: "persistent" | "oneshot";
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};
//#endregion
//#region src/runtime/public/handle-state.d.ts
declare function encodeAcpxRuntimeHandleState(state: AcpxHandleState): string;
declare function decodeAcpxRuntimeHandleState(runtimeSessionName: string): AcpxHandleState | null;
//#endregion
//#region src/runtime.d.ts
declare const ACPX_BACKEND_ID = "acpx";
type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor(): Promise<AcpRuntimeDoctorReport>;
};
declare function createAgentRegistry(params?: {
  overrides?: Record<string, string>;
}): AcpAgentRegistry;
declare class AcpxRuntime implements AcpxRuntimeLike {
  private readonly options;
  private readonly testOptions?;
  private healthy;
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
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  startTurn(input: AcpRuntimeTurnInput): {
    requestId: string;
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
  setMode(input: {
    handle: AcpRuntimeHandle;
    mode: string;
  }): Promise<void>;
  setConfigOption(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void>;
  cancel(input: {
    handle: AcpRuntimeHandle;
    reason?: string;
  }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void>;
  private getManager;
  private runProbe;
  private resolveManagerHandle;
  private resolveHandleState;
}
declare function createAcpRuntime(options: AcpRuntimeOptions): AcpxRuntime;
declare function createRuntimeStore(options: {
  stateDir: string;
}): AcpSessionStore;
//#endregion
export { ACPX_BACKEND_ID, type AcpAgentRegistry, type AcpFileSessionStoreOptions, type AcpPermissionDecision, type AcpPermissionRequest, type AcpRuntime, type AcpRuntimeAvailableCommand, type AcpRuntimeCapabilities, type AcpRuntimeDoctorReport, type AcpRuntimeEnsureInput, AcpRuntimeError, type AcpRuntimeErrorCode, type AcpRuntimeEvent, type AcpRuntimeHandle, type AcpRuntimeOptions, type AcpRuntimePromptMode, type AcpRuntimeSessionMode, type AcpRuntimeSessionModels, type AcpRuntimeSessionUsage, type AcpRuntimeStatus, type AcpRuntimeTurn, type AcpRuntimeTurnAttachment, type AcpRuntimeTurnInput, type AcpRuntimeTurnResult, type AcpRuntimeTurnResultError, type AcpRuntimeUsageBreakdown, type AcpRuntimeUsageCost, type AcpSessionRecord, type AcpSessionStore, type AcpSessionUpdateTag, AcpxRuntime, DEFAULT_AGENT_NAME, REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE, REQUESTED_MODEL_UNSUPPORTED_REASONS, RequestedModelUnsupportedError, type RequestedModelUnsupportedErrorCode, type RequestedModelUnsupportedReason, type SessionAgentOptions, type SystemPromptOption, createAcpRuntime, createAgentRegistry, createFileSessionStore, createRuntimeStore, decodeAcpxRuntimeHandleState, encodeAcpxRuntimeHandleState, isAcpRuntimeError, isRequestedModelUnsupportedError };
//# sourceMappingURL=runtime.d.ts.map