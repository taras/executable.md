/**
 * The terminal grid boundary — how a host presents one grid of interactive
 * panes, and what composing middleware around it may do.
 *
 * This is not the native launcher. A launch hands **one** child the whole
 * foreground terminal and waits for it; a grid divides that terminal into
 * several panes that stay interactive at the same time, each with its own
 * lifetime. tmux is one way to do that, a host-native grid UI is another,
 * and a test surface that opens no terminal at all is a third. None of them
 * appears in the document: `<Terminal.Grid>` asks for panes and their authored
 * layout, and the host chooses what presents them.
 *
 * **This surface is routing, and only routing.** Middleware here may observe,
 * narrow, refuse, wrap or delegate one grid request. What it cannot do is open
 * a grid: `open()` answers `unknown`, and the answer is thrown away. The
 * capability that takes the terminal leases and settles a grid is a
 * non-contextual presentation function delivered straight to the registered
 * provider, and a handler that answers without delegating has therefore
 * presented nothing and settled nothing.
 *
 * A grid is prepared before it is shown, which is what makes opening one atomic:
 * the provider builds the whole grid while it is hidden, core starts the
 * authored panes and waits for every one of them to acquire a terminal
 * activity, and only then is anything attached.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensure, resource } from "effection";
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
 * per grid expansion and presentation compares the object it is given with
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
 * One terminal activity: something interactive a pane runs.
 *
 * A resource, and the acquisition is the whole point. Preparing a child and
 * spawning it happen before the value exists, so a provider that could not
 * start one never yields — and the pane it belongs to never becomes ready.
 * Acquiring it means the child is running; the value acquired is the operation
 * that settles with how that child ended; releasing it kills and reaps whatever
 * is left.
 *
 * A child that starts and exits immediately is therefore both ready and
 * settled.
 */
export type TerminalActivity<T> = Operation<Operation<T>>;

/**
 * One provider's realization of one complete grid.
 *
 * This *is* the grid the provider drew, for the one request it was presented,
 * and it belongs to that one preparation: a provider that hands the same one
 * back twice has handed back a grid the second expansion did not ask for. It is
 * supplied as a resource, so acquiring it is how a grid comes to exist and
 * releasing it is how it goes — exactly once, whether the grid succeeded,
 * failed to start, was closed by the reader, was failed by the provider, or was
 * cancelled. There is no destroy to call and no way to call it twice.
 */
export interface TerminalGrid {
  /**
   * Show the grid. Called once, and only after every pane is ready.
   *
   * A provider that has to place panes does it here rather than during
   * acquisition, so the reader never sees a grid fill in.
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
   * The host's default interactive shell in one pane, as a terminal activity.
   *
   * Which shell that is comes from live host policy, never from the document.
   * Acquiring it means the shell started, which is what makes a self-closing
   * pane ready; a shell that could not start is a failure before acquisition
   * and leaves the pane unready.
   */
  shell(ordinal: number): TerminalActivity<TerminalShellOutcome>;
  /**
   * Settle when the reader closes or leaves the grid.
   *
   * A grid stays visible after its panes have settled, so this is what tells
   * core the reader is finished with it.
   */
  closed(): Operation<void>;
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
   * evidence that a grid was opened, and core reads what presentation settled
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
 * Everything one controlled grid did, in the order it did it.
 *
 * The record is the evidence: a suite reads it to prove that preparation came
 * before every pane started, that nothing attached before the readiness
 * barrier, and that release took down exactly the grid it prepared.
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
   * Each one goes up when the grid takes something and down when it gives
   * it back, so a suite reads it after a run to prove nothing was stranded —
   * including after a cancellation, where the ordering of the record alone
   * would not say whether teardown finished.
   */
  readonly live: TerminalProviderResources;
}

/** What one controlled provider holds at a moment, by kind. */
export interface TerminalProviderResources {
  /** Grids acquired and not yet released. */
  grids: number;
  /** Grids attached and not yet released. */
  attached: number;
  /** Shell activities acquired and not yet released. */
  shells: number;
}

/** A fresh, empty record. */
export function terminalProviderLog(): TerminalProviderLog {
  return {
    events: [],
    shown: new Map<number, string>(),
    live: { grids: 0, attached: 0, shells: 0 },
  };
}

/**
 * What a controlled grid does instead of opening a terminal.
 *
 * Each hook is a place a suite makes something happen or go wrong: `onPrepare`
 * refuses before a grid exists, `onAttach` fails the barrier, `shell` decides
 * what a self-closing pane's shell did and whether it started at all, and
 * `close` is the operation the grid waits on, so a suite controls exactly when
 * the reader leaves.
 */
export interface ControlledTerminalGridOptions {
  /** Appended to as the grid works, so ordering is read rather than timed. */
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
  /**
   * The shell activity for one pane.
   *
   * A suite that wants a shell which never starts supplies one that throws
   * before it provides: the pane then never becomes ready, exactly as a real
   * spawn failure leaves it.
   */
  shell?: (ordinal: number) => TerminalActivity<TerminalShellOutcome>;
  close?: () => Operation<void>;
}

/** An outcome that is already settled, for a child that needed no waiting. */
function settled<T>(outcome: T): Operation<T> {
  // deno-lint-ignore require-yield
  return (function* (): Operation<T> {
    return outcome;
  })();
}

/**
 * One controlled grid that presents nothing and records everything.
 *
 * A resource, like a real provider's: acquiring it is the grid coming into
 * existence and releasing it is the grid going away, so a suite reads the
 * record to prove that happened exactly once. It answers the whole contract —
 * attach, update, display, shell, close — without a terminal, a multiplexer, or
 * a process anywhere in it.
 */
export function controlledTerminalGrid(
  request: TerminalGridRequest,
  options: ControlledTerminalGridOptions = {},
  generation = 0,
): Operation<TerminalGrid> {
  return resource(function* (provide) {
    const log = options.log ?? terminalProviderLog();
    if (options.onPrepare) {
      yield* options.onPrepare(request);
    }
    log.events.push(`prepare:${generation}:${request.columns}x${request.rows}`);
    log.live.grids++;
    let attached = false;

    // Registered before the grid is provided, so every way out of the resource
    // runs it once: settled, failed to start, closed, failed by the provider,
    // or cancelled.
    yield* ensure(function* () {
      if (options.onDestroy) {
        yield* options.onDestroy();
      }
      log.events.push(`destroy:${generation}`);
      log.live.grids--;
      if (attached) {
        attached = false;
        log.live.attached--;
      }
    });

    yield* provide({
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
      shell(ordinal) {
        return resource(function* (provideOutcome) {
          if (options.shell) {
            // Whatever the suite supplies: it may refuse before providing,
            // which is a shell that never started.
            const outcome = yield* options.shell(ordinal);
            log.events.push(`shell:${generation}:${ordinal}`);
            log.live.shells++;
            yield* ensure(() => {
              log.live.shells--;
            });
            yield* provideOutcome(outcome);
            return;
          }
          // The default shell starts and is done: a suite that says nothing
          // about a pane wants a pane that works.
          log.events.push(`shell:${generation}:${ordinal}`);
          log.live.shells++;
          yield* ensure(() => {
            log.live.shells--;
          });
          yield* provideOutcome(settled<TerminalShellOutcome>({ exitCode: 0 }));
        });
      },
      *closed() {
        if (options.close) {
          yield* options.close();
        }
        log.events.push(`closed:${generation}`);
      },
    });
  });
}
