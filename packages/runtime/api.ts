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
 */

export { Config, timeout, timeoutExec, timeoutFetch, verbose } from "./config.ts";
export type { ConfigApi } from "./config.ts";
export { asDuration, durationError, parseDuration } from "./duration.ts";
