/**
 * Provider-neutral terminal grids.
 *
 * This entrypoint is the arrangement and nothing else: it describes a grid as
 * data and loads no executable-Markdown integration. A host that wants the
 * authored syntax imports this package's integration subpath instead, which is
 * a separate module with its own dependency on the engine.
 */

export { terminalGridLayout } from "./src/layout.ts";
export type {
  PlacedPane,
  TerminalGridCell,
  TerminalGridLayout,
  TerminalPaneForm,
} from "./src/layout.ts";
