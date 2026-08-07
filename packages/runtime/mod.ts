/**
 * @module
 * Runtime Context APIs for executable markdown.
 *
 * `API` is available for middleware (`.around()`).
 * For normal calls, import operations directly.
 *
 * Six domain APIs:
 * - `API.Process` — subprocess execution (`exec`)
 * - `API.Fs` — filesystem (`readTextFile`, `writeTextFile`, `stat`, `glob`,
 *   `realpath`, `ensureDir`, `rename`, `remove`)
 * - `API.Fetch` — HTTP requests (`fetch`)
 * - `API.Env` — the host: variables, platform info, the command that invokes
 *   this xmd, and eval-block compilation
 *   (`cwd`, `env`, `platform`, `command`, `compile`)
 * - `API.Service` — scoped cooperative service startup (`startService`)
 * - `Config` — shared execution config (`timeout`)
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
} from "./apis.ts";
export type { EvalBlock, ResponseHeaders, RuntimeFetchResponse, StatResult } from "./apis.ts";
export { findFreePort } from "./find-free-port.ts";
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
  ServiceResource,
  ServiceStartOptions,
} from "./service.ts";
export { Config, timeout } from "./config.ts";
export type { ConfigApi } from "./config.ts";
