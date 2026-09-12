/**
 * The executable-Markdown integration for terminal grids.
 *
 * A separate entrypoint from the package root because it depends on the engine
 * and the root does not: a host arranging grids as data loads no executable
 * Markdown, and canonical core imports neither.
 */

export {
  NoTerminalProviderError,
  noTerminalProviderMessage,
  TERMINAL_GRID,
  TERMINAL_PANE,
  TERMINAL_XMD_ORIGIN,
  terminalGridInstallation,
} from "./src/xmd.ts";
