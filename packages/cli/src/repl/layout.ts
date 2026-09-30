/**
 * Where everything goes, at whatever size the terminal happens to be.
 *
 * Presentation and nothing else. Layout decides placement; it never changes
 * which model objects are selected, which node a control belongs to or what an
 * action means. Resizing a terminal therefore moves things and changes nothing
 * else — which is why the frame it produces names the live node behind every
 * cell rather than carrying a copy of what that node holds.
 *
 * ## Four profiles, and a refusal
 *
 * `160x36` is wide, `120x30` is medium, `72x20` is narrow, and anything smaller
 * than narrow is a refusal rather than a squeezed layout. The refusal is
 * explicit and recovers on resize: nothing is torn down, and no control it hides
 * can be activated while it is showing.
 *
 * Wide and medium carry the sidebar, the transcript, the bindings/history
 * inspection column, the drawer layer and the fixed full-width footer. Narrow
 * keeps the drawer and the footer and gives the rest of the screen to one routed
 * content surface. The History band is five rows at every size; when the labels
 * of several markers cannot fit, their *visual* labels are grouped and every
 * marker keeps its own identity in the frame.
 *
 * Geometry is integer and deterministic: the same size and the same surface
 * produce the same frame, cell for cell and bound for bound.
 */

import type { ReplTerminalSize } from "./terminal.ts";

/** Which layout one size gets. */
export type ReplProfile = "wide" | "medium" | "narrow" | "too-small";

/** The named areas a frame can have. */
export type ReplRegion =
  | "sidebar"
  | "transcript"
  | "inspection"
  | "content"
  | "drawer"
  | "footer"
  | "refusal";

/** Integer cell geometry. */
export interface ReplBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One thing the application wants shown, and the node it belongs to. */
export interface ReplSurfaceCell {
  /** The live node this came from. Presentation never invents one. */
  readonly node: string;
  readonly text: string;
  /** Whether a pointer may activate it. */
  readonly targetable?: true;
}

/** One selectable history position, as the band would label it. */
export interface ReplSurfaceMarker {
  readonly marker: string;
  readonly label: string;
}

/** What the application wants on screen, before anything decides where. */
export interface ReplSurface {
  /**
   * The one surface a narrow frame shows, chosen by the route.
   *
   * Named separately rather than derived from the regions below, because which
   * surface a narrow screen is showing is a routing decision the application
   * makes and not one placement is entitled to invent.
   */
  readonly content: readonly ReplSurfaceCell[];
  /** Present and possibly empty: an empty Sessions section is still a section. */
  readonly sessions: readonly ReplSurfaceCell[];
  readonly entries: readonly ReplSurfaceCell[];
  readonly transcript: readonly ReplSurfaceCell[];
  readonly inspection: readonly ReplSurfaceCell[];
  /** Absent when no drawer is open. */
  readonly drawer: readonly ReplSurfaceCell[];
  readonly footer: readonly ReplSurfaceCell[];
  readonly history: readonly ReplSurfaceMarker[];
}

/** One placed cell: what to draw, where, and which node it is. */
export interface ReplPlacedCell {
  /** The rendered element's id. Stable for one node in one region. */
  readonly id: string;
  readonly node: string;
  readonly region: ReplRegion;
  readonly text: string;
  readonly bounds: ReplBounds;
  readonly targetable: boolean;
}

/** One marker as the band shows it, grouped or not. */
export interface ReplPlacedMarker {
  readonly marker: string;
  /** The label shown. Several markers may share one when space is short. */
  readonly label: string;
  /** The other markers sharing that label, this one excluded. */
  readonly grouped: readonly string[];
}

/** One frame, decided and nothing more. */
export interface ReplSemanticFrame {
  readonly profile: ReplProfile;
  readonly size: ReplTerminalSize;
  readonly regions: readonly { readonly region: ReplRegion; readonly bounds: ReplBounds }[];
  readonly cells: readonly ReplPlacedCell[];
  /** Exactly five rows, whatever the size. */
  readonly historyRows: readonly string[];
  readonly markers: readonly ReplPlacedMarker[];
  /** The sentence a too-small frame shows, and nothing else it shows. */
  readonly refusal: string | undefined;
}

/** The narrow profile's size, which is also the minimum this REPL draws at. */
export const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };
const MEDIUM: ReplTerminalSize = { columns: 120, rows: 30 };
const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };

/** The footer is one border row, five History rows and one input row. */
const FOOTER_ROWS = 7;
/** The History band's own five rows. */
export const HISTORY_ROWS = 5;

