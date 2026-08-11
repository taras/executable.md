/**
 * The durable `workflow_run` record, and what a history has to hold to be a
 * run's own.
 *
 * One immutable value per workflow run, written before the root document is
 * imported. The journal is parsed, never trusted: a record that does not
 * describe a workflow run is refused rather than coerced, and a record made
 * from a different base is refused rather than quietly standing in for this
 * run's.
 *
 * Recognition is deliberately narrow. A record identifies a run only when it is
 * the root coroutine's own successfully settled Yield, under the canonical type
 * *and* the canonical name, holding a closed value of exactly the three members
 * a run has. Anything looser lets a same-typed Yield written under another name,
 * or by a child coroutine, stand in for the record that was removed — and a
 * recorded terminal result would then be reused on its authority.
 */

import { StaleInputError } from "@executablemd/durable-streams";
import type { DurableEvent, EffectDescription } from "@executablemd/durable-streams";

/**
 * One workflow run: an opaque identifier, the base that was asked for, and the
 * commit that base resolved to once.
 */
export interface WorkflowRun {
  readonly runId: string;
  readonly base: string;
  readonly pinnedCommit: string;
}

export const WORKFLOW_RUN = "workflow_run";

/** The coroutine a document execution's own history belongs to. */
const ROOT_COROUTINE = "root";

const RUN_MEMBERS: readonly string[] = ["runId", "base", "pinnedCommit"];

/** How the record identifies itself. `base` is for a reader, never for matching. */
export function describeWorkflowRun(base: string): EffectDescription {
  return { type: WORKFLOW_RUN, name: WORKFLOW_RUN, base };
}

/**
 * What a refusal is allowed to carry about the run.
 *
 * `StaleInputError` retains the description it is given, so handing it the
 * recording description would keep the base reachable on the error object even
 * though no message prints it. A fresh value each time, holding the two members
 * that name the effect and nothing else.
 */
function refusalDescription(): EffectDescription {
  return { type: WORKFLOW_RUN, name: WORKFLOW_RUN };
}

/**
 * Read one value the journal supplied, or answer that reading it refused.
 *
 * Deliberately narrow: exactly one read of exactly one journal-controlled
 * value is inside. A hostile `ownKeys` trap, a `getOwnPropertyDescriptor` trap,
 * a throwing getter and a revoked proxy all raise from here, and all of them
 * mean the same thing — this value does not describe a run. Widening it would
 * start converting programmer and infrastructure errors into "malformed
 * journal", which is the opposite of a total parse.
 */
function readingJournalValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The workflow run a stored value describes, or `undefined` if it describes none.
 *
 * Closed over its three members: a value carrying a fourth is not a run with
 * something extra, it is a value this version cannot account for.
 *
 * Total over anything the journal can hold. Classification and enumeration are
 * both the value's to refuse — `Array.isArray` throws for a revoked proxy, and
 * `Object.entries` runs the traps and the getters — so both happen inside one
 * guarded read and a refusal is an answer rather than an exception carrying the
 * journal's own text out with it.
 */
export function readWorkflowRun(value: unknown): WorkflowRun | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = readingJournalValue(() =>
    Array.isArray(value) ? undefined : Object.fromEntries(Object.entries(value)),
  );
  if (record === undefined) {
    return undefined;
  }
  if (
    Object.keys(record).length !== RUN_MEMBERS.length ||
    !RUN_MEMBERS.every((member) => Object.hasOwn(record, member))
  ) {
    return undefined;
  }
  const { runId, base, pinnedCommit } = record;
  if (typeof runId !== "string" || typeof base !== "string" || typeof pinnedCommit !== "string") {
    return undefined;
  }
  return Object.freeze({ runId, base, pinnedCommit });
}

/** What one retained event claims about the run, when it claims anything. */
interface RunClaim {
  readonly settled: boolean;
  readonly value: unknown;
}

/**
 * The claim this event makes, read totally and fail-closed.
 *
 * Every member a decision rests on is forced here — the discriminator, the
 * coroutine, both halves of the description, the settlement and a successful
 * settlement's value — and an event that refuses any of them is a history this
 * run cannot describe rather than an unrelated event to step past. Skipping it
 * is what would let a record that will not read stand in for one that is
 * absent, and a recorded terminal result be reused on the difference.
 *
 * A Yield that reads cleanly but is not the root coroutine's, or is not under
 * both the canonical type and the canonical name, makes no claim at all.
 */
function runClaim(event: DurableEvent): RunClaim | undefined {
  try {
    if (event.type === "close") {
      // Forced, not read for a value: a Close this history cannot classify is
      // the same refusal as a Yield that will not read.
      void event.coroutineId;
      void event.result.status;
      return undefined;
    }
    if (event.type !== "yield" || event.coroutineId !== ROOT_COROUTINE) {
      return undefined;
    }
    if (event.description.type !== WORKFLOW_RUN || event.description.name !== WORKFLOW_RUN) {
      return undefined;
    }
    return event.result.status === "ok"
      ? { settled: true, value: event.result.value }
      : { settled: false, value: undefined };
  } catch {
    throw malformedRecord();
  }
}

