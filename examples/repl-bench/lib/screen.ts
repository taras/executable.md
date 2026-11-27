import type { TerminalBackend } from "@termless/core";
import { REPL_PALETTE } from "../../../packages/cli/src/repl/presentation-style.ts";
import { composerInput } from "../../../packages/cli/tests/support/composer-input.ts";
import type { Point, Region, Size } from "./protocol.ts";

type Box = { left: number; right: number; top: number; bottom: number };

export function viewport(backend: TerminalBackend, size: Size) {
  const { totalRows, screenRows } = backend.getScrollback();
  const bufferStart = totalRows - screenRows;
  const styled = Array.from({ length: size.rows }, (_, row) => backend.getRow(bufferStart + row));
  const cells = styled.map((line) =>
    line.map((cell, column) => cell.char || (column > 0 && line[column - 1]?.wide ? "" : " ")),
  );
  function background(row: number, column: number): number | undefined {
    const colour = styled[row]?.[column]?.bg;
    return colour == null ? undefined : (colour.r << 16) | (colour.g << 8) | colour.b;
  }
  function foreground({ row, column }: Point): number | undefined {
    const colour = styled[row]?.[column]?.fg;
    return colour == null ? undefined : (colour.r << 16) | (colour.g << 8) | colour.b;
  }
  const full: Box = { left: 0, right: size.columns, top: 0, bottom: size.rows };
  const rows = cells.map((row) => row.join(""));

  function* matches(text: string, box: Box = full): Generator<Point, undefined> {
    for (let row = box.top; row < box.bottom; row++) {
      const line = cells[row] ?? [];
      const visible = line.slice(box.left, box.right);
      const joined = visible.join("");
      let offset = 0;
      for (const [index, cell] of visible.entries()) {
        if (cell !== "" && joined.startsWith(text, offset)) {
          yield { row, column: box.left + index };
        }
        offset += cell.length;
      }
    }
    return undefined;
  }

  const history = rows.findIndex((row) => /^ HISTORY\s/.test(row));
  const bodyBottom = history < 0 ? size.rows : history;
  // The bordered input, found from its edge rather than from what it holds.
  const input = composerInput(cells, (row, column) => foreground({ row, column }), bodyBottom);
  const transcriptTitle = rows.findIndex((row, index) => index < 4 && /^\s*TRANSCRIPT\s/.test(row));
  const composer = input && {
    left: input.left,
    right: input.right,
    top: input.top,
    bottom: input.bottom,
  };
  function drawer(title: string): Box | undefined {
    const heading = [...matches(title)].find(
      ({ row, column }) =>
        background(row, column) === REPL_PALETTE.drawerSurface &&
        cells[row - 1]?.[column] === "─" &&
        cells[row - 1]?.[column + 1] === "─",
    );
    if (heading === undefined) {
      return undefined;
    }
    const topBorder = cells[heading.row - 1] ?? [];
    let right = heading.column;
    while (topBorder[right] === "─") {
      right++;
    }
    return { left: heading.column, right, top: heading.row + 1, bottom: bodyBottom };
  }
  const transcriptDivider = cells[transcriptTitle]?.indexOf("│") ?? -1;
  const transcript =
    transcriptTitle < 0
      ? undefined
      : {
          left: 0,
          right: transcriptDivider < 0 ? size.columns : transcriptDivider,
          top: transcriptTitle + 1,
          bottom: bodyBottom,
        };

  return {
    text: rows.map((row) => row.trimEnd()).join("\n"),
    matches,
    bold: ({ row, column }: Point) => styled[row]?.[column]?.bold === true,
    /** A cell inside the composer's input, for a pointer that wants to reach it. */
    composerCell: input && { row: input.top, column: input.left },
    composerFocused: input?.focused === true,
    focusHints(): string[] | undefined {
      for (const { row, column } of matches(" move focus · Esc closes")) {
        if (row !== 0 && background(row, column + 1) !== REPL_PALETTE.drawerSurface) {
          continue;
        }
        const before = cells[row].slice(0, column).join("");
        const offered = /(?:^|\s)([1-9](?: [1-9])*)$/.exec(before)?.[1]?.split(" ");
        if (
          offered !== undefined &&
          [...matches(`[${offered[0]}]`)].some(
            ({ row, column }) => background(row, column) === REPL_PALETTE.focusHint,
          )
        ) {
          return offered;
        }
      }
      return undefined;
    },
    get sidekickAnswerFocused(): boolean {
      return (
        [...matches(">  = ")].some((point) => foreground(point) === REPL_PALETTE.focus) &&
        matches("[submit]").next().value !== undefined
      );
    },
    box(region?: Region): Box | undefined {
      switch (region) {
        case "sidekick-composer":
          return composer;
        case "transcript":
          return transcript;
        case "history":
          return drawer(" History ");
        default:
          return full;
      }
    },
    sidekickControl(): Point | undefined {
      const header = { ...full, bottom: Math.min(size.rows, 3) };
      // The identity and notice rows share the chrome surface and can name the Sidekick in prose.
      const tab = (point: Point) =>
        background(point.row, point.column) !== REPL_PALETTE.chromeSurface;
      return (
        [...matches("SIDEKICK", header)].find(tab) ?? [...matches("Sidekick", header)].find(tab)
      );
    },
  };
}
