/**
 * How a completed document's failure reaches the terminal.
 *
 * Shared because `xmd run` and `xmd prompt` end in the same thing — one
 * ordinary document execution — and a person reading the output of either has
 * no reason to see the same failure worded two ways. A test failure is the case
 * that makes the difference visible: it earns a heading and a blank line above
 * it, and printing only its message would report a failed suite as if it were
 * an ordinary error.
 */

import { TestFailureError } from "@executablemd/testing";

/** Print a completed document's failure the way `xmd` has always printed it. */
export function reportFailure(error: Error, prefix?: string): void {
  const label = prefix === undefined ? "" : `${prefix}: `;
  if (error instanceof TestFailureError) {
    console.error(`\n${label}tests failed: ${error.message}`);
    return;
  }
  console.error(`${label}${error.message}`);
}
