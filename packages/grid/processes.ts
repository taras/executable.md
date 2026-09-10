/**
 * What a host may establish about processes and terminals
 * (architecture.md §Package ownership).
 *
 * The contract only. Every answer is a host's, installed through
 * `./posix` or by a suite that supplies its own, and every path fails closed:
 * a question that could not be answered is never read as "nothing is there".
 */

export {
  deliverSignal,
  descendantsOf,
  establishQuiescence,
  groupMembers,
  paneOccupants,
  processReachable,
  processTable,
  TERMINAL_PROCESSES_API,
  TERMINAL_PROCESSES_UNAVAILABLE,
  TerminalProcesses,
  TerminalProcessesUnavailableError,
  terminalHolders,
} from "./src/processes.ts";
export type {
  PaneOccupants,
  PaneQuiescence,
  ProcessFacts,
  SignalDelivery,
  TerminalProcessHandler,
  TerminalSignal,
} from "./src/processes.ts";