/** How wide a column is at each profile that has one. */
interface ColumnWidths {
  readonly wide: number;
  readonly medium: number;
}

const SIDEBAR: ColumnWidths = { wide: 32, medium: 28 };
const INSPECTION: ColumnWidths = { wide: 36, medium: 28 };

/**
 * How wide the surface that carries content is, at one size.
 *
 * Asked by whoever has to *write* something that must fit: a row longer than the
 * region it lands in is reflowed into rows the layout never allocated, so the
 * width has to be a question with one answer rather than a constant each caller
 * guesses at. Zero when there is no such surface, which is the refusal.
 */
export function surfaceWidth(size: ReplTerminalSize): number {
  const profile = profileFor(size);
  if (profile === "too-small") {
    return 0;
  }
  if (profile === "narrow") {
    return size.columns;
  }
  const sidebar = profile === "wide" ? SIDEBAR.wide : SIDEBAR.medium;
  const inspection = profile === "wide" ? INSPECTION.wide : INSPECTION.medium;
  return size.columns - sidebar - inspection;
}

/**
 * How wide the drawer layer is, at one size.
 *
 * The same question for a modal: what it writes has to reach its own edges, or
 * what it is in front of shows through from where its text stops.
 */
export function drawerWidth(size: ReplTerminalSize): number {
  if (profileFor(size) === "too-small") {
    return 0;
  }
  return size.columns - 2 * Math.floor(size.columns / 8);
}

/**
 * How tall the drawer layer is, at one size.
 *
 * The same arithmetic the placement below uses, exported because what a drawer
 * can hold decides how much of a long message it may show: a region that drew
 * more rows than this would clip its own controls off the bottom.
 */
export function drawerHeight(size: ReplTerminalSize): number {
  if (profileFor(size) === "too-small") {
    return 0;
  }
  const body = size.rows - FOOTER_ROWS;
  return body - 2 * Math.floor(body / 8);
}

/** Which profile a size gets. */
export function profileFor(size: ReplTerminalSize): ReplProfile {
  if (size.columns < NARROW.columns || size.rows < NARROW.rows) {
    return "too-small";
  }
  if (size.columns >= WIDE.columns && size.rows >= WIDE.rows) {
    return "wide";
  }
  if (size.columns >= MEDIUM.columns && size.rows >= MEDIUM.rows) {
    return "medium";
  }
  return "narrow";
}

/** Lay one surface out at one size. */
export function layout(size: ReplTerminalSize, surface: ReplSurface): ReplSemanticFrame {
  const profile = profileFor(size);
  if (profile === "too-small") {
    return refuse(size);
  }

  const body = size.rows - FOOTER_ROWS;
  const footer: ReplBounds = { x: 0, y: body, width: size.columns, height: FOOTER_ROWS };
  const regions: { region: ReplRegion; bounds: ReplBounds }[] = [];
  const cells: ReplPlacedCell[] = [];

  if (profile === "narrow") {
    const content: ReplBounds = { x: 0, y: 0, width: size.columns, height: body };
    regions.push({ region: "content", bounds: content });
    // Exactly the routed surface, and nothing else. A narrow screen that stacked
    // every region would be a wide screen with the columns removed: the reader
    // would scroll past three lists to reach the one they asked for, and every
    // row of the other two would still be a target.
    place(cells, "content", content, surface.content);
  } else {
    const sidebarWidth = profile === "wide" ? SIDEBAR.wide : SIDEBAR.medium;
    const inspectionWidth = profile === "wide" ? INSPECTION.wide : INSPECTION.medium;
    const sidebar: ReplBounds = { x: 0, y: 0, width: sidebarWidth, height: body };
    const inspection: ReplBounds = {
      x: size.columns - inspectionWidth,
      y: 0,
      width: inspectionWidth,
      height: body,
    };
    const transcript: ReplBounds = {
      x: sidebarWidth,
      y: 0,
      width: size.columns - sidebarWidth - inspectionWidth,
      height: body,
    };
    regions.push(
      { region: "sidebar", bounds: sidebar },
      { region: "transcript", bounds: transcript },
      { region: "inspection", bounds: inspection },
    );
    place(cells, "sidebar", sidebar, [...surface.sessions, ...surface.entries]);
    place(cells, "transcript", transcript, surface.transcript);
    place(cells, "inspection", inspection, surface.inspection);
  }

  if (surface.drawer.length > 0) {
    // Over the body, inset, and above the footer rather than across it.
    const drawer: ReplBounds = {
      x: Math.floor(size.columns / 8),
      y: Math.floor(body / 8),
      width: size.columns - 2 * Math.floor(size.columns / 8),
      height: body - 2 * Math.floor(body / 8),
    };
    regions.push({ region: "drawer", bounds: drawer });
    place(cells, "drawer", drawer, surface.drawer);
  }

  regions.push({ region: "footer", bounds: footer });
  place(cells, "footer", footer, surface.footer);

  const band = grouped(surface.history, size.columns);
  return Object.freeze({
    profile,
    size: Object.freeze({ ...size }),
    regions: Object.freeze(
      regions.map((region) => Object.freeze({ ...region, bounds: Object.freeze(region.bounds) })),
    ),
    cells: Object.freeze(cells),
    historyRows: Object.freeze(rowsFor(band, size.columns)),
    markers: Object.freeze(band),
    refusal: undefined,
  });
}

