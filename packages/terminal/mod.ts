/**
 * The provider-neutral terminal domain (architecture.md §Package ownership).
 *
 * Everything here is what a document means by a terminal, independent of what
 * presents one: a native launch that wants the foreground, a grid of panes and
 * the states they pass through, the routing that finds whichever provider a
 * host installed, and the errors a caller meets when none did. No multiplexer,
 * socket, process topology or window identifier appears in this package.
 *
 * The lifecycle a provider is driven through lives in `./lifecycle`, process
 * observation in `./processes`, the POSIX adapters in `./posix`, and the
 * controlled fixtures that prove the contract in `./test` — facets of one
 * package rather than separate definitions, so a symbol exported by two of them
 * is the same object.
 *
 * Those are boundaries in the module graph, not just in the export lists. This
 * root, `./lifecycle` and `./processes` reach contracts and operations only:
 * nothing they load spawns a process, reads `process.stdout`, or is a test
 * fixture. Anything that performs a launch lives behind `./posix`, and anything
 * that pretends to behind `./test`, so importing the domain to describe a grid
 * pulls in nothing that could present or fake one.
 */

export {
  flushOutput,
  NATIVE_LAUNCHER_UNAVAILABLE,
  NativeLauncher,
  NativeLauncherUnavailableError,
  nativeLaunch,
  NO_TERMINAL,
  reserveTerminal,
} from "./src/native-launcher.ts";
export type {
  NativeLauncherHandler,
  NativeLaunchOutcome,
  NativeLaunchRequest,
} from "./src/native-launcher.ts";

export {
  TERMINAL_GRIDS_API,
  TERMINAL_PROVIDER_UNAVAILABLE,
  TerminalGrids,
  TerminalProviderUnavailableError,
} from "./src/composite.ts";
export type {
  TerminalComposite,
  TerminalGridApi,
  TerminalGridRequest,
  TerminalPaneRequest,
  TerminalPaneState,
  TerminalShellOutcome,
} from "./src/composite.ts";

export {
  registerTerminalProvider,
  TERMINAL_PROVIDERS_API,
  TerminalProviderInstallError,
  TerminalProviders,
} from "./src/provider-api.ts";
export type {
  TerminalProviderApi,
  TerminalProviderCall,
  TerminalProviderFactory,
  TerminalProviderInstallRequest,
  TerminalProviderOptions,
} from "./src/provider-api.ts";

export { paneTerminal, usePaneTerminal } from "./src/pane.ts";
export type { PaneTerminal } from "./src/pane.ts";
export { usePaneNativeLauncher } from "./src/pane-launcher.ts";
export type { RunInPane } from "./src/pane-launcher.ts";
