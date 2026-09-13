/**
 * Controlled providers, launchers, gates and records.
 *
 * Nothing here presents anything, opens a terminal, looks for a multiplexer,
 * or starts a process. It exists so that the grammar, authority, lifecycle,
 * convergence, settlement and replay contracts can be proved without a
 * production provider anywhere in the picture.
 */

export { installControlledLauncher } from "./launcher.ts";
export type { ControlledLauncherOptions } from "./launcher.ts";

export {
  controlledTerminalProvider,
  rendererEndedMessage,
  settled,
  subscriptionEndedMessage,
  terminalProviderLog,
} from "./provider.ts";
export type {
  ControlledProviderOptions,
  TerminalProviderLog,
  TerminalProviderResources,
} from "./provider.ts";

export { barrier, gate } from "./signal.ts";
export type { Barrier, Gate } from "./signal.ts";
