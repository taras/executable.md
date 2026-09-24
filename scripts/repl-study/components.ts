/**
 * The REPL's components: one render body each, attached to one Freedom node.
 *
 * Every body here takes its **own immutable view subtree** and the box its
 * parent gave it, and returns terminal operations wrapping whatever its
 * children already rendered. None of them can reach the journal, the store, the
 * tree or the terminal — a component that could would be able to act on the
 * application without saying so as an action.
 *
 * The drawing primitives come from `render.ts`, which still owns the study's
 * colours, glyphs and line arithmetic. What moved here is *which* component
 * draws *what*, which is the part the mounted tree now decides.
 */

import { close, fixed, open, text } from "@bomb.sh/tty";
import type { Op } from "@bomb.sh/tty";

import type { Body } from "./component.ts";
import {
  bandRegion,
  BG,
  drawerRegion,
  focusMapRegion,
  focusMark,
  regionMark,
  inputRegion,
  rule,
  surfaceBarRegion,
  tooSmallRegion,
  blank,
  C,
  clock,
  fit,
  label,
  plain,
  region,
  transcriptLines,
  wrapText,
} from "./render.ts";
import type { VisualLine } from "./render.ts";
import type { OverlayEntry } from "./tree.ts";
import type { Layout, Rect, SurfaceName } from "./layout.ts";
import type { Mutation } from "./mutations.ts";
import type { Motion } from "./playback.ts";
import type {
  BindingsView,
  DrawerView,
  ContextualView,
  HistoryView,
  ReplView,
  SessionsView,
  TranscriptView,
} from "./view.ts";
import { isRedacted } from "./view.ts";

/** The crumb line above the panes. */
export const headerBody: Body<Pick<ReplView, "crumb" | "badge" | "notice">> = ({
  self,
  data,
  placement,
}) =>
  region(
    self.id,
    placement.rect,
    [
      {
        segments: [
          { text: data.crumb, color: C.label },
          ...(data.badge === undefined
            ? []
            : [{ text: data.badge, color: C.gold, width: [...data.badge].length + 2 }]),
        ],
      },
      // A refusal has to be seen or it is the same as a button that does
      // nothing, which is the failure the action boundary exists to remove. It
      // gets the row the header already spends on air rather than a share of
      // the crumb's, because a truncated refusal is not a visible one.
      data.notice === "" ? blank() : plain(data.notice, C.hold),
    ],
    { bg: BG.center },
  );

export const sessionsBody: Body<SessionsView> = ({ self, data, placement, children, focus }) => {
  const lines: VisualLine[] = [];
  if (!placement.dense) {
    lines.push(plain("XMD REPL", C.out), blank());
  }
  lines.push(
    {
      segments: [
        { text: "SESSION", color: data.tab === "sessions" ? C.intro : C.label, width: 10 },
        { text: "JOURNAL", color: data.tab === "journal" ? C.intro : C.label, width: 10 },
        { text: "STATE", color: data.tab === "state" ? C.intro : C.label, width: 8 },
      ],
    },
    blank(),
  );
  if (data.heading !== undefined) {
    lines.push(label(data.heading));
  }
  if (data.subheading !== undefined && !placement.dense) {
    lines.push(plain(data.subheading, C.dim));
  }
  lines.push(blank());

  if (data.tab === "journal") {
    for (const marker of data.markers) {
      lines.push({
        segments: [
          { text: clock(marker.at), color: marker.selected ? C.gold : C.dim, width: 6 },
          {
            text: marker.boundary ? "◆" : "●",
            color: marker.selected ? C.gold : marker.later ? C.dim : C.active,
            width: 2,
          },
          { text: marker.label, color: marker.selected ? C.out : marker.later ? C.dim : C.src },
        ],
      });
    }
    lines.push(blank(), plain("▸ 26 internal records", C.dim));
    const chosen = data.markers.find((marker) => marker.selected);
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
    return region(self.id, placement.rect, lines, {
      bg: BG.side,
      children,
      focused: focus === "self",
    });
  }

  if (data.sessions.length === 0) {
    for (const placeholder of data.placeholder) {
      for (const wrapped of wrapText(placeholder, Math.max(1, placement.rect.width - 2))) {
        lines.push(plain(wrapped, C.dim));
      }
    }
    return region(self.id, placement.rect, lines, {
      bg: BG.side,
      children,
      focused: focus === "self",
    });
  }

  for (const session of data.sessions) {
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
        {
          text: placement.dense ? session.agent : `${session.agent} · ${session.turn}`,
          color: C.dim,
        },
      ],
    });
    if (session.note !== undefined && !placement.dense) {
      lines.push(plain(`  ${session.note}`, C.dim));
    }
    lines.push(blank());
  }
  return region(self.id, placement.rect, lines, {
    bg: BG.side,
    children,
    focused: focus === "self",
  });
};

