/** One step of a wheel pattern: a burst of notches in one direction, or a wait. */
export type WheelStep =
  | { readonly kind: "wheel"; readonly delta: number }
  | { readonly kind: "pause"; readonly ticks: number };

/**
 * Read a wheel pattern as the steps it plays.
 *
 * `d` is one notch down, `u` is one notch up and `.` is one tick of waiting. A
 * run of one character is one step: the notches of a run arrive together, and a
 * run of dots is one wait of that many ticks.
 */
export function wheelSteps(pattern: string): WheelStep[] {
  const steps: WheelStep[] = [];
  for (const [run] of pattern.matchAll(/d+|u+|\.+|[^du.]/g)) {
    const mark = run.charAt(0);
    if (mark === ".") {
      steps.push({ kind: "pause", ticks: run.length });
    } else if (mark === "d" || mark === "u") {
      steps.push({ kind: "wheel", delta: mark === "d" ? run.length : -run.length });
    } else {
      throw new Error(`A wheel pattern holds only "d", "u" and ".", not "${mark}".`);
    }
  }
  if (steps.length === 0) {
    throw new Error("A wheel pattern needs at least one step.");
  }
  return steps;
}
