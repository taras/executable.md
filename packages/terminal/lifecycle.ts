/**
 * Running one grid, and the integration seam the host expands content through.
 *
 * Everything here is the lifecycle's own: opening an installation so a
 * presentation can be admitted, the resource that runs a whole grid beneath the
 * expansion that submitted it, and the cell-output sink core appends rendered
 * Markdown through while it interprets a paired cell.
 *
 * The sink is deliberately not a member of either UI or the provider's view. It
 * carries no store, dispatch, identity, title, status or host authority, and
 * outside an issued cell scope it is inert.
 */

export { terminalGrid } from "./src/grid.ts";
export {
  cellBusyMessage,
  cellClosedMessage,
  cellNeverStartedMessage,
  noProviderMessage,
  outsideExecutionMessage,
} from "./src/grid.ts";

export { appendTerminalCellOutput } from "./src/output.ts";

export { terminalInstallation, useTerminalInstallation } from "./src/presentation.ts";
export type { TerminalInstallation } from "./src/presentation.ts";

export { TerminalGridPresentationError } from "./src/errors.ts";
export type { PresentTerminalGrid } from "./src/host.ts";
