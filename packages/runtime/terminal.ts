/**
 * The terminal provider — how a host presents one grid of interactive panes.
 *
 * This is not the native launcher. A launch hands **one** child the whole
 * foreground terminal and waits for it; a grid divides that terminal into
 * several panes that stay interactive at the same time, each with its own
 * lifetime. tmux is one way to do that, a host-native composite UI is another,
 * and a test surface that opens no terminal at all is a third. None of them
 * appears in the document: `<Terminal.Grid>` asks for panes and their authored
 * layout, and the host chooses what presents them.
 *
 * A grid is prepared before it is shown, which is what makes opening one atomic:
 *
 * 1. `prepare()` builds the whole composite while it is still hidden — every
 *    pane endpoint and its supervision — and presents nothing. A host that
 *    cannot open a grid refuses here, before any pane has started work.
 * 2. Core starts the authored panes concurrently and waits for every one of
 *    them to be ready.
 * 3. `attach()` shows the composite, once, after that barrier. A failure before
 *    it discards the hidden composite instead of leaving a partial grid on the
 *    reader's screen.
 * 4. `destroy()` takes it down again and gives the root terminal back.
 *
 * There is no host default. `xmd run` installs the production provider; a test
 * or embedding host installs a controlled one that needs no terminal. Until one
 * is installed every operation refuses, which is what keeps writing, inspecting
 * and validating a document free of all of this.
 *
 * **Presentation never decides an outcome.** `update()` receives the pane states
 * core has already settled on, so a provider draws them and answers for none of
 * them. Nothing a handler returns can make a pane succeed, fail, or be ready.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

/** One pane the provider is asked to present, by its authored ordinal. */
export interface TerminalPaneRequest {
  /** The pane's identity: its position among the grid's panes, from zero. */
  readonly ordinal: number;
  /** The label to display. Two panes may carry the same one. */
  readonly title: string;
  /** The row it occupies, from zero. */
  readonly row: number;
  /** The column it occupies, from zero. */
  readonly column: number;
  /**
   * Whether the document supplies this pane's work or the host's default shell
   * does. A provider reads it to know which panes it must start a shell in.
   */
  readonly form: "paired" | "self-closing";
}

/**
 * The grid one expansion asks for.
 *
 * Provider-neutral throughout: it names no terminal, multiplexer, socket,
 * process, window or pane identifier, and carries no command, argv or
 * environment. It is what the author wrote, resolved.
 */
export interface TerminalGridRequest {
  readonly columns: number;
  readonly rows: number;
  readonly panes: readonly TerminalPaneRequest[];
}

/**
 * What core tells a provider about one pane, as it happens.
 *
 * A closed set, and display only. `running` follows readiness, `succeeded` and
 * `failed` follow the pane's own settlement, and `closed` is a live pane
 * cancelled solely because the reader closed the grid — which is not a failure
 * and is deliberately spelled differently from one.
 */
export type TerminalPaneState = "starting" | "running" | "succeeded" | "failed" | "closed";

/** How a pane's default shell ended. */
export interface TerminalShellOutcome {
  exitCode?: number;
  signal?: string;
}

/**
 * One prepared, still-hidden grid.
 *
 * Everything here belongs to the one `prepare()` that produced it. A composite
 * is never reused across expansions, and a provider that hands the same one
 * back twice has handed back a grid the second expansion did not ask for.
 */
export interface TerminalComposite {
  /**
   * Show the composite. Called once, and only after every pane is ready.
   *
   * A provider that has to place panes does it here rather than during
   * preparation, so the reader never sees a grid fill in.
   */
  attach(): Operation<void>;
  /**
   * Display one pane's state. Called with states core has already decided.
   *
   * Its return value is ignored on purpose: drawing a status is not a chance to
   * change one.
   */
  update(ordinal: number, state: TerminalPaneState): Operation<void>;
  /**
   * Start the host's default interactive shell in one pane and report how it
   * ended.
   *
   * Which shell that is comes from live host policy, never from the document.
   * The bytes it exchanges with the reader belong to the pane: nothing captures
   * or journals them.
   *
   * `spawned` is the pane's readiness latch, and calling it is the only thing
   * that makes this pane ready. Call it from the runtime's successful
   * child-spawn event and before waiting for the child to exit — so a shell
   * that starts and exits at once is both ready and settled, while a shell that
   * never started leaves the latch alone and the grid never attaches.
   */
  shell(ordinal: number, spawned: () => void): Operation<TerminalShellOutcome>;
  /**
   * Settle when the reader closes or leaves the composite.
   *
   * A grid stays visible after its panes have settled, so this is what tells
   * core the reader is finished with it.
   */
  closed(): Operation<void>;
  /**
   * Take the composite down and give the root terminal back.
   *
   * Called exactly once for every composite `prepare()` returned, including one
   * discarded before it ever attached.
   */
  destroy(): Operation<void>;
}

