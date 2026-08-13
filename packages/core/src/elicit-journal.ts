/**
 * What an elicitation leaves behind.
 *
 * Only the validated response is journaled. Which provider was installed, what
 * it opened, how long a person took — all of it belongs to the run that happened
 * to ask, and a replay that restored any of it would describe an interaction
 * that is over.
 *
 * The description carries a fingerprint of what the person was actually asked:
 * the normalized schema and the rendered message. This module decides what a
 * mismatch means, because nothing else does — only `type` and `name` decide
 * whether a journal entry matches, and neither of those changes when the
 * question does. A recorded answer whose fingerprint is not this run's is
 * refused with a `StaleInputError` rather than bound: binding an answer to a
 * question nobody was given is the failure a human-decision component must not
 * have. Refusing is as far as it goes; `refuseChangedQuestion` below says why.
 *
 * Preflight is not what replay skips. Compiling the schema and expanding the
 * invocation content run on every execution, replay included — they are how this
 * run knows which recorded answer it is looking for. What replay never repeats
 * is the provider call and the interaction it stands for.
 */

import {
  createDurableOperation,
  ReplayGuard,
  StaleInputError,
} from "@executablemd/durable-streams";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { canonicalFingerprint } from "./canonical.ts";
import { parseJson } from "./json.ts";
import { sourceDescription } from "./source-position.ts";
import type { Json, JsonObject, SourcePosition } from "./types.ts";

const ELICIT = "elicit";

export interface ElicitationQuestion {
  schema: JsonObject;
  message: string;
}

/** Where the answer was recorded and what question it answered. */
export interface ElicitationIdentity {
  /** `path:line:column` — the durable name. */
  location: string;
  fingerprint: string;
  /** Where the element was written, for history. Never read back as identity. */
  position?: Readonly<SourcePosition>;
}

function recordName(location: string): string {
  return `elicit:${location}`;
}

/** A stable name for what was asked. */
export function questionFingerprint(question: ElicitationQuestion): string {
  return canonicalFingerprint({ schema: question.schema, message: question.message });
}

/**
 * Refuse to replay an answer to a different question.
 *
 * Only `type` and `name` decide whether a journal entry matches, and this
 * effect's name is its source position — so without a guard, editing the
 * message or the schema and resuming would bind the previous answer to a
 * question nobody was asked. The fingerprint is recorded so that this guard has
 * something to compare; on its own it is inert.
 *
 * Installed by the caller rather than by `persistElicitation`, because a
 * `Workflow` may yield only durable effects and this is an ordinary one.
 *
 * A `StaleInputError`, so expansion propagates it rather than rendering it: the
 * ambient error mode must not be able to downgrade a durability failure to a
 * comment and let later siblings run on an answer that was never given.
 *
 * This refuses rather than re-asks. Refusing is what the durable protocol
 * currently offers — a guard decides between "replay" and "error", and
 * re-execution is named in `ReplayOutcome` as a future outcome. Failing where
 * the question changed is the safe half of that; #218's re-execution work is
 * where the other half belongs.
 */
export function refuseChangedQuestion(identity: ElicitationIdentity): Operation<void> {
  const name = recordName(identity.location);
  return ReplayGuard.around({
    decide([event], next) {
      if (event.description.type !== ELICIT || event.description.name !== name) {
        return next(event);
      }
      if (event.description.input === identity.fingerprint) {
        return next(event);
      }
      return {
        outcome: "error",
        error: new StaleInputError(
          `the recorded answer for ${name} was given to a different question: the schema or ` +
            "the message has changed since it was recorded. Re-run the document from the " +
            "start rather than resuming from a journal that answers something else.",
          { coroutineId: event.coroutineId, description: event.description },
        ),
      };
    },
  });
}

/**
 * Ask once and record the answer, or restore the answer already recorded.
 *
 * On replay `live` is never entered, which is what keeps a resumed document from
 * asking anyone anything a second time.
 */
export function* persistElicitation(
  identity: ElicitationIdentity,
  live: () => Operation<Json>,
): Workflow<Json> {
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: ELICIT,
      name: recordName(identity.location),
      input: identity.fingerprint,
      ...sourceDescription(identity.position),
    },
    function* (): Operation<DurableJson> {
      return parseJson(yield* live());
    },
  );
  return parseJson(stored);
}
