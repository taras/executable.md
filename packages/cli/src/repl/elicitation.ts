/**
 * How this REPL asks the person sitting in front of it.
 *
 * A provider and nothing more. The document says what it is asking and what
 * shape the answer must have; this decides where the asking happens, publishes
 * the request so the application can draw it, and waits. Core normalized the
 * schema, Core compiles it, Core judges what comes back, and Core alone appends
 * the answer — so a question this provider could not present never becomes a
 * half-answered record.
 *
 * ## The form language is closed, and says so
 *
 * This presents a bounded subset of JSON Schema: a closed object of string
 * fields, each optionally an enum or a minimum length, with at most one
 * conditional that makes further fields required when one field holds one exact
 * value. That is what the packaged Plan and the generated README program ask
 * for.
 *
 * Anything else is refused as an `ElicitationProviderError` *before* a value is
 * yielded, before `asked` moves and before anything is published — and the
 * refusal names the offending keyword and where it sits, so the limit is legible
 * rather than mysterious. Refusing is deliberate: a provider that quietly
 * rendered a keyword it does not understand would collect an answer to a
 * question nobody was shown.
 *
 * ## Validation is Core's, twice
 *
 * The provider compiles the request's schema through Core's own preparation and
 * judges each assembled object with Core's own validator before it resolves. An
 * object that fails leaves the question exactly where it was — nothing is
 * appended and nothing is resolved — and the normalized issues go back to the
 * application to show. Core then judges the resolved answer again on its way
 * out, which is the boundary that actually decides.
 *
 * ## Nothing here is durable
 *
 * No provider state, form state, focus or presentation reaches the Journal. A
 * pending request lives exactly as long as the suspended `action()` holding it:
 * if the run is halted the request disappears with it and no answer is
 * manufactured. Closing the drawer is a presentation decision and leaves the
 * request waiting; only a valid submission answers it.
 */

import { action, createSignal } from "effection";
import type { Operation, Stream } from "effection";
import { Elicitation, ElicitationProviderError, prepareElicitation } from "@executablemd/core";
import { validateParsed } from "@executablemd/core";
import type { ElicitationRequest, NormalizedIssue } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";

/** What one field's value must also satisfy, when the schema says so. */
export interface ReplFieldConstraint {
  readonly name: string;
  /** The shortest accepted value, when the schema states one. */
  readonly minLength: number | undefined;
}

/** One field the form presents, in the order the schema declared it. */
export interface ReplFormField extends ReplFieldConstraint {
  /** The schema's own label for it, when it wrote one. */
  readonly title: string | undefined;
  readonly description: string | undefined;
  /** The exact values offered, when the field is an enum. */
  readonly choices: readonly string[] | undefined;
  /** Whether the root requires it however the rest of the form is filled. */
  readonly required: boolean;
}

/** What one conditional adds when its field holds one exact value. */
export interface ReplFormCondition {
  readonly field: string;
  readonly equals: string;
  /** The fields that become required, with whatever `then` adds to them. */
  readonly requires: readonly ReplFieldConstraint[];
}

/** The whole question shape this REPL presents, parsed once. */
export interface ReplQuestionForm {
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly fields: readonly ReplFormField[];
  readonly condition: ReplFormCondition | undefined;
}

/** What a submission did: it answered, or it is still the same question. */
export type ReplFormOutcome =
  /**
   * Taken. `answer` is the exact object the question was resolved with, so
   * whoever submitted it can recognise the record it causes among records it
   * did not cause.
   */
  | { readonly kind: "answered"; readonly answer: Json }
  | { readonly kind: "invalid"; readonly issues: readonly NormalizedIssue[] };

