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
 * `main` is a moving target, so the head is read twice: once to select against,
 * once after inspecting the run. A head that changed in between means the
 * verdict describes a commit that is no longer the base, and the gate blocks
 * rather than reporting a stale pass.
 */
import { createContext, Err, Ok } from "effection";
import type { Context, Operation, Result } from "effection";

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

/** What stopped the gate. Every arm blocks; they differ in what to tell the author. */
export type Obstacle =
  | { kind: "absent"; head: string }
  | { kind: "unfinished"; run: Run }
  | { kind: "unsuccessful"; run: Run }
  | { kind: "advanced"; from: string; to: string };

export class MainNotGreen extends Error {
  readonly obstacle: Obstacle;

  constructor(obstacle: Obstacle) {
    super(explain(obstacle));
    this.name = "MainNotGreen";
    this.obstacle = obstacle;
  }
}

/** What let the gate pass, which is the one thing the job's log has to say. */
export type Clearance = { via: "repair" } | { via: "main"; run: Run };

export interface MainReads {
  head(): Operation<string>;
  runs(head: string): Operation<Run[]>;
}

export const Reads: Context<MainReads> = createContext<MainReads>("main-green.reads");

function short(sha: string): string {
  return sha.slice(0, 7);
}

export function explain(obstacle: Obstacle): string {
  if (obstacle.kind === "absent") {
    return [
      `no completed CI run exists for \`main\` at ${short(obstacle.head)}.`,
      "A run for an earlier commit does not prove this one.",
      "Wait for CI to finish on `main`, then re-run this job.",
    ].join(" ");
  }
  if (obstacle.kind === "unfinished") {
    return [
      `CI for \`main\` at ${short(obstacle.run.headSha)} is ${obstacle.run.status}`,
      `(${obstacle.run.url}). Wait for it to finish, then re-run this job.`,
    ].join(" ");
  }
  if (obstacle.kind === "unsuccessful") {
    return [
      `CI for \`main\` at ${short(obstacle.run.headSha)} concluded`,
      `${obstacle.run.conclusion ?? "without a conclusion"} (${obstacle.run.url}).`,
      `Restore \`main\` first, or label a repair pull request \`${REPAIR_LABEL}\`.`,
    ].join(" ");
  }
  return [
    `\`main\` advanced from ${short(obstacle.from)} to ${short(obstacle.to)}`,
    "while this gate inspected it, so the run it read is no longer about the base.",
    "Re-run this job.",
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
 * The verdict, as a function of everything read.
 *
 * `became` is the head as it stood after the run was inspected. The run checks
 * come first so a broken `main` is named concretely rather than reported as a
 * race, and the two together are what a pass requires.
 */
export function judge(input: { head: string; runs: Run[]; became: string }): Result<Run> {
  const { head, runs, became } = input;
  const authoritative = selectAuthoritative(head, runs);

  if (authoritative === undefined) {
    return Err(new MainNotGreen({ kind: "absent", head }));
  }
  if (authoritative.status !== "completed") {
    return Err(new MainNotGreen({ kind: "unfinished", run: authoritative }));
  }
  if (authoritative.conclusion !== "success") {
    return Err(new MainNotGreen({ kind: "unsuccessful", run: authoritative }));
  }
  if (became !== head) {
    return Err(new MainNotGreen({ kind: "advanced", from: head, to: became }));
  }

  return Ok(authoritative);
}

/**
 * Read `main`'s head, the runs for it, and its head again — in that order,
 * because the second read is what makes the first one's verdict current.
 */
export function* inspectMain(): Operation<Result<Run>> {
  const reads = yield* Reads.expect();

  const head = yield* reads.head();
  const runs = yield* reads.runs(head);
  const became = yield* reads.head();

  return judge({ head, runs, became });
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
 * for the labelled pull request to reach `green`.
 */
export function* mainGreen(payload: string): Operation<Result<Clearance>> {
  if (repairRequested(payload)) {
    return Ok({ via: "repair" });
  }

  const found = yield* inspectMain();
  if (!found.ok) {
    return found;
  }

  return Ok({ via: "main", run: found.value });
}
