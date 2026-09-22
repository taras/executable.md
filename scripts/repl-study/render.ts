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

import type { Checkpoint, Entry, Fixture, Phase, TranscriptRow } from "./model.ts";
import type { Layout, Rect } from "./layout.ts";
import { MINIMUM } from "./layout.ts";
import type { View } from "./view.ts";
import type { Mutation } from "./mutations.ts";

const C = {
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
};

const BG = {
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

function fit(value: string, width: number): string {
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

interface RegionOptions {
  readonly bg?: number;
  readonly padding?: { readonly left?: number; readonly right?: number; readonly top?: number };
}

function region(
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
    }),
  ];
  lines.slice(0, capacity).forEach((line, index) => {
    ops.push(...lineOps(`${id}.line.${index}`, innerWidth, line));
  });
  ops.push(close());
  return ops;
}

function rule(id: string, rect: Rect, glyph: string): Op[] {
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

function blank(): VisualLine {
  return { segments: [{ text: "" }] };
}

function plain(value: string, color = C.src): VisualLine {
  return { segments: [{ text: value, color }] };
}

function label(value: string): VisualLine {
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

function transcriptRegion(fixture: Fixture, view: View, rect: Rect, mutation?: Mutation): Op[] {
  const width = Math.max(0, rect.width - 2);
  const lines: VisualLine[] = [];
  if (!fixture.entry) {
    lines.push(label("TRANSCRIPT"), blank(), plain("No executions yet.", C.dim), blank());
    for (const wrapped of wrapText(
      "Submitted blocks append here as immutable entries. Each entry keeps its source, its rendered output, and the bindings it published.",
      width,
    )) {
      lines.push(plain(wrapped, C.dim));
    }
    return region("transcript", rect, lines, { bg: BG.center });
  }

  lines.push(entryHeader(fixture.entry), blank());
  const body = transcriptLines(fixture.entry, width);
  const capacity = Math.max(0, rect.height - lines.length);
  const windowed =
    mutation === "clip-long-transcript"
      ? body
      : body.slice(view.anchor, view.anchor + Math.max(0, capacity - 1));
  lines.push(...windowed);
  if (mutation !== "clip-long-transcript") {
    const remaining = body.length - view.anchor - windowed.length;
    if (remaining > 0) {
      lines.push(plain(`▸ ${remaining} more lines · ↑↓ PgUp PgDn`, C.dim));
    } else if (view.anchor > 0) {
      lines.push(plain(`▴ ${view.anchor} earlier lines · ↑ scrolls back`, C.dim));
    }
  }
  return region("transcript", rect, lines, { bg: BG.center });
}

function sidebarRegion(fixture: Fixture, view: View, layout: Layout, rect: Rect): Op[] {
  const lines: VisualLine[] = [];
  const tabs = fixture.sidebar.tab;
  if (!layout.dense && layout.profile === "wide") {
    lines.push(plain("XMD REPL", C.out), blank());
  }
  lines.push(
    {
      segments: [
        { text: "SESSION", color: tabs === "sessions" ? C.intro : C.label, width: 10 },
        { text: "JOURNAL", color: tabs === "journal" ? C.intro : C.label, width: 10 },
        { text: "STATE", color: tabs === "state" ? C.intro : C.label, width: 8 },
      ],
    },
    blank(),
  );

  if (fixture.sidebar.heading !== undefined) {
    lines.push(label(fixture.sidebar.heading));
  }
  if (fixture.sidebar.subheading !== undefined && !layout.dense) {
    lines.push(plain(fixture.sidebar.subheading, C.dim));
  }
  lines.push(blank());

  if (tabs === "journal") {
    const selected = view.checkpoint;
    fixture.history.checkpoints.forEach((point, index) => {
      const on = index === selected;
      const later = selected >= 0 && index > selected;
      lines.push({
        segments: [
          { text: clock(point.at), color: on ? C.gold : C.dim, width: 6 },
          {
            text: point.kind === "entry" ? "◆" : "●",
            color: on ? C.gold : later ? C.dim : C.active,
            width: 2,
          },
          { text: point.label, color: on ? C.out : later ? C.dim : C.src },
        ],
      });
    });
    lines.push(blank(), plain("▸ 26 internal records", C.dim));
    const chosen = fixture.history.checkpoints[selected];
    if (chosen) {
      lines.push(
        blank(),
        label("SELECTED CHECKPOINT"),
        plain(chosen.label, C.out),
        plain(`${clock(chosen.at)} elapsed · ${chosen.scope}`, C.dim),
      );
      for (const record of chosen.records) {
        lines.push(plain(`· ${record}`, C.dim));
      }
    }
    return region("sidebar", rect, lines, { bg: BG.side });
  }

  if (fixture.sessions.length === 0) {
    for (const placeholder of fixture.sidebar.placeholder ?? []) {
      for (const wrapped of wrapText(placeholder, Math.max(1, rect.width - 2))) {
        lines.push(plain(wrapped, C.dim));
      }
    }
    return region("sidebar", rect, lines, { bg: BG.side });
  }

  for (const session of fixture.sessions) {
    lines.push({
      segments: [
        { text: session.selected ? "│ " : "  ", color: C.active, width: 2 },
        { text: session.id, color: session.selected ? C.out : C.name },
      ],
    });
    lines.push({
      segments: [
        { text: "  ", width: 2 },
        {
          text: session.label,
          color:
            session.state === "active" ? C.active : session.state === "completed" ? C.tick : C.dim,
          width: 14,
        },
        { text: layout.dense ? session.agent : `${session.agent} · ${session.turn}`, color: C.dim },
      ],
    });
    if (session.note !== undefined && !layout.dense) {
      lines.push(plain(`  ${session.note}`, C.dim));
    }
    lines.push(blank());
  }
  return region("sidebar", rect, lines, { bg: BG.side });
}

function bindingsRegion(fixture: Fixture, layout: Layout, rect: Rect): Op[] {
  const lines: VisualLine[] = [
    label("BINDINGS"),
    plain(fixture.bindings.scopeName, C.dim),
    blank(),
  ];
  if (fixture.bindings.bindings.length === 0) {
    for (const placeholder of fixture.bindings.placeholder ?? []) {
      for (const wrapped of wrapText(placeholder, Math.max(1, rect.width - 2))) {
        lines.push(plain(wrapped, C.dim));
      }
    }
    return region("bindings", rect, lines, { bg: BG.bind });
  }
  for (const binding of fixture.bindings.bindings) {
    lines.push(plain(binding.name, C.name));
    if (binding.note !== undefined && !layout.dense) {
      lines.push(plain(binding.note, C.dim));
    }
    for (const value of binding.lines) {
      lines.push(plain(value, C.settledText));
    }
    lines.push(blank());
  }
  return region("bindings", rect, lines, { bg: BG.bind });
}

function contextualRegion(fixture: Fixture, view: View, layout: Layout, rect: Rect): Op[] {
  const width = Math.max(0, rect.width - 2);
  if (fixture.drawer && view.drawerOpen) {
    const drawer = fixture.drawer;
    const lines: VisualLine[] = [plain(drawer.heading, C.hold)];
    // Which suspended request this is answering is never dropped: a drawer
    // without its origin is a form with no idea what it belongs to.
    for (const wrapped of wrapText(drawer.origin, width)) {
      lines.push(plain(wrapped, C.dim));
    }
    lines.push(blank());
    if (drawer.kind === "project") {
      for (const wrapped of wrapText(drawer.prompt, width)) {
        lines.push(plain(wrapped, C.src));
      }
      lines.push(blank());
      for (const field of drawer.fields) {
        lines.push(label(field.label));
        lines.push({
          segments: [
            { text: "┃ ", color: C.rule, width: 2 },
            { text: field.value, color: C.out },
          ],
        });
      }
      lines.push(blank(), {
        segments: [
          { text: drawer.validation, color: C.dim, width: Math.min(width, 20) },
          { text: drawer.submit, color: C.tick },
        ],
      });
      if (!layout.dense) {
        lines.push(blank(), label("schema"));
        for (const schema of drawer.schema) {
          lines.push(plain(schema, C.settledText));
        }
      }
    }
    if (drawer.kind === "review") {
      for (const planLine of drawer.plan) {
        lines.push(plain(planLine, C.src));
      }
      lines.push(plain(drawer.more, C.dim), blank());
      for (const decision of drawer.decisions) {
        lines.push({
          segments: [
            {
              text: decision.chosen ? "(•) " : "( ) ",
              color: decision.chosen ? C.tick : C.label,
              width: 4,
            },
            { text: decision.label, color: decision.chosen ? C.out : C.src },
          ],
        });
      }
      lines.push(blank(), plain(drawer.submit, C.tick));
    }
    if (drawer.kind === "confirm") {
      for (const wrapped of wrapText(drawer.prompt, width)) {
        lines.push(plain(wrapped, C.src));
      }
      for (const preview of drawer.preview) {
        lines.push({
          segments: [
            { text: "│ ", color: C.rule, width: 2 },
            { text: preview, color: C.src },
          ],
        });
      }
      lines.push(blank(), {
        segments: drawer.actions.map((action) => ({
          text: `[ ${action.label} ]`,
          color: action.primary ? C.tick : C.label,
          width: action.label.length + 6,
        })),
      });
      lines.push(plain(drawer.hint, C.dim));
    }
    return region("contextual", rect, lines, { bg: BG.drawer });
  }

  const input = fixture.input;
  const lines: VisualLine[] = [
    {
      segments: [
        { text: input.label, color: C.label, width: Math.min(width, 18) },
        { text: input.hint, color: input.runEnabled ? C.dim : C.hold },
        {
          text: input.runEnabled ? "[ Run ⌘⏎ ]" : "[ Run ]",
          color: input.runEnabled ? C.tick : C.dim,
          width: 12,
        },
      ],
    },
    plain(input.placeholder ?? "", C.settledText),
  ];
  return region("contextual", rect, lines, { bg: BG.input });
}

function clock(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const rest = Math.floor(Math.max(0, seconds) % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export interface Transport {
  readonly word: string;
  readonly color: number;
  readonly controls: readonly string[];
}

function transportFor(fixture: Fixture, dense: boolean): Transport {
  const mode = fixture.history.transport;
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
  readonly checkpoints: readonly Checkpoint[];
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
  history: Fixture["history"],
  trackLeft: number,
  trackWidth: number,
  mutation?: Mutation,
): Notch[] {
  if (mutation === "clip-long-transcript") {
    return history.checkpoints.map((checkpoint) => ({
      column: columnFor(checkpoint.at, history, trackLeft, trackWidth),
      checkpoints: [checkpoint],
    }));
  }
  const columns = new Map<number, Checkpoint[]>();
  for (const checkpoint of history.checkpoints) {
    const column = columnFor(checkpoint.at, history, trackLeft, trackWidth);
    const bucket = columns.get(column) ?? [];
    bucket.push(checkpoint);
    columns.set(column, bucket);
  }
  return [...columns.entries()]
    .map(([column, checkpoints]) => ({ column, checkpoints }))
    .toSorted((one, other) => one.column - other.column);
}

export function columnFor(
  at: number,
  history: Fixture["history"],
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
export function bandGeometry(fixture: Fixture, layout: Layout, rect: Rect): BandGeometry {
  const transport = transportFor(fixture, layout.dense || layout.profile === "narrow");
  const controls = transport.controls.map((control) => `[ ${control} ]`).join(" ");
  const right = `${transport.word}  ${controls}`;
  const inner = Math.max(0, rect.width - 2);
  // A narrow band spends its columns on the track instead of on a label the
  // surface bar above it already carries.
  const labelWidth =
    layout.profile === "narrow" ? 10 : Math.min(Math.max(18, Math.round(rect.width * 0.12)), 26);
  const headLabelRoom = fixture.history.transport === "live" ? 8 : 15;
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
 * The Execution History band.
 *
 * Four extents distinguish what sits on the track, which is the study's own
 * vocabulary read into cells: a minor checkpoint takes the track row, an entry
 * boundary rises one row above it, the head takes three rows and carries its
 * label, and a historical selection takes the whole band. Depth is a glyph tier
 * rather than a fifth height — the band has four rows and cannot spend one per
 * nesting level.
 */
function footerRegion(
  fixture: Fixture,
  view: View,
  layout: Layout,
  rect: Rect,
  mutation?: Mutation,
): Op[] {
  const history = fixture.history;
  const flat = mutation === "flatten-notches";
  const { transport, right, inner, labelWidth, trackLeft, trackWidth } = bandGeometry(
    fixture,
    layout,
    rect,
  );

  const grid: string[][] = [0, 1, 2, 3].map(() => Array.from({ length: inner }, () => " "));
  const colors: number[][] = [0, 1, 2, 3].map(() => Array.from({ length: inner }, () => C.dim));

  const put = (row: number, column: number, glyph: string, color: number) => {
    if (row < 0 || row > 3 || column < 0 || column >= inner) {
      return;
    }
    grid[row][column] = glyph;
    colors[row][column] = color;
  };

  const hasHistory = history.checkpoints.length > 0;
  if (hasHistory) {
    const headColumn = columnFor(history.headAt, history, trackLeft, trackWidth);
    for (let column = trackLeft; column <= headColumn && column < inner; column += 1) {
      put(2, column, "─", C.rule);
    }

    const selected = history.checkpoints[view.checkpoint];
    const notches = notchLayout(history, trackLeft, trackWidth, mutation);

    for (const notch of notches) {
      const boundary = notch.checkpoints.some((checkpoint) => checkpoint.kind === "entry");
      const deepest = Math.max(...notch.checkpoints.map((checkpoint) => checkpoint.depth));
      const later =
        selected !== undefined &&
        notch.checkpoints.every((checkpoint) => checkpoint.at > selected.at);
      const color = later ? C.dim : boundary ? C.out : C.active;
      const coalesced = notch.checkpoints.length > 1;
      const glyph = coalesced
        ? notch.checkpoints.length < 10
          ? String(notch.checkpoints.length)
          : "+"
        : boundary
          ? "◆"
          : deepest <= 1
            ? "●"
            : deepest === 2
              ? "◇"
              : "·";
      put(2, notch.column, glyph, color);
      if (boundary && !flat) {
        put(1, notch.column, "│", color);
      }
    }

    if (history.compressed) {
      put(2, columnFor(history.compressed.at, history, trackLeft, trackWidth), "≈", C.hold);
    }

    const headColor = history.transport === "live" ? C.active : C.dim;
    put(2, headColumn, "┃", headColor);
    if (!flat) {
      put(1, headColumn, "│", headColor);
      put(0, headColumn, "│", headColor);
    }

    if (selected !== undefined) {
      const column = columnFor(selected.at, history, trackLeft, trackWidth);
      for (const row of flat ? [2] : [0, 1, 2, 3]) {
        put(row, column, "┃", C.gold);
      }
    }
  }

  const putText = (row: number, column: number, value: string, color: number) => {
    [...value].forEach((glyph, offset) => {
      put(row, column + offset, glyph, color);
    });
  };

  const selected = history.checkpoints[view.checkpoint];

  // A narrow band has no room for the study's full left labels, and truncating
  // them to "EXECUTION HI…" says less than a shorter word that fits. The
  // surface bar above already names the surface there.
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
  putText(2, 0, fit(fixture.entry ? fixture.entry.id : "", labelWidth - 1), C.dim);
  putText(0, Math.max(0, inner - [...right].length), right, transport.color);

  if (hasHistory) {
    const headColumn = columnFor(history.headAt, history, trackLeft, trackWidth);
    const headLabel =
      history.transport === "live"
        ? "LIVE"
        : history.transport === "idle"
          ? "SETTLED"
          : "PAUSED HEAD";
    const headColor = history.transport === "live" ? C.active : C.dim;
    if (headColumn + 2 + headLabel.length < inner - [...right].length) {
      putText(0, headColumn + 2, headLabel, headColor);
      putText(1, headColumn + 2, clock(history.headAt), C.dim);
    }
    const note =
      selected !== undefined
        ? `${clock(selected.at)} · snapped · ${(history.headAt - selected.at).toFixed(1)}s before head`
        : history.compressed
          ? history.compressed.note
          : "digits mark coalesced checkpoints · ←/→ visits each";
    const anchor =
      selected !== undefined
        ? columnFor(selected.at, history, trackLeft, trackWidth)
        : history.compressed
          ? columnFor(history.compressed.at, history, trackLeft, trackWidth)
          : trackLeft;
    // Two columns clear of the marker it describes, so the note never writes
    // over the notch and shortens it.
    const noteColumn = Math.max(0, Math.min(anchor + 2, inner - [...note].length));
    putText(3, noteColumn, note, selected !== undefined ? C.gold : C.dim);
  }

  const lines: VisualLine[] = [0, 1, 2, 3].map((row) => ({
    segments: runsOf(grid[row], colors[row]),
  }));

  // Narrow routing gives the band a whole screen. The extra rows carry the
  // checkpoint list, so a marker the band had to coalesce is still readable —
  // summarizing the track is only honest if the detail is somewhere.
  if (rect.height > 6) {
    lines.push(blank(), label("CHECKPOINTS"));
    const room = rect.height - lines.length;
    const listed = history.checkpoints.slice(0, Math.max(0, room - 1));
    listed.forEach((point, index) => {
      const on = index === view.checkpoint;
      lines.push({
        segments: [
          { text: clock(point.at), color: on ? C.gold : C.dim, width: 6 },
          {
            text:
              point.kind === "entry" ? "◆" : point.depth <= 1 ? "●" : point.depth === 2 ? "◇" : "·",
            color: on ? C.gold : C.active,
            width: 2,
          },
          { text: point.label, color: on ? C.out : C.src },
          { text: point.scope, color: C.dim, width: Math.min(28, Math.max(0, rect.width - 40)) },
        ],
      });
    });
    const hidden = history.checkpoints.length - listed.length;
    if (hidden > 0) {
      lines.push(plain(`▸ ${hidden} more checkpoints · ←/→ moves through every one`, C.dim));
    }
  }

  return region("footer", rect, lines, { bg: BG.footer, padding: { left: 1, right: 1 } });
}

/** Keep each cell's colour when a grid row becomes segments. */
function runsOf(glyphs: readonly string[], colors: readonly number[]): Segment[] {
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

function headerRegion(fixture: Fixture, rect: Rect): Op[] {
  const lines: VisualLine[] = [
    {
      segments: [
        { text: fixture.crumb, color: C.label },
        ...(fixture.badge === undefined
          ? []
          : [{ text: fixture.badge, color: C.gold, width: [...fixture.badge].length + 2 }]),
      ],
    },
    blank(),
  ];
  return region("header", rect, lines, { bg: BG.center });
}

function surfaceBarRegion(fixture: Fixture, view: View, rect: Rect): Op[] {
  const names = {
    sessions: "SESSIONS",
    transcript: "TRANSCRIPT",
    bindings: "BINDINGS",
    history: "EXECUTION HISTORY",
  };
  const at = ["sessions", "transcript", "bindings", "history"].indexOf(view.surface) + 1;
  return region(
    "surface-bar",
    rect,
    [
      {
        segments: [
          { text: `${names[view.surface]} · ${at} / 4`, color: C.intro, width: 27 },
          {
            text: fixture.badge ?? fixture.crumb,
            color: fixture.badge === undefined ? C.dim : C.gold,
          },
          { text: "Tab ▸", color: C.label, width: 7 },
        ],
      },
    ],
    { bg: BG.side },
  );
}

function tooSmallRegion(layout: Layout): Op[] {
  const lines: VisualLine[] = [
    plain("Terminal too small", C.out),
    plain(
      `${MINIMUM.cols} × ${MINIMUM.rows} required · ${layout.cols} × ${layout.rows} now`,
      C.hold,
    ),
    plain("resize to continue", C.dim),
  ];
  return region("too-small", layout.screen, lines, {
    bg: BG.app,
    padding: { left: 1, right: 1, top: 1 },
  });
}

export interface ScreenRequest {
  readonly fixture: Fixture;
  readonly view: View;
  readonly layout: Layout;
  readonly mutation?: Mutation;
}

export function renderScreen(request: ScreenRequest): Op[] {
  const { fixture, view, layout, mutation } = request;
  const ops: Op[] = [
    open("root", { layout: { width: grow(), height: grow(), direction: "ttb" }, bg: BG.app }),
  ];

  if (layout.profile === "too-small") {
    ops.push(...tooSmallRegion(layout), close());
    return ops;
  }

  if (layout.surfaceBar) {
    ops.push(...surfaceBarRegion(fixture, view, layout.surfaceBar));
  }
  if (layout.header) {
    ops.push(...headerRegion(fixture, layout.header));
  }
  if (layout.sidebar) {
    ops.push(...sidebarRegion(fixture, view, layout, layout.sidebar));
  }
  if (layout.transcript) {
    ops.push(...transcriptRegion(fixture, view, layout.transcript, mutation));
  }
  if (layout.bindings) {
    ops.push(...bindingsRegion(fixture, layout, layout.bindings));
  }
  const covering =
    mutation === "drawer-covers-footer" && layout.footer !== undefined && view.drawerOpen;
  if (layout.contextual && !covering) {
    ops.push(...contextualRegion(fixture, view, layout, layout.contextual));
  }
  if (layout.footer) {
    ops.push(...footerRegion(fixture, view, layout, layout.footer, mutation));
  }
  if (layout.contextual && covering) {
    // Drawn last, so it lands on top of the band the study says is never
    // covered — which is the point of this control.
    ops.push(
      ...contextualRegion(fixture, view, layout, {
        ...layout.contextual,
        height: layout.contextual.height + layout.footer!.height,
      }),
    );
  }
  for (const [index, separator] of layout.separators.entries()) {
    ops.push(...rule(`rule.${index}`, separator, separator.width === 1 ? "│" : "─"));
  }
  ops.push(close());
  return ops;
}
