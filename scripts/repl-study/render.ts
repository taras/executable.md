/**
 * The approved interface, in terminal cells.
 *
 * Every region is a floating box placed at the rectangle `layout.ts` computed,
 * so what the renderer reports through `render().info` can be checked against
 * what the layout intended. Lines are pre-wrapped and padded here rather than
 * left to wrap themselves, because a window over a long transcript has to know
 * how many rows each line will take before it can decide which lines to show.
 *
 * Colours, glyphs and wording come from the Product Owner's study. The study is
 * explicit that a lifecycle phase is "glyph + word, never colour alone", so a
 * phase is always legible on a monochrome terminal too.
 */

import { close, grow, fixed, open, rgba, text } from "@bomb.sh/tty";
import type { Op } from "@bomb.sh/tty";

import type { Checkpoint, Entry, Fixture, Phase, TranscriptRow, TransportMode } from "./model.ts";
import type { DrawerView, HistoryView, InputView, MarkerView } from "./view.ts";
import { drawerViewFrom, historyViewFrom } from "./view.ts";
import type { Layout, Rect, SurfaceName } from "./layout.ts";
import type { Placement } from "./component.ts";
import { placementOf } from "./component.ts";
import { MINIMUM } from "./layout.ts";
import type { View } from "./store.ts";
import type { Mutation } from "./mutations.ts";
import type { OverlayEntry } from "./tree.ts";

export const C = {
  src: rgba(0xc8, 0xd2, 0xd9),
  active: rgba(0x7f, 0xd3, 0xe8),
  tick: rgba(0x5a, 0xa8, 0x7c),
  settledText: rgba(0x7c, 0x86, 0x8d),
  hold: rgba(0xc9, 0x9a, 0x3f),
  intro: rgba(0xcf, 0xe0, 0xea),
  out: rgba(0xe6, 0xec, 0xf1),
  label: rgba(0x8b, 0x95, 0x9c),
  dim: rgba(0x7b, 0x85, 0x8d),
  name: rgba(0xb8, 0xc4, 0xcc),
  exit: rgba(0xc2, 0x76, 0x6e),
  gold: rgba(0xc9, 0xa8, 0x6a),
  fail: rgba(0xd2, 0x4b, 0x3f),
  rule: rgba(0x16, 0x1c, 0x21),
  focus: rgba(0x9a, 0xe0, 0xa8),
};

export const BG = {
  app: rgba(0x0b, 0x0d, 0x0f),
  side: rgba(0x09, 0x0b, 0x0c),
  center: rgba(0x0c, 0x0e, 0x11),
  bind: rgba(0x0a, 0x0c, 0x0e),
  drawer: rgba(0x0e, 0x13, 0x16),
  input: rgba(0x0a, 0x0d, 0x0f),
  footer: rgba(0x08, 0x09, 0x0b),
  rule: rgba(0x16, 0x1c, 0x21),
};

interface PhaseStyle {
  readonly glyph: string;
  readonly word: string;
  readonly color: number;
}

const PHASE: Record<Phase, PhaseStyle> = {
  enter: { glyph: "▶", word: "ENTER", color: C.tick },
  active: { glyph: "●", word: "ACTIVE", color: C.active },
  waiting: { glyph: "●", word: "WAITING", color: C.hold },
  exit: { glyph: "◀", word: "EXIT", color: C.exit },
  settled: { glyph: "✓", word: "SETTLED", color: C.tick },
  failed: { glyph: "×", word: "FAILED", color: C.fail },
  pending: { glyph: " ", word: "", color: C.dim },
};

/** One piece of a line, with the width it is padded or truncated to. */
export interface Segment {
  readonly text: string;
  readonly color?: number;
  /** Omit on exactly one segment to let it take the remaining width. */
  readonly width?: number;
}

export interface VisualLine {
  readonly segments: readonly Segment[];
}

export function fit(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const glyphs = [...value];
  if (glyphs.length > width) {
    return width === 1 ? "…" : glyphs.slice(0, width - 1).join("") + "…";
  }
  return value + " ".repeat(width - glyphs.length);
}

