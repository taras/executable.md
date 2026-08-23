/**
 * Decide whether a pull request may claim `green`.
 *
 * Main Health reports a red `main` and assigns it to a person. Reporting is not
 * gating: an ordinary pull request could still pass every check of its own and
 * merge onto a base nothing had proven, which makes the next `main` failure
 * indistinguishable from the one already open. This gate closes that by
 * refusing the aggregate check until CI has completed successfully for `main`'s
 * *exact* current head.
 *
 * Exact is the whole claim. A successful run for the previous head says only
 * that `main` used to work, and that is precisely the state a red `main` is in
 * one commit after it broke. So the authoritative run is selected by
 * `selectAuthoritative()` — the same head/branch/event/number/attempt rules
 * Main Health decides a report with, rather than a second interpretation of
 * main health that could disagree with the issue an operator is reading.
 *
 * Exactness is also why the gate waits rather than answering once. `main`'s
 * verdict arrives minutes after its push, and a pull request that asked too
 * early has no verdict to read — that is a missing answer, not a red `main`.
 * So an absent, queued or in-progress run is a state to wait through, an
 * advancing head is one to follow, and only a completed run for the head that
 * is still current is a verdict at all. Waiting is a convergence — `when()`
 * from `@effectionx/converge` — and running out of it means this pull request
 * obtained no proof, which is not the same claim as `main` having failed.
 */
import { createContext, Err, Ok } from "effection";
import type { Context, Operation, Result } from "effection";
import { when } from "@effectionx/converge";
import type { ConvergeOptions } from "@effectionx/converge";

import { selectAuthoritative } from "./main-health.ts";
import type { Run } from "./main-health.ts";

/**
 * The one exception, applied by a maintainer to one pull request.
 *
 * Restoring a red `main` needs a pull request that cannot satisfy this gate, by
 * construction — the base it would prove is the broken one. The label buys only
 * the remote lookup: the labelled pull request additionally runs
 * `composability`, the clean-checkout battery `main` pushes run, so the branch
 * that claims to repair `main` proves it the same way `main` itself is proven.
 */
export const REPAIR_LABEL = "ci-main-red-fix";

/** Held here so the gate and the label a maintainer applies cannot drift. */
export const REPAIR_LABEL_DESCRIPTION =
  "Maintainer-controlled: lands one PR while main is red, only with the full clean-checkout proof";

/**
 * How long the waiter sleeps between polls.
 *
 * An authoritative `main` run takes tens of minutes, so this is not a race to
 * observe the finish; it is short enough that following an advancing head costs
 * one interval, and long enough that a waiting job is not a poller.
 */
export const POLL_INTERVAL_MILLISECONDS = 15 * 1000;

/** The `timeout-minutes` on the job, held here so the two cannot drift. */
export const JOB_TIMEOUT_MINUTES = 60;

/**
 * When the waiter gives up, which is deliberately before the job does.
 *
 * The job's timeout kills the step mid-poll and leaves the log saying nothing
 * about what was awaited. Converging inside that bound means the gate reports
 * the state it last saw, so "no verdict arrived" is legible and stays distinct
 * from `main` having failed.
 */
export const WAIT_TIMEOUT_MILLISECONDS = 55 * 60 * 1000;

/** What one pass over `main` saw. Only the last two arms are verdicts. */
export type Observation =
  | { kind: "advanced"; from: string; to: string }
  | { kind: "absent"; head: string }
  | { kind: "unfinished"; run: Run }
  | { kind: "unsuccessful"; run: Run }
  | { kind: "successful"; run: Run };

/**
 * The gate's one failure: CI completed unsuccessfully for the head `main` still
 * has. Nothing else reaches here — an absent, unfinished or superseded
 * observation is a reason to keep waiting, and reporting one as a main-health
 * verdict would blame `main` for an answer that had not arrived yet.
 */
export class MainNotGreen extends Error {
  readonly run: Run;

  constructor(run: Run) {
    super(explain(run));
    this.name = "MainNotGreen";
    this.run = run;
  }
}

/** What let the gate pass, which is the one thing the job's log has to say. */
export type Clearance = { via: "repair" } | { via: "main"; run: Run };

export interface MainReads {
  head(): Operation<string>;
  runs(head: string): Operation<Run[]>;
}

export const Reads: Context<MainReads> = createContext<MainReads>("main-green.reads");

/** Where the waiter says what it is waiting on. */
export type Note = (message: string) => void;

/**
 * How the wait is paced and where it reports.
 *
 * `interval` and `timeout` are `when()`'s own options, so a focused test drives
 * many iterations in no real time by shrinking both.
 */
export interface WaitOptions extends ConvergeOptions {
  note?: Note;
}

/**
 * The waiter ran out of time before `main` produced a verdict.
 *
 * This is the absence of proof, not proof of a red `main`: nothing here says
 * CI failed, only that it had not finished for a head that stayed current.
 */
export class NoVerdict extends Error {
  constructor(awaiting: string, milliseconds: number) {
    super(`no verdict for \`main\` within ${milliseconds}ms — still ${awaiting}`);
    this.name = "NoVerdict";
  }
}

