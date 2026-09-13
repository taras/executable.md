/**
 * Provider-neutral interactive terminal grids.
 *
 * A document can replace its one foreground terminal with a grid of terminals
 * that stay interactive at the same time. What presents that grid — a tmux
 * integration, another multiplexer, a host-native UI, or a controlled surface
 * that opens no terminal at all — is a provider, and nothing in this package
 * knows which one is installed.
 *
 * This root owns the contracts everybody shares: the native launch seam, the
 * resolved layout and the request derived from it, the immutable live state, the
 * domain actions, the provider's read-only view and host, routing and
 * installation, the journal boundary, and the errors any of them refuse with.
 *
 * The grid lifecycle itself is `@executablemd/terminal/lifecycle`; process
 * facts are `./processes`; the POSIX host is `./posix`; and `./test` holds the
 * controlled surfaces. A value exported from more than one of them is the same
 * value.
 */

export {
  NATIVE_LAUNCHER_API,
  NativeLauncher,
  flushOutput,
  nativeLaunch,
  reserveTerminal,
} from "./src/launch.ts";
export type {
  NativeLaunchOutcome,
  NativeLaunchRequest,
  NativeLauncherHandler,
} from "./src/launch.ts";

export {
  NATIVE_LAUNCHER_UNAVAILABLE,
  NO_TERMINAL,
  NativeLauncherUnavailableError,
  PROCESS_OBSERVATION_UNAVAILABLE,
  ProcessObservationUnavailableError,
  TERMINAL_PROVIDER_UNAVAILABLE,
  TerminalGridError,
  TerminalGridPresentationError,
  TerminalProviderInstallError,
  TerminalProviderUnavailableError,
} from "./src/errors.ts";

export { terminalGridLayout, terminalGridRequest } from "./src/layout.ts";
export type {
  PlacedCell,
  TerminalCellForm,
  TerminalCellRequest,
  TerminalGridCell,
  TerminalGridLayout,
  TerminalGridRequest,
} from "./src/layout.ts";

export type {
  TerminalCellId,
  TerminalCellState,
  TerminalCellStatus,
  TerminalGridPhase,
  TerminalGridRevision,
  TerminalGridState,
} from "./src/state.ts";

export type {
  PresentTerminalGrid,
  TerminalActivity,
  TerminalGridHost,
  TerminalGridProvider,
  TerminalGridView,
  TerminalShellOutcome,
} from "./src/host.ts";

export { useTerminalCellUI } from "./src/ui.ts";
export type { TerminalCellUI, TerminalGridUI } from "./src/ui.ts";

export {
  TERMINAL_GRIDS_API,
  TERMINAL_PROVIDERS_API,
  TerminalGrids,
  TerminalProviders,
  installTerminalProvider,
  registerTerminalProvider,
} from "./src/routing.ts";
export type {
  TerminalGridApi,
  TerminalProviderApi,
  TerminalProviderCall,
  TerminalProviderFactory,
  TerminalProviderInstallRequest,
  TerminalProviderOptions,
} from "./src/routing.ts";

export { retainedGridLayout } from "./src/journal.ts";
export type {
  RetainedCell,
  RetainedCellOutcome,
  RetainedGrid,
  RetainedGridLayout,
  TerminalCellWork,
  TerminalGridCloseKind,
  TerminalGridJournal,
} from "./src/journal.ts";
