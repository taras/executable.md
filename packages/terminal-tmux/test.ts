/**
 * The low-level seams this adapter's own evidence drives
 * (architecture.md §Package ownership).
 *
 * Not a second provider API. These are the pieces a row needs to hold one
 * layer to its contract — a channel without a server, a worker without tmux, a
 * layout string without a window — and production code imports none of them.
 */

export { useAttachClient } from "./src/attach-client.ts";
export type { AttachClient } from "./src/attach-client.ts";
export { layoutString, placementProblems, rowMajorCells, swapsInto } from "./src/layout.ts";
export type { LayoutCell, PaneSwap } from "./src/layout.ts";
export { usePaneChannels } from "./src/pane-channel.ts";
export type { PaneChannels, PaneLink } from "./src/pane-channel.ts";
export { sweepHolders, usePaneChild } from "./src/pane-child.ts";
export type {
  PaneChild,
  PaneChildOutcome,
  PaneChildRequest,
  PaneStartFailure,
} from "./src/pane-child.ts";
export {
  paneSocketPath,
  paneTokenPath,
  parseFromWorker,
  parseToWorker,
  readFrames,
  writeFrame,
} from "./src/pane-protocol.ts";
export type { FromWorker, Hello, Settlement, ToWorker } from "./src/pane-protocol.ts";
export {
  foregroundSignalListeners,
  requireQuiescent,
  runPaneWorker,
  useForegroundSignals,
} from "./src/pane-worker.ts";
export type { PaneWorkerDependencies } from "./src/pane-worker.ts";
export { createGridTeardown, runInPane } from "./src/provider.ts";
export type { GridParts } from "./src/provider.ts";
export { classify, useTmuxGrid } from "./src/tmux-grid.ts";
export type {
  ControlEvent,
  ServerStopped,
  TmuxGrid,
  TmuxGridRequest,
  TmuxPane,
  VisibleClient,
} from "./src/tmux-grid.ts";
export { probeTmux, tmuxAt, TmuxCommandFailed } from "./src/tmux.ts";
export type { Tmux } from "./src/tmux.ts";
