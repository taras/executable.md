/**
 * How this REPL asks the person sitting in front of it.
 *
 * A provider and nothing more. The document says what it is asking and what
 * shape the answer must have; this decides where the asking happens, publishes
 * the request so the application can draw it, and waits. Core normalized the
 * schema, core validates what comes back, and core alone appends the answer —
 * so a question this provider could not present never becomes a half-answered
 * record.
 *
 * ## One form, stated as a refusal
 *
 * This slice presents exactly one shape: a closed object with one required
 * string property whose values are an enum. Anything else is refused as an
 * `ElicitationProviderError` *before* a value is yielded, because a provider
 * that quietly rendered a schema it does not understand would collect an answer
 * to a question nobody was shown. Refusing names the shape it can present, so
 * the limit is legible rather than mysterious — and it is a limit rather than a
 * general JSON Schema form toolkit, deliberately.
 *
 * ## Nothing here is durable
 *
 * No provider state, form state, focus or presentation reaches the Journal. A
 * pending request lives exactly as long as the suspended `action()` holding it:
 * if the run is halted the request disappears with it and no answer is
 * manufactured. Closing the drawer is a presentation decision and leaves the
 * request waiting; only submitting a value answers it.
 */

import { action, createSignal } from "effection";
import type { Operation, Stream } from "effection";
import { Elicitation, ElicitationProviderError } from "@executablemd/core";
import type { ElicitationRequest } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";

/** The one question shape this REPL presents: one field, one list of choices. */
export interface ReplQuestionForm {
  readonly field: string;
  readonly choices: readonly string[];
}

/** One question waiting for an answer in this process. */
export interface ReplQuestion {
  readonly message: string;
  readonly schema: Json;
  readonly form: ReplQuestionForm;
  /**
   * Submit one of the offered choices.
   *
   * A choice the form does not offer is not an answer: the request stays open
   * and nothing is appended, which is what keeps a stray keystroke from binding
   * a value the schema would then reject.
   */
  answer(choice: string): boolean;
}

/** What the application reads to draw the question, and to know there is one. */
export interface ReplElicitations {
  /** The question waiting right now, or none. */
  readonly pending: ReplQuestion | undefined;
  /** Every change to what is pending, as it changes. */
  readonly changes: Stream<ReplQuestion | undefined, never>;
  /** How many questions this provider has been asked. */
  readonly asked: number;
}

/**
 * The form one normalized schema describes, or none when this REPL cannot
 * present it.
 *
 * Read from the normalized schema core compiled rather than from the source
 * that produced it: what the person is shown has to be what the answer will be
 * judged against.
 */
export function readQuestionForm(schema: Json): ReplQuestionForm | undefined {
  if (!isObject(schema) || schema["type"] !== "object") {
    return undefined;
  }
  if (schema["additionalProperties"] !== false) {
    return undefined;
  }
  const properties = schema["properties"];
  const required = schema["required"];
  if (!isObject(properties) || !Array.isArray(required) || required.length !== 1) {
    return undefined;
  }
  const names = Object.keys(properties);
  const field = required[0];
  if (names.length !== 1 || typeof field !== "string" || names[0] !== field) {
    return undefined;
  }
  const property = properties[field];
  if (!isObject(property) || property["type"] !== "string") {
    return undefined;
  }
  const choices = property["enum"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const offered: string[] = [];
  for (const choice of choices) {
    if (typeof choice !== "string") {
      return undefined;
    }
    offered.push(choice);
  }
  return { field, choices: Object.freeze(offered) };
}

/**
 * Install this REPL's provider on the calling scope.
 *
 * At `{ at: "min" }`: middleware installed at the default position runs
 * outermost, so an outer provider would answer ahead of this one — the opposite
 * of what a provider is.
 */
export function* useReplElicitation(): Operation<ReplElicitations> {
  const changes = createSignal<ReplQuestion | undefined, never>();
  let pending: ReplQuestion | undefined;
  let asked = 0;

  function publish(question: ReplQuestion | undefined): void {
    pending = question;
    changes.send(question);
  }

  yield* Elicitation.around(
    {
      *elicit([request]: [ElicitationRequest]) {
        const form = readQuestionForm(request.schema);
        if (form === undefined) {
          throw new ElicitationProviderError(
            "this REPL presents one question shape: an object with one required string " +
              "property whose values are an enum, and no other properties. The document asked " +
              "for something else, so nobody was asked.",
          );
        }
        asked++;
        return yield* action<Json>(function (resolve) {
          const question: ReplQuestion = {
            message: request.message,
            schema: request.schema,
            form,
            answer(choice: string): boolean {
              if (!form.choices.includes(choice)) {
                return false;
              }
              resolve({ [form.field]: choice });
              return true;
            },
          };
          publish(question);
          // Whatever ends this — an answer, a halt, a failure upstream — the
          // request stops being pending exactly when it stops existing.
          return () => publish(undefined);
        });
      },
    },
    { at: "min" },
  );

  return {
    get pending() {
      return pending;
    },
    changes,
    get asked() {
      return asked;
    },
  };
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
