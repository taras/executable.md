import { c as NonInteractivePermissionPolicy, d as PermissionStats, l as PermissionMode, p as PromptInput, r as AcpClientOptions } from "./session-options-jkYbBxGE.js";
import { AnyMessage, InitializeResponse, ListSessionsRequest, ListSessionsResponse, PromptResponse, SessionConfigOption, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";

//#region src/acp/model-support.d.ts
type SessionModelState = {
  configId?: string;
  currentModelId: string;
  availableModels: Array<{
    modelId: string;
    name: string;
  }>;
};
declare const REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE: "ACP_MODEL_UNSUPPORTED";
type RequestedModelUnsupportedErrorCode = typeof REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE;
declare const REQUESTED_MODEL_UNSUPPORTED_REASONS: readonly ["missing-capability", "unadvertised-model"];
type RequestedModelUnsupportedReason = (typeof REQUESTED_MODEL_UNSUPPORTED_REASONS)[number];
declare class RequestedModelUnsupportedError extends Error {
  readonly code: "ACP_MODEL_UNSUPPORTED";
  readonly reason: RequestedModelUnsupportedReason;
  constructor(message: string, reason: RequestedModelUnsupportedReason);
}
declare function isRequestedModelUnsupportedError(value: unknown): value is RequestedModelUnsupportedError;
//#endregion
//#region src/acp/client.d.ts
type LoadSessionOptions = {
  suppressReplayUpdates?: boolean;
  replayIdleMs?: number;
  replayDrainTimeoutMs?: number;
};
type SessionCreateResult = {
  sessionId: string;
  agentSessionId?: string;
  configOptions?: SessionConfigOption[];
  models?: SessionModelState;
  configOptionsPresent: boolean;
  legacyModelMetadataPresent: boolean;
};
type SessionLoadResult = {
  agentSessionId?: string;
  configOptions?: SessionConfigOption[];
  models?: SessionModelState;
  configOptionsPresent: boolean;
  legacyModelMetadataPresent: boolean;
};
type SessionResumeResult = SessionLoadResult;
type AgentDisconnectReason = "process_exit" | "process_close" | "pipe_close" | "connection_close";
type ModelControlOverride = Pick<SessionModelState, "configId"> & Partial<Pick<SessionModelState, "availableModels">>;
type AgentExitInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
  reason: AgentDisconnectReason;
  unexpectedDuringPrompt: boolean;
};
type AgentLifecycleSnapshot = {
  pid?: number;
  startedAt?: string;
  running: boolean;
  lastExit?: AgentExitInfo;
};
declare class AcpClient {
  private options;
  private connection?;
  private agent?;
  private initResult?;
  private loadedSessionId?;
  private eventHandlers;
  private readonly permissionStats;
  private readonly filesystem;
  private readonly terminalManager;
  private sessionUpdateChain;
  private observedSessionUpdates;
  private processedSessionUpdates;
  private suppressSessionUpdates;
  private suppressReplaySessionUpdateMessages;
  private activePrompt?;
  private readonly cancellingSessionIds;
  private readonly permissionAbortControllers;
  private closing;
  private agentStartedAt?;
  private lastAgentExit?;
  private lastKnownPid?;
  private readonly promptPermissionFailures;
  private readonly pendingConnectionRequests;
  private readonly modelConfigIds;
  private readonly legacyModelSessionIds;
  constructor(options: AcpClientOptions);
  get initializeResult(): InitializeResponse | undefined;
  getAgentPid(): number | undefined;
  getPermissionStats(): PermissionStats;
  getAgentLifecycleSnapshot(): AgentLifecycleSnapshot;
  supportsLoadSession(): boolean;
  supportsResumeSession(): boolean;
  supportsCloseSession(): boolean;
  supportsListSessions(): boolean;
  setEventHandlers(handlers: Pick<AcpClientOptions, "onAcpMessage" | "onAcpOutputMessage" | "onSessionUpdate" | "onClientOperation" | "onPermissionEscalation">): void;
  clearEventHandlers(): void;
  updateRuntimeOptions(options: {
    permissionMode?: PermissionMode;
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    permissionPolicy?: AcpClientOptions["permissionPolicy"];
    terminal?: boolean;
    suppressSdkConsoleErrors?: boolean;
    verbose?: boolean;
  }): void;
  private refreshRuntimePermissionPolicy;
  hasReusableSession(sessionId: string): boolean;
  hasActivePrompt(sessionId?: string): boolean;
  start(): Promise<void>;
  private resolveAgentLaunchPlan;
  private logAgentLaunch;
  private ensureLaunchSupport;
  private spawnAgentProcess;
  private createConnection;
  private initializeAgentConnection;
  private initializeProtocolConnection;
  private handleInitializeFailure;
  private createTappedStream;
  createSession(cwd?: string): Promise<SessionCreateResult>;
  loadSession(sessionId: string, cwd?: string): Promise<SessionLoadResult>;
  loadSessionWithOptions(sessionId: string, cwd?: string, options?: LoadSessionOptions): Promise<SessionLoadResult>;
  resumeSession(sessionId: string, cwd?: string): Promise<SessionResumeResult>;
  private applySessionUpdateSuppression;
  private restoreSessionUpdateSuppression;
  prompt(sessionId: string, prompt: PromptInput | string): Promise<PromptResponse>;
  private normalizePromptForAgent;
  private returnPromptResponseOrPermissionFailure;
  private throwPromptPermissionFailureIfPresent;
  setSessionMode(sessionId: string, modeId: string): Promise<void>;
  setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<SetSessionConfigOptionResponse>;
  setSessionModel(sessionId: string, modelId: string, controlOverride?: ModelControlOverride): Promise<SetSessionConfigOptionResponse | undefined>;
  private setSessionModelThroughConfig;
  private setSessionModelThroughLegacyMethod;
  private throwSessionModelError;
  private resolveModelControl;
  private rememberSessionModels;
  private updateRememberedSessionModels;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(params?: ListSessionsRequest): Promise<ListSessionsResponse>;
  requestCancelActivePrompt(): Promise<boolean>;
  cancelActivePrompt(waitMs?: number): Promise<PromptResponse | undefined>;
  close(): Promise<void>;
  private terminateAgentProcess;
  private endAgentStdin;
  private killAgentIfRunning;
  private detachAgentHandles;
  private getConnection;
  private log;
  private captureStartupStderr;
  private summarizeStartupStderr;
  private createStartupFailureWatcher;
  private normalizeInitializeError;
  private selectAuthMethod;
  private readAgentSpecificEnvCredential;
  private selectAgentManagedAuthMethod;
  private isGrokBuildAcpCommand;
  private authenticateIfRequired;
  private handlePermissionRequest;
  private tryHandlePermissionRequestWithHost;
  private hostPermissionDecisionResponse;
  private hostPermissionErrorResponse;
  private resolvePermissionRequestFromMode;
  private emitPermissionEscalation;
  private handleModePermissionError;
  private attachAgentLifecycleObservers;
  private recordAgentExit;
  private notePromptPermissionFailure;
  private consumePromptPermissionFailure;
  private runConnectionRequest;
  private rejectPendingConnectionRequests;
  private handleReadTextFile;
  private handleWriteTextFile;
  private handleCreateTerminal;
  private handleTerminalOutput;
  private handleWaitForTerminalExit;
  private handleKillTerminal;
  private handleReleaseTerminal;
  private cancellationSignalForSession;
  private abortAndDropPermissionSignal;
  private recordPermissionDecision;
  private recordPermissionError;
  private handleSessionUpdate;
  private waitForSessionUpdateDrain;
  waitForSessionUpdatesIdle(options?: {
    idleMs?: number;
    timeoutMs?: number;
  }): Promise<void>;
}
//#endregion
export { RequestedModelUnsupportedErrorCode as a, RequestedModelUnsupportedError as i, REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE as n, RequestedModelUnsupportedReason as o, REQUESTED_MODEL_UNSUPPORTED_REASONS as r, isRequestedModelUnsupportedError as s, AcpClient as t };
//# sourceMappingURL=client-DwNyFauq.d.ts.map