/**
 * The tmux terminal-grid provider, and what a host must be to install it
 * (architecture.md §Interactive terminal grids).
 *
 * This is the one place the provider-neutral request from #730 meets tmux. The
 * request names columns, rows and the authored panes; what comes back is a
 * composite core drives through its own lifecycle. Nothing tmux-shaped crosses
 * in either direction: no socket, session, window, pane, client or server
 * identifier appears in a request, a result, a retained record or a diagnostic.
 *
 * A host installs this only when it can actually present a grid. `xmd run` on a
 * terminal with a usable tmux does; `xmd test`, a piped run, a host without
 * tmux, and the Node and Bun runtimes do not — they keep the language and the
 * validation and install no operational provider, so a document that asks for a
 * grid is refused before a pane starts rather than part-way through one.
 *
 * The hangup is here because it ends the same way. A terminal that goes away
 * takes the grid with it, and the way it does that is the ordinary structured
 * cancellation every other stop uses — not a second teardown path that would
 * have to be kept honest separately.
 */

import { ensure, resource, withResolvers } from "effection";
import process from "node:process";
import type { Operation } from "effection";
import { TerminalGrids } from "@executablemd/runtime";
import type {
  NativeLaunchOutcome,
  NativeLaunchRequest,
  TerminalComposite,
  TerminalGridRequest,
  TerminalPaneState,
  TerminalShellOutcome,
} from "@executablemd/runtime";
import { registerTerminalProvider } from "@executablemd/core";
import type { TerminalProviderFactory } from "@executablemd/core";
import { usePaneChannels } from "./pane-channel.ts";
import { requireQuiescent } from "./pane-worker.ts";
import type { PaneLink } from "./pane-channel.ts";
import { useTmuxGrid } from "./tmux-grid.ts";
import type { TmuxGrid, VisibleClient } from "./tmux-grid.ts";
import { probeTmux, TerminalTeardownFailed, tmuxAt, TmuxUnavailableError } from "./tmux.ts";
import type { Tmux } from "./tmux.ts";

/** The name a host installs this provider under. */
export const TMUX_PROVIDER = "tmux";

export interface TmuxProviderDependencies {
  /** Whether this invocation has a terminal to divide. */
  isTerminal(): boolean;
  /** What every process in the topology receives. */
  readonly env: Record<string, string>;
  /**
   * The command that runs one pane's worker: this executable, hidden mode.
   *
   * An operation because a host resolves its own invocation contextually, and
   * every pane's is resolved before the server exists.
   */
  workerCommand(ordinal: number, directory: string): Operation<readonly string[]>;
  /** The window to lay panes out in. */
  size(): { columns: number; rows: number };
  /** How a private server is reached. Substituted only by this package's tests. */
  createTmux?: (socket: string, env: Record<string, string>) => Tmux;
  /** What asking tmux its version does. Substituted only by this package. */
  askVersion?: () => Operation<{ code: number; stdout: string }>;
}

/**
 * Build the provider factory a host registers.
 *
 * The factory receives the terminal authority directly and presents the exact
 * request it was routed — a handler that answered without presenting would have
 * presented nothing, which is what #730's handshake is for.
 */
export function tmuxGridProvider(deps: TmuxProviderDependencies): TerminalProviderFactory {
  return function* (_options, authority): Operation<void> {
    yield* TerminalGrids.around(
      {
        *open([request]): Operation<unknown> {
          const composite = yield* usePresentedGrid(deps, request);
          yield* authority.present(request, composite);
          return undefined;
        },
      },
      { at: "min" },
    );
  };
}

/**
 * Everything one grid needs, prepared while it is still hidden.
 *
 * Ownership, innermost last — which is also the order it comes down in:
 *
 *   grid scope
 *   ├─ private directory, sockets and tokens (removed last, after they close)
 *   ├─ the tmux server and its panes (`kill-server`, proved)
 *   └─ the admitted worker links
 */
