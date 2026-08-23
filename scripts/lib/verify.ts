/**
 * One conflict topology, and the proof it changed nothing.
 *
 * `deno task build:web` is the producer: the one path that reads the two
 * `@rjsf/validator-ajv8` manifests, resolves through the installed tree, and
 * republishes the generated browser module. Around it stand three consumers —
 * Deno, Node and Bun, all running `lib/consumer-cycle.ts` — and an observer
 * watching the manifests and the generated output from this process. What they
 * prove together is narrower than correctness, which belongs to the dedicated
 * runtime jobs:
 *
 *     after preparation, build and verification operations do not corrupt or
 *     replace shared repository-owned state while supported runtimes consume it
 *
 * **A final fingerprint cannot prove that on its own.** A build that replaced a
 * manifest and put the original bytes back compares equal at the end and has
 * still broken every runtime that resolved through it in between. So the live
 * observer and consumers are the evidence, and the comparison afterwards is the
 * separate claim that nothing was left moved.
 *
 * Nothing here knows which host it is on: every host-specific act arrives as a
 * capability from `scripts/verify.ts`. This module is listed in
 * `tsconfig.node.json`, so importing `prepared-state.ts` and its `Deno.*`
 * globals would fail the portable typecheck. That is the boundary's proof.
 *
 * Two rules survive from #279. Results are ordered by `PARTICIPANTS` rather
 * than by finish order, so two runs of one worktree read identically; and every
 * participant settles before anything is decided, so one failing neither
 * cancels another nor skips the comparison. Nothing retries.
 */

import { race, sleep, spawn } from "effection";
import type { Operation, Task } from "effection";

import { compareTracked } from "./tracked.ts";
import type { TrackedState } from "./tracked.ts";
import { PRODUCING, RUNTIMES, SETTLED } from "./consumer-cycle.ts";
import type { CycleReport, Runtime } from "./consumer-cycle.ts";

export { PRODUCING, RUNTIMES, SETTLED };
export type { CycleReport, Runtime };

/** The producer's id, which is also the command a reader would type. */
export const PRODUCER = "build:web";

export const OBSERVER = "observer";

/** Every participant, in the order every report uses. */
export const PARTICIPANTS: readonly string[] = [PRODUCER, ...RUNTIMES, OBSERVER];

/**
 * How long the probe may take to get the producer started and finished.
 *
 * `deno bundle` and its esbuild service can deadlock under concurrent load
 * (denoland/deno#36417), and a probe with no ceiling then hangs to whatever
 * kills it from outside, with nothing printed. One number, because a consumer
 * that never reaches its first cycle wedges the invocation the same silent way.
 * It clears a healthy run — about a minute — by a wide margin.
 */
export const PROBE_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;

/** How often the observer re-reads the state the producer must not disturb. */
export const OBSERVE_INTERVAL_MILLISECONDS = 25;

/** How often the coordinator asks whether the consumers have reached a cycle. */
export const READY_INTERVAL_MILLISECONDS = 25;

export interface Settled {
  code: number;
  milliseconds: number;
  /** Settled by the ceiling rather than by its own exit. */
  timedOut?: boolean;
}

/** The state a producer must not disturb, as one reader sees it. */
export interface Sensitive {
  /** Manifest path to a fingerprint of its bytes *and* its file identity. */
  manifests: Record<string, string>;
  /** The generated module's export shape when whole, and why not when not. */
  generated: string;
}

/** How `Sensitive.generated` spells a module that could not be read whole. */
export const UNREADABLE = "✗ ";

/** Everything this repository owns, in one snapshot. */
export interface OwnedState {
  /** Every tracked path, by content, mode, symlink target, or absence. */
  tracked: TrackedState;
  /** The complete `node_modules` tree: `<path> <mode> <kind> <digest-or-target>`. */
  installed: readonly string[];
  /** `deno.lock`, digested. */
  lock: string;
}

