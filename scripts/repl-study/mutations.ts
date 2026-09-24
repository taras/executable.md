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
  /** Never schedule a frame, so an animation renders once and stops. */
  "never-tick",
  /** Reconstruct a moment as a half-finished animation rather than a state. */
  "restore-mid-animation",
  /** Move focus when a background update arrives. */
  "steal-focus-on-background",
  /** Rebuild the whole tree on every sync instead of reconciling it. */
  "rebuild-tree-each-sync",
  /** Render from a second mounted tree instead of the one focus and input use. */
  "second-tree",
  /** Leave a replaced control wherever it was appended, losing canonical order. */
  "append-replacements",
  /** Close a drawer without removing its branch, so its controls survive. */
  "keep-closed-branch",
  /** Number the overlay from a static list instead of walking the tree. */
  "flat-overlay",
  /** Let Tab escape an open drawer into the panes behind it. */
  "leak-drawer-trap",
  /** Make a visible-but-disabled control focusable. */
  "focus-hidden-target",
  /** Push a navigation entry for every keystroke in the draft. */
  "push-draft-edits",
  /** Rebuild the route from the profile instead of preserving it. */
  "drop-route-on-resize",
  /** Leave focus where it was when a drawer closes. */
  "forget-drawer-invoker",
  /** Permit a mutation while a recorded moment is under inspection. */
  "mutate-while-inspecting",
  /** Drop `ScanResult.pending`, so a lone Escape is never delivered. */
  "swallow-pending-escape",
  /** Accept only a synthetic Tab+shift as reverse traversal. */
  "ignore-backtab",
  /** Move focus across a region boundary without moving the URL's surface. */
  "keep-route-on-focus",
  /** Forget the selected marker when a state is rebuilt from its URL. */
  "drop-selection-on-hydrate",
  /** Exit on Ctrl+C while a paused entry is still active. */
  "exit-on-paused-interrupt",
  /** Leave the sibling arrows inert, as if the locus had no siblings. */
  "inert-sibling-arrows",
] as const;

export type Mutation = (typeof MUTATIONS)[number];

export function isMutation(value: string): value is Mutation {
  return (MUTATIONS as readonly string[]).includes(value);
}