function usePresentedGrid(
  deps: TmuxProviderDependencies,
  request: TerminalGridRequest,
): Operation<TerminalComposite> {
  return resource<TerminalComposite>(function* (provide) {
    const probed = yield* probeTmux({
      isTerminal: deps.isTerminal,
      env: deps.env,
      ...(deps.askVersion === undefined ? {} : { askVersion: deps.askVersion }),
    });
    if (!probed.ok) {
      // Before a directory, a socket, a token, a server or a pane exists, so a
      // host that cannot present a grid leaves nothing behind for having tried.
      throw probed.error;
    }

    const channels = yield* usePaneChannels(request.panes.length);
    // Resolved before a server exists, so a host that cannot say how to run its
    // own worker fails while there is still nothing to take down.
    const workers: string[][] = [];
    for (let ordinal = 0; ordinal < request.panes.length; ordinal++) {
      workers.push([...(yield* deps.workerCommand(ordinal, channels.directory))]);
    }
    const build = deps.createTmux ?? tmuxAt;
    const window = deps.size();
    const grid = yield* useTmuxGrid(build(`${channels.directory}/s`, deps.env), {
      session: "xmd",
      columns: request.columns,
      panes: request.panes.length,
      width: window.columns,
      height: window.rows,
      titles: request.panes.map((pane) => pane.title),
      workerCommand: (ordinal) => workers[ordinal] ?? [],
      cwd: process.cwd(),
      env: deps.env,
    });

    const links: PaneLink[] = [];
    for (let ordinal = 0; ordinal < request.panes.length; ordinal++) {
      links.push(yield* channels.link(ordinal));
    }

    let shown = 0;
    let visible: VisibleClient | undefined;
    /** The one teardown in flight, so repeat callers observe it rather than skip it. */
    let tearing: ReturnType<typeof withResolvers<void>> | undefined;
    let complete = false;

    /**
     * The one teardown, in the one order, however this grid ends.
     *
     * Core calls it through `destroy()`; the finalizer calls it when core never
     * got that far, which is what a preparation that failed halfway leaves. A
     * second caller waits on the first rather than skipping past unfinished
     * work, and a teardown that *failed* is retried rather than remembered as
     * done — marking it complete before it succeeded would let the run continue
     * past a pane it never established was free.
     *
     * The order is the contract, and every step is a proof rather than a
     * request:
     *
     *   detach the reader's client and establish it stopped
     *     → ask every acquired worker to shut down
     *     → require its settlement, its holder-free goodbye, and its channel
     *       closing, in that order
     *     → close every private channel
     *     → stop the server and establish it is gone
     *
     * Every acquired resource is attempted even after an earlier one failed, so
     * one bad worker does not strand the server, the channels or the paths. The
     * first failure is what surfaces.
     */
    function* tearDown(): Operation<void> {
      if (complete) {
        return;
      }
      if (tearing) {
        return yield* tearing.operation;
      }
      tearing = withResolvers<void>();
      let failure: Error | undefined;
      const failed = (error: unknown): void => {
        failure = failure ?? (error instanceof Error ? error : new Error(String(error)));
      };

      // The reader's client first, and asked rather than told: a client that
      // detaches restores the terminal, and one that is killed cannot.
      if (visible !== undefined) {
        const client = visible;
        visible = undefined;
        try {
          yield* grid.detach(client);
        } catch (error) {
          failed(error);
        }
      }

      for (const link of links) {
        try {
          yield* quiesceWorker(link);
        } catch (error) {
          failed(error);
        }
      }

      // Channels before the server: a socket still open onto a pane of a server
      // that has gone is a handle onto nothing.
      try {
        yield* channels.close();
      } catch (error) {
        failed(error);
      }

      try {
        yield* grid.stop();
      } catch (error) {
        failed(error);
      }

      if (failure !== undefined) {
        // Retryable: `tearing` is cleared, so a later caller runs it again
        // rather than being told a teardown that failed had finished.
        tearing.reject(failure);
        tearing = undefined;
        throw failure;
      }
      complete = true;
      tearing.resolve();
    }

    yield* ensure(function* () {
      yield* tearDown();
    });

    yield* provide({
      *attach() {
        visible = yield* grid.attach();
      },
      *update(ordinal, state) {
        // Sanitized status only, and display only: core has already decided
        // what this is, and drawing it is not a chance to change it.
        yield* label(grid, ordinal, request, state);
      },
      *display(ordinal, text) {
        const link = links[ordinal];
        if (link === undefined) {
          return;
        }
        yield* link.send({ type: "display", seq: ++shown, text });
      },
      *shell(ordinal, spawned) {
        // The host's default shell, derived from live policy — never from the
        // document, and never from a request.
        return yield* runInPane(
          links[ordinal],
          { command: [deps.env.SHELL ?? "/bin/sh"], cwd: process.cwd(), env: deps.env },
          spawned,
        );
      },
      *launch(ordinal, request, spawned) {
        // The exact command vector, working directory and environment the Agent
        // provider supplied, over this pane's authenticated channel. tmux's
        // parser sees none of it.
        return yield* runInPane(links[ordinal], request, spawned);
      },
      *closed() {
        // The reader leaving, and nothing else. A host hangup is not a reader
        // close — it is the terminal going away, which cancels the grid through
        // the ordinary structured path rather than selecting a close outcome.
        yield* grid.detached();
      },
      *destroy() {
        yield* tearDown();
      },
    });
  });
}

