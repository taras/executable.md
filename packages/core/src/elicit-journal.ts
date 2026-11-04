import { durablePosition } from "@executablemd/durable-streams";
import { inputValues } from "./secrets/inputs.ts";
import { parseInputRecord } from "./secrets/input-record.ts";
import { prepareElicitation, runPreparedElicitation, ElicitValidationError } from "./elicit.ts";
import type { PreparedElicitation } from "./elicit.ts";
import { validateParsed } from "./components/parse-schema.ts";
/**
 * What an elicitation leaves behind.
 *
 * The validated response is the answer, and it is the record's result. Beside it
 * the description retains the question's normalized schema — descriptive input,
 * never identity — so a reader of the history knows which fields the person was
 * shown without asking a provider that is no longer running. Which provider was
 * installed, what it opened, how long a person took, and what the form looked
 * like all belong to the run that happened to ask, and a replay that restored
 * any of it would describe an interaction that is over.
 *
 * The description also carries a fingerprint of what the person was actually
 * asked: the normalized schema and the rendered message. This module decides
 * what a mismatch means, because nothing else does — only `type` and `name`
 * decide whether a journal entry matches, and neither of those changes when the
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
  ephemeral,
  ReplayGuard,
  StaleInputError,
} from "@executablemd/durable-streams";
import type {
  EffectDescription,
  Json as DurableJson,
  Workflow,
} from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { canonicalFingerprint } from "./canonical.ts";
import { isJsonObject, parseJson } from "./json.ts";
import { SourceOwner, sourceOwnerDescription } from "./source-owner.ts";
import type { Json, JsonObject, SourcePosition } from "./types.ts";

const ELICIT = "elicit";

/**
 * The description field the question's normalized schema occupies.
 *
 * Beside `type` and `name` rather than in either, under one stable namespaced
 * field, because a durable effect's identity is its type and its name and
 * nothing else: a schema that travelled in one would change what a replay
 * matches. It is stored descriptive input — never compared during divergence
 * detection, never part of admission — and the fingerprint over schema and
 * message remains the guard.
 */
export const ELICITATION_SCHEMA_FIELD = "executablemd.elicitation-schema";

export interface ElicitationQuestion {
  schema: JsonObject;
  message: string;
}

/** Where the answer was recorded and what question it answered. */
export interface ElicitationIdentity {
  /** `path:line:column` — the durable name. */
  location: string;
  fingerprint: string;
  /** The normalized schema, retained so history can show what was asked. */
  schema: JsonObject;
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
 * The normalized schema a recorded elicitation retains, or none.
 *
 * Parsed rather than asserted: a description is journal data, so a field that
 * is absent or is not a JSON object answers "none" instead of reaching a reader
 * as a schema it is not. A record written before the field existed has none,
 * and that is the same answer.
 */
export function readElicitationSchema(description: EffectDescription): JsonObject | undefined {
  const field = description[ELICITATION_SCHEMA_FIELD];
  return isJsonObject(field) ? field : undefined;
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
  const sourceOwner = yield* ephemeral(SourceOwner.get());
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: ELICIT,
      name: recordName(identity.location),
      input: identity.fingerprint,
      [ELICITATION_SCHEMA_FIELD]: identity.schema,
      ...sourceOwnerDescription(identity.position, sourceOwner),
    },
    function* (): Operation<DurableJson> {
      return parseJson(yield* live());
    },
  );
  return parseJson(stored);
}

export function* persistProtectedElicitation(
  identity: ElicitationIdentity,
  prepared: PreparedElicitation,
  message: string,
): Workflow<unknown> {
  const owner = yield* ephemeral(inputValues());
  if (owner === undefined) {
    throw new Error("Protected elicitation requires an execution-owned input owner.");
  }
  const position = yield* ephemeral(durablePosition());
  const sourceOwner = yield* ephemeral(SourceOwner.get());
  const bind = (answer: Json) => {
    if (!isJsonObject(answer)) {
      throw new Error("Protected elicitation requires an object answer.");
    }
    const result: Record<string, unknown> = { ...answer };
    for (const field of prepared.secretFields) {
      const value = answer[field];
      if (typeof value === "string") {
        result[field] = owner.protect(
          { coroutine: position.coroutineId, index: position.index, field },
          value,
        );
      }
    }
    return result;
  };
  let live: unknown;
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: ELICIT,
      name: recordName(identity.location),
      input: identity.fingerprint,
      [ELICITATION_SCHEMA_FIELD]: identity.schema,
      ...sourceOwnerDescription(identity.position, sourceOwner),
    },
    function* () {
      live = bind(yield* runPreparedElicitation(prepared, message));
      const recorded = owner.record(live);
      if (!recorded.ok) {
        throw recorded.error;
      }
      return parseJson({ "executablemd.input": recorded.value });
    },
  );
  if (live !== undefined) {
    return live;
  }
  const envelope = parseJson(stored);
  if (!isJsonObject(envelope)) {
    throw new Error("Invalid protected elicitation history.");
  }
  const record = parseInputRecord(envelope["executablemd.input"]);
  if (record.kind !== "object") {
    throw new Error("Invalid protected elicitation receipt.");
  }
  const publicAnswer: JsonObject = {};
  const missing: string[] = [];
  for (const [name, member] of Object.entries(record.members)) {
    if (member.kind === "input") {
      if (
        !prepared.secretFields.includes(name) ||
        member.field.coroutine !== position.coroutineId ||
        member.field.index !== position.index ||
        member.field.field !== name
      ) {
        throw new Error("Invalid protected elicitation field identity.");
      }
      missing.push(name);
    } else {
      const restored = owner.restore(member);
      if (!restored.ok) {
        throw restored.error;
      }
      publicAnswer[name] = parseJson(restored.value);
    }
  }
  if (missing.length === 0) {
    return publicAnswer;
  }
  const properties = prepared.schema.properties;
  if (!isJsonObject(properties)) {
    throw new Error("Invalid protected elicitation schema.");
  }
  const fresh = yield* ephemeral(
    prepareElicitation({
      type: "object",
      properties: Object.fromEntries(missing.map((name) => [name, properties[name]])),
      required: missing.filter(
        (field) =>
          Array.isArray(prepared.schema.required) && prepared.schema.required.includes(field),
      ),
      additionalProperties: false,
    }),
  );
  const answer = yield* ephemeral(
    runPreparedElicitation(
      fresh,
      `${message}\n\nRecorded public fields: ${JSON.stringify(publicAnswer)}`,
    ),
  );
  if (!isJsonObject(answer)) {
    throw new Error("Invalid protected elicitation response.");
  }
  const merged = { ...publicAnswer, ...answer };
  const issues = validateParsed(prepared.validate, merged);
  if (issues.length > 0) {
    throw new ElicitValidationError(prepared.label, issues);
  }
  return bind(merged);
}
