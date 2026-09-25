/**
 * Cells, and nothing else.
 *
 * A renderer is handed the lines the mounted tree drew and a viewport, and it
 * answers bytes. It holds no state about the application, knows no component,
 * and is replaceable while a run is going: swapping one for another changes
 * what the terminal receives and changes nothing about where you are, what is
 * mounted, or how far a drawer has opened — because none of that is here.
 *
 * Two are provided, which is one more than the experiment needs and exactly
 * enough to show the seam is real. A single renderer is not a boundary; it is
 * an implementation with a hopeful name.
 */

export interface Renderer {
  readonly name: string;
  /** The lines the tree drew, as the bytes a terminal of this size receives. */
  draw(lines: readonly string[], columns: number): string;
}

/** The lines as they are, clipped to the width. */
export const plainRenderer: Renderer = {
  name: "plain",
  draw(lines, columns) {
    return lines.map((line) => clip(line, columns)).join("\n");
  },
};

/** The same lines inside a rule, to show the seam changes bytes and nothing else. */
export const framedRenderer: Renderer = {
  name: "framed",
  draw(lines, columns) {
    const width = Math.max(2, columns);
    const rule = "─".repeat(width - 2);
    const body = lines.map((line) => `│${clip(line, width - 2)}`);
    return [`┌${rule}`, ...body, `└${rule}`].join("\n");
  },
};

function clip(line: string, columns: number): string {
  return line.length <= columns ? line : `${line.slice(0, Math.max(0, columns - 1))}…`;
}
