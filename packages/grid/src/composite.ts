/**
 * The grid boundary — how a host presents one grid of interactive
 * panes, and what composing middleware around it may do.
 *
 * This is not the native launcher. A launch hands **one** child the whole
 * foreground terminal and waits for it; a grid divides that terminal into
 * several panes that stay interactive at the same time, each with its own
 * lifetime. tmux is one way to do that, a host-native composite UI is another,
 * and a test surface that opens no terminal at all is a third. None of them
 * appears in the document: `<Grid>` asks for panes and their authored
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
import type { NativeLaunchOutcome, NativeLaunchRequest } from "./native-launcher.ts";

/** One pane the provider is asked to present, by its authored ordinal. */
export interface PaneRequest {
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
export interface GridRequest {
  readonly columns: number;
  readonly rows: number;
  readonly panes: readonly PaneRequest[];
}

/**
 * What core tells a provider about one pane, as it happens.
 *
 * A closed set, and display only. `running` follows readiness, `succeeded` and
 * `failed` follow the pane's own settlement, and `closed` is a live pane
 * cancelled solely because the reader closed the grid — which is not a failure
 * and is deliberately spelled differently from one.
 */
export type PaneState = "starting" | "running" | "succeeded" | "failed" | "closed";

/** How a pane's default shell ended. */
export interface ShellOutcome {
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
export interface GridComposite {
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
  update(ordinal: number, state: PaneState): Operation<void>;
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
  shell(ordinal: number, spawned: () => void): Operation<ShellOutcome>;
  /**
   * Run one native launch in one pane, on that pane's terminal.
   *
   * This is the physical endpoint for a `<Session.Launch>` written inside a
   * paired pane. Core closes its pane-scoped launcher over this operation and
   * the pane's authored ordinal, so the ordinal stays in a live closure and
   * enters no request, session key, durable phase, result or diagnostic. What
   * crosses is the exact command vector, working directory and environment the
   * Agent provider supplied.
   *
   * Required of every composite, and deliberately not optional: a provider that
   * cannot execute a pane launch refuses here. Falling back would put a native
   * UI on the root terminal — the one terminal a pane exists to avoid.
   *
   * `spawned` is the pane's readiness latch, on the same terms as `shell()`:
   * called for the child's runtime spawn event and nothing earlier.
   *
   * Kept apart from `shell()` because they answer different questions. `shell()`
   * derives its executable from live host policy; this runs the request it is
   * given.
   */
  launch(
    ordinal: number,
    request: NativeLaunchRequest,
    spawned: () => void,
  ): Operation<NativeLaunchOutcome>;
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
export const GRIDS_API = "Grids";

export const GRID_PROVIDER_UNAVAILABLE =
  "no grid provider is installed — this host does not present a grid of " +
  "interactive panes. `xmd run` installs one; a test or embedding host installs " +
  "its own.";

export class GridProviderUnavailableError extends Error {
  override name = "GridProviderUnavailableError";
  constructor(message: string = GRID_PROVIDER_UNAVAILABLE) {
    super(message);
  }
}

export interface GridApi {
  /**
   * Route one grid request to whatever presents it.
   *
   * Answers `unknown`, and the answer is discarded: a return value is not
   * evidence that a grid was opened, and core reads what the authority settled
   * instead of what a handler said.
   */
  open(request: GridRequest): Operation<unknown>;
}

/**
 * The public routing surface. Its own default always refuses.
 *
 * Reaching this default means no registered provider consumed the request, so
 * nothing was presented — which is the honest answer for a host that installs
 * no provider at all.
 */
export const Grids: Api<GridApi> = createApi<GridApi>(GRIDS_API, {
  // deno-lint-ignore require-yield
  *open(_request: GridRequest): Operation<unknown> {
    throw new GridProviderUnavailableError();
  },
});