/**
 * What one installation requires of a history that is not empty.
 *
 * The two installations differ in one thing, and it is not strictness. A
 * retained run was created by a host before anything executed, so a history of
 * its own is something it must have: none, or one that failed, means the
 * recorded work is not this run's. A programmatic run allocates itself on first
 * execution, and §6 records a base that would not resolve as a *failed* effect —
 * so a history whose only record is that failure is this run's history, and
 * replaying it reproduces the failure rather than asking Git again.
 */
export interface RunHistoryRules {
  /** Whether a non-empty history must carry a successful record. */
  readonly required: boolean;
  /** The recorded run, or a refusal naming what it disagrees about. */
  agree(recorded: WorkflowRun): WorkflowRun;
}

/**
 * Hold a retained history to the run it belongs to.
 *
 * An empty history is the ordinary live start and is held to nothing. Otherwise
 * every canonical record it carries must read as a workflow run and agree with
 * this installation, and it may carry at most one — the record is written before
 * the root document is imported, so two describe two runs.
 */
export function admitWorkflowRunHistory(
  retained: readonly DurableEvent[],
  rules: RunHistoryRules,
): WorkflowRun | undefined {
  if (retained.length === 0) {
    return undefined;
  }

  const runs: WorkflowRun[] = [];
  let claimed = 0;
  for (const event of retained) {
    const claim = runClaim(event);
    if (claim === undefined) {
      continue;
    }
    // Counted whether or not it settled successfully. The record is written
    // once, before the root document is imported, so a second entry under the
    // canonical identity describes a second run however it ended — and a failed
    // one beside a successful one is two runs, not one run with a stumble.
    claimed += 1;
    if (!claim.settled) {
      continue;
    }
    const run = readWorkflowRun(claim.value);
    // A settled record that will not read is damaged rather than absent, and
    // saying so is what tells a corrupted journal from somebody else's.
    if (run === undefined) {
      throw malformedRecord();
    }
    runs.push(run);
  }

  if (claimed > 1) {
    throw duplicateRunRecords(claimed);
  }
  const only = runs[0];
  if (only === undefined) {
    if (rules.required) {
      throw missingRunEvidence();
    }
    return undefined;
  }
  return rules.agree(only);
}

/**
 * The journal holds something that is not a workflow run.
 *
 * The stored value is described, never quoted: it is external journal data, and
 * reporting it would carry whatever it happened to hold into logs and rendered
 * output.
 */
export function malformedRecord(): StaleInputError {
  return new StaleInputError(
    `The journal records "${WORKFLOW_RUN}" holding a value that does not describe a ` +
      "workflow run. A record that cannot be read is refused rather than replayed. Re-run " +
      "the document from the start rather than resuming from this journal.",
    { coroutineId: ROOT_COROUTINE, description: refusalDescription() },
  );
}

/** A journal with history offers no record that says whose history it is. */
export function missingRunEvidence(): StaleInputError {
  return new StaleInputError(
    "The journal holds recorded history but records no successful workflow run of its " +
      "own. A workflow run replays only from history that identifies it. Resume the run " +
      "this journal belongs to, or re-run the document from the start.",
    { coroutineId: ROOT_COROUTINE, description: refusalDescription() },
  );
}

/**
 * A journal carries more than one entry under the canonical run identity.
 *
 * The tally is this module's own count rather than anything the journal said,
 * so naming it carries nothing across. Failed entries count: the question is
 * how many runs the history describes, not how many of them finished.
 */
export function duplicateRunRecords(records: number): StaleInputError {
  return new StaleInputError(
    `The journal records ${records} workflow run entries where at most one describes a ` +
      "run. A history recording more than one run is not one run's history. Resume the " +
      "run this journal belongs to, or re-run the document from the start.",
    { coroutineId: ROOT_COROUTINE, description: refusalDescription() },
  );
}

/**
 * The recorded run is not the retained run this execution was installed with.
 *
 * The differing fields are named and their values are not. A run id may be
 * caller-selected and a base may be any revision expression, so both are
 * external text on the same terms as retained props: naming a field says what
 * disagrees without carrying the disagreement into logs and rendered output.
 */
export function retainedRunMismatch(fields: readonly string[]): StaleInputError {
  return new StaleInputError(
    `The journal records a workflow run whose ${fields.join(", ")} differs from the retained ` +
      "run this execution was installed with. A retained run is replayed as itself rather " +
      "than onto a different one. Resume the run the journal belongs to.",
    { coroutineId: ROOT_COROUTINE, description: refusalDescription() },
  );
}

/**
 * The recorded run started from a different base than this run supplied.
 *
 * Both bases are named, because here they are the two things a caller has to
 * compare to understand the refusal, and both came from that caller rather than
 * from the journal's opaque content. They are named in the sentence only: the
 * description this error retains still holds nothing but the effect's type and
 * name.
 */
export function baseMismatch(recorded: string, supplied: string): StaleInputError {
  return new StaleInputError(
    `The journal records this workflow run starting from "${recorded}", but this run ` +
      `supplied "${supplied}". A recorded base cannot be replayed onto a run that asked ` +
      "for a different one. Re-run the document from the start rather than resuming from " +
      "this journal.",
    { coroutineId: ROOT_COROUTINE, description: refusalDescription() },
  );
}
