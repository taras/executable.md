/**
 * Secretlint's detector, with its profiler stubbed out.
 *
 * This module is the only place the package reaches Secretlint. Everything else
 * imports `lintSource` from here, so the stub below is in place before any scan
 * runs and there is one boundary to read rather than a rule spread over call
 * sites.
 *
 * ## Why the profiler is stubbed
 *
 * `@secretlint/profiler` exports a process-global singleton that every
 * `lintSource()` call marks through — 66 marks and 33 measures per scan for the
 * rule set this package pins. A `PerformanceObserver` pushes each mark into an
 * array nothing ever clears, and for each `::end` mark it scans that array
 * looking for the matching start and then discards the result. The scan is dead
 * work, and it is linear in every mark the process has ever emitted, so a scan
 * costs more than the one before it.
 *
 * Measured on this rule set, one scanner, buckets of 100 scans:
 * 1.19 ms → 2.09 → 1.54 → 2.13 → 6.68 → 10.52 ms per scan, with the mark count
 * passing 39,000. Stubbed, the same measurement is flat at 0.045 ms.
 *
 * The cost is worst where a runtime shares one process across a whole corpus.
 * Bun does: a second test file starts with the marks the first one emitted still
 * counted. Deno gives each file its own process, which is why the same corpus
 * only showed it under Bun.
 *
 * ## Why it is replaced once, and never restored
 *
 * The alternatives do not work. Clearing `performance` marks leaves the array
 * alone — it belongs to the profiler, not the performance timeline. An install
 * -time override reaches Node but not Deno (measured: 0 marks against 62), and
 * would in any case only apply to this repository's own builds — anything
 * installed from JSR or npm would resolve the real package and carry the defect.
 * Replacing the method here travels with the code, so a consumer of this package
 * runs the same stub we do.
 *
 * Doing it once at module evaluation is what keeps it out of execution lifetime.
 * A profiler that is switched per run is shared mutable state: concurrent runs
 * would have to agree about who restores it, and an unrelated Secretlint user in
 * the process would see profiling appear and disappear under them. Stubbing once
 * removes the question — the value never changes again, so nothing can observe
 * it change, and no execution owns any part of it.
 *
 * Nothing reads what is being discarded. The profiler exists to feed Secretlint's
 * `--profile` CLI reporting, which this package does not use, and `lintSource`
 * returns its findings entirely through its resolved value.
 */

import { secretLintProfiler } from "@secretlint/profiler";

secretLintProfiler.mark = () => {};

export { lintSource } from "@secretlint/core";
