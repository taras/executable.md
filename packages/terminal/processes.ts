/**
 * What a terminal provider must be able to establish about a process.
 *
 * Reusable by any host: a provider that needs to prove a child stopped, or that
 * nothing still holds a cell's terminal, asks here rather than reaching for a
 * platform primitive of its own.
 */

export {
  PROCESS_OBSERVATION_API,
  ProcessObservation,
  deliverSignal,
  processReachable,
} from "./src/processes.ts";
export type { ProcessObserver, SignalDelivery, TerminalSignal } from "./src/processes.ts";

export {
  PROCESS_OBSERVATION_UNAVAILABLE,
  ProcessObservationUnavailableError,
} from "./src/errors.ts";