export function wrapText(value: string, width: number): string[] {
  if (width <= 0) {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(" ")) {
    if (current === "") {
      current = word;
      continue;
    }
    if ([...current].length + 1 + [...word].length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.length === 0 ? [""] : lines;
}

/** Lay one row of segments out across `width` columns. */
function lineOps(id: string, width: number, line: VisualLine): Op[] {
  const fixedWidth = line.segments.reduce((total, segment) => total + (segment.width ?? 0), 0);
  const flexible = line.segments.filter((segment) => segment.width === undefined).length;
  const remaining = Math.max(0, width - fixedWidth);
  const share = flexible === 0 ? 0 : Math.floor(remaining / flexible);
  const ops: Op[] = [
    open(id, { layout: { width: fixed(width), height: fixed(1), direction: "ltr" } }),
  ];
  let used = 0;
  line.segments.forEach((segment, index) => {
    const isLastFlexible =
      segment.width === undefined &&
      line.segments.slice(index + 1).every((later) => later.width !== undefined);
    const segmentWidth = segment.width ?? (isLastFlexible ? Math.max(0, remaining - used) : share);
    if (segment.width === undefined) {
      used += segmentWidth;
    }
    ops.push(
      open(`${id}.${index}`, { layout: { width: fixed(segmentWidth), height: fixed(1) } }),
      text(fit(segment.text, segmentWidth), { color: segment.color ?? C.src }),
      close(),
    );
  });
  ops.push(close());
  return ops;
}

export interface RegionOptions {
  readonly bg?: number;
  /**
   * Draw this region's own focus marker.
   *
   * The component that *is* focused draws it, from its own node-relative
   * relation. Nothing tells a parent which of its children is focused.
   */
  readonly focused?: boolean;
  /**
   * What this region's children already rendered.
   *
   * A parent wraps them rather than drawing over them, which is what makes the
   * mounted tree and the rendered composition the same shape.
   */
  readonly children?: readonly Op[];
  readonly padding?: { readonly left?: number; readonly right?: number; readonly top?: number };
  /**
   * A transition the renderer owns.
   *
   * Declaring it makes `@bomb.sh/tty` interpolate this region between the
   * geometry of one frame and the next, and report `animating` until it
   * settles. The harness supplies the time; it does not do the interpolation.
   */
  readonly transition?: {
    readonly duration: number;
    readonly easing?: "linear" | "easeIn" | "easeOut" | "easeInOut";
    readonly properties: readonly ("x" | "y" | "position" | "width" | "height" | "size" | "bg")[];
  };
}

export function region(
  id: string,
  rect: Rect,
  lines: readonly VisualLine[],
  options: RegionOptions = {},
): Op[] {
  const padLeft = options.padding?.left ?? 1;
  const padRight = options.padding?.right ?? 1;
  const padTop = options.padding?.top ?? 0;
  const innerWidth = Math.max(0, rect.width - padLeft - padRight);
  const capacity = Math.max(0, rect.height - padTop);
  const ops: Op[] = [
    open(id, {
      layout: {
        width: fixed(rect.width),
        height: fixed(rect.height),
        direction: "ttb",
        padding: { left: padLeft, right: padRight, top: padTop },
      },
      floating: { x: rect.x, y: rect.y, attachTo: "root" },
      bg: options.bg ?? BG.app,
      clip: { horizontal: true, vertical: true },
      ...(options.transition === undefined
        ? {}
        : {
            transition: {
              duration: options.transition.duration,
              easing: options.transition.easing,
              properties: [...options.transition.properties],
            },
          }),
    }),
  ];
  lines.slice(0, capacity).forEach((line, index) => {
    ops.push(...lineOps(`${id}.line.${index}`, innerWidth, line));
  });
  ops.push(...(options.children ?? []));
  ops.push(close());
  if (options.focused === true) {
    ops.push(...regionMark(`${id}.focus`, rect));
  }
  return ops;
}

/** The glyph a focused region wears at its top-left corner. */
const REGION_MARK = "\u258c";

/**
 * A focused region's own marker.
 *
 * A glyph rather than a colour, so focus survives a monochrome terminal and a
 * committed `.txt` capture. It is separate from `region()` because a region is
 * not always the thing that draws its own box: the way out of a drawer is a
 * region of the drawer's, drawn over the band it names.
 */
export function regionMark(id: string, rect: Rect): Op[] {
  if (rect.width <= 0 || rect.height <= 0) {
    return [];
  }
  return [
    open(id, {
      layout: { width: fixed(1), height: fixed(1) },
      floating: { x: rect.x, y: rect.y, attachTo: "root" },
    }),
    text(REGION_MARK, { color: C.focus }),
    close(),
  ];
}

export function rule(id: string, rect: Rect, glyph: string): Op[] {
  const ops: Op[] = [
    open(id, {
      layout: { width: fixed(rect.width), height: fixed(rect.height), direction: "ttb" },
      floating: { x: rect.x, y: rect.y, attachTo: "root" },
      bg: BG.rule,
      clip: { horizontal: true, vertical: true },
    }),
  ];
  for (let row = 0; row < rect.height; row += 1) {
    ops.push(
      open(`${id}.${row}`, { layout: { width: fixed(rect.width), height: fixed(1) } }),
      text(glyph.repeat(Math.max(0, rect.width)), { color: C.rule }),
      close(),
    );
  }
  ops.push(close());
  return ops;
}

/**
 * How long the drawer takes to arrive, in the renderer's own unit.
 *
 * `@bomb.sh/tty` measures transitions in **seconds** — both this duration and
 * the `deltaTime` a frame is advanced by. The harness thinks in milliseconds
 * everywhere else, because that is what `sleep()` and the playback clock speak,
 * and converts once at the renderer's boundary.
 */
export const DRAWER_TRANSITION_SECONDS = 0.26;

/**
 * The drawer's own movement, which the renderer performs.
 *
 * The contextual band is four rows as an input and fourteen as a drawer, and it
 * is bottom-anchored, so both its height and its top edge change when a
 * suspension opens. Declaring the transition is all the harness does; Clay
 * interpolates the geometry and reports `animating` until it arrives.
 */
const DRAWER_TRANSITION = {
  duration: DRAWER_TRANSITION_SECONDS,
  easing: "easeInOut",
  properties: ["height", "y"],
} as const;

/** One numbered entry the overlay draws, derived from the mounted tree. */
export interface OverlayItem {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly number: number;
  readonly focused: boolean;
}

/** The glyph beside the focused entry. */
const FOCUS_MARK = "\u25b8";

/**
 * One control's own focus marker, in the single cell its parent reserved.
 *
 * Drawn by the control, never by its parent: it is the one thing a component
 * says about focus, and it says it only about itself.
 */
export function focusMark(id: string, rect: Rect): Op[] {
  if (rect.width <= 0 || rect.height <= 0) {
    return [];
  }
  return [
    open(id, {
      layout: { width: fixed(1), height: fixed(1) },
      floating: { x: rect.x, y: rect.y, attachTo: "root" },
    }),
    text(FOCUS_MARK, { color: C.focus }),
    close(),
  ];
}

/**
 * The numbered focus map, as a legend rather than as floating callouts.
 *
 * The study numbers its targets on top of the interface, which a browser can do
 * because it measured them. In cells the honest equivalent is a legend: the
 * same numbers, in the same order, with a disabled target dimmed and present —
 * study frame 12 numbers a dimmed `Continue` and says Tab skips it, so the map
 * has to show what the ring does not.
 *
 * Its entries are derived from the mounted tree by its parent, and its box is
 * the placement its parent gave it. It is handed no layout and no application
 * focus state.
 */
export function focusMapRegion(
  id: string,
  ordered: readonly OverlayItem[],
  placement: Placement,
): Op[] {
  const screen = placement.rect;
  const width = Math.min(34, Math.max(18, Math.round(screen.width * 0.24)));
  const height = Math.min(screen.height, ordered.length + 2);
  const rect = { x: Math.max(0, screen.width - width - 1), y: 1, width, height };
  const lines: VisualLine[] = [label("FOCUS MAP · F1")];
  for (const target of ordered) {
    lines.push({
      segments: [
        { text: target.focused ? `${FOCUS_MARK} ` : "  ", color: C.focus, width: 2 },
        { text: `${target.number}`, color: target.enabled ? C.out : C.dim, width: 3 },
        { text: target.label, color: target.enabled ? C.src : C.dim },
      ],
    });
  }
  return region(id, rect, lines, { bg: BG.drawer });
}

export function blank(): VisualLine {
  return { segments: [{ text: "" }] };
}

export function plain(value: string, color = C.src): VisualLine {
  return { segments: [{ text: value, color }] };
}

export function label(value: string): VisualLine {
  return plain(value, C.label);
}

/**
 * The transcript's rows, already wrapped and railed.
 *
 * A rail runs from a component's opening boundary to its matching close, so a
 * reader can see which nested scope a line belongs to. That is why this returns
 * visual lines rather than the semantic rows: the window that scrolls them has
 * to count what the terminal will actually show.
 */
export function transcriptLines(entry: Entry, width: number, collapse = true): VisualLine[] {
  const lines: VisualLine[] = [];
  const openDepths: number[] = [];
  const wordColumn = width >= 56 ? 8 : 0;

  const prefixFor = (depth: number, exclude?: number): string => {
    let prefix = "";
    for (let level = 0; level < depth; level += 1) {
      const railed = openDepths.includes(level) && level !== exclude;
      prefix += railed ? "│ " : "  ";
    }
    return prefix;
  };

  const push = (row: TranscriptRow) => {
    if (row.kind === "lifecycle") {
      const style = PHASE[row.phase];
      const prefix = prefixFor(row.depth, row.close ? row.depth : undefined);
      const head = `${prefix}${style.glyph} `;
      const body = width - head.length - wordColumn;
      lines.push({
        segments: [
          { text: head, color: style.color, width: head.length },
          // Depth already indents the line, so the source's own leading spaces
          // would indent it twice.
          { text: fit(row.source.trimStart(), Math.max(0, body)), color: C.src },
          ...(wordColumn > 0 ? [{ text: style.word, color: style.color, width: wordColumn }] : []),
        ],
      });
      if (row.pair !== undefined && !row.close) {
        openDepths.push(row.depth);
      }
      if (row.pair !== undefined && row.close) {
        const at = openDepths.lastIndexOf(row.depth);
        if (at >= 0) {
          openDepths.splice(at, 1);
        }
      }
      return;
    }
    if (row.kind === "section") {
      const prefix = prefixFor(row.depth);
      const glyph = row.state === "collapsed" ? "✓" : "▾";
      const color = row.state === "collapsed" ? C.settledText : C.intro;
      const summary =
        collapse && row.state === "collapsed" ? `${row.name} · ${row.published}` : row.name;
      lines.push({
        segments: [
          {
            text: `${prefix}${glyph} `,
            color: row.state === "collapsed" ? C.tick : C.intro,
            width: prefix.length + 2,
          },
          { text: summary, color },
        ],
      });
      return;
    }
    if (row.kind === "fence") {
      const prefix = prefixFor(row.depth);
      const inner = width - prefix.length - 2;
      const border = (content: string, color: number) => {
        lines.push({
          segments: [
            { text: `${prefix}│ `, color: C.rule, width: prefix.length + 2 },
            { text: fit(content, Math.max(0, inner)), color },
          ],
        });
      };
      border(row.label, C.label);
      for (const fenced of row.lines) {
        border(fenced, fenced.startsWith("#") ? C.intro : C.src);
      }
      if (row.caption !== undefined) {
        border(row.caption, C.dim);
      }
      return;
    }
    const prefix = prefixFor(row.depth);
    const color =
      row.emphasis === "dim"
        ? C.dim
        : row.emphasis === "title"
          ? C.out
          : row.emphasis === "strong"
            ? C.hold
            : C.src;
    for (const wrapped of wrapText(row.text, Math.max(1, width - prefix.length))) {
      lines.push({
        segments: [
          { text: prefix, width: prefix.length },
          { text: wrapped, color },
        ],
      });
    }
  };

  for (const row of entry.rows) {
    push(row);
  }
  return lines;
}

function entryHeader(entry: Entry): VisualLine {
  const running = entry.state === "running";
  return {
    segments: [
      { text: entry.id, color: C.out, width: entry.id.length + 2 },
      {
        text: running ? `● running · ${entry.elapsed}s` : `✓ completed · ${entry.elapsed}s`,
        color: running ? C.active : C.tick,
        width: 24,
      },
      { text: entry.scopeNote, color: C.dim },
    ],
  };
}

/**
 * One suspension's drawer.
 *
 * The drawing is the study's. What changed is that it takes a `DrawerView` and
 * the box its parent gives it, so the same body serves the component tree and
 * the rectangle path while both exist.
 */
/** One 1×1 cell a control owns, to draw its own focus marker in. */
export interface Slot {
  readonly id: string;
  readonly rect: Rect;
}

/**
 * The drawer's lines, and the gutter cell each of its controls owns.
 *
 * Both come out of one pass. A slot computed apart from the line it sits in
 * would be a second layout free to disagree with the first, and the marker
 * would drift off the word it belongs to.
 *
 * The drawer draws the text and *reserves* the gutter; it never fills it. Which
 * control holds focus is the control's own to say, so the glyph is drawn by the
 * control, from its own relation to focus. The gutter appears only while focus
 * is somewhere inside this drawer, which is a fact about this node and its own
 * subtree — and it is why a drawer nothing is focused in is drawn exactly as
 * #838 drew it.
 */
function drawerContent(
  drawer: DrawerView,
  placement: Placement,
  gutter: boolean,
): { readonly lines: VisualLine[]; readonly slots: Slot[] } {
  const rect = placement.rect;
  const width = Math.max(0, rect.width - 2);
  const lines: VisualLine[] = [];
  const slots: Slot[] = [];
  // A recorded drawer offers nothing to act on, so it spends no column on a
  // gutter: focus is inside it — on the way out — but none of its controls can
  // ever hold it, and a gutter would promise one that could.
  const reserve = gutter && !drawer.historical;
  /** Reserve the gutter on the line about to be pushed, at `column` within it. */
  const mark = (id: string, column: number): string => {
    if (!reserve) {
      return "";
    }
    // Only a line this box actually draws gets a cell. The region clips its own
    // text; a marker floats above the screen and is clipped by nothing, so a
    // cell on a line the drawer has no room for would draw over whatever is
    // there instead — which is what a band shrunk to the closed drawer's height
    // does during the frame before one opens.
    const y = rect.y + lines.length;
    if (lines.length < rect.height && column + 1 < rect.width) {
      slots.push({ id, rect: { x: rect.x + 1 + column, y, width: 1, height: 1 } });
    }
    return "  ";
  };
  lines.push(plain(drawer.heading, C.hold));
  // Which suspended request this is answering is never dropped: a drawer
  // without its origin is a form with no idea what it belongs to.
  for (const wrapped of wrapText(drawer.origin, width)) {
    lines.push(plain(wrapped, C.dim));
  }
  if (drawer.historical) {
    // What this is comes before what it says: a recording offers nothing to
    // act on, and a reader should know that before reading the form. It also
    // has to survive a band that clips — appended last, it did not.
    lines.push(plain("recorded · read-only", C.gold));
  }
  lines.push(blank());
  if (drawer.kind === "project") {
    for (const wrapped of wrapText(drawer.prompt, width)) {
      lines.push(plain(wrapped, C.src));
    }
    lines.push(blank());
    for (const field of drawer.fields) {
      const id = `field:drawer.project.${field.label === "Project name" ? "name" : "description"}`;
      lines.push(label(`${mark(id, 0)}${field.label}`));
      lines.push({
        segments: [
          { text: "┃ ", color: C.rule, width: 2 },
          { text: field.value, color: C.out },
        ],
      });
    }
    lines.push(blank());
    const validationWidth = Math.min(width, 20);
    lines.push({
      segments: [
        { text: drawer.validation, color: C.dim, width: validationWidth },
        {
          text: `${mark("control:drawer.project.submit", validationWidth)}${drawer.submit}`,
          color: C.tick,
        },
      ],
    });
    if (!placement.dense) {
      lines.push(blank());
      lines.push(label(`${mark("control:drawer.project.schema", 0)}schema`));
      for (const schema of drawer.schema) {
        lines.push(plain(schema, C.settledText));
      }
    }
  }
  if (drawer.kind === "review") {
    lines.push(plain(`${mark("control:drawer.review.scroll", 0)}${drawer.plan[0] ?? ""}`, C.src));
    for (const planLine of drawer.plan.slice(1)) {
      lines.push(plain(planLine, C.src));
    }
    lines.push(plain(drawer.more, C.dim), blank());
    const decided = ["approve", "request", "stop"];
    drawer.decisions.forEach((decision, index) => {
      lines.push({
        segments: [
          {
            text: decision.chosen ? "(•) " : "( ) ",
            color: decision.chosen ? C.tick : C.label,
            width: 4,
          },
          {
            text: `${mark(`control:drawer.review.${decided[index] ?? index}`, 4)}${decision.label}`,
            color: decision.chosen ? C.out : C.src,
          },
        ],
      });
    });
    lines.push(blank());
    lines.push(plain(`${mark("control:drawer.review.submit", 0)}${drawer.submit}`, C.tick));
  }
  if (drawer.kind === "confirm") {
    for (const wrapped of wrapText(drawer.prompt, width)) {
      lines.push(plain(wrapped, C.src));
    }
    drawer.preview.forEach((preview, index) => {
      lines.push({
        segments: [
          { text: "│ ", color: C.rule, width: 2 },
          {
            text: index === 0 ? `${mark("control:drawer.confirm.preview", 2)}${preview}` : preview,
            color: C.src,
          },
        ],
      });
    });
    lines.push(blank());
    let column = 0;
    lines.push({
      segments: drawer.actions.map((action) => {
        const at = column;
        const segmentWidth = action.label.length + 6 + (reserve ? 2 : 0);
        column += segmentWidth;
        return {
          text: `[ ${mark(
            `control:drawer.confirm.${action.label.toLowerCase()}`,
            at + 2,
          )}${action.label} ]`,
          color: action.primary ? C.tick : C.label,
          width: segmentWidth,
        };
      }),
    });
    lines.push(plain(drawer.hint, C.dim));
  }
  return { lines, slots };
}

/** Where each of this drawer's controls may draw its own marker. */
export function drawerSlots(
  drawer: DrawerView,
  placement: Placement,
  gutter: boolean,
): readonly Slot[] {
  return drawerContent(drawer, placement, gutter).slots;
}

/**
 * One suspension's drawer.
 *
 * The drawing is the study's. What changed is that it takes a `DrawerView` and
 * the box its parent gives it, so the same body serves the component tree and
 * the rectangle path while both exist.
 */
export function drawerRegion(
  id: string,
  drawer: DrawerView,
  placement: Placement,
  focused = false,
  gutter = false,
): Op[] {
  return region(id, placement.rect, drawerContent(drawer, placement, gutter).lines, {
    bg: BG.drawer,
    transition: DRAWER_TRANSITION,
    focused,
  });
}

/** The columns the `Run` affordance is written in, focused or not. */
const RUN_WIDTH = 12;

/** The REPL input band, which the drawer takes over while one is open. */
export function inputRegion(
  id: string,
  input: InputView,
  placement: Placement,
  focused = false,
): Op[] {
  const rect = placement.rect;
  const width = Math.max(0, rect.width - 2);
  const lines: VisualLine[] = [
    {
      segments: [
        { text: input.label, color: C.label, width: Math.min(width, 18) },
        { text: input.hint, color: input.run !== undefined ? C.dim : C.hold },
        {
          text: input.run !== undefined ? "[ Run ⌘⏎ ]" : "[ Run ]",
          color: input.run !== undefined ? C.tick : C.dim,
          width: RUN_WIDTH,
        },
      ],
    },
    plain(input.draft === "" ? input.placeholder : input.draft, C.settledText),
  ];
  return region(id, rect, lines, { bg: BG.input, transition: DRAWER_TRANSITION, focused });
}

/**
 * The cell the `Run` affordance's own control may draw its marker in.
 *
 * The band writes `[ Run ⌘⏎ ]` in a fixed twelve-column segment at the right
 * end of its first line, so the marker replaces the space inside the bracket
 * and the affordance keeps its width — the same bargain the transport controls
 * strike, and for the same reason.
 */
export function inputSlot(placement: Placement): Rect | undefined {
  const rect = placement.rect;
  const inner = Math.max(0, rect.width - 2);
  if (inner < RUN_WIDTH + 1) {
    return undefined;
  }
  return { x: rect.x + 1 + (inner - RUN_WIDTH) + 1, y: rect.y, width: 1, height: 1 };
}

export function clock(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const rest = Math.floor(Math.max(0, seconds) % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export interface Transport {
  readonly word: string;
  readonly color: number;
  readonly controls: readonly string[];
}

export function transportFor(mode: TransportMode, dense: boolean): Transport {
  if (mode === "live") {
    return { word: "LIVE", color: C.active, controls: ["Pause"] };
  }
  if (mode === "paused") {
    return {
      word: "PAUSED",
      color: C.dim,
      controls: ["Continue", dense ? "Return" : "Return to paused head"],
    };
  }
  if (mode === "inspecting") {
    return {
      word: dense ? "INSPECTING" : "INSPECTING HISTORY",
      color: C.gold,
      controls: [
        "Continue",
        dense ? "Return" : "Return to paused head",
        dense ? "Fork" : "Fork from here",
      ],
    };
  }
  return { word: "IDLE", color: C.dim, controls: ["Pause"] };
}

/** What one column of the band is carrying. */
export interface Notch {
  readonly column: number;
  /** The recorded markers sharing this column, which the band gathers. */
  readonly markers: readonly MarkerView[];
}

/**
 * Which checkpoints share which column.
 *
 * Markers that would land on the same column are gathered rather than drawn
 * over one another, because a marker drawn over its neighbour is a checkpoint
 * the band is silently not showing. The gathered count is what the band draws,
 * and the scrubber still steps through every checkpoint behind it.
 */
export function notchLayout(
  history: HistoryView,
  trackLeft: number,
  trackWidth: number,
  mutation?: Mutation,
): Notch[] {
  if (mutation === "clip-long-transcript") {
    return history.markers.map((marker) => ({
      column: columnFor(marker.at, history, trackLeft, trackWidth),
      markers: [marker],
    }));
  }
  const columns = new Map<number, MarkerView[]>();
  for (const marker of history.markers) {
    const column = columnFor(marker.at, history, trackLeft, trackWidth);
    const bucket = columns.get(column) ?? [];
    bucket.push(marker);
    columns.set(column, bucket);
  }
  return [...columns.entries()]
    .map(([column, markers]) => ({ column, markers }))
    .toSorted((one, other) => one.column - other.column);
}

export function columnFor(
  at: number,
  history: Pick<HistoryView, "headAt">,
  trackLeft: number,
  trackWidth: number,
): number {
  const span = 72;
  const end = Math.max(history.headAt, 6);
  const start = Math.max(0, end - span);
  const ratio = (at - start) / Math.max(1, end - start);
  return trackLeft + Math.min(trackWidth - 1, Math.max(0, Math.round(ratio * (trackWidth - 1))));
}

export interface BandGeometry {
  readonly transport: Transport;
  readonly right: string;
  readonly inner: number;
  readonly labelWidth: number;
  readonly trackLeft: number;
  readonly trackWidth: number;
}

/**
 * How much of the band the track actually gets.
 *
 * The study's own rule is that the track yields room to exactly the transport
 * controls that are visible in that mode, so inspecting history — which shows
 * three controls — leaves a much shorter track than running does. The head's
 * label sits just right of the head, so it is reserved too.
 */
/**
 * How much of the band the track gets, asked of the semantic view.
 *
 * The band's arithmetic is about what is *shown* — which transport controls are
 * visible, how wide their labels are — so it takes the view model rather than a
 * fixture. Nothing about a checkpoint's storage reaches it.
 */
export function bandGeometry(history: HistoryView, placement: Placement): BandGeometry {
  const rect = placement.rect;
  const transport = transportFor(
    history.transport,
    placement.dense || placement.profile === "narrow",
  );
  const controls = transport.controls.map((control) => `[ ${control} ]`).join(" ");
  const right = `${transport.word}  ${controls}`;
  const inner = Math.max(0, rect.width - 2);
  // A narrow band spends its columns on the track instead of on a label the
  // surface bar above it already carries.
  const labelWidth =
    placement.profile === "narrow" ? 10 : Math.min(Math.max(18, Math.round(rect.width * 0.12)), 26);
  const headLabelRoom = history.transport === "live" ? 8 : 15;
  const rightReserve = Math.min(inner - labelWidth - 4, [...right].length + 2 + headLabelRoom);
  return {
    transport,
    right,
    inner,
    labelWidth,
    trackLeft: labelWidth,
    trackWidth: Math.max(1, inner - labelWidth - rightReserve),
  };
}

/**
 * The cell each transport control may draw its own marker in.
 *
 * One per control, in the band's own order — the same order the tree mounts
 * them in, because both read the same transport mode. The marker replaces the
 * space inside the bracket rather than widening it: the track's room is
 * computed from that string, and a focused control that shortened the track
 * would make focus a layout decision.
 */
export function transportSlots(history: HistoryView, placement: Placement): readonly Rect[] {
  const rect = placement.rect;
  const geometry = bandGeometry(history, placement);
  const right = [...geometry.right];
  const slots: Rect[] = [];
  let column = Math.max(0, geometry.inner - right.length) + [...geometry.transport.word].length + 2;
  for (const control of geometry.transport.controls) {
    const cell = column + 1;
    slots.push(
      cell < geometry.inner
        ? { x: rect.x + 1 + cell, y: rect.y, width: 1, height: 1 }
        : { x: 0, y: 0, width: 0, height: 0 },
    );
    // `[ ` + the word + ` ]`, then the space that joins it to the next one.
    column += [...control].length + 5;
  }
  return slots;
}

/**
 * How tall the notch for one scope depth is.
 *
 * Height carries depth and nothing else: the shallowest scope gets the whole
 * band and each level in takes one row less. Four depths are what four rows can
 * spell, so anything deeper shares the shortest notch and says so with a glyph.
 */
export function notchHeightForDepth(depth: number): number {
  return Math.max(1, 4 - Math.min(depth, 3));
}

/** The band's rows: four a notch can reach, and the label row below them. */
export const BAND_ROWS = [0, 1, 2, 3, 4] as const;

/** Where the track runs, and where a notch of depth 3 sits. */
export const TRACK_ROW = 3;

/** The row the selection's label owns, which no notch reaches. */
export const NOTE_ROW = 4;

/** True where a depth is deeper than the band has heights for. */
export function isDeeperThanBand(depth: number): boolean {
  return depth > 3;
}

/**
 * The Execution History band.
 *
 * A notch's height is its scope depth — depth 0 fills all four rows, depth 3
 * takes the track row alone — because that is the settled meaning of notch
 * height. Everything else about a marker is said some other way: the playhead is
 * its own full-height stem with a label, a selection is gold with a caret under
 * it, an entry boundary is `◆` where an ordinary event is `●`, and a column
 * holding several checkpoints shows how many.
 */
export function bandRegion(
  id: string,
  history: HistoryView,
  placement: Placement,
  mutation?: Mutation,
  headAt = history.headAt,
  focused = false,
): Op[] {
  const rect = placement.rect;
  const flat = mutation === "flatten-notches";
  const geometry = bandGeometry(history, placement);
  const { transport, inner, labelWidth, trackLeft, trackWidth } = geometry;
  // The marker replaces the space inside the bracket rather than widening it:
  // the track's room is computed from this string, and a focused control that
  // shortened the track would make focus a layout decision.
  const right = geometry.right;

  const grid: string[][] = BAND_ROWS.map(() => Array.from({ length: inner }, () => " "));
  const colors: number[][] = BAND_ROWS.map(() => Array.from({ length: inner }, () => C.dim));

  const put = (row: number, column: number, glyph: string, color: number) => {
    if (row < 0 || row >= BAND_ROWS.length || column < 0 || column >= inner) {
      return;
    }
    grid[row][column] = glyph;
    colors[row][column] = color;
  };

  const putText = (row: number, column: number, value: string, color: number) => {
    [...value].forEach((glyph, offset) => {
      put(row, column + offset, glyph, color);
    });
  };

  const hasHistory = history.markers.length > 0;
  const selectedCheckpoint = history.markers.find((marker) => marker.selected);

  // Text goes down before the markers do, so a notch or a caret always wins the
  // column it belongs in rather than being written over by a label.
  const compact = labelWidth < 18;
  putText(0, 0, fit(compact ? "HISTORY" : "EXECUTION HISTORY", labelWidth - 1), C.label);
  putText(
    1,
    0,
    fit(
      hasHistory
        ? compact
          ? history.elapsed
          : `recorded · ${history.elapsed}`
        : "No recorded execution yet",
      labelWidth - 1,
    ),
    C.dim,
  );
  putText(2, 0, fit(history.entryId ?? "", labelWidth - 1), C.dim);
  putText(0, Math.max(0, inner - [...right].length), right, transport.color);

  if (hasHistory) {
    const headColumn = columnFor(headAt, history, trackLeft, trackWidth);
    const note =
      selectedCheckpoint !== undefined
        ? `▲ ${clock(selectedCheckpoint.at)} · snapped · ${(
            history.headAt - selectedCheckpoint.at
          ).toFixed(1)}s before head`
        : history.compressed
          ? history.compressed.note
          : "notch height is scope depth · digits mark coalesced checkpoints";
    const anchor =
      selectedCheckpoint !== undefined
        ? columnFor(selectedCheckpoint.at, history, trackLeft, trackWidth)
        : history.compressed
          ? columnFor(history.compressed.at, history, trackLeft, trackWidth)
          : trackLeft;
    // The label row is the band's fifth, which no notch reaches, so the note
    // can sit under the marker it describes without shortening it.
    const noteColumn = Math.max(0, Math.min(anchor, inner - [...note].length));
    putText(NOTE_ROW, noteColumn, note, selectedCheckpoint !== undefined ? C.gold : C.dim);
  }

  if (hasHistory) {
    const headColumn = columnFor(headAt, history, trackLeft, trackWidth);
    for (let column = trackLeft; column <= headColumn && column < inner; column += 1) {
      put(TRACK_ROW, column, "─", C.rule);
    }

    const selected = selectedCheckpoint;
    const notches = notchLayout(history, trackLeft, trackWidth, mutation);

    for (const notch of notches) {
      const boundary = notch.markers.some((marker) => marker.boundary);
      const deepest = Math.max(...notch.markers.map((marker) => marker.depth));
      const later =
        selected !== undefined && notch.markers.every((marker) => marker.at > selected.at);
      const color = later ? C.dim : boundary ? C.out : C.active;
      const coalesced = notch.markers.length > 1;
      // The shallowest scope in the column owns the notch's height, so a
      // coalesced column never hides the outermost thing that happened there.
      const shallowest = Math.min(...notch.markers.map((marker) => marker.depth));
      const chosen =
        selected !== undefined && notch.markers.some((marker) => marker.at === selected.at);
      const glyph = coalesced
        ? notch.markers.length < 10
          ? String(notch.markers.length)
          : "+"
        : boundary
          ? "◆"
          : isDeeperThanBand(deepest)
            ? "·"
            : "●";
      const notchColor = chosen ? C.gold : color;
      put(TRACK_ROW, notch.column, glyph, notchColor);
      // The notch rises from the track row, one row per level out, so its
      // height is the depth and nothing else about it is.
      const height = flat ? 1 : notchHeightForDepth(shallowest);
      for (let row = TRACK_ROW - 1; row > TRACK_ROW - height; row -= 1) {
        put(row, notch.column, "│", notchColor);
      }
    }

    if (history.compressed) {
      put(TRACK_ROW, columnFor(history.compressed.at, history, trackLeft, trackWidth), "≈", C.hold);
    }

    // The playhead is not a notch and does not borrow a notch's meaning: it is
    // a heavier stem over the notch rows, and it carries its own label.
    const headColor = history.transport === "live" ? C.active : C.dim;
    for (const row of flat ? [TRACK_ROW] : [0, 1, 2, 3]) {
      put(row, headColumn, "┃", headColor);
    }

    // The head's label goes down last. A moving head passes over notches, and
    // what a person needs to read there is where the head is, not the stem of
    // a marker it happens to be beside.
    const headLabel =
      history.transport === "live"
        ? "LIVE"
        : history.transport === "idle"
          ? "SETTLED"
          : "PAUSED HEAD";
    if (headColumn + 2 + headLabel.length < inner - [...right].length) {
      putText(0, headColumn + 2, headLabel, headColor);
      putText(1, headColumn + 2, clock(headAt), C.dim);
    }
  }

  const lines: VisualLine[] = BAND_ROWS.map((row) => ({
    segments: runsOf(grid[row], colors[row]),
  }));

  // Narrow routing gives the band a whole screen. The extra rows carry the
  // checkpoint list, so a marker the band had to coalesce is still readable —
  // summarizing the track is only honest if the detail is somewhere.
  if (rect.height > 6) {
    lines.push(blank(), label("CHECKPOINTS"));
    const room = rect.height - lines.length;
    const listed = history.markers.slice(0, Math.max(0, room - 1));
    for (const marker of listed) {
      const on = marker.selected;
      lines.push({
        segments: [
          { text: clock(marker.at), color: on ? C.gold : C.dim, width: 6 },
          {
            text: marker.boundary ? "◆" : isDeeperThanBand(marker.depth) ? "·" : "●",
            color: on ? C.gold : C.active,
            width: 2,
          },
          { text: marker.label, color: on ? C.out : C.src },
          { text: marker.scope, color: C.dim, width: Math.min(28, Math.max(0, rect.width - 40)) },
        ],
      });
    }
    const hidden = history.markers.length - listed.length;
    if (hidden > 0) {
      lines.push(plain(`▸ ${hidden} more checkpoints · ←/→ moves through every one`, C.dim));
    }
  }

  return region(id, rect, lines, { bg: BG.footer, padding: { left: 1, right: 1 }, focused });
}

/** Keep each cell's colour when a grid row becomes segments. */
export function runsOf(glyphs: readonly string[], colors: readonly number[]): Segment[] {
  const segments: Segment[] = [];
  let run = "";
  let color = colors[0] ?? C.dim;
  glyphs.forEach((glyph, index) => {
    const at = colors[index] ?? C.dim;
    if (at !== color && run !== "") {
      segments.push({ text: run, color, width: [...run].length });
      run = "";
    }
    color = at;
    run += glyph;
  });
  if (run !== "") {
    segments.push({ text: run, color, width: [...run].length });
  }
  return segments;
}

export function surfaceBarRegion(
  id: string,
  crumb: string,
  badge: string | undefined,
  surface: SurfaceName,
  rect: Rect,
  notice = "",
): Op[] {
  const names = {
    sessions: "SESSIONS",
    transcript: "TRANSCRIPT",
    bindings: "BINDINGS",
    history: "EXECUTION HISTORY",
  };
  const at = ["sessions", "transcript", "bindings", "history"].indexOf(surface) + 1;
  return region(
    id,
    rect,
    [
      {
        segments: [
          { text: `${names[surface]} · ${at} / 4`, color: C.intro, width: 27 },
          // A refusal takes the line over: it is about the last thing the
          // person did, and there is nowhere else this narrow to put it.
          { text: notice === "" ? (badge ?? crumb) : notice, color: refusalColor(badge, notice) },
          { text: "Tab ▸", color: C.label, width: 7 },
        ],
      },
    ],
    { bg: BG.side },
  );
}

/** Amber for a refusal, gold for a badge, dim for an ordinary crumb. */
function refusalColor(badge: string | undefined, notice: string): number {
  if (notice !== "") {
    return C.hold;
  }
  return badge === undefined ? C.dim : C.gold;
}

export function tooSmallRegion(id: string, layout: Layout): Op[] {
  const lines: VisualLine[] = [
    plain("Terminal too small", C.out),
    plain(
      `${MINIMUM.cols} × ${MINIMUM.rows} required · ${layout.cols} × ${layout.rows} now`,
      C.hold,
    ),
    plain("resize to continue", C.dim),
  ];
  return region(id, layout.screen, lines, {
    bg: BG.app,
    padding: { left: 1, right: 1, top: 1 },
  });
}
