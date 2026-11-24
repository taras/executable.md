/**
 * Waiting for one pull request's checks to settle
 * (specs/workflow-workspace-spec.md §7.7.1).
 *
 * `<PullRequest.Checks watch timeoutSeconds={…} as="result" />` reads the same
 * complete check-run and commit-status collection a snapshot reads, repeatedly,
 * until every reported check has settled or the caller's budget runs out. What
 * this module owns is provider-neutral: the result record, how a collection is
 * classified, and the polling loop. The reads themselves are the existing
 * `checks` and `details` transport reads, so matching, the host ceiling, the
 * credential and the record contract are exactly the snapshot's.
 *
 * ## The head is pinned
 *
 * The first successful read of the pull request names the head, and that head is
 * the one the watch reports on, however many collections fail after it. The
 * head is read again before every later collection and once more before a
 * collection is accepted; the collection itself must be at the pinned head too. A different head ends the watch as `head-changed` even when the
 * collection just read would have settled it, because that collection describes
 * a revision nobody asked about.
 *
 * ## One deadline bounds everything
 *
 * The whole loop races one sleep to the deadline, so requests, pagination,
 * retry delays and poll sleeps all end when the budget does. The state the loop
 * mutates is what the result is built from afterwards, so a deadline that lands
 * mid-request still reports the last accepted collection.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { Err, Ok, race, sleep } from "effection";
import type { Operation, Result } from "effection";
import { isJsonObject, JsonParseError, parseJson } from "@executablemd/core";
import type { Json, JsonObject } from "@executablemd/core";
import { PullRequestReadError } from "./errors.ts";
import {
  parsePullRequestReadResult,
  pullRequestReadResultJson,
} from "./pull-request-read-records.ts";
import type { CheckEvidence, PullRequestReadResult } from "./pull-request-read-records.ts";

/** The element every watch refusal names. */
const ELEMENT = "<PullRequest.Checks>";

/** How long a watch waits between two accepted observations. */
export const CHECK_WATCH_POLL_MS = 10_000;

/** How long a watch waits after a read it could not complete. */
export const CHECK_WATCH_RETRY_MS = 5_000;

export type CheckWatchOutcome = "success" | "failure" | "incomplete";

export type CheckWatchReason = "timeout" | "head-changed" | "read-error";

/**
 * What a watch binds.
 *
 * `success` and `failure` are settled CI results and carry no reason. An
 * `incomplete` result says why a settled result could not be established.
 * `checks` is the last complete collection accepted for `headSha`, in provider
 * order and with every record whole.
 */
export interface CheckWatchResult {
  readonly outcome: CheckWatchOutcome;
  readonly reason?: CheckWatchReason;
  readonly headSha: string | null;
  readonly checks: readonly CheckEvidence[];
}

/** What one watch was asked. */
export interface CheckWatchInvocation {
  /** The canonical pull-request URL. */
  readonly url: string;
  /** The explicit discriminator, for a self-hosted or non-standard URL. */
  readonly provider: string | undefined;
  /** The caller's whole budget, in seconds. */
  readonly timeoutSeconds: number;
}

/** The stable name every loaded copy composes the watch through. */
export const PULL_REQUEST_CHECKS_WATCH = "executablemd.git.composition.pull-request-checks-watch";

export interface PullRequestChecksWatchApi {
  /** Wait for the pull request's reported checks to settle, within the budget. */
  watch(invocation: CheckWatchInvocation): Operation<CheckWatchResult>;
}

/**
 * The watch a host supports, refused by default.
 *
 * Only a host that retains the deadline and the pinned head per invocation can
 * continue an unfinished watch honestly, so a profile that installs nothing here
 * refuses before any read, credential or request.
 */
export const PullRequestChecksWatch: Api<PullRequestChecksWatchApi> =
  createApi<PullRequestChecksWatchApi>(PULL_REQUEST_CHECKS_WATCH, {
    // deno-lint-ignore require-yield
    *watch(_invocation: CheckWatchInvocation): Operation<CheckWatchResult> {
      throw new PullRequestReadError(
        "unsupported",
        ELEMENT,
        "this host does not watch checks; a REPL entry does. Omit `watch` to read one snapshot.",
      );
    },
  });

/** The stable name of the clock a watch reads its deadline and sleeps through. */
export const PULL_REQUEST_WATCH_CLOCK = "executablemd.git.composition.pull-request-watch-clock";

export interface PullRequestWatchClockApi {
  /** Milliseconds since the epoch. */
  now(): Operation<number>;
  /** Wait this many milliseconds. */
  sleep(milliseconds: number): Operation<void>;
}

/** Wall-clock time by default; a suite composes a controlled clock around it. */
export const PullRequestWatchClock: Api<PullRequestWatchClockApi> =
  createApi<PullRequestWatchClockApi>(PULL_REQUEST_WATCH_CLOCK, {
    // deno-lint-ignore require-yield
    *now(): Operation<number> {
      return Date.now();
    },
    sleep(milliseconds: number): Operation<void> {
      return sleep(milliseconds);
    },
  });

/** How one record stands, under the watch's completion policy. */
type CheckStanding = "passed" | "failed" | "pending";

