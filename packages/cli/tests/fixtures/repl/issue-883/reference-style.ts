/**
 * The surfaces and edges #883's accepted refinement states, independent of the
 * product that draws them.
 *
 * Every value here is transcribed from the refinement the Product Owner
 * accepted — `repl-sidekick-clear-columns.html`, SHA-256
 * `f987486535d8c3aa48033e1a3c903b042bad1efd4b6e863390c967b508028a51`, recorded
 * in `.reviewer/issue-883/reference/sha256sums.txt` and tabulated under
 * "Accepted column separation" in `.reviewer/issue-883/reference/README.md`.
 *
 * It is a separate archive from the #881 one beside it, not a correction of it.
 * `../reference-style.ts` records the Terminal Interface archive as it was, and
 * those literals are history: the sidebar really was `#090b0c` there, and
 * saying so is what makes this refinement a change rather than a restatement.
 * So the superseded surfaces are stated again here, with this provenance, and
 * the two files disagree on purpose.
 *
 * Nothing here reads the product. A test that asked `REPL_PALETTE` what colour
 * a divider is would agree with the product however the product drifted, and
 * the one thing these regressions exist to catch is the product drifting away
 * from what was accepted.
 */

/** The refinement these literals were transcribed from. */
export const ACCEPTED_REFINEMENT = Object.freeze({
  sha256: "f987486535d8c3aa48033e1a3c903b042bad1efd4b6e863390c967b508028a51",
  source: ".reviewer/issue-883/reference/repl-sidekick-clear-columns.html",
  manifest: ".reviewer/issue-883/reference/sha256sums.txt",
  /** The browser captures the refinement was reviewed through. */
  captures: Object.freeze(["sidekick-clear-columns.png", "bindings-clear-columns.png"]),
});

/**
 * What each area of the screen is painted with, under the refinement.
 *
 * The browser states a pane's divider as a `4px` rule and its header edge as a
 * `2px` one. Neither is a cell count: the accepted terminal adaptation is one
 * continuous cell for a column divider and the existing chrome for a header or
 * footer edge, so what carries over is which role takes which colour.
 */
export const ACCEPTED_SURFACE = Object.freeze({
  /** The Sessions and catalog column. Was `#090b0c` in the #881 archive. */
  side: 0x101820,
  /** The right pane, under either of its two tabs. Was `#0a0c0e`. */
  right: 0x131d26,
  /** The transcript's own surface, which the refinement leaves alone. */
  centre: 0x0c0e11,
  /** The transcript's title row, which had no surface of its own before. */
  transcriptHeader: 0x17212a,
  /** The right pane's title and tab chrome, which had none either. */
  rightHeader: 0x1b2935,
});

/**
 * What parts one reading from the next, in the two roles the refinement splits.
 *
 * One value served both before this: the rule between two columns and the rule
 * between the body and the footer were the same `#161c21`. The refinement
 * gives them different weights in the browser and different colours here, so a
 * product drawing both from one constant cannot satisfy it.
 */
export const ACCEPTED_EDGE = Object.freeze({
  /** Between two columns, continuous, one cell wide. */
  divider: 0x60788a,
  /** Under a header and above the footer, in the chrome already there. */
  chrome: 0x3f5363,
});
