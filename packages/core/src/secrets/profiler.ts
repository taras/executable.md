/**
 * Secretlint's profiler, silenced for as long as an execution needs it.
 *
 * `@secretlint/profiler` exports a process-global singleton that every
 * `lintSource()` call marks through — 66 marks and 33 measures per scan for the
 * rule set this package pins. A `PerformanceObserver` pushes each mark into an
 * array nothing ever clears, and for each `::end` mark it scans that array
 * looking for the matching start and then discards the result. The scan is dead
 * work, and it is linear in every mark the process has ever emitted, so the cost
 * of a scan grows with the number of scans before it.
 *
 * Measured on this rule set, one scanner, buckets of 100 scans:
 * 1.19 ms → 2.09 → 1.54 → 2.13 → 6.68 → 10.52 ms per scan, with the mark count
 * passing 39,000. Silenced, the same measurement is flat at 0.045 ms.
 *
 * Clearing `performance` marks does not help: the array belongs to the profiler,
 * not to the performance timeline. The only lever from outside the package is
 * its own `mark` method, so that is what this replaces.
 *
 * Nothing here reads profiler output — it exists for Secretlint's `--profile`
 * CLI flag, which this package does not use.
 *
 * ## Why a counter
 *
 * The thing being silenced is process-global, but the silence is scope-bound, and
 * executions overlap: two concurrent runs would otherwise have the inner one
 * restore the outer one's silence, or the first to finish un-silence a run still
 * going. The counter is the smallest thing that makes "restore what we found,
 * once everyone is done" correct. It describes the process, not any execution —
 * no execution's state lives here, and it returns to zero when the last one ends.
 */

import { resource } from "effection";
import type { Operation } from "effection";
import { secretLintProfiler } from "@secretlint/profiler";

type Mark = typeof secretLintProfiler.mark;

const silent: Mark = () => {};

let holders = 0;
let noisy: Mark | undefined;

/**
 * Silence the profiler until the current operation ends.
 *
 * The first holder replaces `mark` and remembers what was there; the last one
 * to leave puts it back, so a process that ran a document is left as it was
 * found.
 */
export function useSilentSecretProfiler(): Operation<void> {
  return resource(function* (provide) {
    if (holders === 0) {
      noisy = secretLintProfiler.mark;
      secretLintProfiler.mark = silent;
    }
    holders += 1;

    try {
      yield* provide();
    } finally {
      holders -= 1;
      if (holders === 0 && noisy) {
        secretLintProfiler.mark = noisy;
        noisy = undefined;
      }
    }
  });
}

/** Whether the profiler is currently silenced. For tests only. */
export function profilerIsSilenced(): boolean {
  return secretLintProfiler.mark === silent;
}
