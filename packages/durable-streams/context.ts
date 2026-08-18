/**
 * DurableContext — the scope-local state for durable execution.
 *
 * Stored on each Effection scope via createContext(). Child scopes
 * inherit the shared replayIndex and stream, but get their own
 * coroutineId and childCounter.
 */

import { type Context, createContext, type Operation } from "effection";
import type { ReplayIndex } from "./replay-index.ts";
import type { DurableStream } from "./stream.ts";
import type { CoroutineId } from "./types.ts";

export interface DurableAppendFence {
  hold(): Operation<void>;
}

export interface DurabilityState {
  failure?: Error;
  appendFence?: DurableAppendFence;
}

export interface DurableContext {
  /** Shared replay index (built from stream on startup). */
  replayIndex: ReplayIndex;
  /** Shared durable stream for appending events. */
  stream: DurableStream;
  /** This coroutine's hierarchical ID. */
  coroutineId: CoroutineId;
  /** Counter for assigning child IDs. */
  childCounter: number;
  /**
   * How many durable yields this coroutine has settled.
   *
   * Advanced by both settlement paths, so a coroutine running past its retained
   * history keeps counting where replay left off. See `position.ts`.
   */
  position?: number;
  /** Protocol failure shared by the root and every durable child. */
  durability?: DurabilityState;
}

/**
 * Effection Context for durable execution state.
 * Set on the root scope by durableRun(); inherited by child scopes.
 */
export const DurableContext: Context<DurableContext> =
  createContext<DurableContext>("@effection/durable");
