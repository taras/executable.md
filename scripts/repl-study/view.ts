/**
 * What the person looking at the harness has chosen.
 *
 * The renderer clips; it does not scroll. So the window over a long transcript,
 * the selected checkpoint, and which surface narrow routing is showing are the
 * application's to own — and they survive every resize, which is the property
 * #838 asks a profile transition to preserve.
 */

import type { FixtureName } from "./model.ts";
import type { Fixture } from "./model.ts";
import type { SurfaceName } from "./layout.ts";
import { SURFACES } from "./layout.ts";

export interface View {
  readonly fixture: FixtureName;
  /** Index of the first visible transcript line. */
  readonly anchor: number;
  /** Index into the fixture's checkpoints, or -1 for "following the head". */
  readonly checkpoint: number;
  readonly surface: SurfaceName;
  readonly drawerOpen: boolean;
}

export function initialView(fixture: Fixture): View {
  const selected = fixture.history.selectedAt;
  const checkpoint =
    selected === undefined
      ? -1
      : fixture.history.checkpoints.findIndex((point) => point.at === selected);
  return {
    fixture: fixture.name,
    anchor: 0,
    checkpoint,
    surface: "transcript",
    drawerOpen: fixture.drawer !== undefined,
  };
}

export function scrollBy(view: View, delta: number, limit: number): View {
  const anchor = Math.max(0, Math.min(limit, view.anchor + delta));
  return anchor === view.anchor ? view : { ...view, anchor };
}

/**
 * Move the selection one checkpoint at a time.
 *
 * Navigation runs over the checkpoint list rather than over the columns the band
 * drew, so a marker that had to share a column with its neighbour is still
 * reachable — which is the whole reason the band is allowed to summarize.
 */
export function scrubBy(view: View, delta: number, count: number): View {
  if (count === 0) {
    return view;
  }
  const from = view.checkpoint === -1 ? count : view.checkpoint;
  const checkpoint = Math.max(0, Math.min(count - 1, from + delta));
  return checkpoint === view.checkpoint ? view : { ...view, checkpoint };
}

/** Return to the head, abandoning a historical selection. */
export function returnToHead(view: View): View {
  return view.checkpoint === -1 ? view : { ...view, checkpoint: -1 };
}

export function moveSurface(view: View, delta: number): View {
  const at = SURFACES.indexOf(view.surface);
  const next = SURFACES[(at + delta + SURFACES.length) % SURFACES.length];
  return { ...view, surface: next };
}

export function showSurface(view: View, surface: SurfaceName): View {
  return view.surface === surface ? view : { ...view, surface };
}

export function toggleDrawer(view: View): View {
  return { ...view, drawerOpen: !view.drawerOpen };
}
