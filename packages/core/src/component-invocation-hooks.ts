import type { Operation, Result } from "effection";
import type { Json } from "./types.ts";

/** Describe one selected call without granting invocation or effect permission. */
export interface ComponentInvocationObservation {
  readonly component: string;
  /** Detached, deeply frozen validated ordinary props, including defaults. */
  readonly props: Readonly<Record<string, Json>>;
}

/** Observe this installation's selected identity component calls. */
export interface ComponentInvocationHooks {
  /** Returning normally proceeds; throwing prevents the unstarted body. */
  before?(observation: ComponentInvocationObservation): Operation<void>;
  /**
   * Observe the selected outcome after owned cleanup and return acceptance.
   *
   * Core supplies the same observation and selected Result. cancelled is true
   * only for owner-selected cancellation after successful owning cleanup; it is
   * false for ordinary failure, including a thrown ComponentInvocationCancelled,
   * and selected teardown failure. Cancellation leaves the caller cancelled.
   * The selected inputs stay fixed before notification. Callback cleanup joins;
   * callback failure never replaces an existing ordinary failure or retries work.
   * Fatal precedence is unchanged. No continuation or replacement is supplied.
   * Each callback is independently optional; omission changes no execution.
   */
  after?(
    observation: ComponentInvocationObservation,
    outcome: Result<unknown>,
    cancelled: boolean,
  ): Operation<void>;
}

/** Notify an observer of cancellation without granting cancellation control. */
export class ComponentInvocationCancelled extends Error {
  override readonly name = "ComponentInvocationCancelled";
  constructor() {
    super("The component invocation was cancelled.");
  }
}
