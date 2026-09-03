/**
 * Which hosts open a terminal grid, and which only describe one
 * (architecture.md §Interactive terminal grids).
 *
 * The Deno source entrypoint and the compiled binary present grids when the
 * invocation has a terminal and a usable tmux. Node and Bun keep the same
 * language, catalog and validation and install no operational provider — a
 * document that asks for a grid there is refused before a pane starts, rather
 * than part-way through one.
 *
 * That is a fact about the host, so the entrypoint states it rather than this
 * module inferring it. `unsupportedTerminalGrid` is the honest half of the same
 * choice: it installs nothing, and the refusal a document meets is the one core
 * already gives when no provider is installed.
 */

import { ensure, resource, withResolvers } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { installTerminalGridProfile } from "@executablemd/core";
import { command as hostCommand } from "@executablemd/runtime";
import { installTmuxGridProvider, TMUX_PROVIDER } from "./provider.ts";
import type { TmuxProviderDependencies } from "./provider.ts";
import { paneEnvironment } from "./tmux.ts";
import { PANE_WORKER_COMMAND } from "./pane-worker.ts";

/** How a host installs whatever presents its terminal grids. */
export type TerminalGridInstaller = () => Operation<void>;

/**
 * A host that describes grids and presents none.
 *
 * Not an error, and not silence either: the installation is opened so a grid is
 * still validated, and core's own refusal is what a document meets when it asks
 * for one to be shown.
 */
export function* unsupportedTerminalGrid(): Operation<void> {
  yield* installTerminalGridProfile();
}

/** The terminal this run is drawing on, as tmux needs to know it. */
function windowSize(): { columns: number; rows: number } {
  // A terminal that cannot say gets the sizes tmux itself defaults to, which is
  // better than a grid that refuses to lay out at all.
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

/**
 * Settle when this process's terminal goes away.
 *
 * SIGHUP is the terminal saying it is gone. What follows is the ordinary
 * structured cancellation a reader's close would cause — the grid comes down
 * the same way, through the same teardown, rather than through a second path
 * that would have to be kept honest separately.
 *
 * Registered as a resource so the handler is removed with the run: a listener
 * that outlived its grid would answer for a terminal the next one is using.
 */
export function useHangup(): Operation<Operation<void>> {
  return resource<Operation<void>>(function* (provide) {
    const hung = withResolvers<void>();
    const onHangup = (): void => hung.resolve();
    process.on("SIGHUP", onHangup);
    yield* ensure(() => {
      process.off("SIGHUP", onHangup);
    });
    yield* provide(hung.operation);
  });
}

/**
 * Install the tmux provider for a foreground host.
 *
 * `workerCommand` is how this host re-invokes itself for one pane. Reusing the
 * executable is what makes a pane work in the compiled distribution, where
 * there is no script to run.
 */
export function foregroundTerminalGrid(
  overrides: Partial<TmuxProviderDependencies> = {},
): TerminalGridInstaller {
  return function* (): Operation<void> {
    const hangup = yield* useHangup();
    yield* installTmuxGridProvider({
      isTerminal: () => process.stdout.isTTY === true,
      env: paneEnvironment(process.env),
      workerCommand: (ordinal, directory) =>
        hostCommand([PANE_WORKER_COMMAND, String(ordinal), directory]),
      size: windowSize,
      hangup: () => hangup,
      ...overrides,
    });
    yield* installTerminalGridProfile({ provider: TMUX_PROVIDER, label: TMUX_PROVIDER });
  };
}
