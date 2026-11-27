import assert from "node:assert/strict";
import { createXtermBackend } from "@termless/xtermjs";
import { REPL_PALETTE } from "../../../packages/cli/src/repl/presentation-style.ts";
import { viewport } from "../lib/screen.ts";

const size = { columns: 72, rows: 20 };
const encoder = new TextEncoder();

function paint(surface: number, text: string): string {
  return `\x1b[48;2;${surface >> 16};${(surface >> 8) & 255};${surface & 255}m${text}\x1b[0m`;
}

function ink(colour: number, text: string): string {
  return `\x1b[38;2;${colour >> 16};${(colour >> 8) & 255};${colour & 255}m${text}\x1b[39m`;
}

/** Three rows of a box drawn with one edge colour, holding this text, at this indent. */
function boxed(edge: number, text: string, indent: number, width: number): string[] {
  const inner = width - 2;
  return [
    " ".repeat(indent) + ink(edge, `┌${"─".repeat(inner)}┐`),
    " ".repeat(indent) + ink(edge, "│") + ` ${text}`.padEnd(inner) + ink(edge, "│"),
    " ".repeat(indent) + ink(edge, `└${"─".repeat(inner)}┘`),
  ];
}

function screenOf(rows: readonly string[]) {
  const backend = createXtermBackend({ cols: size.columns, rows: size.rows });
  backend.feed(encoder.encode(rows.join("\r\n")));
  return { backend, screen: viewport(backend, size) };
}

Deno.test("finds the composer's bordered input whatever it holds, and reads focus from its edge", () => {
  for (const [edge, held, focused] of [
    [REPL_PALETTE.focus, "Send sidekick a message", true],
    [REPL_PALETTE.focus, "Hello World!", true],
    [REPL_PALETTE.muted, "Hello World!", false],
  ] satisfies readonly (readonly [number, string, boolean])[]) {
    const { backend, screen } = screenOf([
      "  [x]loop    [send]",
      ...boxed(edge, held, 1, 40),
      "  [exit]",
    ]);
    try {
      assert.deepEqual(screen.box("sidekick-composer"), { top: 2, bottom: 3, left: 2, right: 40 });
      assert.equal(screen.composerFocused, focused);
      assert.deepEqual(screen.composerCell, { row: 2, column: 2 });
      assert.deepEqual([...screen.matches(held, screen.box("sidekick-composer"))], [
        { row: 2, column: 3 },
      ]);
    } finally {
      backend.destroy();
    }
  }
});

Deno.test("does not take another outline or an open frame for the composer", () => {
  const { backend, screen } = screenOf([
    ...boxed(REPL_PALETTE.chromeEdge, "Executable Markdown", 0, 30),
    ink(REPL_PALETTE.focus, "┌──────┐"),
    ink(REPL_PALETTE.focus, "│") + " open ",
    ink(REPL_PALETTE.focus, "└──────┘"),
    ink(REPL_PALETTE.muted, "└──────┘ a closing edge with nothing above it"),
  ]);
  try {
    assert.equal(screen.box("sidekick-composer"), undefined);
    assert.equal(screen.composerCell, undefined);
    assert.equal(screen.composerFocused, false);
  } finally {
    backend.destroy();
  }
});

Deno.test("reads the complete focus legend without treating document text as shortcuts", () => {
  const backend = createXtermBackend({ cols: size.columns, rows: size.rows });
  try {
    backend.feed(encoder.encode("XMD REPL\r\n[1] 1 5 move focus · Esc closes\r\n"));
    assert.equal(viewport(backend, size).focusHints(), undefined);

    const badge = paint(REPL_PALETTE.focusHint, "[1]");
    backend.feed(
      encoder.encode(
        `${badge}  ${paint(REPL_PALETTE.drawerSurface, "1 2 8 move focus · Esc closes")}\r\n`,
      ),
    );
    assert.deepEqual(viewport(backend, size).focusHints(), ["1", "2", "8"]);
  } finally {
    backend.destroy();
  }
});

Deno.test("finds the Sidekick tab below a notice that names the Sidekick", () => {
  const backend = createXtermBackend({ cols: size.columns, rows: size.rows });
  try {
    const identity = paint(REPL_PALETTE.chromeSurface, " XMD REPL".padEnd(size.columns));
    const notice = paint(
      REPL_PALETTE.chromeSurface,
      "! the Sidekick was stopped. Nothing it had already done was undone".padEnd(size.columns),
    );
    backend.feed(encoder.encode(`${identity}\r\n${notice}\r\n`));
    assert.equal(viewport(backend, size).sidekickControl(), undefined);

    const surfaces =
      paint(REPL_PALETTE.paneHeaderSurface, "     Sessions      Entries  ") +
      paint(REPL_PALETTE.selectedSurface, "  * Sidekick");
    backend.feed(encoder.encode(surfaces));
    assert.deepEqual(viewport(backend, size).sidekickControl(), { row: 2, column: 32 });
  } finally {
    backend.destroy();
  }
});
