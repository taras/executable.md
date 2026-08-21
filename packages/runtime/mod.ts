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
 *   `stat`, `glob`, `realpath`, `ensureDir`, `rename`, `remove`)
 * - `API.Files` — document filesystem access as whole semantic operations,
 *   with no host default. `useHostFiles()` installs the host provider.
 * - `API.Fetch` — HTTP requests (`fetch`)
 * - `API.Env` — the host: variables, platform info, the command that invokes
 *   this xmd, and eval-block compilation
 *   (`cwd`, `env`, `platform`, `command`, `compile`)
 * - `API.Service` — scoped attached service startup (`startService`)
 * - `NativeLauncher` — handing one native agent UI the foreground terminal
 *   (`reserveTerminal`, `flushOutput`, `nativeLaunch`)
 * - `Config` — shared execution config (`timeout`, `timeoutExec`, `timeoutFetch`)
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
  EvalBlock,
  FetchInit,
  FetchOperation,
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
export { Config, timeout, timeoutExec, timeoutFetch } from "./config.ts";
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
export { ExecutableBinding, ExecutableObservationError } from "./executable-binding.ts";
export { SessionLease } from "./session-lease.ts";
export type { SessionLeaseApi, SessionLeaseOutcome } from "./session-lease.ts";
export { hasDenoSessionLease, installDenoSessionLease } from "./deno-session-lease.ts";
export type {
  ExecutableBindingApi,
  ExecutableRefusal,
  LiveExecutable,
} from "./executable-binding.ts";
export { hostFilesHandler, useHostFiles } from "./host-files.ts";
export type { HostFilesEvent, HostFilesObserver, HostFilesOptions } from "./host-files.ts";
