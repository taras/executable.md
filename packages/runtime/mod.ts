/**
 * @module
 * Runtime Context APIs for executable markdown.
 *
 * `API` is available for middleware (`.around()`).
 * For normal calls, import operations directly.
 *
 * Seven domain APIs:
 * - `API.Process` — subprocess execution (`exec`)
 * - `API.Fs` — the low-level host filesystem (`readTextFile`, `writeTextFile`,
 *   `stat`, `lstat`, `readDirectory`, `glob`, `realpath`, `ensureDir`, `rename`,
 *   `remove`)
 * - `API.Files` — document filesystem access as whole semantic operations,
 *   with no host default. `useHostFiles()` installs the host provider.
 * - `API.Fetch` — HTTP requests (`fetch`)
 * - `API.Env` — the host: variables, platform info, the command that invokes
 *   this xmd, and eval-block compilation
 *   (`cwd`, `env`, `platform`, `command`, `compile`)
 * - `API.Service` — scoped attached service startup (`startService`)
 * - `NativeLauncher` — handing one native agent UI the foreground terminal
 *   (`reserveTerminal`, `flushOutput`, `nativeLaunch`)
 * - `Config` — shared execution config (`timeout`, `timeoutExec`, `timeoutFetch`,
 *   `verbose`)
 *
 * See `apis.ts` for architecture rationale.
 * See `@executablemd/runtime/test` for composable test stubs.
 */

export { API } from "./apis.ts";
export {
  exec,
  readTextFile,
  writeTextFile,
  stat,
  lstat,
  readDirectory,
  glob,
  realpath,
  ensureDir,
  rename,
  remove,
  fetch,
  cwd,
  env,
  platform,
  command,
  compile,
  useQuietProcessOutput,
} from "./apis.ts";
export type {
  DirectoryEntry,
  EvalBlock,
  FetchInit,
  FetchOperation,
  LinkStatResult,
  ResponseHeaders,
  RuntimeFetchResponse,
  StatResult,
} from "./apis.ts";
export {
  Service,
  SERVICE_HOSTNAME,
  SERVICE_READY_PREFIX,
  ServiceProcessExitBeforeReadyError,
  ServiceProtocolDuplicateError,
  ServiceProtocolHostnameMismatchError,
  ServiceProtocolIncompatibleError,
  ServiceProtocolMalformedError,
  ServiceProtocolTokenMismatchError,
  ServiceProviderError,
  ServiceStartupTimeoutError,
  ServiceTeardownError,
  ServiceUnexpectedExitError,
  parseServiceReadyRecord,
  startService,
} from "./service.ts";
export type {
  ServiceEndpoint,
  ServiceHandler,
  ServiceAttachment,
  ServiceStartOptions,
} from "./service.ts";
export { Config, timeout, timeoutExec, timeoutFetch, verbose } from "./config.ts";
export type { ConfigApi } from "./config.ts";
export { asDuration, durationError, parseDuration } from "./duration.ts";
export type { ProcessExecOptions, ProcessOutcome } from "./apis.ts";
export {
  asFilesFatal,
  FILES_ERROR,
  FILES_ERROR_MESSAGE,
  FILES_FATAL,
  FILES_INVARIANT_MESSAGE,
  FILES_OPERATION_DENIED_MESSAGE,
  FILES_PROVIDER_UNAVAILABLE_MESSAGE,
  FILES_WRITE_SUCCESS,
  Files,
  FilesError,
  FilesInvariantError,
  FilesOperationDeniedError,
  FilesProviderUnavailableError,
  fileWriteFailure,
  fileWriteSuccess,
  filesFailure,
  isFilesFatal,
  parseFilesPhase,
  parseFilesReason,
  parseFileWriteFailure,
  parseFileWritePhase,
  parseFileWriteSuccess,
  parseFilesFailure,
  parseFilesFatal,
} from "./files.ts";
export type {
  FilePathInput,
  FilesDeniableOperation,
  FilesErrorData,
  FilesFailureData,
  FilesFatalData,
  FilesFatalFailure,
  FilesHandler,
  FilesInvariantCategory,
  FilesOperation,
  FilesPhase,
  FilesReason,
  FileWriteFailureData,
  FileWriteInput,
  FileWritePhase,
  FileWriteSuccess,
  FileWriteTarget,
  GlobInput,
} from "./files.ts";
export {
  flushOutput,
  installControlledLauncher,
  installForegroundLauncher,
  NATIVE_LAUNCHER_UNAVAILABLE,
  NativeLauncher,
  NativeLauncherUnavailableError,
  nativeLaunch,
  NO_TERMINAL,
  reserveTerminal,
} from "./launcher.ts";
export type {
  ControlledLauncherOptions,
  NativeLauncherHandler,
  NativeLaunchOutcome,
  NativeLaunchRequest,
} from "./launcher.ts";
export {
  prepareControlledComposite,
  TERMINAL_GRIDS_API,
  TERMINAL_PROVIDER_UNAVAILABLE,
  TerminalGrids,
  terminalProviderLog,
  TerminalProviderUnavailableError,
} from "./terminal.ts";
export type {
  ControlledCompositeOptions,
  TerminalComposite,
  TerminalGridApi,
  TerminalGridRequest,
  TerminalPaneRequest,
  TerminalPaneState,
  TerminalProviderLog,
  TerminalProviderResources,
  TerminalShellOutcome,
} from "./terminal.ts";
export {
  descendantsOf,
  deliverSignal,
  establishQuiescence,
  groupMembers,
  paneOccupants,
  processReachable,
  processTable,
  TERMINAL_PROCESSES_API,
  TERMINAL_PROCESSES_UNAVAILABLE,
  TerminalProcesses,
  TerminalProcessesUnavailableError,
  terminalHolders,
} from "./terminal-processes.ts";
export type {
  PaneOccupants,
  PaneQuiescence,
  ProcessFacts,
  SignalDelivery,
  TerminalProcessHandler,
  TerminalSignal,
} from "./terminal-processes.ts";
export { installDenoTerminalProcesses, posixProcessProbes } from "./deno-terminal-processes.ts";
export type { ProcessProbes } from "./deno-terminal-processes.ts";
export { hostFilesHandler, useHostFiles } from "./host-files.ts";
export type { HostFilesEvent, HostFilesObserver, HostFilesOptions } from "./host-files.ts";
export {
  AgentSessionBusy,
  agentSessionKeyDigest,
  AgentSessionRecoveryRequired,
  parseAgentSessionOwnership,
  serializeAgentSessionOwnership,
} from "./agent-session-coordinator.ts";
export type {
  AgentSessionCoordinator,
  AgentSessionKey,
  AgentSessionOwner,
  AgentSessionOwnerKind,
  AgentSessionOwnership,
  AgentSessionOwnershipRecordV1,
} from "./agent-session-coordinator.ts";
export {
  createDenoAgentSessionCoordinator,
  hasDenoAgentSessionCoordinator,
} from "./deno-agent-session-coordinator.ts";
export { ExecutableObservationError } from "./executable-observer.ts";
export type {
  ExecutableObserver,
  ExecutableRefusal,
  ObservedExecutable,
} from "./executable-observer.ts";
export {
  createDenoExecutableObserver,
  hasDenoExecutableObserver,
} from "./deno-executable-observer.ts";
