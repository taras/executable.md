/**
 * The terminal grid boundary — how a host presents one grid of interactive
 * panes, and what composing middleware around it may do.
 *
 * This is not the native launcher. A launch hands **one** child the whole
 * foreground terminal and waits for it; a grid divides that terminal into
 * several panes that stay interactive at the same time, each with its own
 * lifetime. tmux is one way to do that, a host-native composite UI is another,
 * and a test surface that opens no terminal at all is a third. None of them
 * appears in the document: `<Terminal.Grid>` asks for panes and their authored
 * layout, and the host chooses what presents them.
 *
 * **This surface is routing, and only routing.** Middleware here may observe,
 * narrow, refuse, wrap or delegate one grid request. What it cannot do is open
 * a grid: `open()` answers `unknown`, and the answer is thrown away. The
 * capability that takes the terminal leases, mints pane claims and settles a
 * grid is a non-contextual authority delivered straight to the registered
 * provider, and a handler that answers without delegating has therefore
 * presented nothing and settled nothing.
 *
 * A grid is prepared before it is shown, which is what makes opening one atomic:
 * the provider builds the whole composite while it is hidden, core starts the
 * authored panes and waits for every one of them to report a spawn, and only
 * then is anything attached.
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
 *
 * It is also **one-use and identity-bearing**. Core mints exactly one of these
 * per grid expansion and the authority compares the object it is presented with
 * against the one it issued, so a request that was copied, rebuilt with the same
 * members, kept from an earlier grid, or already used authorizes nothing.
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
 * Everything here belongs to the one preparation that produced it. A composite
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
   * Show text a pane's own content rendered.
   *
   * This is where a paired pane's output goes, and the only place it goes: it
   * is never copied into the root document output or into a capture written
   * around the grid, because the reader is looking at the pane. Terminal bytes
   * an interactive child exchanges with the reader never come through here at
   * all — those belong to the pane's terminal and are neither captured nor
   * journaled.
   */
  display(ordinal: number, text: string): Operation<void>;
  /**
   * Start the host's default interactive shell in one pane and report how it
   * ended.
   *
   * Which shell that is comes from live host policy, never from the document.
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
   * Called exactly once for every composite that was prepared, including one
   * discarded before it ever attached.
   */
  destroy(): Operation<void>;
}

/** The stable name every loaded copy composes through. */
export const TERMINAL_GRIDS_API = "TerminalGrids";

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

export interface TerminalGridApi {
  /**
   * Route one grid request to whatever presents it.
   *
   * Answers `unknown`, and the answer is discarded: a return value is not
   * evidence that a grid was opened, and core reads what the authority settled
   * instead of what a handler said.
   */
  open(request: TerminalGridRequest): Operation<unknown>;
}

/**
 * The public routing surface. Its own default always refuses.
 *
 * Reaching this default means no registered provider consumed the request, so
 * nothing was presented — which is the honest answer for a host that installs
 * no provider at all.
 */
export const TerminalGrids: Api<TerminalGridApi> = createApi<TerminalGridApi>(TERMINAL_GRIDS_API, {
  // deno-lint-ignore require-yield
  *open(_request: TerminalGridRequest): Operation<unknown> {
    throw new TerminalProviderUnavailableError();
  },
});

/**
 * Everything one controlled composite did, in the order it did it.
 *
 * The record is the evidence: a suite reads it to prove that preparation came
 * before every pane started, that nothing attached before the readiness
 * barrier, and that teardown destroyed exactly the composite it prepared.
 */
export interface TerminalProviderLog {
  readonly events: string[];
  /**
   * What each pane displayed, by ordinal.
   *
   * A suite reads this to prove where a pane's output went — and reads the root
   * document output to prove where it did not.
   */
  readonly shown: Map<number, string>;
  /**
   * What the provider still holds, counted rather than described.
   *
   * Each one goes up when the composite takes something and down when it gives
   * it back, so a suite reads it after a run to prove nothing was stranded —
   * including after a cancellation, where the ordering of the record alone
   * would not say whether teardown finished.
   */
  readonly live: TerminalProviderResources;
}

