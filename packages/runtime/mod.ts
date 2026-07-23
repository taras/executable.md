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
 * - `API.Env` — environment variables and platform info (`cwd`, `env`, `platform`)
 * - `API.Compiler` — block compilation (`compile`)
 *
 * See `apis.ts` for architecture rationale.
 * See `@executablemd/runtime/test` for composable test stubs.
 */

export { API } from "./apis.ts";
export { exec, readTextFile, stat, glob, fetch, cwd, env, platform, compile } from "./apis.ts";
export type { ResponseHeaders, RuntimeFetchResponse, StatResult } from "./apis.ts";
export { findFreePort } from "./find-free-port.ts";
