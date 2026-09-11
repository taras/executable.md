/**
 * What a terminal provider must be able to establish about a process.
 *
 * A cancelled launch may not leave a child holding a terminal, and a cell may
 * not admit its next activity while the previous one still owns the screen.
 * Both are claims about processes, and neither can be made from a PID, an
 * elapsed timeout, or a signal that was merely sent. This is the neutral
 * vocabulary for making them; `@executablemd/terminal/posix` is one host's
 * answer.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

import { ProcessObservationUnavailableError } from "./errors.ts";

/**
 * What one signal delivery established about the process it was aimed at.
 *
 * `absent` is the outcome the caller was asking for: gone between the decision
 * and the delivery is still gone. `refused` is a delivery that did not happen,
 * and is evidence of nothing.
 */
export type SignalDelivery = "delivered" | "absent" | "refused";

/** The signals a terminal provider has cause to send. */
export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface ProcessObserver {
  /**
   * Whether the process still exists.
   *
   * Reachability, not an exit event: an event is a report, and a report is not
   * the fact a teardown proof needs.
   */
  reachable(pid: number): Operation<boolean>;
  /** Send one signal, and say what that established. */
  deliver(pid: number, signal: TerminalSignal): Operation<SignalDelivery>;
}

/** The stable name every loaded copy composes through. */
export const PROCESS_OBSERVATION_API = "terminal.processObservation";

/**
 * The public observation surface. Its own default always refuses.
 *
 * A host that cannot observe processes must say so rather than answer "gone"
 * for a child it never looked at.
 */
export const ProcessObservation: Api<ProcessObserver> = createApi<ProcessObserver>(
  PROCESS_OBSERVATION_API,
  {
    // deno-lint-ignore require-yield
    *reachable(_pid: number): Operation<boolean> {
      throw new ProcessObservationUnavailableError();
    },
    // deno-lint-ignore require-yield
    *deliver(_pid: number, _signal: TerminalSignal): Operation<SignalDelivery> {
      throw new ProcessObservationUnavailableError();
    },
  },
);

/** Whether the process still exists. */
export function processReachable(pid: number): Operation<boolean> {
  return ProcessObservation.operations.reachable(pid);
}

/** Send one signal, and report what it established. */
export function deliverSignal(pid: number, signal: TerminalSignal): Operation<SignalDelivery> {
  return ProcessObservation.operations.deliver(pid, signal);
}
