import { close, fixed, open, text } from "../../generated/tty/mod.js";
import type { Op } from "../../generated/tty/mod.js";
import { flatten } from "./layout.ts";
import type { ReplBox, ReplBoxProps } from "./layout.ts";
import { BOLD, REPL_PALETTE, terminalColour } from "./presentation-style.ts";
import type { ReplMeasured } from "./renderer.ts";
import type { ReplRoute } from "./route.ts";
import type { ReplTerminalSize } from "./terminal.ts";

const DESTINATIONS: Readonly<
  Record<string, { readonly label: string; readonly anchors: readonly string[] }>
> = {
  "1": { label: "Message", anchors: ["sidekick:message"] },
  "2": { label: "Transcript", anchors: ["transcript:title", "transcript:heading"] },
  "3": { label: "Selected work", anchors: ["work:crumbs", "entries:heading"] },
  "4": { label: "Draft", anchors: ["footer:input"] },
  "5": { label: "Tabs", anchors: ["tab:bindings"] },
  "6": { label: "Reading pane", anchors: ["sidekick:heading:usage:", "binding:anchor"] },
  "7": { label: "TODO", anchors: ["todo:header"] },
  "8": { label: "History", anchors: ["footer:history"] },
  "9": { label: "View switcher", anchors: ["surface:sidekick", "entries:heading"] },
};

export function focusRouteHint(route: ReplRoute, narrow: boolean): string {
  if (!narrow) {
    return "opens the Sidekick tab";
  }
  if (route.view === "sidekick") {
    return "opens Sidekick";
  }
  return route.surface === "sessions" ? "opens Sessions" : "opens Entries";
}

const BADGE_WIDTH = 3;
const BADGE_COLOUR = terminalColour(REPL_PALETTE.focusHint);
const BADGE_INK = terminalColour(REPL_PALETTE.applicationSurface);
const PANEL_INK = terminalColour(REPL_PALETTE.output);
const PANEL_COLOUR = terminalColour(REPL_PALETTE.drawerSurface);

interface RowText {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly end: number;
}

function floating(x: number, y: number): ReplBoxProps["floating"] {
  return { attachTo: "root", x, y, zIndex: 5, pointerCaptureMode: "passthrough" };
}

function badge(digit: string): Op {
  return text(`[${digit}]`, { color: BADGE_INK, bg: BADGE_COLOUR, attrs: BOLD });
}

function rowText(box: ReplBox, measured: ReplMeasured): RowText[] {
  const content = box.text?.trimEnd();
  const bounds = measured.boundsOf(box.id);
  if (!content || bounds === undefined || bounds.height < 1 || bounds.width < 1) {
    return [];
  }
  // Pane labels use these single-cell marks. For arbitrary text, leave its
  // entire allocation clear instead of treating a string's length as its width.
  const cells = /^[ -~▾▴›·←→─…]*$/.test(content) ? content.length : bounds.width;
  const x = Math.floor(bounds.x) + (content.length - content.trimStart().length);
  return [
    {
      key: box.key ?? box.id,
      x,
      y: Math.floor(bounds.y),
      end: Math.ceil(bounds.x + Math.min(bounds.width, cells)),
    },
  ];
}

/** Draw over unused cells in the admitted frame without changing its hit targets. */
export function focusHintOps(
  root: ReplBox,
  measured: ReplMeasured,
  size: ReplTerminalSize,
  offered: readonly (readonly [digit: string, route: string | undefined])[],
): Op[] {
  const rows = flatten(root).flatMap((box) => rowText(box, measured));
  const ops: Op[] = [];
  const listed: { digit: string; label: string }[] = [];
  for (const [digit, route] of offered) {
    const destination = DESTINATIONS[digit];
    const row =
      route === undefined
        ? destination.anchors
            .map((anchor) =>
              rows.find((row) =>
                anchor.endsWith(":") ? row.key.startsWith(anchor) : row.key === anchor,
              ),
            )
            .find((row) => row !== undefined)
        : undefined;
    if (row !== undefined) {
      const x = [row.end + 1, row.end].find(
        (x) =>
          x + BADGE_WIDTH <= size.columns &&
          !rows.some((other) => other.y === row.y && other.x < x + BADGE_WIDTH && other.end > x),
      );
      if (x !== undefined) {
        rows.push({ key: "", y: row.y, x, end: x + BADGE_WIDTH });
        ops.push(
          open(`focus-hint:${digit}`, {
            layout: { width: fixed(BADGE_WIDTH), height: fixed(1) },
            floating: floating(x, row.y),
          }),
          badge(digit),
          close(),
        );
        continue;
      }
    }
    listed.push({
      digit,
      label: route === undefined ? destination.label : `${destination.label} · ${route}`,
    });
  }
  const digits = offered.map(([digit]) => digit).join(" ");
  const legend = `${digits} move focus · Esc closes`;
  const legendX = size.columns - legend.length - 1;
  const legendFits = !rows.some((row) => row.y === 0 && row.end > legendX);
  if (legendFits) {
    ops.push(
      open("focus-hint:legend", {
        layout: { width: fixed(legend.length), height: fixed(1) },
        floating: floating(legendX, 0),
      }),
      text(legend, { color: PANEL_INK }),
      close(),
    );
  }
  if (listed.length === 0 && legendFits) {
    return ops;
  }
  const heading = legendFits ? "Press a number to move focus" : legend;
  const width = 2 + Math.max(heading.length, ...listed.map(({ label }) => 4 + label.length));
  const height = 1 + listed.length;
  const tray = measured.boundsOf("box:tray");
  const body = measured.boundsOf("box:body");
  const right = tray === undefined ? size.columns : Math.floor(tray.x + tray.width);
  const bottom = tray?.y ?? (body === undefined ? size.rows - 2 : body.y + body.height);
  ops.push(
    open("focus-hint:panel", {
      layout: {
        width: fixed(width),
        height: fixed(height),
        direction: "ttb",
        padding: { left: 1 },
      },
      bg: PANEL_COLOUR,
      floating: floating(right - width, Math.max(1, Math.floor(bottom) - height)),
    }),
    text(heading, { color: PANEL_INK, attrs: BOLD }),
  );
  for (const { digit, label } of listed) {
    ops.push(
      open(`focus-hint:panel:${digit}`, {
        layout: { width: fixed(width - 1), height: fixed(1), direction: "ltr" },
      }),
      badge(digit),
      text(` ${label}`, { color: PANEL_INK }),
      close(),
    );
  }
  ops.push(close());
  return ops;
}