/** Thrown to keep `when()` converging; never escapes this module. */
class StillWaiting extends Error {}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function explain(run: Run): string {
  return [
    `CI for \`main\` at ${short(run.headSha)} concluded`,
    `${run.conclusion ?? "without a conclusion"} (${run.url}).`,
    `Restore \`main\` first, or label a repair pull request \`${REPAIR_LABEL}\`.`,
  ].join(" ");
}

/**
 * The line the job's log gets while the gate is still waiting.
 *
 * It names every field a change is worth reporting — the head, the run's number
 * and attempt, and its status — because the waiter decides whether to print by
 * comparing this text against the last one it printed. One renderer, so a state
 * that changed cannot render identically and go unsaid.
 */
export function narrate(observation: Observation): string {
  if (observation.kind === "advanced") {
    return [
      `\`main\` advanced from ${short(observation.from)} to ${short(observation.to)}`,
      "— following the new head.",
    ].join(" ");
  }
  if (observation.kind === "absent") {
    return `waiting for CI to start on \`main\` at ${short(observation.head)}.`;
  }
  const { run } = observation;
  return [
    `waiting for CI run ${run.runNumber}.${run.attempt} on \`main\``,
    `at ${short(run.headSha)}: ${run.status} (${run.url}).`,
  ].join(" ");
}

export function announce(clearance: Clearance): string {
  if (clearance.via === "repair") {
    return [
      `\`${REPAIR_LABEL}\` is applied, so \`main\`'s health is not consulted.`,
      "This pull request proves itself with the full clean-checkout battery instead.",
    ].join(" ");
  }
  return `\`main\` is green at ${short(clearance.run.headSha)} — ${clearance.run.url}`;
}

/**
 * What everything read amounts to.
 *
 * `became` is the head as it stood after the runs were listed, and it is read
 * first here: a conclusion about a head `main` has left describes neither the
 * base nor `main`, so a stale failure must not fail the gate any more than a
 * stale success may pass it.
 */
export function judge(input: { head: string; runs: Run[]; became: string }): Observation {
  const { head, runs, became } = input;

  if (became !== head) {
    return { kind: "advanced", from: head, to: became };
  }

  const authoritative = selectAuthoritative(head, runs);

  if (authoritative === undefined) {
    return { kind: "absent", head };
  }
  if (authoritative.status !== "completed") {
    return { kind: "unfinished", run: authoritative };
  }
  if (authoritative.conclusion !== "success") {
    return { kind: "unsuccessful", run: authoritative };
  }

  return { kind: "successful", run: authoritative };
}

/**
 * Read `main`'s head, the runs for it, and its head again — in that order,
 * because the second read is what makes the first one's verdict current.
 */
export function* inspectMain(): Operation<Observation> {
  const reads = yield* Reads.expect();

  const head = yield* reads.head();
  const runs = yield* reads.runs(head);
  const became = yield* reads.head();

  return judge({ head, runs, became });
}

/**
 * Converge on a verdict for the head `main` currently has.
 *
 * Absent, queued, in-progress and superseded are the states `when()` keeps
 * retrying through: each throws, so the poll continues, and the last one thrown
 * is what the timeout reports. A completed run for the still-current head — and
 * an infrastructure failure — are returned instead, because a returned value is
 * what converges, and neither is something a later poll can improve on.
 */
export function* waitForMain(options: WaitOptions = {}): Operation<Result<Run>> {
  const { note = console.log, ...converging } = options;

  let said: string | undefined;

  function* poll(): Operation<Result<Run>> {
    let observation: Observation;
    try {
      observation = yield* inspectMain();
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }

    if (observation.kind === "successful") {
      return Ok(observation.run);
    }
    if (observation.kind === "unsuccessful") {
      return Err(new MainNotGreen(observation.run));
    }

    const line = narrate(observation);
    if (line !== said) {
      note(line);
      said = line;
    }
    throw new StillWaiting(line);
  }

  const timeout = converging.timeout ?? WAIT_TIMEOUT_MILLISECONDS;

  try {
    const converged = yield* when(poll, {
      interval: POLL_INTERVAL_MILLISECONDS,
      ...converging,
      timeout,
    });
    return converged.value;
  } catch (error) {
    if (error instanceof StillWaiting) {
      return Err(new NoVerdict(error.message, timeout));
    }
    throw error;
  }
}

/**
 * A label payload is a JSON array of names, and anything else is a
 * misconfiguration rather than an absent label: reading "no labels" out of a
 * payload this could not parse would apply the gate to a repair pull request
 * that was correctly labelled, which is the direction that cannot be recovered
 * from without an admin.
 */
export function repairRequested(payload: string): boolean {
  const parsed: unknown = JSON.parse(payload);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `the pull request's labels were ${JSON.stringify(parsed)}, expected an array of names`,
    );
  }
  return parsed.includes(REPAIR_LABEL);
}

/**
 * The gate's whole decision. The repair label bypasses the remote lookup and
 * nothing else — every other job, `composability` included, still has to pass
 * for the labelled pull request to reach `green`. It is read before anything
 * else happens, so a repair pull request neither reads `main` nor waits on it.
 */
export function* mainGreen(
  payload: string,
  options: WaitOptions = {},
): Operation<Result<Clearance>> {
  if (repairRequested(payload)) {
    return Ok({ via: "repair" });
  }

  const found = yield* waitForMain(options);
  if (!found.ok) {
    return found;
  }

  return Ok({ via: "main", run: found.value });
}
