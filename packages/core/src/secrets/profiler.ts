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
 * The cost is worst where a runtime shares one process across a whole test
 * corpus. Bun does: a second test file starts with the marks the first one
 * emitted still counted, so scans get slower the further into a run they are.
 * Deno gives each file its own process, which is why the same corpus only shows
 * it under Bun.
 */

import { resource } from "effection";
import type { Operation } from "effection";
import { secretLintProfiler } from "@secretlint/profiler";

type Mark = typeof secretLintProfiler.mark;

const silent: Mark = () => {};

/**
 * Silence the profiler until the current operation ends.
 *
 * What it found is held in this operation's own frame and put back when the
 * operation ends, so nothing about the silence outlives the run that asked for
 * it and no state is kept here between runs.
 *
 * A run that finds the profiler already silent leaves it alone and restores
 * nothing. That is what makes overlapping runs settle correctly without any
 * shared bookkeeping: exactly one of them holds the real `mark`, so however
 * they interleave, the process ends up as noisy as it started. The cost is that
 * a run finishing while another is still going hands profiling back early —
 * which the other run pays for in speed and never in correctness.
 */
export function useSilentSecretProfiler(): Operation<void> {
  return resource(function* (provide) {
    const noisy = secretLintProfiler.mark;
    if (noisy === silent) {
      yield* provide();
      return;
    }

    secretLintProfiler.mark = silent;
    try {
      yield* provide();
    } finally {
      secretLintProfiler.mark = noisy;
    }
  });
}

/** Whether the profiler is currently silenced. For tests only. */
export function profilerIsSilenced(): boolean {
  return secretLintProfiler.mark === silent;
}