export interface TerminalProviderHandler {
  /** Build the whole hidden composite for `request`, presenting nothing. */
  prepare(request: TerminalGridRequest): Operation<TerminalComposite>;
}

export const TERMINAL_PROVIDER_UNAVAILABLE =
  "no terminal provider is installed — this host does not present a grid of " +
  "interactive panes. `xmd run` installs one; a test or embedding host installs " +
  "its own.";

export class TerminalProviderUnavailableError extends Error {
  override name = "TerminalProviderUnavailableError";
  constructor(message: string = TERMINAL_PROVIDER_UNAVAILABLE) {
    super(message);
  }
}

/**
 * The stable contextual boundary a grid request travels.
 *
 * Middleware composed here may observe, narrow, refuse, wrap or delegate a
 * request — everything composition needs. What it cannot do is authorize one:
 * the terminal authority that mints pane claims and takes terminal ownership is
 * delivered directly to the installed provider and reachable from nowhere else,
 * so a handler that answers without delegating has presented nothing.
 */
export const TerminalProvider: Api<TerminalProviderHandler> = createApi<TerminalProviderHandler>(
  "runtime.terminalProvider",
  {
    // deno-lint-ignore require-yield
    *prepare(_request: TerminalGridRequest): Operation<TerminalComposite> {
      throw new TerminalProviderUnavailableError();
    },
  },
);

/** Build the hidden composite for one grid expansion. */
export function prepareTerminalGrid(request: TerminalGridRequest): Operation<TerminalComposite> {
  return TerminalProvider.operations.prepare(request);
}

/**
 * Everything one controlled composite did, in the order it did it.
 *
 * The record is the evidence: a suite reads it to prove that preparation came
 * before every pane started, that nothing attached before the readiness
 * barrier, and that teardown destroyed exactly the composite it prepared.
 */
export interface TerminalProviderLog {
  readonly events: string[];
}

/**
 * What a controlled provider does instead of opening a terminal.
 *
 * Each hook is a place a suite makes something happen or go wrong: `onPrepare`
 * can refuse before a composite exists, `onAttach` can fail the barrier, `shell`
 * decides what a self-closing pane's shell did and how long it took, and
 * `close` is the operation the grid waits on, so a suite controls exactly when
 * the reader leaves.
 */
export interface ControlledTerminalProviderOptions {
  /** Appended to as the provider works, so ordering is read rather than timed. */
  readonly log?: TerminalProviderLog;
  onPrepare?: (request: TerminalGridRequest) => Operation<void>;
  onAttach?: () => Operation<void>;
  onDestroy?: () => Operation<void>;
  /**
   * What a pane's shell did.
   *
   * It receives the readiness latch, so a suite decides whether this shell
   * reports a spawn at all — which is how "never started" is told apart from
   * "started and exited immediately".
   */
  shell?: (ordinal: number, spawned: () => void) => Operation<TerminalShellOutcome>;
  close?: () => Operation<void>;
}

/**
 * Install a provider that presents nothing and records everything.
 *
 * It answers the whole contract — prepare, attach, update, shell, close,
 * destroy — so a suite exercises core's lifecycle without a terminal, a
 * multiplexer, or a process anywhere in it.
 */
export function* installControlledTerminalProvider(
  options: ControlledTerminalProviderOptions = {},
): Operation<void> {
  const log = options.log ?? { events: [] };
  let prepared = 0;

  yield* TerminalProvider.around(
    {
      *prepare([request]): Operation<TerminalComposite> {
        if (options.onPrepare) {
          yield* options.onPrepare(request);
        }
        const generation = prepared++;
        log.events.push(`prepare:${generation}:${request.columns}x${request.rows}`);
        let destroyed = false;
        return {
          *attach() {
            if (options.onAttach) {
              yield* options.onAttach();
            }
            log.events.push(`attach:${generation}`);
          },
          // deno-lint-ignore require-yield
          *update(ordinal, state) {
            log.events.push(`state:${generation}:${ordinal}:${state}`);
          },
          *shell(ordinal, spawned) {
            log.events.push(`shell:${generation}:${ordinal}`);
            if (options.shell) {
              return yield* options.shell(ordinal, spawned);
            }
            // The default shell starts: a suite that says nothing about a pane
            // wants a pane that works, and one that never reported a spawn
            // would hang the readiness barrier instead.
            spawned();
            return { exitCode: 0 };
          },
          *closed() {
            if (options.close) {
              yield* options.close();
            }
            log.events.push(`closed:${generation}`);
          },
          *destroy() {
            // Destroying twice would make the record say a composite was taken
            // down more times than it was built, which is exactly the ordering
            // claim a suite reads this log for.
            if (destroyed) {
              throw new Error(`controlled composite ${generation} was destroyed twice`);
            }
            destroyed = true;
            if (options.onDestroy) {
              yield* options.onDestroy();
            }
            log.events.push(`destroy:${generation}`);
          },
        };
      },
    },
    { at: "min" },
  );
}
