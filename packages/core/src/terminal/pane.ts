/**
 * How work written inside a pane reaches that pane's terminal.
 *
 * A `<Session.Launch>` written at the root reserves the run's one foreground
 * terminal and competes with every other launch for it. The same element
 * written inside a pane must not: panes are interactive at the same time, which
 * is the whole reason a grid exists. So core installs this in each pane's own
 * scope, and anything interactive asks here first.
 *
 * What travels contextually is the seam, not the authority. The claim it hands
 * out was minted for one ordinal of one grid and cannot be forged, copied
 * usefully, or kept past the expansion that owns it — so a replaced context
 * yields a pane terminal nobody owns rather than a way into one somebody does.
 *
 * Absence is the ordinary case and means "not in a pane": work outside a grid
 * reads nothing here and goes on competing for the root lease exactly as it
 * always has.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { TerminalPaneClaim } from "./authority.ts";

/** The pane the current work is running in. */
export interface PaneTerminal {
  /** The pane's identity: its position among the grid's panes, from zero. */
  readonly ordinal: number;
  /**
   * Run one interactive operation as this pane's owner.
   *
   * `body` receives the pane's readiness latch and must call it from the
   * runtime's successful child-spawn event, before it waits for the child to
   * exit. A body that never spawns never reports, and the grid it belongs to
   * never attaches — which is what stops a pane that failed to start being
   * presented as one that is running.
   *
   * A second interactive operation while one is live on this pane is refused.
   * Two panes do not contend with each other at all.
   */
  interactive<T>(body: (spawned: () => void) => Operation<T>): Operation<T>;
}

const PaneTerminalContext: Context<PaneTerminal | undefined> = createContext<
  PaneTerminal | undefined
>("core.terminal.pane", undefined);

/** The pane the current work is running in, or `undefined` outside a grid. */
export function paneTerminal(): Operation<PaneTerminal | undefined> {
  return PaneTerminalContext.get();
}

/**
 * Install one pane's seam for the scope that runs that pane's work.
 *
 * Set rather than composed: a pane is not a layer over the enclosing pane,
 * because panes do not nest. A grid written inside a pane is refused by the
 * grammar, so the value a pane's scope holds is always its own.
 */
export function* usePaneTerminal(claim: TerminalPaneClaim): Operation<void> {
  yield* PaneTerminalContext.set({
    ordinal: claim.ordinal,
    interactive(body) {
      return claim.admit(() => body(() => claim.ready()));
    },
  });
}