export interface TranscriptData {
  readonly view: TranscriptView;
  /** The window over a long transcript, which the renderer clips rather than scrolls. */
  readonly anchor: number;
  readonly mutation?: Mutation;
  /** Present only while a playback is running between two moments. */
  readonly motion?: Motion;
}

export const transcriptBody: Body<TranscriptData> = ({
  self,
  data,
  placement,
  children,
  focus,
}) => {
  const rect = placement.rect;
  const width = Math.max(0, rect.width - 2);
  const lines: VisualLine[] = [];
  const entry = data.view.entry;
  if (entry === undefined) {
    lines.push(label("TRANSCRIPT"), blank(), plain("No executions yet.", C.dim), blank());
    for (const placeholder of data.view.placeholder) {
      for (const wrapped of wrapText(placeholder, width)) {
        lines.push(plain(wrapped, C.dim));
      }
    }
    return region(self.id, rect, lines, { bg: BG.center, children, focused: focus === "self" });
  }
  const running = entry.state === "running";
  lines.push(
    {
      segments: [
        { text: entry.id, color: C.out, width: entry.id.length + 2 },
        {
          text: running ? `● running · ${entry.elapsed}s` : `✓ completed · ${entry.elapsed}s`,
          color: running ? C.active : C.tick,
          width: 24,
        },
        { text: entry.scopeNote, color: C.dim },
      ],
    },
    blank(),
  );

  const body = transcriptLines({ ...entry, sourceLines: 0, rows: data.view.rows }, width);
  const capacity = Math.max(0, rect.height - lines.length);
  const windowed =
    data.mutation === "clip-long-transcript"
      ? body
      : body.slice(data.anchor, data.anchor + Math.max(0, capacity - 1));

  // While a playback runs, the target's transcript arrives a few rows at a
  // time. This is the application's own interpolation; the renderer is not
  // animating anything here.
  const arriving = data.motion !== undefined && !data.motion.done;
  if (arriving) {
    const shown = Math.max(1, Math.ceil(data.motion!.reveal * windowed.length));
    lines.push(...windowed.slice(0, shown), plain("…", C.dim));
    return region(self.id, rect, lines, { bg: BG.center, children, focused: focus === "self" });
  }

  lines.push(...windowed);
  if (data.mutation !== "clip-long-transcript") {
    const remaining = body.length - data.anchor - windowed.length;
    if (remaining > 0) {
      lines.push(plain(`▸ ${remaining} more lines · ↑↓ PgUp PgDn`, C.dim));
    } else if (data.anchor > 0) {
      lines.push(plain(`▴ ${data.anchor} earlier lines · ↑ scrolls back`, C.dim));
    }
  }
  return region(self.id, rect, lines, { bg: BG.center, children, focused: focus === "self" });
};

export const bindingsBody: Body<BindingsView> = ({ self, data, placement, children, focus }) => {
  const lines: VisualLine[] = [label("BINDINGS"), plain(data.scopeName, C.dim), blank()];
  if (data.bindings.length === 0) {
    for (const placeholder of data.placeholder) {
      for (const wrapped of wrapText(placeholder, Math.max(1, placement.rect.width - 2))) {
        lines.push(plain(wrapped, C.dim));
      }
    }
    return region(self.id, placement.rect, lines, {
      bg: BG.bind,
      children,
      focused: focus === "self",
    });
  }
  for (const binding of data.bindings) {
    if (isRedacted(binding)) {
      // A secret has no representable value here. There is nothing to leak
      // because there is nothing to render.
      lines.push(plain("secret", C.name));
      lines.push(plain(binding.state === "answered" ? "answered · redacted" : "required", C.dim));
      lines.push(blank());
      continue;
    }
    lines.push(plain(binding.name, C.name));
    if (binding.note !== undefined && !placement.dense) {
      lines.push(plain(binding.note, C.dim));
    }
    for (const value of binding.lines) {
      lines.push(plain(value, C.settledText));
    }
    lines.push(blank());
  }
  return region(self.id, placement.rect, lines, {
    bg: BG.bind,
    children,
    focused: focus === "self",
  });
};

export const inputBody: Body<ContextualView["input"]> = ({
  self,
  data,
  placement,
  children,
  focus,
}) => [...inputRegion(self.id, data, placement, focus === "self"), ...children];

/**
 * The Execution History band.
 *
 * The drawing is `render.ts`'s — notch height is scope depth, the playhead is
 * its own stem, a selection is gold with a caret — and what changed is who asks
 * for it: the band is a component handed its own view and its own box.
 */
