import assert from "node:assert/strict";
import { createXtermBackend } from "@termless/xtermjs";
import { REPL_PALETTE } from "../../../packages/cli/src/repl/presentation-style.ts";
import { viewport } from "../lib/screen.ts";

const size = { columns: 72, rows: 20 };
const encoder = new TextEncoder();
const { composerSurface, draftSurface } = REPL_PALETTE;
const focusSurface = 0x243747;
const label = "> › message the sidekick";

function paint(surface: number, text: string): string {
  return `\x1b[48;2;${surface >> 16};${(surface >> 8) & 255};${surface & 255}m${text}\x1b[0m`;
}

Deno.test("recognizes the focused composer among lookalike queue and TODO rows", () => {
  const backend = createXtermBackend({ cols: size.columns, rows: size.rows });
  try {
    const queueRow = paint(composerSurface, `queued ${label}`.padEnd(size.columns));
    const todoRow =
      paint(composerSurface, " ") +
      paint(focusSurface, label.padEnd(44)) +
      paint(composerSurface, " ".repeat(size.columns - 45));
    backend.feed(encoder.encode(`${queueRow}\r\n${todoRow}\r\n`));
    assert.equal(viewport(backend, size).composerLabel, undefined);

    const fieldRow =
      paint(composerSurface, " ") +
      paint(focusSurface, label.padEnd(size.columns - 2)) +
      paint(composerSurface, " ");
    const valueRow = paint(composerSurface, " ") + paint(draftSurface, "focused composer value");
    backend.feed(encoder.encode(`${fieldRow}\r\n${valueRow}`));
    const screen = viewport(backend, size);
    assert.deepEqual(screen.composerLabel, { row: 2, column: 3 });
    assert.equal(screen.composerFocused, true);
    assert.deepEqual(
      [...screen.matches("focused composer value", screen.box("sidekick-composer"))],
      [{ row: 3, column: 1 }],
    );
  } finally {
    backend.destroy();
  }
});
