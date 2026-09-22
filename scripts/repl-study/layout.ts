/**
 * Where each region goes, in terminal cells.
 *
 * The study composes one screen at 2560×1440 — a sidebar at `0..620`, the
 * transcript centred in `620..2100`, a bindings pane at `2130..2530`, the
 * contextual surface bottom-anchored above a full-width 92px Execution History
 * footer. Those proportions are kept here and the pixels are not: a terminal is
 * measured in cells, and the same composition has to hold at 240 columns and at
 * 120.
 *
 * Below the wide composition's floor the interface is not shrunk further. It is
 * routed: one surface at a time, full screen, which is the policy #827 asks for
 * instead of scaling an interface until its text is unreadable.
 */

import type { Mutation } from "./mutations.ts";

export type Profile = "wide" | "medium" | "narrow" | "too-small";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The surfaces narrow routing moves between, in ring order. */
export const SURFACES = ["sessions", "transcript", "bindings", "history"] as const;

export type SurfaceName = (typeof SURFACES)[number];

/** Below this the interface refuses rather than lies. */
export const MINIMUM = { cols: 72, rows: 20 } as const;

/** What a pane must have to be worth composing beside another one. */
export const PANE_MINIMUMS = { sidebar: 28, bindings: 26, transcript: 40 } as const;

/** Rows the study's 92px bands become. */
const FOOTER_ROWS = 4;
const INPUT_ROWS = 4;
const HEADER_ROWS = 2;

export interface Layout {
  readonly profile: Profile;
  readonly cols: number;
  readonly rows: number;
  readonly screen: Rect;
  /** True where a pane is at its floor and secondary detail is dropped. */
  readonly dense: boolean;
  readonly sidebar?: Rect;
  readonly transcript?: Rect;
  readonly bindings?: Rect;
  readonly header?: Rect;
  /** The REPL input or the Elicit drawer, bottom-anchored above the footer. */
  readonly contextual?: Rect;
  readonly footer?: Rect;
  readonly separators: readonly Rect[];
  /** Narrow only: the one row naming the surface you are on. */
  readonly surfaceBar?: Rect;
  readonly surface?: SurfaceName;
}

export function profileFor(cols: number, rows: number): Profile {
  if (cols < MINIMUM.cols || rows < MINIMUM.rows) {
    return "too-small";
  }
  if (cols >= 160 && rows >= 36) {
    return "wide";
  }
  if (cols >= 120 && rows >= 30) {
    return "medium";
  }
  return "narrow";
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export interface LayoutRequest {
  readonly cols: number;
  readonly rows: number;
  /** An open drawer takes the contextual band in wide, the screen in narrow. */
  readonly drawer: boolean;
  /** Which surface narrow routing is showing. */
  readonly surface: SurfaceName;
  /** A deliberate break, for the evidence that would otherwise check nothing. */
  readonly mutation?: Mutation;
}

/**
 * The profile a request is composed as.
 *
 * Two mutations live here rather than in the renderer, because both are
 * decisions about which composition to use at all: one keeps the wide
 * composition where routing was required, and the other composes an interface
 * on a terminal that is too small to carry one.
 */
function composedProfile(cols: number, rows: number, mutation?: Mutation): Profile {
  const measured = profileFor(cols, rows);
  if (mutation === "ignore-minimum" && measured === "too-small") {
    return "narrow";
  }
  if (mutation === "shrink-wide-at-narrow" && measured === "narrow") {
    return "medium";
  }
  return measured;
}

export function layoutFor(request: LayoutRequest): Layout {
  const { cols, rows, drawer, surface } = request;
  const screen = { x: 0, y: 0, width: cols, height: rows };
  const profile = composedProfile(cols, rows, request.mutation);

  if (profile === "too-small") {
    return { profile, cols, rows, screen, dense: false, separators: [] };
  }

  if (profile === "narrow") {
    if (drawer) {
      return {
        profile,
        cols,
        rows,
        screen,
        dense: true,
        separators: [],
        surface,
        contextual: screen,
      };
    }
    const surfaceBar = { x: 0, y: 0, width: cols, height: 1 };
    const body = { x: 0, y: 1, width: cols, height: rows - 1 };
    if (surface === "transcript") {
      const input = { x: 0, y: rows - 3, width: cols, height: 3 };
      return {
        profile,
        cols,
        rows,
        screen,
        dense: true,
        separators: [],
        surfaceBar,
        surface,
        transcript: { ...body, height: body.height - input.height },
        contextual: input,
      };
    }
    const region = { ...body };
    return {
      profile,
      cols,
      rows,
      screen,
      dense: true,
      separators: [],
      surfaceBar,
      surface,
      sidebar: surface === "sessions" ? region : undefined,
      bindings: surface === "bindings" ? region : undefined,
      footer: surface === "history" ? region : undefined,
    };
  }

  const sidebarWidth = clamp(Math.round(cols * 0.24), PANE_MINIMUMS.sidebar, 52);
  const bindingsWidth = clamp(Math.round(cols * 0.16), PANE_MINIMUMS.bindings, 40);
  const footer = { x: 0, y: rows - FOOTER_ROWS, width: cols, height: FOOTER_ROWS };
  const contextualHeight = drawer ? Math.min(14, rows - FOOTER_ROWS - 8) : INPUT_ROWS;
  const contextual = {
    x: sidebarWidth + 1,
    y: footer.y - contextualHeight,
    width: cols - sidebarWidth - 1,
    height: contextualHeight,
  };
  const header = { x: sidebarWidth + 1, y: 0, width: contextual.width, height: HEADER_ROWS };
  const paneTop = HEADER_ROWS + 1;
  const paneHeight = contextual.y - paneTop;

  return {
    profile,
    cols,
    rows,
    screen,
    dense: profile === "medium",
    sidebar: { x: 0, y: 0, width: sidebarWidth, height: footer.y },
    header,
    transcript: {
      x: sidebarWidth + 1,
      y: paneTop,
      width: cols - sidebarWidth - bindingsWidth - 2,
      height: paneHeight,
    },
    bindings: { x: cols - bindingsWidth, y: paneTop, width: bindingsWidth, height: paneHeight },
    contextual,
    footer,
    separators: [
      { x: sidebarWidth, y: 0, width: 1, height: footer.y },
      { x: cols - bindingsWidth - 1, y: paneTop, width: 1, height: paneHeight },
      { x: sidebarWidth + 1, y: HEADER_ROWS, width: contextual.width, height: 1 },
    ],
  };
}

/** True when two rectangles share at least one cell. */
export function intersects(one: Rect, other: Rect): boolean {
  return (
    one.x < other.x + other.width &&
    other.x < one.x + one.width &&
    one.y < other.y + other.height &&
    other.y < one.y + one.height
  );
}