/** What one controlled composite holds at a moment, by kind. */
export interface TerminalProviderResources {
  /** Composites prepared and not yet destroyed. */
  composites: number;
  /** Composites attached and not yet destroyed. */
  attached: number;
  /** Shells started whose outcome has not been returned. */
  shells: number;
}

/** A fresh, empty record. */
export function terminalProviderLog(): TerminalProviderLog {
  return {
    events: [],
    shown: new Map<number, string>(),
    live: { composites: 0, attached: 0, shells: 0 },
  };
}

/**
 * What a controlled composite does instead of opening a terminal.
 *
 * Each hook is a place a suite makes something happen or go wrong: `onPrepare`
 * refuses before a composite exists, `onAttach` fails the barrier, `shell`
 * decides what a self-closing pane's shell did and whether it started at all,
 * and `close` is the operation the grid waits on, so a suite controls exactly
 * when the reader leaves.
 */
export interface ControlledCompositeOptions {
  /** Appended to as the composite works, so ordering is read rather than timed. */
  readonly log?: TerminalProviderLog;
  onPrepare?: (request: TerminalGridRequest) => Operation<void>;
  onAttach?: () => Operation<void>;
  onDestroy?: () => Operation<void>;
  /**
   * Called as each pane state is displayed.
   *
   * A suite watches it to react to something the grid decided — a pane that
   * failed, a pane that became runnable — instead of waiting and hoping.
   */
  onUpdate?: (ordinal: number, state: TerminalPaneState) => void;
  shell?: (ordinal: number, spawned: () => void) => Operation<TerminalShellOutcome>;
  close?: () => Operation<void>;
}

/**
 * Prepare one composite that presents nothing and records everything.
 *
 * It answers the whole contract — attach, update, display, shell, close,
 * destroy — so a suite exercises core's lifecycle without a terminal, a
 * multiplexer, or a process anywhere in it.
 */
export function prepareControlledComposite(
  request: TerminalGridRequest,
  options: ControlledCompositeOptions = {},
  generation = 0,
): Operation<TerminalComposite> {
  return (function* (): Operation<TerminalComposite> {
    const log = options.log ?? terminalProviderLog();
    if (options.onPrepare) {
      yield* options.onPrepare(request);
    }
    log.events.push(`prepare:${generation}:${request.columns}x${request.rows}`);
    log.live.composites++;
    let destroyed = false;
    let attached = false;
    return {
      *attach() {
        if (options.onAttach) {
          yield* options.onAttach();
        }
        log.events.push(`attach:${generation}`);
        attached = true;
        log.live.attached++;
      },
      // deno-lint-ignore require-yield
      *update(ordinal, state) {
        log.events.push(`state:${generation}:${ordinal}:${state}`);
        options.onUpdate?.(ordinal, state);
      },
      // deno-lint-ignore require-yield
      *display(ordinal, text) {
        log.shown.set(ordinal, (log.shown.get(ordinal) ?? "") + text);
      },
      *shell(ordinal, spawned) {
        log.events.push(`shell:${generation}:${ordinal}`);
        log.live.shells++;
        try {
          if (options.shell) {
            return yield* options.shell(ordinal, spawned);
          }
          // The default shell starts: a suite that says nothing about a pane
          // wants a pane that works, and one that never reported a spawn would
          // hang the readiness barrier instead.
          spawned();
          return { exitCode: 0 };
        } finally {
          // Counted down however the shell left — returned, thrown, or
          // cancelled — because a shell a suite can still find is a shell the
          // provider is still holding.
          log.live.shells--;
        }
      },
      *closed() {
        if (options.close) {
          yield* options.close();
        }
        log.events.push(`closed:${generation}`);
      },
      *destroy() {
        // Destroying twice would make the record say a composite was taken down
        // more times than it was built, which is exactly the ordering claim a
        // suite reads this log for.
        if (destroyed) {
          throw new Error(`controlled composite ${generation} was destroyed twice`);
        }
        destroyed = true;
        if (options.onDestroy) {
          yield* options.onDestroy();
        }
        log.events.push(`destroy:${generation}`);
        log.live.composites--;
        if (attached) {
          attached = false;
          log.live.attached--;
        }
      },
    };
  })();
}
