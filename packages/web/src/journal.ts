/**
 * What a form leaves behind.
 *
 * Only the validated response is journaled. A port, a token, a URL, whether a
 * browser opened — all of it belongs to the run that happened to serve the form,
 * and a replay that restored any of it would be describing a listener that no
 * longer exists.
 *
 * The description carries a fingerprint of what the person was actually asked:
 * the normalized schema, the normalized UI schema, and the sanitized content.
 * This module decides what a mismatch means, because nothing else does — only
 * `type` and `name` decide whether a journal entry matches, and neither of those
 * changes when the question does. A recorded answer whose fingerprint is not
 * this run's is refused with a `StaleInputError` rather than bound: binding an
 * answer to a question nobody was given is the failure a human-decision
 * component must not have. Refusing is as far as it goes; `refuseChangedQuestion`
 * below says why.
 */

import { canonicalize, sourceDescription } from "@executablemd/core";
import type { SourcePosition } from "@executablemd/core";
import {
  createDurableOperation,
  ReplayGuard,
  StaleInputError,
} from "@executablemd/durable-streams";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";
import { createHash } from "node:crypto";
import type { Operation } from "effection";

import type { Json, JsonObject } from "./json.ts";
import { parseJson } from "./json.ts";

const WEB_FORM = "web_form";

/** Where the answer was recorded and what question it answered. */
export interface FormIdentity {
  /** `path:line:column` — the durable name. */
  location: string;
  fingerprint: string;
  /** Where the element was written, for history. Never read back as identity. */
  position?: Readonly<SourcePosition>;
}

function recordName(location: string): string {
  return `webform:${location}`;
}

export interface FormQuestion {
  schema: JsonObject;
  uiSchema?: JsonObject;
  content: string;
}

/**
 * A stable name for what was asked.
 *
 * Object keys are sorted before hashing, because two schemas that differ only in
 * key order are the same question, and `JSON.stringify` would otherwise make them
 * different answers to replay.
 */
export function fingerprint(question: FormQuestion): string {
  const canonical = JSON.stringify({
    schema: canonicalize(question.schema),
    uiSchema: question.uiSchema === undefined ? null : canonicalize(question.uiSchema),
    content: question.content,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Refuse to replay an answer to a different question.
 *
 * Only `type` and `name` decide whether a journal entry matches, and this
 * effect's name is its source position — so without a guard, a journal that
 * describes a different question would still bind its answer here. The
 * fingerprint is recorded so that this guard has something to compare; on its
 * own it is inert.
 *
 * Installed by the caller rather than by `persistResponse`, because a `Workflow`
 * may yield only durable effects and this is an ordinary one.
 *
 * A `StaleInputError`, so expansion propagates it rather than rendering it: the
 * ambient error error mode must not be able to downgrade a durability failure to a
 * comment and let later siblings run on an answer that was never given.
 *
 * This refuses rather than re-asks. Refusing is what the durable protocol
 * currently offers — a guard decides between "replay" and "error", and
 * re-execution is named in `ReplayOutcome` as a future outcome. Failing where
 * the question changed is the safe half of that; #218's re-execution work is
 * where the other half belongs.
 */
export function refuseChangedQuestion(identity: FormIdentity): Operation<void> {
  const name = recordName(identity.location);
  return ReplayGuard.around({
    decide([event], next) {
      if (event.description.type !== WEB_FORM || event.description.name !== name) {
        return next(event);
      }
      if (event.description.input === identity.fingerprint) {
        return next(event);
      }
      return {
        outcome: "error",
        error: new StaleInputError(
          `the recorded answer for ${name} was given to a different question: the schema, the ` +
            "UI schema, or the rendered body has changed since it was recorded. Re-run the " +
            "document from the start rather than resuming from a journal that answers " +
            "something else.",
          { coroutineId: event.coroutineId, description: event.description },
        ),
      };
    },
  });
}

/**
 * Run a form once and record its answer, or restore the answer already recorded.
 *
 * On replay `live` is never entered, which is what keeps a resumed document from
 * binding a port, printing a URL, or asking anyone anything a second time.
 */
export function* persistResponse(
  identity: FormIdentity,
  live: () => Operation<Json>,
): Workflow<Json> {
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: WEB_FORM,
      name: recordName(identity.location),
      input: identity.fingerprint,
      ...sourceDescription(identity.position),
    },
    function* (): Operation<DurableJson> {
      return asDurable(yield* live());
    },
  );
  return parseJson(stored);
}

/** The durable stream's `Json` and the package's are the same values, parsed once. */
function asDurable(value: Json): DurableJson {
  return parseJson(value);
}