/** One question waiting for an answer in this process. */
export interface ReplQuestion {
  readonly message: string;
  readonly form: ReplQuestionForm;
  /**
   * Offer one assembled object as the answer.
   *
   * Judged by the same compiled schema the request carries. A valid object
   * resolves the wait exactly once; an invalid one changes nothing at all and
   * comes back with the issues to show, so the question a person is looking at
   * is still the question they are answering.
   */
  submit(values: Readonly<Record<string, string>>): ReplFormOutcome;
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

/** The keywords a root object may carry. */
const ROOT_KEYWORDS = new Set([
  "type",
  "additionalProperties",
  "properties",
  "required",
  "if",
  "then",
  "title",
  "description",
]);

/** The keywords one string field may carry. */
const FIELD_KEYWORDS = new Set(["type", "enum", "minLength", "title", "description"]);

/** The keywords the `if` object may carry. */
const CONDITION_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties"]);

/** The keywords the `then` object may carry. */
const CONSEQUENCE_KEYWORDS = new Set(["type", "properties", "required"]);

/**
 * The constraints one conditionally required field may restate.
 *
 * Narrower than a root field on purpose: what `then` adds is a requirement and
 * a minimum length, and those are the two things the form both draws and has
 * judged. Anything else would be a rule nothing here represents.
 */
const CONSEQUENCE_FIELD_KEYWORDS = new Set(["type", "minLength"]);

function refuse(what: string, path: string): never {
  throw new ElicitationProviderError(
    `this REPL presents a bounded form language, and this schema ${what} at ${path}. It asks ` +
      "for something this surface cannot draw, so nobody was asked. Supported: a closed " +
      "object of string fields, each optionally an enum or a minLength, with at most one " +
      "if/then that requires further string fields when one field holds one exact value.",
  );
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every keyword on this object that the subset does not accept. */
function refuseUnknown(subject: { [key: string]: Json }, allowed: Set<string>, path: string): void {
  for (const keyword of Object.keys(subject)) {
    if (!allowed.has(keyword)) {
      refuse(`uses the unsupported keyword "${keyword}"`, `${path}.${keyword}`);
    }
  }
}

/** The annotations a reader is shown, which change no rule. */
function annotations(
  subject: { [key: string]: Json },
  path: string,
): {
  title: string | undefined;
  description: string | undefined;
} {
  for (const key of ["title", "description"]) {
    const value = subject[key];
    if (value !== undefined && typeof value !== "string") {
      refuse(`declares a non-string "${key}"`, `${path}.${key}`);
    }
  }
  return {
    title: typeof subject["title"] === "string" ? subject["title"] : undefined,
    description: typeof subject["description"] === "string" ? subject["description"] : undefined,
  };
}

/** The exact values one enum offers, or none when the field declares none. */
function choicesOf(field: { [key: string]: Json }, path: string): readonly string[] | undefined {
  const declared = field["enum"];
  if (declared === undefined) {
    return undefined;
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    refuse("declares an enum that is not a non-empty array", `${path}.enum`);
  }
  const offered: string[] = [];
  for (const [index, choice] of declared.entries()) {
    if (typeof choice !== "string") {
      refuse("declares a non-string enum member", `${path}.enum[${index}]`);
    }
    offered.push(choice);
  }
  return Object.freeze(offered);
}

/** The shortest accepted value, when the field states one. */
function minLengthOf(field: { [key: string]: Json }, path: string): number | undefined {
  const declared = field["minLength"];
  if (declared === undefined) {
    return undefined;
  }
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
    refuse("declares a minLength that is not a non-negative integer", `${path}.minLength`);
  }
  return declared;
}

/** One list of names the schema declared, checked for shape rather than meaning. */
function namesOf(declared: Json | undefined, path: string): readonly string[] {
  if (!Array.isArray(declared)) {
    refuse('declares a "required" that is not an array', path);
  }
  const names: string[] = [];
  for (const [index, name] of declared.entries()) {
    if (typeof name !== "string") {
      refuse("declares a non-string required name", `${path}[${index}]`);
    }
    if (names.includes(name)) {
      refuse(`declares "${name}" as required twice`, `${path}[${index}]`);
    }
    names.push(name);
  }
  return names;
}

/** The one conditional this subset accepts, read from `if` and `then` together. */
function conditionOf(
  root: { [key: string]: Json },
  declared: ReadonlySet<string>,
): ReplFormCondition | undefined {
  const when = root["if"];
  const consequence = root["then"];
  if (when === undefined && consequence === undefined) {
    return undefined;
  }
  if (when === undefined) {
    refuse('declares a "then" with no "if"', "$.then");
  }
  if (consequence === undefined) {
    refuse('declares an "if" with no "then"', "$.if");
  }
  if (!isObject(when)) {
    refuse('declares an "if" that is not an object schema', "$.if");
  }
  if (!isObject(consequence)) {
    refuse('declares a "then" that is not an object schema', "$.then");
  }
  refuseUnknown(when, CONDITION_KEYWORDS, "$.if");
  refuseUnknown(consequence, CONSEQUENCE_KEYWORDS, "$.then");
  const sides: readonly { readonly side: string; readonly schema: { [key: string]: Json } }[] = [
    { side: "if", schema: when },
    { side: "then", schema: consequence },
  ];
  for (const { side, schema } of sides) {
    if (schema["type"] !== undefined && schema["type"] !== "object") {
      refuse(`declares a "${side}" whose type is not object`, `$.${side}.type`);
    }
  }
  if (when["additionalProperties"] !== undefined && when["additionalProperties"] !== false) {
    refuse('declares an "if" that is not closed', "$.if.additionalProperties");
  }

  const tested = when["properties"];
  if (!isObject(tested)) {
    refuse('declares an "if" with no tested properties', "$.if.properties");
  }
  const names = Object.keys(tested);
  if (names.length !== 1) {
    refuse("tests more than one field in its condition", "$.if.properties");
  }
  const field = names[0]!;
  if (!declared.has(field)) {
    refuse(`tests "${field}", which the root does not declare`, `$.if.properties.${field}`);
  }
  const test = tested[field];
  if (!isObject(test)) {
    refuse("declares a condition that is not an object schema", `$.if.properties.${field}`);
  }
  refuseUnknown(test, new Set(["const", "type"]), `$.if.properties.${field}`);
  // Core evaluates this type as part of the condition. This form reduces the
  // whole condition to one string equality, so a tested type of anything else
  // would draw a form that requires different fields than validation does.
  if (test["type"] !== undefined && test["type"] !== "string") {
    refuse("tests its field as a type other than string", `$.if.properties.${field}.type`);
  }
  const equals = test["const"];
  if (typeof equals !== "string") {
    refuse(
      "tests its field with something other than a string const",
      `$.if.properties.${field}.const`,
    );
  }
  // Not defaulted to the tested field. `properties` does not require a property
  // to exist, so an `if` without `required` also matches an object where the
  // field is absent — Core would apply `then` there, and this form would be
  // waiting for a value the person never has to give.
  if (when["required"] === undefined) {
    refuse("tests a field without requiring it to be present", "$.if.required");
  }
  const requiredByCondition = namesOf(when["required"], "$.if.required");
  if (requiredByCondition.length !== 1 || requiredByCondition[0] !== field) {
    refuse("requires something other than the field it tests", "$.if.required");
  }

  // What the condition adds. Each name has to be a field the root declared, and
  // may restate its own string constraints; nothing new is introduced here.
  const added = namesOf(consequence["required"], "$.then.required");
  const constraints: ReplFieldConstraint[] = [];
  const restated = consequence["properties"];
  if (restated !== undefined && !isObject(restated)) {
    refuse('declares a "then" properties that is not an object', "$.then.properties");
  }
  for (const name of added) {
    if (!declared.has(name)) {
      refuse(`requires "${name}", which the root does not declare`, "$.then.required");
    }
    const own = restated === undefined ? undefined : restated[name];
    if (own !== undefined && !isObject(own)) {
      refuse(
        "restates a field as something other than an object schema",
        `$.then.properties.${name}`,
      );
    }
    if (own !== undefined) {
      // Only the constraints this condition actually models. A conditional
      // `enum`, title or description would be accepted and then never drawn or
      // enforced by anything here, so it is refused rather than ignored.
      refuseUnknown(own, CONSEQUENCE_FIELD_KEYWORDS, `$.then.properties.${name}`);
      if (own["type"] !== undefined && own["type"] !== "string") {
        refuse("restates a field as a type other than string", `$.then.properties.${name}.type`);
      }
    }
    constraints.push(
      Object.freeze({
        name,
        minLength: own === undefined ? undefined : minLengthOf(own, `$.then.properties.${name}`),
      }),
    );
  }
  if (restated !== undefined) {
    for (const name of Object.keys(restated)) {
      if (!added.includes(name)) {
        refuse(`restates "${name}" without requiring it`, `$.then.properties.${name}`);
      }
    }
  }
  return Object.freeze({ field, equals, requires: Object.freeze(constraints) });
}

/**
 * The form one normalized schema describes, or a refusal naming why not.
 *
 * Read from the normalized schema Core compiled rather than from the source that
 * produced it: what the person is shown has to be what the answer will be judged
 * against. Nothing here retains or freezes the caller's object — every value is
 * copied out.
 */
export function readQuestionForm(schema: Json): ReplQuestionForm {
  if (!isObject(schema)) {
    refuse("is not an object schema", "$");
  }
  refuseUnknown(schema, ROOT_KEYWORDS, "$");
  if (schema["type"] !== "object") {
    refuse('declares a root that is not type "object"', "$.type");
  }
  if (schema["additionalProperties"] !== false) {
    refuse("declares a root that is not closed", "$.additionalProperties");
  }
  const properties = schema["properties"];
  if (!isObject(properties)) {
    refuse("declares no properties", "$.properties");
  }
  const order = Object.keys(properties);
  if (order.length === 0) {
    refuse("declares no properties", "$.properties");
  }
  const declared = new Set(order);
  const required = namesOf(schema["required"] ?? [], "$.required");
  for (const name of required) {
    if (!declared.has(name)) {
      refuse(`requires "${name}", which it does not declare`, "$.required");
    }
  }

  const fields: ReplFormField[] = [];
  for (const name of order) {
    const path = `$.properties.${name}`;
    const field = properties[name];
    if (!isObject(field)) {
      refuse("declares a field that is not an object schema", path);
    }
    refuseUnknown(field, FIELD_KEYWORDS, path);
    if (field["type"] !== "string") {
      refuse("declares a field whose type is not string", `${path}.type`);
    }
    fields.push(
      Object.freeze({
        name,
        ...annotations(field, path),
        choices: choicesOf(field, path),
        minLength: minLengthOf(field, path),
        required: required.includes(name),
      }),
    );
  }

  return Object.freeze({
    ...annotations(schema, "$"),
    fields: Object.freeze(fields),
    condition: conditionOf(schema, declared),
  });
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
        // The whole schema, before anything else happens. A refusal here has
        // asked nobody, moved no counter and published no drawer.
        const form = readQuestionForm(request.schema);
        // Core's own compiler, so what the person is judged against is the
        // thing that will judge the answer on its way out.
        const prepared = yield* prepareElicitation(request.schema, "Elicit");
        asked++;
        return yield* action<Json>(function (resolve) {
          let settled = false;
          const question: ReplQuestion = {
            message: request.message,
            // No schema member. The parsed form is everything a reader needs,
            // and retaining the caller's object would hand a live reference to
            // whatever built it out to the application.
            form,
            submit(values: Readonly<Record<string, string>>): ReplFormOutcome {
              if (settled) {
                return { kind: "invalid", issues: [] };
              }
              // Every property the form actually holds, copied into a plain
              // object — the empty string included. An optional field someone
              // deliberately cleared is present and empty, which a schema may
              // well accept; dropping it would answer a different question from
              // the one on the screen. A field nobody has touched is absent.
              const assembled: Record<string, Json> = {};
              for (const field of form.fields) {
                const value = values[field.name];
                if (value !== undefined) {
                  assembled[field.name] = value;
                }
              }
              const issues = validateParsed(prepared.validate, assembled);
              if (issues.length > 0) {
                return { kind: "invalid", issues: Object.freeze([...issues]) };
              }
              settled = true;
              resolve(assembled);
              return { kind: "answered", answer: Object.freeze({ ...assembled }) };
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
