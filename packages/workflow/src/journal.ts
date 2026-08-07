/**
 * The durable `workflow_run` record.
 *
 * One immutable value per workflow run, written before the root document is
 * imported. The journal is parsed, never trusted: a record that does not
 * describe a workflow run is refused rather than coerced, and a record made
 * from a different base is refused rather than quietly standing in for this
 * run's.
 */

import { StaleInputError } from "@executablemd/durable-streams";
import type { EffectDescription } from "@executablemd/durable-streams";

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

/** How the record identifies itself. `base` is for a reader, never for matching. */
export function describeWorkflowRun(base: string): EffectDescription {
  return { type: WORKFLOW_RUN, name: WORKFLOW_RUN, base };
}

/** The workflow run a stored value describes, or `undefined` if it describes none. */
export function readWorkflowRun(value: unknown): WorkflowRun | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { runId, base, pinnedCommit } = Object.fromEntries(Object.entries(value));
  if (typeof runId !== "string" || typeof base !== "string" || typeof pinnedCommit !== "string") {
    return undefined;
  }
  return Object.freeze({ runId, base, pinnedCommit });
}

/**
 * The journal holds something that is not a workflow run.
 *
 * The stored value is described, never quoted: it is external journal data, and
 * reporting it would carry whatever it happened to hold into logs and rendered
 * output.
 */
export function malformedRecord(description: EffectDescription): StaleInputError {
  return new StaleInputError(
    `The journal records "${description.name}" holding a value that does not describe a ` +
      "workflow run. A record that cannot be read is refused rather than replayed. Re-run " +
      "the document from the start rather than resuming from this journal.",
    { coroutineId: "root", description },
  );
}

/** The recorded run started from a different base than this run supplied. */
export function baseMismatch(
  description: EffectDescription,
  recorded: string,
  supplied: string,
): StaleInputError {
  return new StaleInputError(
    `The journal records this workflow run starting from "${recorded}", but this run ` +
      `supplied "${supplied}". A recorded base cannot be replayed onto a run that asked ` +
      "for a different one. Re-run the document from the start rather than resuming from " +
      "this journal.",
    { coroutineId: "root", description },
  );
}
