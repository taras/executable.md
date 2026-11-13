import type { TerminalBackend } from "@termless/core";
import type { Point, Region, Size } from "./protocol.ts";

type Box = { left: number; right: number; top: number; bottom: number };

export function viewport(backend: TerminalBackend, size: Size) {
  const { totalRows, screenRows } = backend.getScrollback();
  const bufferStart = totalRows - screenRows;
  const cells = Array.from({ length: size.rows }, (_, row) =>
    backend
      .getRow(bufferStart + row)
      .map((cell, column, line) => cell.char || (column > 0 && line[column - 1]?.wide ? "" : " ")),
  );
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
  const composerLabel = [...matches("› message the sidekick")].find(({ row }) => row < bodyBottom);
  const transcriptTitle = rows.findIndex((row) => /^\s*TRANSCRIPT\s/.test(row));
  const composer = composerLabel && {
    left: composerLabel.column - 2,
    right: size.columns - 1,
    top: composerLabel.row + 1,
    bottom: bodyBottom,
  };
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
    composerLabel,
    composerFocused:
      composerLabel !== undefined && cells[composerLabel.row]?.[composerLabel.column - 2] === ">",
    box(region?: Region): Box | undefined {
      switch (region) {
        case "sidekick-composer":
          return composer;
        case "transcript":
          return transcript;
        default:
          return full;
      }
    },
    sidekickControl(): Point | undefined {
      const header = { ...full, bottom: Math.min(size.rows, 3) };
      return matches("SIDEKICK", header).next().value ?? matches("Sidekick", header).next().value;
    },
  };
}
