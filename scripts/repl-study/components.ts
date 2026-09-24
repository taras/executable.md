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
  BG,
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
export const headerBody: Body<Pick<ReplView, "crumb" | "badge">> = ({ self, data, placement }) =>
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
      blank(),
    ],
    { bg: BG.center },
  );

export const sessionsBody: Body<SessionsView> = ({ self, data, placement, children }) => {
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
    return region(self.id, placement.rect, lines, { bg: BG.side, children });
  }

  if (data.sessions.length === 0) {
    for (const placeholder of data.placeholder) {
      for (const wrapped of wrapText(placeholder, Math.max(1, placement.rect.width - 2))) {
        lines.push(plain(wrapped, C.dim));
      }
    }
    return region(self.id, placement.rect, lines, { bg: BG.side, children });
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
  return region(self.id, placement.rect, lines, { bg: BG.side, children });
};

export interface TranscriptData {
  readonly view: TranscriptView;
  /** The window over a long transcript, which the renderer clips rather than scrolls. */
  readonly anchor: number;
}

export const transcriptBody: Body<TranscriptData> = ({ self, data, placement, children }) => {
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
    return region(self.id, rect, lines, { bg: BG.center, children });
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
  const windowed = body.slice(data.anchor, data.anchor + Math.max(0, capacity - 1));
  lines.push(...windowed);
  const remaining = body.length - data.anchor - windowed.length;
  if (remaining > 0) {
    lines.push(plain(`▸ ${remaining} more lines · ↑↓ PgUp PgDn`, C.dim));
  } else if (data.anchor > 0) {
    lines.push(plain(`▴ ${data.anchor} earlier lines · ↑ scrolls back`, C.dim));
  }
  return region(self.id, rect, lines, { bg: BG.center, children });
};

export const bindingsBody: Body<BindingsView> = ({ self, data, placement, children }) => {
  const lines: VisualLine[] = [label("BINDINGS"), plain(data.scopeName, C.dim), blank()];
  if (data.bindings.length === 0) {
    for (const placeholder of data.placeholder) {
      for (const wrapped of wrapText(placeholder, Math.max(1, placement.rect.width - 2))) {
        lines.push(plain(wrapped, C.dim));
      }
    }
    return region(self.id, placement.rect, lines, { bg: BG.bind, children });
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
  return region(self.id, placement.rect, lines, { bg: BG.bind, children });
};

export const inputBody: Body<ContextualView["input"]> = ({ self, data, placement, children }) => {
  const width = Math.max(0, placement.rect.width - 2);
  const lines: VisualLine[] = [
    {
      segments: [
        { text: data.label, color: C.label, width: Math.min(width, 18) },
        { text: data.hint, color: data.run === undefined ? C.hold : C.dim },
        {
          text: data.run === undefined ? "[ Run ]" : "[ Run ⌘⏎ ]",
          color: data.run === undefined ? C.dim : C.tick,
          width: 12,
        },
      ],
    },
    plain(data.draft === "" ? data.placeholder : data.draft, C.settledText),
  ];
  return region(self.id, placement.rect, lines, { bg: BG.input, children });
};

export const historyBody: Body<HistoryView> = ({ self, data, placement, children }) => {
  const rect = placement.rect;
  const inner = Math.max(0, rect.width - 2);
  const compact = placement.dense;
  const controls = data.controls.map((control) => `[ ${control.label} ]`).join(" ");
  const word =
    data.transport === "live"
      ? "LIVE"
      : data.transport === "paused"
        ? "PAUSED"
        : data.transport === "inspecting"
          ? "INSPECTING"
          : "IDLE";
  const lines: VisualLine[] = [
    {
      segments: [
        { text: fit(compact ? "HISTORY" : "EXECUTION HISTORY", 20), color: C.label },
        { text: `${word}  ${controls}`, color: C.dim },
      ],
    },
    {
      segments: [
        {
          text:
            data.markers.length === 0 ? "No recorded execution yet" : `recorded · ${data.elapsed}`,
          color: C.dim,
        },
      ],
    },
  ];
  for (const marker of data.markers.slice(0, Math.max(0, rect.height - 3))) {
    lines.push({
      segments: [
        { text: clock(marker.at), color: marker.selected ? C.gold : C.dim, width: 6 },
        { text: marker.boundary ? "◆" : "●", color: marker.selected ? C.gold : C.active, width: 2 },
        { text: marker.label, color: marker.selected ? C.out : C.src },
        { text: marker.scope, color: C.dim, width: Math.min(28, Math.max(0, inner - 40)) },
      ],
    });
  }
  return region(self.id, rect, lines, { bg: BG.footer, children });
};

/**
 * One suspension's drawer.
 *
 * A recorded drawer renders the state it recorded and offers nothing to act on:
 * `historical` disables every control, and the body says so rather than drawing
 * affordances that would do nothing.
 */
export const drawerBody: Body<DrawerView> = ({ self, data, placement, children }) => {
  const width = Math.max(0, placement.rect.width - 2);
  const lines: VisualLine[] = [plain(data.heading, C.hold)];
  for (const wrapped of wrapText(data.origin, width)) {
    lines.push(plain(wrapped, C.dim));
  }
  lines.push(blank());
  for (const line of data.lines) {
    for (const wrapped of wrapText(line, width)) {
      lines.push(plain(wrapped, C.src));
    }
  }
  lines.push(blank());
  for (const control of data.controls) {
    lines.push({
      segments: [
        { text: control.enabled ? "  " : "· ", color: C.dim, width: 2 },
        { text: control.label, color: control.enabled ? C.src : C.dim },
      ],
    });
  }
  if (data.historical) {
    lines.push(blank(), plain("recorded · read-only", C.gold));
  }
  return region(self.id, placement.rect, lines, { bg: BG.drawer, children });
};

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
