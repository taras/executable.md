/**
 * The external observations one entry's history holds, and whose they are.
 *
 * A retained effect is normally held to its owner by its own name: a Git-host
 * record and an Issue record are named by a digest that includes the identity
 * they were performed under, so a record another owner wrote is a record no
 * live request here can ask for. An evidence read is the one exception, and
 * deliberately: its name is the authored site and the question, with the owner
 * left out so a workflow fork reaching the same position with the same question
 * consumes the record its source wrote rather than asking the forge again.
 *
 * That omission is a fork's requirement and an entry's exposure. The name an
 * entry's read matches is one another owner's read of the same pull request at
 * the same position also matches, so a segment holding somebody else's
 * observation would answer with it — and answer with no forge request at all,
 * which is exactly what a replay is supposed to look like. Nothing downstream
 * could notice: the restored collection is well formed and the question is the
 * one being asked.
 *
 * So the entry reads the record's own request, here, where it already reads its
 * whole segment, and before anything is attached. A read retained under another
 * owner refuses the continuation, and so does one whose request this host
 * cannot read — the two available answers are both wrong: the observation is
 * not this entry's to hand back, and performing it again would put a second
 * answer at a position this history already has one for.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { parsePullRequestReadRequest } from "../../composition/pull-request-read-records.ts";
import { PULL_REQUEST_READ } from "../composition/pull-request-operations.ts";

/**
 * An observation in this entry's history that is not this entry's.
 *
 * A `StaleInputError`, for the reason every other continuation refusal here is
 * one: a document that went on past it would be running its later elements on
 * an answer somebody else was given, and `<PrintErrors>` must not be able to
 * arrange that.
 */
export class RetainedObservationError extends StaleInputError {
  override name = "RetainedObservationError";
}

/**
 * That every retained observation in this history belongs to `owner`.
 *
 * `Result`, because it is read where the entry's admission already reads its
 * history: the caller fails the continuation there, with nothing attached, no
 * forge reached and no credential opened.
 */
export function admitOwnedObservations(
  events: readonly DurableEvent[],
  owner: string,
): Result<void> {
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== PULL_REQUEST_READ) {
      continue;
    }
    const input = event.description.input;
    const request = input === undefined ? undefined : parsePullRequestReadRequest(input);
    if (request === undefined) {
      return Err(
        new RetainedObservationError(
          "this entry's history holds an evidence read whose retained request this host cannot " +
            "read, so whose observation it is cannot be decided.",
        ),
      );
    }
    if (request.runId !== owner) {
      return Err(
        new RetainedObservationError(
          "this entry's history holds an evidence read retained under another owner, so what it " +
            "observed is not this entry's to answer with.",
        ),
      );
    }
  }
  return Ok(undefined);
}
