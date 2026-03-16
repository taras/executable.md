/**
 * Re-exports DurableRuntime types from @executablemd/durable-streams.
 *
 * The canonical definitions live in durable-streams. This re-export
 * keeps existing imports within durable-effects working without
 * mass import-path changes.
 */

export { DurableRuntimeCtx } from "@executablemd/durable-streams";
export type {
  DurableRuntime,
  ResponseHeaders,
  RuntimeFetchResponse,
  StatResult,
} from "@executablemd/durable-streams";
