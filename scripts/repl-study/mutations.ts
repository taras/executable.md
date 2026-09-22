/**
 * The ways this harness can be broken on purpose.
 *
 * Every claim the evidence makes has one of these behind it, because a claim
 * nobody can break is a claim nobody is checking. Each value is passed to one
 * run, changes exactly one behavior, and has to be rejected by the same oracle
 * that admits the honest run — not merely crash it.
 */

export const MUTATIONS = [
  /** Draw the previous frame's operations after the state changed. */
  "stale-frame",
  /** Keep the three-pane composition at narrow dimensions instead of routing. */
  "shrink-wide-at-narrow",
  /** Let the drawer take the rows the Execution History footer owns. */
  "drawer-covers-footer",
  /** Compose the interface below the supported minimum instead of refusing. */
  "ignore-minimum",
  /** Resize the terminal without telling the renderer. */
  "skip-resize-update",
  /** Drop the transcript window and the scrubber's coalescing. */
  "clip-long-transcript",
  /** Leave the terminal in the modes the harness turned on. */
  "leak-terminal-modes",
  /** Render one notch height for every kind of marker. */
  "flatten-notches",
] as const;

export type Mutation = (typeof MUTATIONS)[number];

export function isMutation(value: string): value is Mutation {
  return (MUTATIONS as readonly string[]).includes(value);
}