export interface VerifyHost {
  /** Run the real `deno task build:web`, spooling its output. */
  produce(): Operation<Settled>;
  /** Run one consumer process to settlement, spooling its output. */
  consume(runtime: Runtime): Operation<Settled>;
  /** The bytes a settled participant wrote, in the order it wrote them. */
  spool(id: string): Operation<Uint8Array>;
  /** Whether `runtime` has completed its first cycle. */
  isReady(runtime: Runtime): Operation<boolean>;
  /** What `runtime` recorded, once it has settled. */
  cycles(runtime: Runtime): Operation<CycleReport | undefined>;
  /** Tell the consumers which phase the producer is in. */
  signal(name: string): Operation<void>;
  /** Read the manifests and the generated module as a consumer would. */
  sensitive(): Operation<Sensitive>;
  /** Tracked paths, `node_modules` and `deno.lock`, together. */
  owned(): Operation<OwnedState>;
  /** Suspend, so the observer and the readiness wait are cancellable. */
  pause(milliseconds: number): Operation<void>;
  /** A line of the report. */
  log(line: string): void;
  /** Bytes straight through, so a failure's output survives undecoded. */
  emit(bytes: Uint8Array): void;
}

/** What a reader would type to run the whole topology again. */
export const REPRODUCE = "deno task verify";

function seconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 100) / 10}s`;
}

function minutes(milliseconds: number): string {
  return `${Math.round(milliseconds / 60_000)}m`;
}

/**
 * What changed between two readings of the sensitive state.
 *
 * The two halves are held to different rules on purpose. A manifest that moved
 * at all is a violation, whether or not it moved back. The generated module is
 * *expected* to move — that is what the producer publishes — so the only thing
 * asked of it is that every reading is a whole one.
 */
export function movedSensitive(before: Sensitive, after: Sensitive): string[] {
  const moved: string[] = [];
  const paths = new Set([...Object.keys(before.manifests), ...Object.keys(after.manifests)]);
  // `sort()` rather than `toSorted()`: this module is typechecked against
  // ES2022 for Node, and the array it sorts was built one line above.
  for (const path of [...paths].sort()) {
    const was = before.manifests[path] ?? "absent";
    const is = after.manifests[path] ?? "absent";
    if (was !== is) {
      moved.push(`${path} changed while the producer ran: ${was} → ${is}`);
    }
  }
  if (after.generated.startsWith(UNREADABLE)) {
    moved.push(`the generated module was not whole: ${after.generated.slice(UNREADABLE.length)}`);
  }
  return moved;
}

/** What moved between two snapshots of repository-owned state. */
export function movedOwned(before: OwnedState, after: OwnedState): string[] {
  const moved = compareTracked(before.tracked, after.tracked);
  if (before.lock !== after.lock) {
    moved.push("deno.lock changed");
  }
  const previous = new Set(before.installed);
  const current = new Set(after.installed);
  const gone = before.installed.filter((entry) => !current.has(entry));
  const added = after.installed.filter((entry) => !previous.has(entry));
  if (gone.length > 0 || added.length > 0) {
    moved.push(
      `node_modules: ${gone.length} removed, ${added.length} added` +
        `\n  ${[...gone.slice(0, 3), ...added.slice(0, 3)].join("\n  ")}`,
    );
  }
  return moved;
}

/**
 * Losing the race halts the operation it beat, whose scope teardown signals the
 * process group and closes the spool — so a participant settled this way still
 * reports with everything it had written.
 */
function* expiry(milliseconds: number): Operation<Settled> {
  yield* sleep(milliseconds);
  return { code: 1, milliseconds, timedOut: true };
}

/** A participant that never started still failed, and still reports. */
function* attempt(work: () => Operation<Settled>): Operation<Settled> {
  try {
    return yield* work();
  } catch {
    return { code: 1, milliseconds: 0 };
  }
}

/**
 * Watch the sensitive state for as long as this task lives.
 *
 * Every reading is kept, not just the last: a violation that was restored
 * before the next poll is exactly the one a final comparison cannot see.
 */
function* observing(host: VerifyHost, baseline: Sensitive, watch: Watch): Operation<void> {
  while (true) {
    yield* observe(host, baseline, watch);
    yield* host.pause(OBSERVE_INTERVAL_MILLISECONDS);
  }
}

/** What the observer has seen so far. Shared, because the loop never returns. */
interface Watch {
  readings: number;
  violations: string[];
}

/**
 * One reading, counted only once it has actually been taken.
 *
 * The increment follows the read rather than preceding it, because the count is
 * what `untilReady` gates the producer on: incrementing first would report the
 * observer ready while its first reading was still in flight, which is the race
 * the handshake exists to remove.
 */
function* observe(host: VerifyHost, baseline: Sensitive, watch: Watch): Operation<void> {
  try {
    const now = yield* host.sensitive();
    watch.readings++;
    watch.violations.push(...movedSensitive(baseline, now));
  } catch (error) {
    watch.readings++;
    watch.violations.push(`the observer could not read the sensitive state: ${String(error)}`);
  }
}

/**
 * Wait until the whole topology is watching: every consumer has completed a
 * cycle or exited without one, and the observer has taken a reading.
 *
 * The observer is a participant, not scaffolding — a producer that started
 * before its first reading would open the very window it is meant to be watched
 * through. A consumer that died is not waited on: its failure is reported, and
 * the topology continues so the producer and the comparison still happen.
 */
function* untilReady(
  host: VerifyHost,
  settled: ReadonlyMap<string, Settled>,
  watch: Watch,
): Operation<boolean> {
  const ready = new Set<Runtime>();
  while (true) {
    let waiting = watch.readings === 0 ? 1 : 0;
    for (const runtime of RUNTIMES) {
      if (ready.has(runtime) || settled.has(runtime)) {
        continue;
      }
      if (yield* host.isReady(runtime)) {
        ready.add(runtime);
        continue;
      }
      waiting++;
    }
    if (waiting === 0) {
      return false;
    }
    yield* host.pause(READY_INTERVAL_MILLISECONDS);
  }
}

/** The deadline's half of a `race`, which the other half answers `false` to. */
function* overrun(milliseconds: number): Operation<boolean> {
  yield* sleep(milliseconds);
  return true;
}

function* joinAll(tasks: Iterable<Task<void>>): Operation<boolean> {
  for (const task of tasks) {
    yield* task;
  }
  return false;
}

/**
 * Run the interference proof and report it.
 *
 * Returns the exit code: non-zero when a participant failed, when a consumer
 * never overlapped the producer, when the observer saw the sensitive state
 * move, or when repository-owned state came out different from how it went in.
 */
export interface VerifyOptions {
  /**
   * Milliseconds the probe may take, overriding `PROBE_TIMEOUT_MILLISECONDS`.
   *
   * A caller that supplies this is asking for a deterministic ceiling — a test
   * proving what a wedge does — rather than choosing a policy.
   */
  deadline?: number;
}

export function* verify(host: VerifyHost, options: VerifyOptions = {}): Operation<number> {
  const deadline = options.deadline ?? PROBE_TIMEOUT_MILLISECONDS;
  const before = yield* host.owned();
  const baseline = yield* host.sensitive();

  host.log(
    `proving ${RUNTIMES.join(", ")} consume the dependency layout and the generated ` +
      `bundle while \`${PRODUCER}\` republishes it (${minutes(deadline)} deadline)`,
  );
  if (baseline.generated.startsWith(UNREADABLE)) {
    host.log(`\n✗ the generated module is not whole before the probe starts:`);
    host.log(`  ${baseline.generated.slice(UNREADABLE.length)}`);
    host.log(`\nrun \`deno task build:web\` first.`);
    return 1;
  }

  const settled = new Map<string, Settled>();
  const watch: Watch = { readings: 0, violations: [] };

  const consumers = new Map<Runtime, Task<void>>();
  for (const runtime of RUNTIMES) {
    consumers.set(
      runtime,
      yield* spawn(function* () {
        settled.set(runtime, yield* attempt(() => host.consume(runtime)));
      }),
    );
  }

  const observer = yield* spawn(() => observing(host, baseline, watch));

  const overran = yield* race([untilReady(host, settled, watch), overrun(deadline)]);

  if (overran) {
    // Not an observation — the observer saw nothing wrong. The topology never
    // assembled, which is a coordination failure and is reported as one.
    settled.set(PRODUCER, { code: 1, milliseconds: deadline, timedOut: true });
    host.log(
      `\n✗ ${watch.readings === 0 ? "the observer and the consumers" : "the consumers"} ` +
        `did not all reach a reading within ${minutes(deadline)}, ` +
        `so \`${PRODUCER}\` never started`,
    );
  } else {
    yield* host.signal(PRODUCING);
    settled.set(PRODUCER, yield* race([attempt(() => host.produce()), expiry(deadline)]));
  }

  yield* host.signal(SETTLED);
  yield* observer.halt();

  // One reading after the producer is gone, so a violation left standing at the
  // very end is not missed between two polls.
  yield* observe(host, baseline, watch);

  // The consumers stop one cycle after the settlement signal, so joining them
  // is ordinary. A consumer that does not is wedged, and waiting on it forever
  // is the silent hang the deadline exists to remove: it is halted, counted
  // against the deadline, and not retried. Readiness having already overrun
  // means they are wedged by definition, so that case does not wait again.
  const abandoned = overran || (yield* race([joinAll(consumers.values()), overrun(deadline)]));
  if (abandoned) {
    for (const [runtime, task] of consumers) {
      yield* task.halt();
      if (!settled.has(runtime)) {
        settled.set(runtime, { code: 1, milliseconds: deadline, timedOut: true });
      }
    }
  }

  const after = yield* host.owned();

  const counted = new Map<Runtime, CycleReport | undefined>();
  for (const runtime of RUNTIMES) {
    counted.set(runtime, yield* host.cycles(runtime));
  }

  const failures: string[] = [];
  host.log("");
  for (const id of PARTICIPANTS) {
    if (id === OBSERVER) {
      const bad = watch.violations.length;
      const line = `${watch.readings} reading(s)` + (bad === 0 ? "" : `, ${bad} violation(s)`);
      host.log(`  ${bad === 0 ? "ok    " : "FAILED"}  ${id.padEnd(10)} ${line}`);
      if (bad > 0) {
        failures.push(id);
      }
      continue;
    }

    const result = settled.get(id) ?? { code: 1, milliseconds: 0 };
    const consumer = id !== PRODUCER;
    const report = consumer ? counted.get(id as Runtime) : undefined;
    const overlap = !consumer
      ? ""
      : report === undefined
        ? " (recorded no cycles)"
        : ` (${report.before} before, ${report.during} during, ${report.after} after)`;

    // A consumer that exited zero without cycling in every phase proves less
    // than it appears to, and a missing report is the same hole with less to
    // say. `after` counts too: the loop runs exactly one cycle once the
    // producer has settled, so a zero there is a consumer that never saw the
    // state the producer left behind.
    const stalled =
      consumer &&
      (report === undefined || report.before === 0 || report.during === 0 || report.after === 0);
    if (result.code === 0 && !stalled) {
      host.log(`  ok      ${id.padEnd(10)} ${seconds(result.milliseconds)}${overlap}`);
      continue;
    }
    failures.push(id);
    const why = result.timedOut
      ? `timed out after ${minutes(deadline)}`
      : stalled
        ? "never overlapped the producer"
        : `exit ${result.code}`;
    host.log(`  FAILED  ${id.padEnd(10)} ${seconds(result.milliseconds)}${overlap} (${why})`);
  }

  const [first, ...rest] = failures;
  if (first !== undefined) {
    host.log(`\n─── ${first} ───`);
    if (first === OBSERVER) {
      for (const violation of watch.violations) {
        host.log(`  ${violation}`);
      }
    } else {
      host.emit(yield* host.spool(first));
    }
    host.log(`\nre-run with:\n  ${REPRODUCE}`);
    for (const id of rest) {
      host.log(`\nalso failed: ${id}`);
    }
  }

  const moved = movedOwned(before, after);
  if (moved.length > 0) {
    host.log(`\n✗ the probe changed ${moved.length} part(s) of repository-owned state:`);
    for (const change of moved) {
      host.log(`  ${change}`);
    }
    return 1;
  }

  if (failures.length > 0) {
    return 1;
  }
  host.log(
    "\nthe runtimes consumed the layout throughout, and tracked files, " +
      "node_modules and deno.lock are unchanged",
  );
  return 0;
}
