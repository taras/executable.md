/**
 * Reconcile the `ci-main-red` report against the authoritative CI state for
 * `main`.
 *
 * The delivery that wakes a reconciliation carries a verdict and none of it is
 * read: `workflow_run` delivery is unordered, a re-run delivers an old
 * conclusion, and a delivery filtered on its own conclusion would still consume
 * the concurrency group's one pending slot and then reconcile nothing. Every
 * answer comes from the run this module selects, so a stale delivery reaches
 * the same one as a timely delivery.
 */
import { createContext } from "effection";
import type { Context, Operation } from "effection";

export const REPORT_LABEL = "ci-main-red";
export const CI_WORKFLOW = "CI";

/**
 * The identity `GITHUB_TOKEN` writes as, and the only author whose markers
 * count. Issue comments are public, so trusting a marker by its content would
 * let any commenter name the current run and suppress a real report.
 *
 * A wrong constant here trusts nothing and comments on every red wake-up. That
 * direction is deliberate: noisy, never silent.
 */
export const TRUSTED_AUTHOR = "github-actions[bot]";

/** Assigned when the pusher cannot be, so the report always reaches a person. */
export const HUMAN_FALLBACK = "taras";

const RED = ["failure", "timed_out", "startup_failure"];

export interface Run {
  id: number;
  runNumber: number;
  attempt: number;
  status: string;
  conclusion: string | undefined;
  headSha: string;
  headBranch: string;
  event: string;
  workflow: string;
  url: string;
  actor: string;
}

/** Text with the login that wrote it, which is what makes a marker trustworthy. */
export interface Authored {
  author: string;
  text: string;
}

export interface Marker {
  runId: number;
  runNumber: number;
  attempt: number;
}

/** The open report as the reads found it, before its comments are loaded. */
export interface ReportHandle {
  number: number;
  assignees: string[];
  body: Authored;
}

export interface OpenReport {
  number: number;
  assignees: string[];
  candidates: Authored[];
}

export type ReportAction = "none" | "open" | "comment" | "comment-then-close";

export interface Decision {
  report: ReportAction;
  /** The login to ensure is assigned, or undefined when there is nothing to do. */
  assignment: string | undefined;
}

export interface GitHubReads {
  head(): Operation<string>;
  runs(head: string): Operation<Run[]>;
  findReport(): Operation<ReportHandle | undefined>;
  comments(issue: number): Operation<Authored[]>;
}

export interface IssueOperations {
  ensureLabel(label: string): Operation<void>;
  open(input: { title: string; body: string; label: string }): Operation<number>;
  comment(issue: number, body: string): Operation<void>;
  close(issue: number): Operation<void>;
  assign(issue: number, login: string): Operation<void>;
  warn(message: string): void;
}

export const Reads: Context<GitHubReads> = createContext<GitHubReads>("main-health.reads");

export const Issues: Context<IssueOperations> =
  createContext<IssueOperations>("main-health.issues");

/**
 * The CI run that decides whether `main` is red: current head, pushed to
 * `main`, highest run number, then highest attempt — so a re-run supersedes
 * its original by construction.
 */
export function selectAuthoritative(head: string, runs: Run[]): Run | undefined {
  let best: Run | undefined;
  for (const run of runs) {
    const eligible =
      run.headSha === head &&
      run.workflow === CI_WORKFLOW &&
      run.event === "push" &&
      run.headBranch === "main";
    if (!eligible) {
      continue;
    }
    if (best === undefined || newer(run.runNumber, run.attempt, best.runNumber, best.attempt)) {
      best = run;
    }
  }
  return best;
}

function newer(number: number, attempt: number, thanNumber: number, thanAttempt: number): boolean {
  if (number !== thanNumber) {
    return number > thanNumber;
  }
  return attempt > thanAttempt;
}

const MARKER = /<!--\s*main-health run=(\d+) number=(\d+) attempt=(\d+)\s*-->/;

export function renderMarker(run: Run): string {
  return `<!-- main-health run=${run.id} number=${run.runNumber} attempt=${run.attempt} -->`;
}

export function parseMarker(text: string): Marker | undefined {
  const found = MARKER.exec(text);
  if (found === null) {
    return undefined;
  }
  return {
    runId: Number(found[1]),
    runNumber: Number(found[2]),
    attempt: Number(found[3]),
  };
}

/**
 * The newest marker written by the workflow itself, by value rather than by
 * position. Anything authored by anyone else is not a marker.
 */
export function selectMarker(candidates: Authored[]): Marker | undefined {
  let newest: Marker | undefined;
  for (const candidate of candidates) {
    if (candidate.author !== TRUSTED_AUTHOR) {
      continue;
    }
    const marker = parseMarker(candidate.text);
    if (marker === undefined) {
      continue;
    }
    if (
      newest === undefined ||
      newer(marker.runNumber, marker.attempt, newest.runNumber, newest.attempt)
    ) {
      newest = marker;
    }
  }
  return newest;
}

