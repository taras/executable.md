/**
 * ReplayGuard API — pluggable validation for replay staleness detection.
 *
 * The durable execution protocol's default behavior is "logs are authoritative"
 * — the journal is unconditionally trusted during replay. ReplayGuard extends
 * this with opt-in validation: guards can examine effect descriptions and
 * result values to validate that recorded results are still valid against
 * current state before allowing replay to proceed.
 *
 * Guards access `event.description.*` for effect input fields (e.g., file
 * path, URL, encoding) and `event.result.value.*` for effect output fields
 * (e.g., content hash, status code). There is no separate metadata field —
 * inputs belong in the effect description, outputs belong in the result.
 *
 * A guard is **composable policy, not authority**. Guards compose through
 * `Api.around`, and a handler installed further out may decline to call `next`.
 * That is what composition is for, and it is why an invariant that must not be
 * negotiable — durable identity above all — belongs somewhere a caller cannot
 * replace, such as inside the `DurableStream` a consumer hands to `durableRun`.
 *
 * The API has three stages:
 *
 * 1. **check** (before replay begins): Runs in generator context inside
 *    `durableRun`, after the journal is loaded but before the workflow starts.
 *    I/O is allowed — this is where file hashing, network checks, and other
 *    observation-gathering happens. Results are cached in middleware closures.
 *
 * 2. **admit** (after every check, before terminal reuse): Runs once with the
 *    retained history as a whole. A guard that requires something of the
 *    history rather than of one event — that an event it validates is present,
 *    and present once — refuses here, because a per-event check has nothing to
 *    object to in a journal that omits the event. Default is a no-op.
 *
 * 3. **decide** (during replay): Runs synchronously inside
 *    `DurableEffect.enter()`, after identity matching succeeds but before
 *    the stored result is fed to the generator. Must be pure and side-effect-
 *    free. Reads from the cache populated during the check phase.
 *
 * Multiple guards compose via Effection's `Api.around()`. A guard that has
 * an opinion returns an outcome directly; one that doesn't calls `next(event)`
 * to delegate. The first `error` outcome wins — the chain short-circuits.
 *
 * See replay-guard-spec.md for the full design.
 */

import type { Api, Operation } from "effection";
import { createApi } from "effection/experimental";
import type { CoroutineId, Yield } from "./types.ts";

/**
 * The retained history a run is about to replay, offered once.
 *
 * A guard's per-event check can only speak about events a journal contains. A
 * journal missing something a guard requires offers it nothing to object to,
 * and the recorded terminal result is then reused on the strength of history
 * that was never validated. This is where a guard says whether the history as a
 * whole may be replayed at all.
 */
export interface RetainedHistory {
  /** The coroutine whose recorded terminal result is about to be reused. */
  readonly coroutineId: CoroutineId;
  /** Every retained Yield, each owning the one cell for what it settled to. */
  readonly yields: readonly Yield[];
  /** Whether a recorded terminal result exists for that coroutine. */
  readonly terminal: boolean;
}

/**
 * The outcome of a replay guard's decision.
 *
 * - "replay": Proceed with replay — use the stored journal result.
 * - "error": Halt replay with an error — the journal entry is stale.
 *
 * Future versions may add:
 * - "reexecute": Re-execute the effect and replace the journal entry.
 * - "fork": Create a new execution branch from this point.
 */
export type ReplayOutcome = { outcome: "replay" } | { outcome: "error"; error?: Error };

/**
 * The core shape of the ReplayGuard API.
 *
 * - `check`: Called once per Yield event, before replay begins. Runs in
 *   generator context — I/O is allowed. Use to gather current state (hash
 *   files, check timestamps) and cache results for the decide phase.
 *
 * - `decide`: Called during replay, after identity matching succeeds.
 *   Must be pure and synchronous — no I/O, no side effects. Returns the
 *   replay outcome based on cached observations.
 */
interface ReplayGuardApi {
  /** Phase 1: Check — gather observations before replay (I/O allowed). */
  check(event: Yield): Operation<void>;
  /**
   * Phase 1b: Admit — the retained history has been offered in full, and a
   * recorded terminal result has not been reused yet. A guard that requires
   * something of the history as a whole — that an event it validates is
   * present at all, and present once — refuses here by throwing.
   */
  admit(history: RetainedHistory): Operation<void>;
  /** Phase 2: Decide — return replay outcome (synchronous, pure). */
  decide(event: Yield): ReplayOutcome;
}

/**
 * Default check — no-op. Events pass through without observation.
 */
function* defaultCheck(_event: Yield): Operation<void> {
  // No observation — pass through to next middleware or default.
}

/**
 * Default admit — no-op. A history nobody objects to is replayed.
 */
function* defaultAdmit(_history: RetainedHistory): Operation<void> {
  // No requirement — pass through to next middleware or default.
}

/**
 * Default decide — always replay. This preserves "logs are authoritative"
 * as the default behavior. Guards must be explicitly installed to add
 * validation.
 */
function defaultDecide(_event: Yield): ReplayOutcome {
  return { outcome: "replay" };
}

/**
 * The ReplayGuard API.
 *
 * Default behavior is pass-through: `check` does nothing, `decide` returns
 * `{ outcome: "replay" }`. This preserves "logs are authoritative" unless
 * middleware says otherwise.
 *
 * Install guards via `yield* ReplayGuard.around({ ... })` before calling
 * `durableRun`. Guards are inherited by child scopes through Effection's
 * context inheritance.
 *
 * Example:
 * ```ts
 * function* myWorkflow(): Operation<void> {
 *   const scope = yield* useScope();
 *   yield* ReplayGuard.around({
 *     *check([event], next) {
 *       // Gather observations (I/O allowed here)
 *       return yield* next(event);
 *     },
 *     decide([event], next) {
 *       // Make decision (pure, synchronous)
 *       if (isStale(event)) {
 *         return { outcome: "error", error: new StaleInputError(...) };
 *       }
 *       return next(event);
 *     },
 *   });
 *
 *   yield* durableRun(workflow, { stream });
 * }
 * ```
 */
export const ReplayGuard: Api<ReplayGuardApi> = createApi<ReplayGuardApi>(
  "DurableEffection.ReplayGuard",
  { check: defaultCheck, admit: defaultAdmit, decide: defaultDecide },
);
