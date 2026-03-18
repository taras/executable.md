/**
 * @module
 * Durable effects and replay guards for Effection workflows.
 *
 * Provides platform-agnostic durable effects (exec, readFile, glob, fetch,
 * eval, resolve) and replay guards for staleness detection, built on
 * @executablemd/durable-streams.
 *
 * Runtime I/O operations (exec, readTextFile, stat, glob, fetch, env,
 * platform) are provided by @executablemd/runtime as context APIs.
 */

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export { computeSHA256 } from "./hash.ts";

// ---------------------------------------------------------------------------
// Durable effects
// ---------------------------------------------------------------------------

export { durableExec } from "./durable-exec.ts";
export type { ExecOptions, ExecResult } from "./durable-exec.ts";

export { durableReadFile } from "./durable-read-file.ts";
export type { ReadFileResult } from "./durable-read-file.ts";

export { durableGlob } from "./durable-glob.ts";
export type { GlobOptions, GlobMatch, GlobResult } from "./durable-glob.ts";

export { durableFetch } from "./durable-fetch.ts";
export type { FetchOptions, FetchResult } from "./durable-fetch.ts";

export { durableEval } from "./durable-eval.ts";
export type { EvalOptions, EvalResult } from "./durable-eval.ts";

export {
  durableResolve,
  durableNow,
  durableUUID,
  durableEnv,
} from "./durable-resolve.ts";
export type { ResolveKind } from "./durable-resolve.ts";

// ---------------------------------------------------------------------------
// Replay guards
// ---------------------------------------------------------------------------

export {
  useFileContentGuard,
  useGlobContentGuard,
  useCodeFreshnessGuard,
} from "./guards.ts";

export type { CellSource } from "./guards.ts";