export const historyBody: Body<HistoryData> = ({ self, data, placement, children, focus }) => [
  ...bandRegion(self.id, data.view, placement, data.mutation, data.motion, focus === "self"),
  ...children,
];

export interface HistoryData {
  readonly view: HistoryView;
  readonly mutation?: Mutation;
  readonly motion?: Motion;
}

/**
 * One suspension's drawer, drawn by the shared region.
 *
 * A recorded drawer keeps its complete presentation and says so; nothing about
 * it is actionable, and the tree does not offer its controls for focus.
 */
export const drawerBody: Body<DrawerData> = ({ self, data, placement, children, focus }) => [
  // The gutter is reserved while focus is anywhere inside this drawer, which is
  // all this node knows and all it needs: the glyph in it is drawn by whichever
  // control is focused, not by the form around it.
  ...drawerRegion(self.id, data.view, placement, focus === "self", focus !== "outside"),
  ...children,
];

/**
 * The way out of a drawer.
 *
 * A drawer traps focus, so the Execution History band outside it is
 * unreachable; the drawer carries a region of its own that names the same band
 * and is inside the trap. It draws nothing but its own marker, over the band it
 * is a way back to — so reaching it looks exactly like reaching the band,
 * which is what it does.
 */
export const escapeBody: Body<undefined> = ({ self, placement, children, focus }) => [
  ...(focus === "self" ? regionMark(`${self.id}.focus`, placement.rect) : []),
  ...children,
];

/**
 * One focusable control: a field, a button, a transport action.
 *
 * It draws exactly one thing — its own focus marker, in the cell its parent
 * reserved for it — because which control holds focus is the control's own to
 * say. For a parent to draw this it would have to be told which of its children
 * was focused, and that is the knowledge tree traversal deliberately withholds.
 *
 * A control whose parent reserved no cell draws nothing. Every focusable
 * control in this interface has one, because keyboard focus that nothing shows
 * is focus a person has to guess at.
 */
export const controlBody: Body<undefined> = ({ self, placement, children, focus }) => [
  ...(focus === "self" ? focusMark(`${self.id}.mark`, placement.rect) : []),
  ...children,
];

export interface DrawerData {
  readonly view: DrawerView;
}

/** Narrow only: the one row naming the surface you are on. */
export const surfaceBarBody: Body<{
  readonly crumb: string;
  readonly badge?: string;
  readonly surface: SurfaceName;
  readonly notice: string;
}> = ({ self, data, placement, children }) => [
  ...surfaceBarRegion(self.id, data.crumb, data.badge, data.surface, placement.rect, data.notice),
  ...children,
];

/** The separators between the composed panes. */
export const rulesBody: Body<readonly Rect[]> = ({ self, data, children }) => [
  ...data.flatMap((separator, at) =>
    rule(`${self.id}.${at}`, separator, separator.width === 1 ? "│" : "─"),
  ),
  ...children,
];

/**
 * The numbered focus map.
 *
 * Its entries are derived by walking the mounted tree — by its parent, which is
 * the only thing that can see the tree — and its box is the placement its
 * parent gave it. It is handed no layout and no application focus state.
 */
export const focusMapBody: Body<FocusMapData> = ({ self, data, placement, children }) => [
  ...(data.visible ? focusMapRegion(self.id, data.entries, placement) : []),
  ...children,
];

export interface FocusMapData {
  readonly entries: readonly OverlayEntry[];
  /** Ordinary UI state: whether F1 has been pressed. Nothing about focus. */
  readonly visible: boolean;
}

/** The refusal a terminal below the supported minimum gets instead of a screen. */
export const refusalBody: Body<Layout> = ({ self, data }) => tooSmallRegion(self.id, data);

/** A structural outlet: it draws nothing and contributes its children unchanged. */
export const outletBody: Body<undefined> = ({ children }) => [...children];

/** The screen, which every region floats against. */
export const rootBody: Body<undefined> = ({ self, placement, children }) => [
  open(self.id, {
    layout: { width: fixed(placement.rect.width), height: fixed(placement.rect.height) },
    bg: BG.app,
  }),
  ...children,
  close(),
];

export const tooSmallBody: Body<{ readonly cols: number; readonly rows: number }> = ({
  self,
  data,
  placement,
}) =>
  region(
    self.id,
    placement.rect,
    [
      plain("Terminal too small", C.out),
      plain(`72 × 20 required · ${data.cols} × ${data.rows} now`, C.hold),
      plain("resize to continue", C.dim),
    ],
    { bg: BG.app, padding: { left: 1, right: 1, top: 1 } },
  );

void text;
