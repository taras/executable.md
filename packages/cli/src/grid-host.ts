/**
 * Which hosts open a grid, and which only describe one
 * (architecture.md §Package ownership).
 *
 * Host composition, not a terminal implementation — which is why it sits here
 * rather than under a `terminal/` path. The domain is
 * `@executablemd/grid`'s and the provider is `@executablemd/grid-tmux`'s;
 * what this module does is decide, per entrypoint, whether to install them.
 *
 * The Deno source entrypoint and the compiled binary present grids when the
 * invocation has a terminal and a usable tmux. Node and Bun keep the same
 * language, catalog and validation and install no operational provider — a
 * document that asks for a grid there is refused before a pane starts, rather
 * than part-way through one.
 *
 * That is a fact about the host, so the entrypoint states it rather than this
 * module inferring it. `unsupportedGrid` is the honest half of the same
 * choice: it installs nothing, and the refusal a document meets is the one core
 * already gives when no provider is installed.
 */

import { ensure, race, resource, withResolvers } from "effection";
import type { Operation } from "effection";
import process from "node:process";
import { Execution, installGridProfile } from "@executablemd/core";
import { command as hostCommand } from "@executablemd/runtime";
import { installDenoTerminalProcesses } from "@executablemd/grid/posix";
import {
  installTmuxGridProvider,
  PANE_WORKER_COMMAND,
  TMUX_PROVIDER,
} from "@executablemd/grid-tmux";
import type { TmuxProviderDependencies } from "@executablemd/grid-tmux";

/** How a host installs whatever presents its grids. */
export type GridInstaller = () => Operation<void>;

/**
 * A host that describes grids and presents none.
 *
 * Not an error, and not silence either: the installation is opened so a grid is
 * still validated, and core's own refusal is what a document meets when it asks
 * for one to be shown.
 */
export function* unsupportedGrid(): Operation<void> {
  yield* installGridProfile();
}

/**
 * Make the host's terminal going away cancel the document.
 *
 * Not a reader close. A reader who detaches has finished with a grid, and the
 * grid settles with a reader-close outcome and the document carries on. A
 * terminal that is *gone* is not a decision about this grid — it is the run
 * losing the thing every part of it was drawing on, so the document is
 * cancelled through the ordinary structured path: the grid's whole teardown
 * runs, and no following sibling gets to go.
 */
export function useHangupCancellation(hangup: Operation<void>): Operation<void> {
  return Execution.around({
    *document([request], next) {
      // The result is returned, not swallowed: canonical execution is what
      // produces a document result, and a handler that answered with nothing
      // would be refused for having returned before one existed.
      return yield* underHangup(hangup, () => next(request));
    },
  });
}

/**
 * Run `body`, and cancel it if the terminal goes away first.
 *
 * The losing side of the race is cancelled, which is the whole point: the grid
 * comes down through the same teardown a reader close uses, and the run stops
 * rather than continuing on a terminal it no longer has.
 */
export function underHangup<T>(hangup: Operation<void>, body: () => Operation<T>): Operation<T> {
  return (function* (): Operation<T> {
    const outcome = yield* race([
      (function* (): Operation<{ done: true; value: T }> {
        return { done: true, value: yield* body() };
      })(),
      (function* (): Operation<{ done: false }> {
        yield* hangup;
        return { done: false };
      })(),
    ]);
    if (!outcome.done) {
      throw new TerminalLost();
    }
    return outcome.value;
  })();
}

/** The host's terminal went away while the document was still running. */
export class TerminalLost extends Error {
  override name = "TerminalLost";
  constructor() {
    super(
      "this run's terminal went away, so the document was stopped. Anything it " +
        "had shown is gone with the terminal; nothing after the point it stopped ran.",
    );
  }
}

/**
 * The environment every process in the topology receives.
 *
 * Named rather than inherited wholesale: a pane's child gets what a terminal
 * program needs and nothing this process happens to be carrying.
 *
 * It is a host decision, so it is made here rather than by the provider. The
 * adapter is handed an environment and passes exactly that along; which of
 * *this* invocation's variables are worth passing is a question only the
 * entrypoint composing the host can answer.
 */
function paneEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "USER",
    "LOGNAME",
    // What a terminal program reads to decide it may use 24-bit colour.
    // Passed through when this host has it, absent when it does not: naming a
    // capability the reader's terminal lacks is worse than leaving a program
    // on the 256 colours `TERM` already promises. It is named here because a
    // pane's direct child reads none of the reader's shell startup — a
    // variable their `.zshrc` exports reaches an interactive shell in a pane
    // and nothing else, which is exactly the difference this closes.
    "COLORTERM",
  ]) {
    const value = source[name];
    if (value !== undefined && value !== "") {
      env[name] = value;
    }
  }
  env.TERM = source.TERM ?? "xterm-256color";
  return env;
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
    // Removed with the run that installed it. A listener that outlived its
    // grid would answer for a terminal the next one is using — and the removal
    // is established before the subscription, because entering an ensure() is
    // itself a suspension.
    yield* ensure(() => {
      process.off("SIGHUP", onHangup);
    });
    process.on("SIGHUP", onHangup);
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
export function foregroundGrid(overrides: Partial<TmuxProviderDependencies> = {}): GridInstaller {
  return function* (): Operation<void> {
    const hangup = yield* useHangup();
    // The observer goes in beside the provider, in the same scope: a host that
    // presents grids is exactly the host that has to prove a pane is free, and
    // one that installs neither refuses rather than guessing at either.
    yield* installDenoTerminalProcesses();
    yield* installTmuxGridProvider({
      isTerminal: () => process.stdout.isTTY === true,
      env: paneEnvironment(process.env),
      workerCommand: (ordinal, directory) =>
        hostCommand([PANE_WORKER_COMMAND, String(ordinal), directory]),
      size: windowSize,
      ...overrides,
    });
    yield* installGridProfile({ provider: TMUX_PROVIDER, label: TMUX_PROVIDER });
    yield* useHangupCancellation(hangup);
  };
}
