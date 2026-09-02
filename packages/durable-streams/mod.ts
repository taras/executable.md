/**
 * @module
 * Durable execution for Effection.
 *
 * Implements the two-event durable execution protocol for generator-based
 * structured concurrency, with Durable Streams as the persistence backend.
 */

// Protocol types
export type {
  Cancellation,
  Close,
  CoroutineId,
  CoroutineView,
  DurableEffect,
  DurableEvent,
  EffectDescription,
  EffectionResult,
  Json,
  Resolve,
  Result,
  SerializedError,
  Workflow,
  Yield,
} from "./types.ts";

// ReplayIndex
export { ReplayIndex } from "./replay-index.ts";
// `retainEvents` is public because `@executablemd/core` owns its own journal
// gate and must produce the stable history across the package boundary. The
// retained classes and the detach helpers stay internal.
export { retainEvents } from "./retained.ts";
export type { YieldEntry } from "./replay-index.ts";

// Stream interface
export type { DurableStream } from "./stream.ts";
export { InMemoryStream } from "./stream.ts";

// Pre-persistence gate — runs before an event reaches its backend
export { guardDurableStream } from "./guard.ts";
// Journal provenance — proves which backend a publication stream descends from
export { establishJournalProvenance, preserveJournalProvenance } from "./guard.ts";
export type { DurableEventGate, JournalProvenance } from "./guard.ts";

// HTTP-backed stream adapter
export { useHttpDurableStream } from "./http-stream.ts";
export type { HttpDurableStreamHandle, HttpDurableStreamOptions } from "./http-stream.ts";

// Errors
export {
  ContinuePastCloseDivergenceError,
  describeEffect,
  DivergenceError,
  DurablePersistenceError,
  EarlyReturnDivergenceError,
  MalformedDurableEventError,
  SOURCE_POSITION_FIELD,
  StaleInputError,
  TerminalDivergenceError,
} from "./errors.ts";

// Divergence API — pluggable policy for replay mismatches (DEC-031)
export { Divergence } from "./divergence.ts";
export type { DivergenceDecision, DivergenceInfo, DivergenceKind } from "./divergence.ts";

// ReplayGuard API — pluggable validation for replay staleness detection
export { ReplayGuard } from "./replay-guard.ts";
export type { ReplayOutcome, RetainedHistory } from "./replay-guard.ts";
export type { AbandonedRetainedEntry, AbandonedRetainedHistory } from "./live-coordinator.ts";

// Context
export { DurableContext } from "./context.ts";

// Serialization utilities
export {
  deserializeError,
  effectionToProtocol,
  protocolToEffection,
  serializeDurableEvent,
  serializeError,
} from "./serialize.ts";

// The typed inverse of serializeDurableEvent
export { parseDurableEvent } from "./parse.ts";

// Core effect factories
export { createDurableEffect, createDurableOperation } from "./effect.ts";

export { durablePosition } from "./position.ts";
export type { DurablePosition } from "./position.ts";
export type { Executor } from "./effect.ts";

// Structured live-operation coordination
export { defaultLiveDurableOperationCoordinator } from "./live-coordinator.ts";
export type {
  ActivateDurabilityFailure,
  LiveDurableOperationCoordinator,
} from "./live-coordinator.ts";

// Workflow-enabled effects
export { durableAction, durableCall, durableSleep, versionCheck } from "./operations.ts";

// Structured concurrency combinators
export { durableAll, durableRace, durableSpawn } from "./combinators.ts";

// Durable iteration
export { durableEach } from "./each.ts";
export type { DurableSource } from "./each.ts";

// Ephemeral — explicit escape hatch for non-durable Operations in Workflows
export { ephemeral } from "./ephemeral.ts";

// Entry point
export { durableRun } from "./run.ts";
export type { DurableRunOptions } from "./run.ts";