/**
 * Report content and assignment are decided independently. An assignment that
 * fails leaves the report open and marked, so tying the two together would
 * make the next reconciliation see a matching marker, write nothing, and never
 * retry the assignment — leaving a report nobody owns.
 */
export function decide(input: {
  authoritative: Run | undefined;
  report: OpenReport | undefined;
}): Decision {
  const { authoritative, report } = input;

  if (authoritative === undefined || authoritative.status !== "completed") {
    return { report: "none", assignment: undefined };
  }

  if (authoritative.conclusion === "success") {
    return {
      report: report === undefined ? "none" : "comment-then-close",
      assignment: undefined,
    };
  }

  // `cancelled` says someone stopped the run or a newer push superseded it,
  // which is not a statement that `main` is broken.
  if (authoritative.conclusion === undefined || !RED.includes(authoritative.conclusion)) {
    return { report: "none", assignment: undefined };
  }

  if (report === undefined) {
    return { report: "open", assignment: authoritative.actor };
  }

  const marker = selectMarker(report.candidates);
  const reported =
    marker !== undefined &&
    marker.runId === authoritative.id &&
    marker.attempt === authoritative.attempt;

  return {
    report: reported ? "none" : "comment",
    assignment: report.assignees.includes(authoritative.actor) ? undefined : authoritative.actor,
  };
}

export function renderTitle(run: Run): string {
  return `\`main\` is red: CI ${run.conclusion} at ${run.headSha.slice(0, 7)}`;
}

/**
 * The notice leads, because the reader of this issue is the one person who can
 * break the mechanism: closing it by hand while `main` is still red means the
 * next failure opens a second issue instead of commenting on this one.
 */
export function renderBody(run: Run): string {
  return [
    "> **Do not close this issue by hand.** It closes itself when CI next",
    "> succeeds on `main`. Closing it early only means the next failure opens",
    "> a second one.",
    "",
    `CI concluded \`${run.conclusion}\` on \`main\`.`,
    "",
    `- Commit: \`${run.headSha.slice(0, 7)}\` (pushed by @${run.actor})`,
    `- Run: ${run.url}`,
    "",
    renderMarker(run),
  ].join("\n");
}

export function renderComment(run: Run): string {
  return [
    `CI concluded \`${run.conclusion}\` on \`main\` again.`,
    "",
    `- Commit: \`${run.headSha.slice(0, 7)}\` (pushed by @${run.actor})`,
    `- Run: ${run.url}`,
    "",
    renderMarker(run),
  ].join("\n");
}

export function renderRecovery(run: Run): string {
  return `✅ \`main\` is green again at \`${run.headSha.slice(0, 7)}\` — [run](${run.url}).`;
}

function* ensureAssignee(issues: IssueOperations, issue: number, login: string): Operation<void> {
  try {
    yield* issues.assign(issue, login);
    return;
  } catch (error) {
    issues.warn(`could not assign @${login} to #${issue}: ${describe(error)}`);
  }
  try {
    yield* issues.assign(issue, HUMAN_FALLBACK);
  } catch (error) {
    issues.warn(
      `could not assign the fallback @${HUMAN_FALLBACK} to #${issue}: ${describe(error)}`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function* reconcile(
  decision: Decision,
  authoritative: Run,
  report: OpenReport | undefined,
): Operation<void> {
  const issues = yield* Issues.expect();
  let issue = report?.number;

  if (decision.report === "open") {
    // Before the first report on a repository that has never had one: `open`
    // fails at `--label` if it does not exist, and reports nothing.
    yield* issues.ensureLabel(REPORT_LABEL);
    issue = yield* issues.open({
      title: renderTitle(authoritative),
      body: renderBody(authoritative),
      label: REPORT_LABEL,
    });
  } else if (issue !== undefined && decision.report === "comment") {
    yield* issues.comment(issue, renderComment(authoritative));
  } else if (issue !== undefined && decision.report === "comment-then-close") {
    yield* issues.comment(issue, renderRecovery(authoritative));
    yield* issues.close(issue);
  }

  if (decision.assignment !== undefined && issue !== undefined) {
    yield* ensureAssignee(issues, issue, decision.assignment);
  }
}

/**
 * Every read completes before any mutation. A failed query is never read as an
 * absence: an outage that resolved to "no authoritative run" would be
 * indistinguishable from a green `main`, and that error's direction is silence.
 */
export function* mainHealth(): Operation<Decision> {
  const reads = yield* Reads.expect();

  const head = yield* reads.head();
  const runs = yield* reads.runs(head);
  const handle = yield* reads.findReport();

  let report: OpenReport | undefined;
  if (handle !== undefined) {
    report = {
      number: handle.number,
      assignees: handle.assignees,
      candidates: [handle.body, ...(yield* reads.comments(handle.number))],
    };
  }

  const authoritative = selectAuthoritative(head, runs);
  const decision = decide({ authoritative, report });

  if (authoritative !== undefined) {
    yield* reconcile(decision, authoritative, report);
  }

  return decision;
}
