/**
 * @module
 *
 * The consumer API of `@executablemd/runtime`: the shared execution
 * configuration a Plugin, a component package or a host reads.
 *
 * `Config` is the same Api the engine and the CLI already install and read;
 * this entrypoint is where a consumer imports it from, so a package depending
 * on runtime reaches its configuration without importing the whole host
 * surface. The root export keeps every one of these names.
 *
 * ```ts
 * import { verbose } from "@executablemd/runtime/api";
 *
 * if (yield* verbose) {
 *   // render the detail a quiet run leaves out
 * }
 * ```
 *
 * `Permissions` is here for the same reason: a scope that permits less than
 * its host does installs middleware around it, which is configuration of the
 * run rather than a filesystem or a transport of its own. `FetchInit` comes
 * with it, so a restriction can be typed without importing the host surface
 * the request is eventually performed by.
 */

export { Config, timeout, timeoutExec, timeoutFetch, verbose } from "./config.ts";
export type { ConfigApi } from "./config.ts";
export { asDuration, durationError, parseDuration } from "./duration.ts";
export { FETCH_NOT_PERMITTED_MESSAGE, Permissions } from "./permissions.ts";
export type { PermissionsApi } from "./permissions.ts";
export type { FetchInit } from "./apis.ts";