/** The one frame a terminal too small to draw in gets. */
function refuse(size: ReplTerminalSize): ReplSemanticFrame {
  const bounds: ReplBounds = { x: 0, y: 0, width: size.columns, height: size.rows };
  return Object.freeze({
    profile: "too-small",
    size: Object.freeze({ ...size }),
    regions: Object.freeze([Object.freeze({ region: "refusal", bounds: Object.freeze(bounds) })]),
    // No cell at all, so nothing this frame hides can be pointed at: a control
    // that is not in the frame is not in its target map either.
    cells: Object.freeze([]),
    historyRows: Object.freeze(new Array<string>(HISTORY_ROWS).fill("")),
    markers: Object.freeze([]),
    refusal:
      `This REPL needs at least ${NARROW.columns}x${NARROW.rows}; this terminal is ` +
      `${size.columns}x${size.rows}. Make the window larger.`,
  });
}

/** Stack one region's cells, one row each, clipped to the region's height. */
function place(
  into: ReplPlacedCell[],
  region: ReplRegion,
  bounds: ReplBounds,
  contents: readonly ReplSurfaceCell[],
): void {
  contents.slice(0, bounds.height).forEach((content, row) => {
    into.push(
      Object.freeze({
        id: `${region}:${content.node}`,
        node: content.node,
        region,
        text: content.text,
        bounds: Object.freeze({ x: bounds.x, y: bounds.y + row, width: bounds.width, height: 1 }),
        targetable: content.targetable === true,
      }),
    );
  });
}

/**
 * Label the markers, grouping their labels when they cannot all fit.
 *
 * Grouping is visual. Every marker stays in the frame under its own name, and
 * the ones sharing a label say which others they share it with — so a compact
 * band never costs a reader the ability to select an exact position.
 */
function grouped(markers: readonly ReplSurfaceMarker[], columns: number): ReplPlacedMarker[] {
  // Five rows wide as the band is wide. Grouping is about the band's whole
  // budget, not one row's: a label that will not fit row three may fit row four.
  const budget = HISTORY_ROWS * Math.max(1, columns - 2);
  const separate = markers.reduce((width, marker) => width + marker.label.length + 1, 0);
  if (markers.length === 0 || separate <= budget) {
    return markers.map((marker) => Object.freeze({ ...marker, grouped: Object.freeze([]) }));
  }

  // A grouped label is its first member's plus a count, so budget for that.
  const widest = markers.reduce((width, marker) => Math.max(width, marker.label.length), 1) + 4;
  const affordable = Math.max(1, Math.floor(budget / (widest + 1)));
  // At least two: reaching here means one-per-group would group nothing and the
  // band would overflow exactly as before.
  const perGroup = Math.max(2, Math.ceil(markers.length / affordable));
  const placed: ReplPlacedMarker[] = [];
  for (let start = 0; start < markers.length; start += perGroup) {
    const group = markers.slice(start, start + perGroup);
    const label = group.length === 1 ? group[0].label : `${group[0].label} +${group.length - 1}`;
    for (const marker of group) {
      placed.push(
        Object.freeze({
          marker: marker.marker,
          label,
          grouped: Object.freeze(
            group.filter((other) => other !== marker).map((other) => other.marker),
          ),
        }),
      );
    }
  }
  return placed;
}

/** The five rows the History band shows. */
function rowsFor(markers: readonly ReplPlacedMarker[], columns: number): string[] {
  const rows = new Array<string>(HISTORY_ROWS).fill("");
  const labels: string[] = [];
  for (const marker of markers) {
    if (!labels.includes(marker.label)) {
      labels.push(marker.label);
    }
  }
  labels.forEach((label, index) => {
    const row = index % HISTORY_ROWS;
    const next = rows[row] === "" ? label : `${rows[row]} ${label}`;
    rows[row] = next.length <= columns ? next : rows[row];
  });
  return rows;
}
