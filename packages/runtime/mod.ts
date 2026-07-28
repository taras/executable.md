/**
 * @module
 * Runtime Context APIs for executable markdown.
 *
 * `API` is available for middleware (`.around()`).
 * For normal calls, import operations directly.
 *
 * Six domain APIs:
 * - `API.Process` — subprocess execution (`exec`)
 * - `API.Fs` — filesystem (`readTextFile`, `stat`, `glob`)
 * - `API.Fetch` — HTTP requests (`fetch`)
 * - `API.Env` — the host: variables, platform info, the command that invokes
 *   this xmd, and eval-block compilation
 *   (`cwd`, `env`, `platform`, `command`, `compile`)
 * - `Config` — shared execution config (`timeout`)
 *
 * See `apis.ts` for architecture rationale.
 * See `@executablemd/runtime/test` for composable test stubs.
 */

export { API } from "./apis.ts";
export {
  exec,
  readTextFile,
  stat,
  glob,
  fetch,
  cwd,
  env,
  platform,
  command,
  compile,
} from "./apis.ts";
export type { EvalBlock, ResponseHeaders, RuntimeFetchResponse, StatResult } from "./apis.ts";
export { findFreePort } from "./find-free-port.ts";
export { Config, timeout } from "./config.ts";
export type { ConfigApi } from "./config.ts";