/** The pane's title, with the state core settled on appended. */
function* label(
  grid: TmuxGrid,
  ordinal: number,
  request: TerminalGridRequest,
  state: TerminalPaneState,
): Operation<void> {
  const pane = request.panes[ordinal];
  if (pane === undefined) {
    return;
  }
  yield* grid.title(ordinal, `${pane.title} — ${state}`);
}

/**
 * Ask one worker to stop, and require what it must say before it has.
 *
 * Settlement, then a goodbye that names no surviving holder, then the channel
 * closing — in that order. A worker that was never there, that has already gone,
 * or that stops part-way through is a teardown failure: none of those is a pane
 * proved free.
 */
function* quiesceWorker(link: PaneLink): Operation<void> {
  if (!link.connected()) {
    throw new TerminalTeardownFailed(
      "a terminal pane's worker was gone before it was asked to stop",
    );
  }
  yield* link.send({ type: "shutdown" });
  let quiesced = false;
  let farewelled = false;
  while (true) {
    const frame = yield* link.next();
    if (frame === undefined) {
      if (!quiesced || !farewelled) {
        throw new TerminalTeardownFailed(
          "a terminal pane stopped answering before it was proved free",
        );
      }
      return;
    }
    if (frame.type === "quiet") {
      requireQuiescent(frame.settlement);
      quiesced = true;
      continue;
    }
    if (frame.type === "bye") {
      if (!quiesced) {
        throw new TerminalTeardownFailed("a terminal pane said goodbye before it was proved free");
      }
      if (frame.holders.some((holder) => !holder.gone)) {
        throw new TerminalTeardownFailed("something still holds a terminal pane");
      }
      farewelled = true;
      continue;
    }
  }
}

/**
 * Run one request in one pane, through that pane's authenticated worker.
 *
 * The same path for both callers, because they are the same act: a shell whose
 * executable came from host policy and a native UI whose argv came from the
 * Agent provider are both "start this, on that pane's terminal". What differs
 * is who decided the vector, and that is decided before this is called.
 */
export function* runInPane(
  link: PaneLink | undefined,
  request: NativeLaunchRequest,
  spawned: () => void,
): Operation<NativeLaunchOutcome> {
  if (link === undefined) {
    // No fallback. A composite that cannot run this in the pane it was asked
    // for refuses, rather than putting a native UI on the root terminal.
    throw new Error("this terminal grid cannot run that pane's launch");
  }
  const id = `launch-${link.ordinal}-${++started}`;
  let settled = false;
  // Registered before the launch is asked for: a cancellation between asking
  // and hearing back must still end the child. Cancelling is not "stop waiting"
  // — it is "ask the pane to stop, and do not come back until it has", because
  // this operation returning is what lets the grid above it come down.
  yield* ensure(function* () {
    if (settled || !link.connected()) {
      return;
    }
    yield* link.send({ type: "cancel", id });
    while (true) {
      const frame = yield* link.next();
      if (frame === undefined) {
        throw new Error("the terminal pane stopped answering before its child was settled");
      }
      if (frame.type === "quiet") {
        requireQuiescent(frame.settlement);
        return;
      }
      if (frame.type === "exited") {
        requireQuiescent(frame.settlement);
        return;
      }
    }
  });
  yield* link.send({
    type: "launch",
    id,
    argv: [...request.command],
    cwd: request.cwd,
    env: request.env ?? {},
  });
  while (true) {
    const frame = yield* link.next();
    if (frame === undefined) {
      // The worker's channel ended mid-launch. Nothing about that says the
      // child stopped, so it is a failure rather than an empty outcome.
      throw new Error("the terminal pane stopped answering before its launch settled");
    }
    if (frame.type === "started") {
      // The worker-observed runtime spawn event, and the only thing that makes
      // this pane ready.
      spawned();
      continue;
    }
    if (frame.type === "busy") {
      settled = true;
      throw new Error("that terminal pane already has a live child");
    }
    if (frame.type === "start-failed") {
      settled = true;
      throw new Error("the terminal pane's child could not be started");
    }
    if (frame.type === "exited") {
      // The worker sends this only once its settlement proved the pane free.
      settled = true;
      const outcome: NativeLaunchOutcome = {};
      if (frame.exitCode !== undefined) {
        outcome.exitCode = frame.exitCode;
      }
      if (frame.signal !== undefined) {
        outcome.signal = frame.signal;
      }
      return outcome;
    }
  }
}

/** Distinguishes one pane's launches from the next in this invocation. */
let started = 0;

/** Install the tmux provider for this host, when this host can present one. */
export function* installTmuxGridProvider(deps: TmuxProviderDependencies): Operation<void> {
  yield* registerTerminalProvider(TMUX_PROVIDER, tmuxGridProvider(deps));
}

export { TmuxUnavailableError };
