/**
 * The tmux presentation provider for terminal grids
 * (architecture.md §Package ownership).
 *
 * The first implementation of the provider-neutral domain in
 * `@executablemd/terminal`, and the only place tmux appears. A host that can
 * divide its terminal installs this; one that cannot installs nothing and the
 * document meets core's own refusal rather than a provider that half-works.
 *
 * The surface is deliberately narrow: a name, what a host must supply, the
 * factory and its installer, the hidden verb one pane's worker is re-invoked
 * under, and the refusals a reader can actually meet. Every tmux command, the
 * private protocol, the channel handles, the layout mechanics and the teardown
 * controls stay inside — a second provider API is not what this is. The seams
 * this adapter's own tests drive live in `./test`.
 */

export { installTmuxGridProvider, TMUX_PROVIDER, tmuxGridProvider } from "./src/provider.ts";
export type { TmuxProviderDependencies } from "./src/provider.ts";

export {
  PANE_WORKER_COMMAND,
  PaneNotQuiescent,
  paneWorkerInvocation,
  runPaneWorkerProcess,
} from "./src/pane-worker.ts";

export { TerminalTeardownFailed, TMUX_UNAVAILABLE, TmuxUnavailableError } from "./src/tmux.ts";