/**
 * Successful, skipped and neutral results pass; a terminal failure, error,
 * cancellation, timeout or action-required result fails; everything else is
 * still running. A completed run without a conclusion cannot establish
 * completion, so it stays pending.
 */
function checkStanding(check: CheckEvidence): CheckStanding {
  if (check.kind === "commit-status") {
    if (check.state === "success") {
      return "passed";
    }
    return check.state === "pending" ? "pending" : "failed";
  }
  if (check.status !== "completed" || check.conclusion === null) {
    return "pending";
  }
  const passing = ["success", "neutral", "skipped"];
  return passing.includes(check.conclusion) ? "passed" : "failed";
}

/**
 * The settled outcome of one complete collection, or `undefined` while any
 * reported check is still running. An empty collection keeps waiting: nothing
 * reported is not the same as everything passed.
 */
function settledOutcome(checks: readonly CheckEvidence[]): "success" | "failure" | undefined {
  if (checks.length === 0) {
    return undefined;
  }
  const standings = checks.map(checkStanding);
  if (standings.includes("pending")) {
    return undefined;
  }
  return standings.includes("failed") ? "failure" : "success";
}

/** The binding one result becomes. */
export function checkWatchResultJson(result: CheckWatchResult): JsonObject {
  const checks = pullRequestReadResultJson({
    kind: "checks",
    headSha: result.headSha ?? "",
    items: result.checks,
  });
  return {
    outcome: result.outcome,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    headSha: result.headSha,
    checks,
  };
}

/**
 * The result a value describes, read whole.
 *
 * Total over values this boundary did not create. A settled outcome carries no
 * reason and an incomplete one requires one; a settled outcome needs a head and
 * a collection that actually settles that way; and every record names the
 * watched head, because a record about another revision is not evidence about
 * this one.
 */
export function parseCheckWatchResult(value: unknown): CheckWatchResult | undefined {
  let complete: Json;
  try {
    complete = parseJson(value);
  } catch (error) {
    if (error instanceof JsonParseError) {
      return undefined;
    }
    throw error;
  }
  if (!isJsonObject(complete)) {
    return undefined;
  }
  const outcome = (["success", "failure", "incomplete"] as const).find(
    (known) => known === complete.outcome,
  );
  const headSha = complete.headSha;
  if (outcome === undefined || (headSha !== null && typeof headSha !== "string")) {
    return undefined;
  }
  if (headSha === "") {
    return undefined;
  }
  const settled = outcome !== "incomplete";
  const members = settled
    ? ["outcome", "headSha", "checks"]
    : ["outcome", "reason", "headSha", "checks"];
  const present = Object.keys(complete);
  if (present.length !== members.length || !members.every((name) => present.includes(name))) {
    return undefined;
  }
  const reason = (["timeout", "head-changed", "read-error"] as const).find(
    (known) => known === complete.reason,
  );
  if (!settled && reason === undefined) {
    return undefined;
  }
  const listed = complete.checks;
  if (!Array.isArray(listed)) {
    return undefined;
  }
  if (headSha === null) {
    return listed.length === 0 && !settled ? { outcome, reason, headSha, checks: [] } : undefined;
  }
  const envelope = parsePullRequestReadResult({ kind: "checks", headSha, items: listed });
  if (envelope?.kind !== "checks") {
    return undefined;
  }
  if (settled) {
    return settledOutcome(envelope.items) === outcome
      ? { outcome, headSha, checks: envelope.items }
      : undefined;
  }
  return { outcome, reason, headSha, checks: envelope.items };
}

/**
 * The two reads one watch cycle makes, through the host's ordinary transport.
 *
 * Each answers with the complete read or with the failure that the read could
 * not be completed. A refusal that happens before the host contacts anything —
 * an unmatched URL, a target outside the ceiling — is raised instead, because
 * waiting would not make it a question this host may ask.
 */
export interface CheckWatchReads {
  read(kind: "checks" | "details"): Operation<Result<PullRequestReadResult>>;
}

/**
 * What one watch has established so far.
 *
 * Mutated by the loop and read after it, so a deadline that halts a cycle
 * mid-request still finds the last accepted collection here.
 */
export interface CheckWatchState {
  /** When the budget ends, in the clock's milliseconds. */
  readonly deadline: number;
  /** The pinned head, once the pull request has named one. */
  headSha: string | null;
  /** The last complete collection accepted for the pinned head. */
  checks: readonly CheckEvidence[];
  /** Whether the latest read failed and no later one has succeeded. */
  failing: boolean;
  /** The pinned head was just observed, so the next collection needs no fresh look. */
  observed?: boolean;
  /** The last progress line written, so a repeated one is suppressed. */
  shown?: string;
}

/** Writes one line of live progress. */
export type CheckWatchProgress = (line: string) => Operation<void>;

export function checkWatchState(deadline: number): CheckWatchState {
  return { deadline, headSha: null, checks: [], failing: false };
}

/**
 * Poll until the pull request names its head, or the budget ends.
 *
 * The first half of a watch, separated so a host can retain the pinned head
 * before any collection is read: a collection that fails afterwards, a retry,
 * and an unfinished watch that resumes all keep the head first observed rather
 * than whatever the pull request names by then.
 */
