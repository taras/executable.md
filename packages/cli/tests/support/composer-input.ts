import { REPL_PALETTE } from "../../src/repl/presentation-style.ts";

/**
 * The inside of the Sidekick composer's box, and how its edge is drawn.
 *
 * Rows from `top` up to `bottom` and columns from `left` up to `right`, each
 * end exclusive: the cells the value and its placeholder are drawn in.
 */
export interface ComposerInput {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  /** Whether the edge is drawn in the focus colour rather than the muted one. */
  readonly focused: boolean;
}

/**
 * Find the Sidekick composer from the edge the screen draws around it.
 *
 * Layout evidence rather than any text inside the box, so an empty draft, its
 * placeholder and a typed draft are found the same way: a closed box whose
 * whole edge is drawn in the focus colour or the muted one. The Round editor's
 * outline and a drawer's frame use neither. The lowest such box ending above
 * `bottom` is the composer, which the layout keeps above the footer.
 */
export function composerInput(
  cells: readonly (readonly string[])[],
  edge: (row: number, column: number) => number | undefined,
  bottom = cells.length,
): ComposerInput | undefined {
  for (let last = bottom - 1; last > 0; last -= 1) {
    const line = cells[last] ?? [];
    for (let left = 0; left < line.length; left += 1) {
      const colour = edge(last, left);
      if (line[left] !== "└" || (colour !== REPL_PALETTE.focus && colour !== REPL_PALETTE.muted)) {
        continue;
      }
      const found = closedBox(cells, edge, colour, last, left);
      if (found !== undefined) {
        return { ...found, focused: colour === REPL_PALETTE.focus };
      }
    }
  }
  return undefined;
}

function closedBox(
  cells: readonly (readonly string[])[],
  edge: (row: number, column: number) => number | undefined,
  colour: number,
  last: number,
  left: number,
): Omit<ComposerInput, "focused"> | undefined {
  const drawn = (row: number, column: number, glyph: string): boolean =>
    cells[row]?.[column] === glyph && edge(row, column) === colour;
  let right = left + 1;
  while (drawn(last, right, "─")) {
    right += 1;
  }
  if (!drawn(last, right, "┘")) {
    return undefined;
  }
  let first = last - 1;
  while (first > 0 && drawn(first, left, "│") && drawn(first, right, "│")) {
    first -= 1;
  }
  if (first === last - 1 || !drawn(first, left, "┌") || !drawn(first, right, "┐")) {
    return undefined;
  }
  for (let column = left + 1; column < right; column += 1) {
    if (!drawn(first, column, "─")) {
      return undefined;
    }
  }
  return { top: first + 1, bottom: last, left: left + 1, right };
}

/** An emulated screen that can say what each cell holds and what colour drew it. */
interface ColouredScreen {
  cells(): readonly (readonly string[])[];
  styleAt(column: number, row: number): { readonly foreground: number | undefined };
}

/** The composer on a screen, or none where no screen or no composer is drawn. */
export function composerOnScreen(screen: ColouredScreen | undefined): ComposerInput | undefined {
  return screen === undefined
    ? undefined
    : composerInput(screen.cells(), (row, column) => screen.styleAt(column, row).foreground);
}