export function* pinCheckHead(
  state: CheckWatchState,
  reads: CheckWatchReads,
  progress: CheckWatchProgress,
): Operation<void> {
  yield* withinDeadline(state, function* (): Operation<void> {
    while (state.headSha === null) {
      const head = yield* observedHead(reads);
      if (!head.ok) {
        yield* failed(state, progress);
        continue;
      }
      state.headSha = head.value;
      state.observed = true;
    }
  });
}

/**
 * Poll the pinned head until every reported check settles, or the budget ends.
 *
 * Waits for every check even when one has already failed: the result reports a
 * settled collection, not the first failure.
 */
export function* settleChecks(
  state: CheckWatchState,
  reads: CheckWatchReads,
  progress: CheckWatchProgress,
): Operation<CheckWatchResult> {
  const pinned = state.headSha;
  if (pinned === null) {
    return incomplete(state, state.failing ? "read-error" : "timeout");
  }
  let ended: CheckWatchResult | undefined;
  yield* withinDeadline(state, function* (): Operation<void> {
    while (ended === undefined) {
      // The head is looked at before every collection, so a move is reported
      // without paging the new head's checks — even when that paging would fail
      // or never finish.
      if (state.observed !== true) {
        const head = yield* observedHead(reads);
        if (!head.ok) {
          yield* failed(state, progress);
          continue;
        }
        if (head.value !== pinned) {
          ended = incomplete(state, "head-changed");
          continue;
        }
      }
      delete state.observed;
      const collected = yield* collection(reads);
      if (!collected.ok) {
        yield* failed(state, progress);
        continue;
      }
      if (collected.value.headSha !== pinned) {
        ended = incomplete(state, "head-changed");
        continue;
      }
      const items = collected.value.items;
      const verified = yield* observedHead(reads);
      if (!verified.ok) {
        yield* failed(state, progress);
        continue;
      }
      if (verified.value !== pinned) {
        ended = incomplete(state, "head-changed");
        continue;
      }
      state.checks = items;
      state.failing = false;
      yield* show(state, progress, summary(pinned, items));
      const outcome = settledOutcome(items);
      if (outcome !== undefined) {
        ended = { outcome, headSha: pinned, checks: items };
        continue;
      }
      yield* PullRequestWatchClock.operations.sleep(CHECK_WATCH_POLL_MS);
    }
  });
  return ended ?? incomplete(state, state.failing ? "read-error" : "timeout");
}

/** The head the pull request names now, from its own record. */
function* observedHead(reads: CheckWatchReads): Operation<Result<string>> {
  const read = yield* reads.read("details");
  if (!read.ok) {
    return read;
  }
  if (read.value.kind !== "details") {
    return Err(
      new PullRequestReadError("protocol", ELEMENT, "a details read answered another kind."),
    );
  }
  return Ok(read.value.details.headSha);
}

/** One complete checks read, narrowed to the collection it must be. */
function* collection(
  reads: CheckWatchReads,
): Operation<Result<{ readonly headSha: string; readonly items: readonly CheckEvidence[] }>> {
  const read = yield* reads.read("checks");
  if (!read.ok) {
    return read;
  }
  if (read.value.kind !== "checks") {
    return Err(
      new PullRequestReadError("protocol", ELEMENT, "a checks read answered another kind."),
    );
  }
  return Ok({ headSha: read.value.headSha, items: read.value.items });
}

/** Run `body` until it returns or the deadline passes, whichever is first. */
function* withinDeadline(state: CheckWatchState, body: () => Operation<void>): Operation<void> {
  const remaining = state.deadline - (yield* PullRequestWatchClock.operations.now());
  if (remaining <= 0) {
    return;
  }
  yield* race([body(), PullRequestWatchClock.operations.sleep(remaining)]);
}

function* failed(state: CheckWatchState, progress: CheckWatchProgress): Operation<void> {
  state.failing = true;
  const head = state.headSha === null ? "" : ` at ${short(state.headSha)}`;
  yield* show(state, progress, `Checks${head}: retrying after a read error`);
  yield* PullRequestWatchClock.operations.sleep(CHECK_WATCH_RETRY_MS);
}

function* show(
  state: CheckWatchState,
  progress: CheckWatchProgress,
  line: string,
): Operation<void> {
  if (state.shown === line) {
    return;
  }
  state.shown = line;
  yield* progress(line);
}

function summary(headSha: string, checks: readonly CheckEvidence[]): string {
  const standings = checks.map(checkStanding);
  const count = (standing: CheckStanding) => standings.filter((s) => s === standing).length;
  return (
    `Checks at ${short(headSha)}: ${count("passed")} passed, ${count("failed")} failed, ` +
    `${count("pending")} pending`
  );
}

function short(headSha: string): string {
  return headSha.slice(0, 7);
}

function incomplete(state: CheckWatchState, reason: CheckWatchReason): CheckWatchResult {
  return { outcome: "incomplete", reason, headSha: state.headSha, checks: state.checks };
}
