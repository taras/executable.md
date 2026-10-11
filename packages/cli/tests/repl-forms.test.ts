/**
 * Bounded Elicit forms (#854 F1, F2, F3).
 *
 * Three levels, each as small as the claim allows. F1 is the schema language on
 * its own, because parsing is a pure question. F2 drives the real provider — the
 * one `useReplElicitation()` installs — through the real reducer, so what judges
 * a submission is the compiled schema and not a test's idea of one. F3 reads the
 * described frame, because what a person can see and reach is a property of the
 * rows, not of a screenshot.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, race, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import {
  Elicitation,
  prepareElicitation,
  useTempFileCompiler,
  validateParsed,
} from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/core";

import { readQuestionForm, useReplElicitation } from "../src/repl/elicitation.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import {
  answered,
  describeApplication,
  EMPTY_FORM,
  focusClaim,
  focusSettled,
  initialState,
  NO_AGENT,
  reduceRepl,
  viewFor,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type {
  ReplAction,
  ReplLive,
  ReplState,
  ReplTransition,
  ReplView,
} from "../src/repl/application.ts";
import { NARROW } from "../src/repl/layout.ts";
import { flatten } from "../src/repl/layout.ts";
import { fields, readDescription } from "../src/repl/description.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import type { ReplDescription } from "../src/repl/description.ts";
import { ENTRY_SCOPE, projectRepl } from "../src/repl/model.ts";
import type { ReplElicitation, ReplModel, ReplScope } from "../src/repl/model.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import { presentationFor } from "../src/repl/application.ts";
import type { ReplPresentationContext } from "../src/repl/application.ts";
import { commitReplFrame, isStaleFrame } from "../src/repl/program.ts";
import { DRAWER_WINDOW, readingKeyOf } from "../src/repl/application.ts";
import { ReplRenderError, useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplMeasured, ReplRenderer } from "../src/repl/renderer.ts";
import type { ReplAdmission } from "../src/repl/layout-admission.ts";
import { committedContext } from "./fixtures/repl/presentation.ts";
import type { ReplTree } from "../src/repl/reconcile.ts";
import { submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplExecution } from "../src/repl/journal.ts";
import { ordinaryEvaluationProfile } from "../src/evaluation-profile.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";

/** The widest accepted frame, stated here because layout keeps it private. */
const WIDE = { columns: 160, rows: 36 };

/** The packaged Plan's review schema, as `Plan.md` writes it. */
const PLAN_SCHEMA: Json = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["Approve", "Request changes", "Stop"] },
    feedback: { type: "string" },
  },
  required: ["decision"],
  additionalProperties: false,
  if: {
    type: "object",
    properties: { decision: { const: "Request changes" } },
    required: ["decision"],
  },
  then: {
    type: "object",
    required: ["feedback"],
    properties: { feedback: { type: "string", minLength: 1 } },
  },
};

/** Project details: two required non-empty strings, both annotated. */
const DETAILS_SCHEMA: Json = {
  type: "object",
  title: "Project details",
  description: "Name the project and say what it is.",
  properties: {
    project: { type: "string", minLength: 1, title: "Project", description: "Its short name." },
    description: { type: "string", minLength: 1, title: "Description" },
  },
  required: ["project", "description"],
  additionalProperties: false,
};

/** Fields named after the suffixes a turn's own read-only facts are keyed with. */
const NAMED_LIKE_FACTS_SCHEMA: Json = {
  type: "object",
  properties: {
    text: { type: "string", title: "Text" },
    stop: { type: "string", title: "Stop" },
  },
  required: ["text"],
  additionalProperties: false,
};

/** Confirmation: one required enum. */
const CONFIRM_SCHEMA: Json = {
  type: "object",
  properties: { decision: { type: "string", enum: ["Approve", "Decline"] } },
  required: ["decision"],
  additionalProperties: false,
};

const EMPTY_MODEL: ReplModel = Object.freeze({
  head: true,
  entries: Object.freeze([]),
  settled: false,
  terminal: undefined,
  checkpoints: Object.freeze([]),
  transcript: Object.freeze([]),
  turns: Object.freeze([]),
  sessions: Object.freeze([]),
  selection: undefined,
});

/** A live reading with one question waiting. */
function asking(question: ReplQuestion | undefined): ReplLive {
  return {
    output: "",
    question,
    expansion: "playing",
    pausable: false,
    running: false,
    agent: NO_AGENT,
    lifecycle: NO_LIFECYCLE,
  };
}

describe("F1 — the bounded language is exact", () => {
  it("F1: the Plan review schema parses into its complete form", function* () {
    const form = readQuestionForm(PLAN_SCHEMA);
    // Field order follows the schema's own property order.
    expect(form.fields.map((one) => one.name)).toEqual(["decision", "feedback"]);
    const [decision, feedback] = form.fields;
    expect(decision?.choices).toEqual(["Approve", "Request changes", "Stop"]);
    expect(decision?.required).toBe(true);
    expect(feedback?.required).toBe(false);
    expect(feedback?.choices).toBe(undefined);
    // The conditional, exactly as written: which field, which value, and what
    // becomes required with what constraint.
    expect(form.condition).toEqual({
      field: "decision",
      equals: "Request changes",
      requires: [{ name: "feedback", minLength: 1 }],
    });
  });

  it("F1: project details and confirmation parse with their annotations", function* () {
    const details = readQuestionForm(DETAILS_SCHEMA);
    expect(details.title).toBe("Project details");
    expect(details.description).toBe("Name the project and say what it is.");
    expect(details.fields.map((one) => one.name)).toEqual(["project", "description"]);
    expect(details.fields.map((one) => one.title)).toEqual(["Project", "Description"]);
    expect(details.fields[0]?.description).toBe("Its short name.");
    expect(details.fields.map((one) => one.minLength)).toEqual([1, 1]);
    expect(details.fields.every((one) => one.required)).toBe(true);
    expect(details.condition).toBe(undefined);

    const confirm = readQuestionForm(CONFIRM_SCHEMA);
    expect(confirm.fields).toHaveLength(1);
    expect(confirm.fields[0]?.choices).toEqual(["Approve", "Decline"]);
  });

  it("F1: the parsed form is frozen, and the source schema is not", function* () {
    const form = readQuestionForm(PLAN_SCHEMA);
    expect(Object.isFrozen(form)).toBe(true);
    expect(Object.isFrozen(form.fields)).toBe(true);
    for (const field of form.fields) {
      expect(Object.isFrozen(field)).toBe(true);
    }
    expect(Object.isFrozen(form.condition)).toBe(true);
    // Nothing the caller owns was retained or frozen on its behalf.
    expect(Object.isFrozen(PLAN_SCHEMA)).toBe(false);
  });

  const refusals: Array<[string, Json, string]> = [
    [
      "a field keyword it does not model",
      {
        type: "object",
        properties: { feedback: { type: "string", pattern: "^x" } },
        additionalProperties: false,
      },
      "$.properties.feedback.pattern",
    ],
    [
      "a root keyword it does not model",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
        oneOf: [],
      },
      "$.oneOf",
    ],
    [
      "an open root",
      { type: "object", properties: { a: { type: "string" } } },
      "$.additionalProperties",
    ],
    [
      "a nested object field",
      { type: "object", properties: { a: { type: "object" } }, additionalProperties: false },
      "$.properties.a.type",
    ],
    [
      "a numeric field",
      { type: "object", properties: { a: { type: "number" } }, additionalProperties: false },
      "$.properties.a.type",
    ],
    [
      "an empty enum",
      {
        type: "object",
        properties: { a: { type: "string", enum: [] } },
        additionalProperties: false,
      },
      "$.properties.a.enum",
    ],
    [
      "a mixed enum",
      {
        type: "object",
        properties: { a: { type: "string", enum: ["x", 1] } },
        additionalProperties: false,
      },
      "$.properties.a.enum[1]",
    ],
    [
      "a required name it does not declare",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["b"],
        additionalProperties: false,
      },
      "$.required",
    ],
    [
      "a duplicate required name",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a", "a"],
        additionalProperties: false,
      },
      "$.required[1]",
    ],
    [
      "a then with no if",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
        then: { type: "object", required: ["a"] },
      },
      "$.then",
    ],
    [
      "an if with no then",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
        if: { type: "object", properties: { a: { const: "x" } }, required: ["a"] },
      },
      "$.if",
    ],
    [
      "a condition over a field the root does not declare",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
        if: { type: "object", properties: { b: { const: "x" } }, required: ["b"] },
        then: { type: "object", required: ["a"] },
      },
      "$.if.properties.b",
    ],
    [
      "a conditional property the root does not declare",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
        if: { type: "object", properties: { a: { const: "x" } }, required: ["a"] },
        then: { type: "object", required: ["b"] },
      },
      "$.then.required",
    ],
    [
      "a conditional constraint it does not model",
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        additionalProperties: false,
        if: { type: "object", properties: { a: { const: "x" } }, required: ["a"] },
        then: {
          type: "object",
          required: ["b"],
          properties: { b: { type: "string", enum: ["y"] } },
        },
      },
      "$.then.properties.b.enum",
    ],
    [
      "an if whose type is not object",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
        if: { type: "string", properties: { a: { const: "x" } }, required: ["a"] },
        then: { type: "object", required: ["a"] },
      },
      "$.if.type",
    ],
    [
      "a then whose type is not object",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
        if: { type: "object", properties: { a: { const: "x" } }, required: ["a"] },
        then: { type: "string", required: ["a"] },
      },
      "$.then.type",
    ],
    [
      // Core evaluates the tested type. This form reduces the condition to a
      // string equality, so a numeric test would draw a form whose required
      // fields disagree with validation.
      "a condition that tests a type other than string",
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        additionalProperties: false,
        if: {
          type: "object",
          properties: { a: { type: "number", const: "x" } },
          required: ["a"],
        },
        then: { type: "object", required: ["b"] },
      },
      "$.if.properties.a.type",
    ],
    [
      // `properties` does not require a property to exist, so this condition
      // also matches an object with no `a` at all.
      "a condition that does not require the field it tests",
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        additionalProperties: false,
        if: { type: "object", properties: { a: { const: "x" } } },
        then: { type: "object", required: ["b"] },
      },
      "$.if.required",
    ],
  ];

  for (const [what, schema, path] of refusals) {
    it(`F1: refuses ${what}, naming ${path}`, function* () {
      let refused: unknown;
      try {
        readQuestionForm(schema);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(Error);
      expect(refused instanceof Error ? refused.name : "").toBe("ElicitationProviderError");
      // The first offending keyword, and where it sits.
      expect(refused instanceof Error ? refused.message : "").toContain(path);
    });
  }

  it("F1: a refused schema publishes nothing and asks nobody", function* () {
    const elicitation = yield* useReplElicitation();
    const refused: string[] = [];
    const outcome = yield* spawn(function* () {
      try {
        yield* Elicitation.operations.elicit({
          message: "unsupported",
          schema: {
            type: "object",
            properties: { a: { type: "string", pattern: "^x" } },
            additionalProperties: false,
          },
        });
      } catch (error) {
        // The refusal belongs to whoever asked. Caught here so it does not
        // also end this test, which is about what the provider did *not* do.
        refused.push(error instanceof Error ? error.name : String(error));
      }
    });
    // One turn is enough for the provider to have refused.
    yield* sleep(0);
    // It refused before publishing, so nothing was ever pending and the
    // counter never moved.
    expect(refused).toEqual(["ElicitationProviderError"]);
    expect(elicitation.pending).toBe(undefined);
    expect(elicitation.asked).toBe(0);
    yield* outcome;
  });
});

/** The request shape the Api takes, from a schema written as a literal here. */
function parsed(schema: Json): { [key: string]: Json } {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("these schemas are objects");
  }
  return schema;
}

/** Everything one live question needs in order to be driven. */
interface Asked {
  readonly question: ReplQuestion;
  /**
   * What the provider resolved with, once it has.
   *
   * `unknown`, because that is what the Api resolves with and an expectation
   * reads a value rather than being told what it is. Read it after a turn of the
   * loop: `submit` resolves the provider's action, and the asking coroutine
   * resumes on the next turn.
   */
  readonly answer: () => unknown;
}

/**
 * Install the real provider, ask one real question, and hand back the pending
 * one.
 *
 * The question is the provider's own: what judges a submission is the schema
 * Core compiled from the request, reached through the same `submit` the
 * application reaches.
 */
function* askingFor(schema: Json, message = "Review the draft"): Operation<Asked> {
  const elicitation = yield* useReplElicitation();
  const settled: { value?: unknown } = {};
  yield* spawn(function* () {
    settled.value = yield* Elicitation.operations.elicit({ message, schema: parsed(schema) });
  });
  // The provider publishes before it suspends, so one turn of the loop is
  // enough for the question to exist.
  yield* sleep(0);
  const question = elicitation.pending;
  if (question === undefined) {
    throw new Error("the provider published no question");
  }
  return { question, answer: () => settled.value };
}

/**
 * One state with the live Elicit drawer open, which is how a form is filled.
 *
 * Opened through the ordinary action against the live question, because that is
 * the only way the drawer opens: a route holding `+elicit` with nothing being
 * asked is refused.
 */
function opened(live: ReplLive): ReplState {
  const transition = reduceRepl(
    initialState("forms"),
    { kind: "open-drawer", drawer: { kind: "live-elicit" } },
    EMPTY_MODEL,
    live,
  );
  if (transition.state.refusal !== undefined) {
    throw new Error(`the drawer did not open: ${transition.state.refusal}`);
  }
  return transition.state;
}

function* drive(
  state: ReplState,
  live: ReplLive,
  actions: readonly ReplAction[],
  engine?: ReplRenderer,
): Operation<{ state: ReplState; transitions: ReplTransition[] }> {
  let current = state;
  const transitions: ReplTransition[] = [];
  for (const action of actions) {
    // Measured for the state this action is answered at, which is what the
    // program does before it reduces: a window moves within the capacity the
    // screen is showing, not one left over from an earlier size or reading.
    const transition = reduceRepl(
      current,
      action,
      EMPTY_MODEL,
      live,
      yield* admissionOf(current, live, EMPTY_MODEL, NARROW, engine),
    );
    transitions.push(transition);
    current = transition.state;
  }
  return { state: current, transitions };
}

describe("F2 — invalid stays open; valid is exact", () => {
  it("F2: choosing Request changes with no feedback keeps the question and says why", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA);
    const live = asking(asked.question);
    const { state, transitions } = yield* drive(opened(live), live, [
      { kind: "choose", field: "decision", option: "Request changes" },
    ]);
    // Activating an option offers the whole object, as Enter does.
    const intent = transitions[0]?.intent;
    expect(intent?.kind).toBe("answer");
    expect(intent?.kind === "answer" ? intent.values : {}).toEqual({
      decision: "Request changes",
    });
    // The schema rejects it, so nothing is answered and the question stands.
    const outcome = asked.question.submit(state.form.values);
    expect(outcome.kind).toBe("invalid");
    yield* sleep(0);
    expect(asked.answer()).toBe(undefined);
    const reported = outcome.kind === "invalid" ? outcome.issues : [];
    expect(reported.length).toBeGreaterThan(0);
    expect(JSON.stringify(reported)).toContain("feedback");
  });

  it("F2: entering feedback then submitting resolves with exactly that object", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA);
    const live = asking(asked.question);
    const { state } = yield* drive(opened(live), live, [
      { kind: "choose", field: "decision", option: "Request changes" },
      { kind: "type", text: "needs work", field: "feedback" },
    ]);
    expect(asked.question.submit(state.form.values).kind).toBe("answered");
    yield* sleep(0);
    expect(asked.answer()).toEqual({ decision: "Request changes", feedback: "needs work" });
  });

  it("F2: each field edits independently, whichever one the control names", function* () {
    const asked = yield* askingFor(DETAILS_SCHEMA);
    const live = asking(asked.question);
    // Typed into the second field first, then the first: an application that
    // kept one global answer, or one that sent text to whichever field it had
    // last recorded, would put both strings in one place.
    const { state } = yield* drive(opened(live), live, [
      { kind: "type", text: "a REPL", field: "description" },
      { kind: "type", text: "xmd", field: "project" },
    ]);
    expect(state.form.values).toEqual({ description: "a REPL", project: "xmd" });
    expect(asked.question.submit(state.form.values).kind).toBe("answered");
    yield* sleep(0);
    expect(asked.answer()).toEqual({ project: "xmd", description: "a REPL" });
  });

  it("F2: both details are required, and one missing keeps the question open", function* () {
    const asked = yield* askingFor(DETAILS_SCHEMA);
    const live = asking(asked.question);
    const { state } = yield* drive(opened(live), live, [
      { kind: "type", text: "xmd", field: "project" },
    ]);
    expect(asked.question.submit(state.form.values).kind).toBe("invalid");
    yield* sleep(0);
    expect(asked.answer()).toBe(undefined);
  });

  it("F2: confirmation returns exactly its offered decision", function* () {
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const { state } = yield* drive(opened(live), live, [
      { kind: "choose", field: "decision", option: "Decline" },
    ]);
    expect(asked.question.submit(state.form.values).kind).toBe("answered");
    yield* sleep(0);
    expect(asked.answer()).toEqual({ decision: "Decline" });
  });

  it("F2: an option the field does not offer puts nothing into the form", function* () {
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const { state, transitions } = yield* drive(opened(live), live, [
      { kind: "choose", field: "decision", option: "Maybe" },
    ]);
    expect(transitions[0]?.intent.kind).toBe("none");
    expect(state.form.values).toEqual({});
    expect(state.refusal).toBeDefined();
  });

  it("F2: an optional field deliberately emptied is present and empty", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA);
    const live = asking(asked.question);
    // Typed and then erased: the person cleared it, which is not the same as
    // never having touched it, and an optional empty string is valid here.
    const { state } = yield* drive(opened(live), live, [
      { kind: "choose", field: "decision", option: "Approve" },
      { kind: "type", text: "x", field: "feedback" },
      { kind: "erase", field: "feedback" },
    ]);
    expect(state.form.values["feedback"]).toBe("");
    expect(asked.question.submit(state.form.values).kind).toBe("answered");
    yield* sleep(0);
    expect(asked.answer()).toEqual({ decision: "Approve", feedback: "" });
  });

  it("F2: closing discards the draft, answers nothing, and reopens empty", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA);
    const live = asking(asked.question);
    const { state, transitions } = yield* drive(opened(live), live, [
      { kind: "type", text: "half written", field: "feedback" },
      { kind: "close-drawer" },
    ]);
    expect(state.form).toEqual(EMPTY_FORM);
    // Closing owes nobody anything: a dismissal that came back as an answer
    // would send the half-written draft to the schema on its way out.
    expect(transitions[1]?.intent.kind).toBe("none");
    yield* sleep(0);
    expect(asked.answer()).toBe(undefined);
    // Still pending, and reopening starts with nothing in it.
    const reopened = yield* drive(state, live, [
      { kind: "open-drawer", drawer: { kind: "live-elicit" } },
    ]);
    expect(reopened.state.form.values).toEqual({});
  });

  it("F2: an astral scalar survives typing, and one erase removes one scalar", function* () {
    const asked = yield* askingFor(DETAILS_SCHEMA);
    const live = asking(asked.question);
    const typed = yield* drive(opened(live), live, [
      { kind: "type", text: "é漢🙂", field: "project" },
    ]);
    expect(typed.state.form.values["project"]).toBe("é漢🙂");
    // One Unicode scalar, not one UTF-16 code unit: erasing the emoji leaves
    // the two characters before it whole rather than half a surrogate pair.
    const erased = yield* drive(typed.state, live, [{ kind: "erase", field: "project" }]);
    expect(erased.state.form.values["project"]).toBe("é漢");
  });
});

/** Every described row, flattened, with its key and label. */
function rowsOf(descriptions: readonly ReplDescription<ReplAction>[]): Array<{
  key: string;
  label: string;
}> {
  const found: Array<{ key: string; label: string }> = [];
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    const named = fields(read.input);
    const label = named?.["label"] ?? named?.["text"] ?? "";
    found.push({ key: read.key, label: typeof label === "string" ? label : "" });
    for (const child of read.children ?? []) {
      walk(child);
    }
  };
  for (const description of descriptions) {
    walk(description);
  }
  return found;
}

/** The view this state reads as, or the failure that stopped it. */
function reading(
  state: ReplState,
  live: ReplLive,
  model: ReplModel = EMPTY_MODEL,
  size = NARROW,
  focused?: string,
): ReplView {
  // The navigation a session would publish for this reading. The History
  // drawer is fed from it rather than from the model's prefix, so a view
  // built here has to carry one or the drawer lists nothing.
  const resolved = viewFor(
    state,
    model,
    live,
    size,
    focused,
    navigationOf(model.checkpoints, model.settled ? "settled" : "unfinished"),
  );
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.value;
}

/**
 * Measure one view with a real engine pair, as the product does.
 *
 * A window's rows are the rows the measurement left room for, so a test asking
 * what a state describes has to measure it. An engine may be handed in where a
 * test walks a window press by press; otherwise one is built for the question
 * and released with it.
 */
function* measuring<T>(
  size: ReplTerminalSize,
  engine: ReplRenderer | undefined,
  body: (renderer: ReplRenderer) => Operation<T>,
): Operation<T> {
  if (engine !== undefined) {
    return yield* body(engine);
  }
  return yield* scoped(function* (): Operation<T> {
    return yield* body(yield* useReplRenderer(size));
  });
}

/** What one view's frame settled on: its measured widths and its admission. */
function* contextOf(view: ReplView, engine?: ReplRenderer): Operation<ReplPresentationContext> {
  return yield* measuring(view.size, engine, (renderer) => committedContext(renderer, view));
}

/** What this state admits at this size, which is what a scroll moves within. */
function* admissionOf(
  state: ReplState,
  live: ReplLive,
  model: ReplModel = EMPTY_MODEL,
  size = NARROW,
  engine?: ReplRenderer,
): Operation<ReplAdmission> {
  const view = reading(state, live, model, size, undefined);
  return (yield* contextOf(view, engine)).admission;
}

/** The descriptions one view produces, measured. */
function* seenView(
  view: ReplView,
  engine?: ReplRenderer,
): Operation<readonly ReplDescription<ReplAction>[]> {
  return presentationFor(view, yield* contextOf(view, engine)).descriptions;
}

/** The descriptions this state produces, measured. */
function* seen(
  state: ReplState,
  live: ReplLive,
  size = NARROW,
  focused?: string,
  engine?: ReplRenderer,
): Operation<readonly ReplDescription<ReplAction>[]> {
  const view = reading(state, live, EMPTY_MODEL, size, focused);
  return presentationFor(view, yield* contextOf(view, engine)).descriptions;
}

function* framed(
  state: ReplState,
  live: ReplLive,
  size = NARROW,
  focused?: string,
  engine?: ReplRenderer,
) {
  return rowsOf(yield* seen(state, live, size, focused, engine));
}

const DRAFT = Array.from({ length: 40 }, (_, line) => `draft line ${line}`).join("\n");

/**
 * Every key layout actually placed, with whether it can be pointed at.
 *
 * At module scope because two describes need the same answer: what a pointer can
 * reach is also the set a keystroke has to be able to reach.
 */
function* placedKeys(
  tree: ReplTree<ReplAction>,
  view: ReplView,
  engine?: ReplRenderer,
): Operation<Map<string, boolean>> {
  const committed = yield* measuring(view.size, engine, (renderer) =>
    commitReplFrame(tree, renderer, view, 0, undefined),
  );
  if (!committed.ok) {
    throw committed.error;
  }
  // Read off the frame that was actually drawn: a box the manifest placed, whose
  // key mounted a live node. A described node the frame did not place is in no
  // cell and no target, which is the whole distinction being tested.
  const mounted = new Set(tree.mounted());
  const nodeByKey = new Map<string, string>();
  for (const node of mounted) {
    const key = tree.keyOf(node);
    if (key !== undefined) {
      nodeByKey.set(key, node);
    }
  }
  const keys = new Map<string, boolean>();
  for (const box of flatten(committed.value.manifest.root)) {
    if (box.key === undefined) {
      continue;
    }
    const node = nodeByKey.get(box.key);
    if (node === undefined) {
      continue;
    }
    keys.set(box.key, box.control);
  }
  return keys;
}

describe("F3 — complete content and reachable navigation", () => {
  /** The essential Plan controls a person has to be able to reach. */
  const ESSENTIAL = [
    "drawer:field:decision",
    "drawer:choice:decision:Approve",
    "drawer:choice:decision:Request changes",
    "drawer:choice:decision:Stop",
    "drawer:value:decision",
    "drawer:field:feedback",
    "drawer:value:feedback",
    "drawer:form:submit",
    "drawer:close",
    "footer:history",
  ];

  it("F3: a field named after a turn's facts is still pointer-targetable", function* () {
    // The key of this field's editable line ends in `:text`, which is how a
    // turn's own read-only text is keyed too. What decides whether a pointer may
    // activate a row is what the row is, so the field keeps its pointer and the
    // fact never had one.
    const asked = yield* askingFor(NAMED_LIKE_FACTS_SCHEMA);
    const live = asking(asked.question);
    const tree = yield* useReplTree<ReplAction>();
    const keys = yield* placedKeys(tree, reading(opened(live), live, EMPTY_MODEL, NARROW));
    expect(keys.get("drawer:field:text")).toBe(true);
    expect(keys.get("drawer:value:text")).toBe(true);
    expect(keys.get("drawer:field:stop")).toBe(true);
    // And what a person only reads inside the same drawer is not a target.
    expect(keys.get("drawer:message:0")).toBe(false);
  });

  it("F3: scrolling places every essential control in the narrow frame", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA, DRAFT);
    const live = asking(asked.question);
    const tree = yield* useReplTree<ReplAction>();

    // Walked from the first clamped position to the last, through the real
    // tree and the real placement boundary. A described node layout never
    // placed is not something a person can see or point at, so only placed
    // cells count here.
    let state = opened(live);
    const reached = new Map<string, boolean>();
    for (let press = 0; press < 120; press++) {
      for (const [key, targetable] of yield* placedKeys(
        tree,
        reading(state, live, EMPTY_MODEL, NARROW, undefined),
      )) {
        if (targetable || !reached.has(key)) {
          reached.set(key, targetable || (reached.get(key) ?? false));
        }
      }
      const next = reduceRepl(
        state,
        { kind: "scroll", delta: 1 },
        EMPTY_MODEL,
        live,
        yield* admissionOf(state, live),
      ).state;
      if (next.form.offset === state.form.offset) {
        break;
      }
      state = next;
    }

    for (const key of ESSENTIAL) {
      expect([key, reached.has(key)]).toEqual([key, true]);
      expect([key, reached.get(key)]).toEqual([key, true]);
    }
  });

  it("F3: a long preview line is readable to its last character at 72x20", function* () {
    // R4. A drawer row is one row, so a message split only at its newlines
    // puts a long line's tail nowhere: the window can scroll to rows that
    // were prepared and cannot recover the rest of one that was not. The
    // reviewed build lost `ng coding agents."` off the end of the README
    // summary at this size, with Approve still reachable — so reaching the
    // controls is not what discriminates this.
    //
    // Walked through the real tree, the real admission and the real scroll,
    // concatenating what the drawer actually placed.
    const summary = "A lightweight workspace for coordinating coding agents.";
    const long = [
      "Proposed README.md:",
      "",
      "{",
      `  "project": "Northstar",`,
      `  "summary": "${summary}"`,
      "}",
      "",
    ].join("\n");
    const asked = yield* askingFor(PLAN_SCHEMA, long);
    const live = asking(asked.question);
    const tree = yield* useReplTree<ReplAction>();

    let state = opened(live);
    const rows: string[] = [];
    const seenKeys = new Set<string>();
    for (let press = 0; press < 160; press++) {
      const view = reading(state, live, EMPTY_MODEL, NARROW, undefined);
      for (const [key] of yield* placedKeys(tree, view)) {
        if (key.startsWith("drawer:message:") && !seenKeys.has(key)) {
          seenKeys.add(key);
        }
      }
      for (const row of yield* framed(state, live)) {
        if (
          row.key.startsWith("drawer:message:") &&
          !rows.includes(row.key + "\u0000" + row.label)
        ) {
          rows.push(row.key + "\u0000" + row.label);
        }
      }
      const next = reduceRepl(
        state,
        { kind: "scroll", delta: 1 },
        EMPTY_MODEL,
        live,
        yield* admissionOf(state, live),
      ).state;
      if (next.form.offset === state.form.offset) {
        break;
      }
      state = next;
    }

    // Every row the drawer showed, in the order its keys number them.
    //
    // Compared with runs of whitespace collapsed, because the display adds
    // two kinds of its own: `drawerLine` pads each row to the drawer's width,
    // and a continuation is set in to the column its line was written at.
    // Neither is content, and neither can be told from the content's own
    // spaces in a drawn row — so the recovery rule is "every character, in
    // order, up to the whitespace the display inserted". That is exactly the
    // rule that catches the defect: a dropped tail is missing characters, not
    // extra spaces.
    const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
    const whole = flat(
      rows
        .map((one) => one.split("\u0000"))
        .sort((a, b) => Number(a[0].split(":")[2]) - Number(b[0].split(":")[2]))
        .map(([, label]) => label)
        .join(" "),
    );

    // The property that makes the text *drawable*, and the one the reviewed
    // build failed. A description's label always held the whole line — the
    // loss happened at the row, where a label wider than the drawer has
    // nowhere to put its tail and the window has no second row to scroll to.
    // So every message row must fit the width the drawer was measured at.
    const room =
      (yield* contextOf(reading(opened(live), live, EMPTY_MODEL, NARROW, undefined))).widths
        ?.drawer ?? 0;
    expect(room).toBeGreaterThan(0);
    const overflowing = rows
      .map((one) => one.split("\u0000"))
      .filter(([, label]) => label.replace(/\s+$/, "").length > room);
    expect(overflowing.map(([key]) => key)).toEqual([]);
    // And there really are more rows than logical lines, so this is wrapping
    // rather than a message that happened to be short enough.
    expect(rows.length).toBeGreaterThan(long.split("\n").length);

    // The tail the reviewed build dropped.
    expect(whole).toContain("ng coding agents.");
    // And the value entire, with its closing quote.
    expect(whole).toContain(flat(`"summary": "${summary}"`));
    // Every logical line is in there whole, so nothing was shortened and
    // nothing was invented.
    for (const line of long.split("\n").filter((one) => one.trim().length > 0)) {
      expect([line, whole.includes(flat(line))]).toEqual([line, true]);
    }
    // The decisions are still reachable afterwards, which is the half the
    // reviewed build already satisfied.
    const reached = new Set<string>();
    let at = opened(live);
    for (let press = 0; press < 160; press++) {
      for (const [key, targetable] of yield* placedKeys(
        tree,
        reading(at, live, EMPTY_MODEL, NARROW, undefined),
      )) {
        if (targetable) {
          reached.add(key);
        }
      }
      const next = reduceRepl(
        at,
        { kind: "scroll", delta: 1 },
        EMPTY_MODEL,
        live,
        yield* admissionOf(at, live),
      ).state;
      if (next.form.offset === at.form.offset) {
        break;
      }
      at = next;
    }
    expect(reached.has("drawer:form:submit")).toBe(true);
  });

  it("F3: the viewport walks the whole message before the form controls", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA, DRAFT);
    const live = asking(asked.question);
    const shown = (rows: readonly { readonly key: string; readonly label: string }[]): string[] =>
      rows.filter((one) => one.key.startsWith("drawer:message:")).map((one) => one.label.trim());

    const first = yield* framed(opened(live), live);
    // Not every line at once, and the first window starts at the beginning.
    expect(shown(first).length).toBeGreaterThan(0);
    expect(shown(first).length).toBeLessThan(40);
    expect(shown(first)[0]).toBe("draft line 0");

    // Every message line is encountered, and all of them before the form's
    // own controls come into view.
    let state = opened(live);
    const seenLines: string[] = [];
    let sawSubmit = false;
    let submitBeforeLastLine = false;
    for (let press = 0; press < 120; press++) {
      const rows = yield* framed(state, live);
      for (const label of shown(rows)) {
        if (!seenLines.includes(label)) {
          seenLines.push(label);
        }
      }
      if (rows.some((one) => one.key === "drawer:form:submit")) {
        sawSubmit = true;
        if (seenLines.length < 40) {
          submitBeforeLastLine = true;
        }
      }
      const next = reduceRepl(
        state,
        { kind: "scroll", delta: 1 },
        EMPTY_MODEL,
        live,
        yield* admissionOf(state, live),
      ).state;
      if (next.form.offset === state.form.offset) {
        break;
      }
      state = next;
    }

    expect(seenLines).toHaveLength(40);
    expect(seenLines[0]).toBe("draft line 0");
    expect(seenLines[39]).toBe("draft line 39");
    expect(sawSubmit).toBe(true);
    expect(submitBeforeLastLine).toBe(false);

    // Clamped at the end rather than wrapping, and one press back moves
    // immediately because the stored offset was clamped.
    const held = state.form.offset;
    state = reduceRepl(
      state,
      { kind: "scroll", delta: 1 },
      EMPTY_MODEL,
      live,
      yield* admissionOf(state, live),
    ).state;
    expect(state.form.offset).toBe(held);
    const back = reduceRepl(
      state,
      { kind: "scroll", delta: -1 },
      EMPTY_MODEL,
      live,
      yield* admissionOf(state, live),
    ).state;
    expect(back.form.offset).toBe(held - 1);

    // And scrolling changed no value and no route.
    expect(back.form.values).toEqual({});
    expect(back.route.drawers.map((one) => one.kind)).toEqual(["live-elicit"]);
  });

  it("F3: the one History control is inside the drawer while it is open", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA);
    const live = asking(asked.question);
    const descriptions = yield* seen(opened(live), live);
    // Exactly one node carries the key, and it is a child of the drawer
    // rather than a sibling of it.
    const all = rowsOf(descriptions).filter((one) => one.key === "footer:history");
    expect(all).toHaveLength(1);
    const drawer = descriptions
      .map((description) => readDescription(description))
      .find((read) => read.key === "drawer:open");
    expect(drawer).toBeDefined();
    const inside = rowsOf(drawer?.children ?? []).some((one) => one.key === "footer:history");
    expect(inside).toBe(true);
  });

  it("F3: the footer trigger is one fixed control, and the drawer holds the message", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA, DRAFT);
    const live = asking(asked.question);
    // Closed: one fixed spelling, taking none of its width from the question.
    // A message is as long as its author made it and the action row is only as
    // wide as the terminal, so a trigger sized by the message is one the
    // narrowest supported frame drops — and a dropped announcement is a waiting
    // question nobody can reach.
    const closed = yield* framed(initialState("forms"), live);
    const trigger = closed.find((one) => one.key === "footer:asked");
    expect(trigger).toBeDefined();
    expect(trigger?.label).toBe("[answer]");
    // Bounded, and now carrying no part of the message at all.
    expect(trigger?.label.includes("\n")).toBe(false);
    expect(trigger?.label).not.toContain("draft line");

    // Which costs nothing, because the message is where there is room for it:
    // the drawer this one control opens. The row above walks all forty lines of
    // it; this one holds the two halves together, so a trigger that stopped
    // announcing cannot be mistaken for a question that stopped being readable.
    const opening = yield* framed(opened(live), live);
    const message = opening
      .filter((one) => one.key.startsWith("drawer:message:"))
      .map((one) => one.label.trim());
    expect(message[0]).toBe("draft line 0");
  });
});

describe("F3 — focus returns to the invocation, not to where the drawer came from", () => {
  // The retained row focus lands on exists only once an answer is recorded, so
  // the model here is a real execution's journal rather than a shape written by
  // this test.
  beforeAll(() => useTempFileCompiler());

  it("F3: focus lands on the record this answer caused, once it appends", function* () {
    // One real session over one real journal, asking three questions in a row.
    // The record focus has to reach does not exist when the answer is taken —
    // it appends when the invocation settles — so this drives the whole
    // interval rather than a frame that already has everything in it.
    const holder = execution();
    const session = granted(
      yield* submitReplEntry({
        execution: holder,
        installations: [{ evaluation: ordinaryEvaluationProfile() }],
        source: THREE_QUESTIONS,
      }),
    );
    // Chained after the session's own observer, so a signal arrives with the
    // session already reprojected — and so the session does not replace it.
    const appended = elicitAppends(holder);

    // An answer this test did not cause, carrying the same value the one under
    // test will carry. What excludes it is that it was already retained, not
    // that it looks different.
    const first = yield* waiting(session, "the first question");
    expect(first.message).toContain("First");
    expect(first.submit({ decision: "Approve" }).kind).toBe("answered");
    yield* appended(1);
    expect(answers(session.model)).toHaveLength(1);

    // The question under test, in the mounted drawer.
    const second = yield* waiting(session, "the question under test", first);
    expect(second.message).toContain("Second");
    const held = liveReading(session);
    const open = withScope(opened(held), ENTRY_SCOPE);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, reading(open, held, session.model));
    const inside = keyed(tree);
    expect(inside?.startsWith("drawer:")).toBe(true);

    // Answered by activating the option control the drawer mounted: Enter on
    // it is one keystroke, and what it produces is the ordinary action.
    yield* focusTo(tree, "drawer:choice:decision:Approve");
    const dispatched = yield* tree.dispatch({ kind: "key", key: "Enter" });
    if (!dispatched.ok || dispatched.value.outcome !== "action") {
      throw new Error("the mounted option control produced no action");
    }
    const transition = reduceRepl(
      open,
      dispatched.value.action,
      session.model,
      held,
      yield* admissionOf(open, held, session.model),
    );
    expect(transition.intent.kind).toBe("answer");
    if (transition.intent.kind !== "answer") {
      throw new Error("activating an option offers the whole object");
    }
    // The boundary the program performs it at, on the question this process is
    // actually holding.
    const outcome = session.overlay.question?.submit(transition.intent.values);
    if (outcome?.kind !== "answered") {
      throw new Error("the live question did not take its answer");
    }
    // Nothing has appended yet: this is the interval the claim has to survive.
    expect(answers(session.model)).toHaveLength(1);
    let state = answered(transition.state, session.model, outcome.answer);
    expect(state.restore?.kind).toBe("answered");

    // A frame drawn in that interval claims nothing, because the row it would
    // name is not there — and spends nothing either.
    let view = reading(state, liveReading(session), session.model, NARROW, inside);
    expect(focusClaim(view)).toBe(undefined);
    yield* applied(tree, view);
    const between = keyed(tree);
    expect(between?.startsWith("elicit:")).toBe(false);
    state = focusSettled(view, between);
    expect(state.restore?.kind).toBe("answered");

    // A third answer, with a different value, so the record under test is no
    // longer the newest one by the time any frame can draw it.
    const third = yield* waiting(session, "the third question", second);
    expect(third.message).toContain("Third");
    expect(third.submit({ decision: "Stop" }).kind).toBe("answered");
    yield* appended(3);

    const retained = answers(session.model);
    expect(retained).toHaveLength(3);
    const caused = retained[1];
    const before = retained[0];
    const newest = retained[2];
    if (caused === undefined || before === undefined || newest === undefined) {
      throw new Error("the entry retained three answers");
    }
    // The one it did not cause has the same answer; the newest one is somebody
    // else's. Identity here is both, or neither would be enough.
    expect(before.answer).toEqual({ decision: "Approve" });
    expect(caused.answer).toEqual({ decision: "Approve" });
    expect(newest.answer).toEqual({ decision: "Stop" });

    // Wide, where there is an inspection region: focus lands on the record this
    // answer caused, and on neither of the two it did not.
    view = reading(state, liveReading(session), session.model, WIDE, between);
    expect(focusClaim(view)).toBe(`elicit:${caused.marker}`);
    yield* applied(tree, view);
    expect(keyed(tree)).toBe(`elicit:${caused.marker}`);
    expect(keyed(tree)).not.toBe(`elicit:${before.marker}`);
    expect(keyed(tree)).not.toBe(`elicit:${newest.marker}`);

    // Narrow, where there is not. The record's own row is not a row this screen
    // offers, so the claim names the entry that owns the record — the visible
    // control — and focus lands there rather than on a node drawing nothing.
    const owner = `entry:${session.model.entries[0]?.key}`;
    view = reading(state, liveReading(session), session.model, NARROW, between);
    expect(focusClaim(view)).toBe(owner);
    yield* applied(tree, view);
    const landed = keyed(tree);
    expect(landed).toBe(owner);
    // And no recorded-answer row is mounted at this size at all, so none of the
    // three could have been what focus found.
    expect(
      tree
        .mounted()
        .map((node) => tree.keyOf(node))
        .filter((key) => key !== undefined && key.startsWith("elicit:")),
    ).toEqual([]);

    // Spent by the commit that satisfied it, so traversal from here is the
    // person's: Tab moves, and the next frame leaves it where they moved it.
    state = focusSettled(view, landed);
    expect(state.restore).toBe(undefined);
    const moved = yield* tabbed(tree);
    expect(moved).not.toBe(landed);
    yield* applied(tree, reading(state, liveReading(session), session.model, NARROW, moved));
    expect(keyed(tree)).toBe(moved);
  });

  it("F3: closing without answering moves focus to the invocation still asking", function* () {
    const recorded = yield* retained();
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const open = withScope(opened(live), recorded.scope);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, reading(open, live, recorded.model));
    const inside = keyed(tree);
    expect(inside?.startsWith("drawer:")).toBe(true);

    // Dismissed, not answered: the same question is still being asked, so the
    // control that is asking it is where focus belongs — and it is the one
    // control that opens this drawer again.
    const closed = reduceRepl(
      open,
      { kind: "close-drawer" },
      recorded.model,
      live,
      yield* admissionOf(open, live, recorded.model),
    ).state;
    expect(closed.restore?.kind).toBe("asked");
    expect(closed.route.drawers).toEqual([]);
    yield* applied(tree, reading(closed, live, recorded.model, NARROW, inside));
    expect(keyed(tree)).toBe("footer:asked");
    // Nothing was answered by closing it.
    yield* sleep(0);
    expect(asked.answer()).toBe(undefined);
  });

  it("F3: without the claim the drawer going leaves focus on an unrelated control", function* () {
    const recorded = yield* retained();
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const open = withScope(opened(live), recorded.scope);
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, reading(open, live, recorded.model));
    const inside = keyed(tree);

    // The same commit with the claim removed, which is what the tree does on
    // its own: Freedom restores whatever held focus before the modal was
    // pushed, and on this screen that is neither invocation. This is what the
    // two rows above are distinguished from.
    const taken = answered(open, recorded.model, { decision: "Approve" });
    const unclaimed = Object.freeze({ ...taken, restore: undefined });
    yield* applied(tree, reading(unclaimed, asking(undefined), recorded.model, NARROW, inside));
    const landed = keyed(tree);
    expect(landed).not.toBe(`elicit:${recorded.marker}`);
    // The first focusable row this frame draws, which is neither the invocation
    // nor where the drawer was opened from. On a narrow route that is the
    // surface navigation, which is mounted above whichever outlet is routed.
    expect(landed).toBe("sessions:heading");
  });
});

/** One real journal with an answer in it, and the scope that shows it. */
function* retained(): Operation<{
  readonly model: ReplModel;
  readonly scope: string;
  readonly marker: string;
}> {
  const projected = projectRepl(yield* referenceEvents());
  if (!projected.ok) {
    throw projected.error;
  }
  const entry = projected.value.entries[0]?.scope;
  const elicitation = entry?.elicitations[0];
  if (entry === undefined || elicitation === undefined) {
    throw new Error("the reference execution recorded no answered elicitation");
  }
  return { model: projected.value, scope: entry.key, marker: elicitation.marker };
}

/** The same state with one scope selected, which is what mounts its rows. */
function withScope(state: ReplState, scope: string): ReplState {
  return Object.freeze({
    ...state,
    route: Object.freeze({ ...state.route, scopes: Object.freeze([scope]) }),
  });
}

/**
 * Commit one view into the real tree, refusing to assert past a rejected set.
 *
 * Through the product's own pipeline: measured, admitted, reconciled and drawn.
 * What is mounted is therefore what was admitted, which is the only tree a test
 * about focus or dispatch should be asking questions of.
 */
function* applied(
  tree: ReplTree<ReplAction>,
  view: ReplView,
  engine?: ReplRenderer,
): Operation<void> {
  const committed = yield* measuring(view.size, engine, (renderer) =>
    commitReplFrame(tree, renderer, view, 0, undefined),
  );
  if (!committed.ok) {
    throw committed.error;
  }
}

/** The key of whatever holds focus now, as the root reads it. */
function keyed(tree: ReplTree<ReplAction>): string | undefined {
  const node = tree.focused();
  return node === undefined ? undefined : tree.keyOf(node);
}

/** One entry that asks three questions in a row, each from the same schema. */
const THREE_QUESTIONS = [
  "```js eval",
  `const decide = ${JSON.stringify({
    type: "object",
    properties: { decision: { type: "string", enum: ["Approve", "Stop"] } },
    required: ["decision"],
    additionalProperties: false,
  })};`,
  "```",
  "",
  '<Elicit schema={decide} as="before">First question</Elicit>',
  "",
  '<Elicit schema={decide} as="under">Second question</Elicit>',
  "",
  '<Elicit schema={decide} as="after">Third question</Elicit>',
  "",
  "{before.decision} {under.decision} {after.decision}",
].join("\n");

/** One execution with an empty journal of its own. */
function execution(): ReplExecution {
  return { id: "elicit-forms", stream: new InMemoryStream([]) };
}

/** The session, or the refusal that means there is nothing to drive. */
function granted(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** This process's overlay, exactly as the program reads it into a view. */
function liveReading(session: ReplSession): ReplLive {
  return {
    output: session.overlay.output,
    question: session.overlay.question,
    expansion: session.expansion.state,
    pausable: session.controller !== undefined,
    running: session.live,
    agent: session.agent,
    lifecycle: NO_LIFECYCLE,
  };
}

/**
 * Wait until this process is asking a question that is not `previous`.
 *
 * The overlay is read rather than the change stream: a signal delivers to
 * whoever is pulling at that moment, and the first question is published while
 * the session is still being opened — before anything could have subscribed.
 */
function* waiting(
  session: ReplSession,
  what: string,
  previous?: ReplQuestion,
): Operation<ReplQuestion> {
  for (let turn = 0; turn < 500; turn++) {
    const question = session.overlay.question;
    if (question !== undefined && question !== previous) {
      return question;
    }
    yield* sleep(0);
  }
  throw new Error(`this process never asked ${what}`);
}

/**
 * Wait for the nth answer to be journaled.
 *
 * Chained onto the stream's own callback rather than watching the model: records
 * only accumulate, so a count is something a test can wait for exactly, while a
 * reprojection signal can be missed between reads.
 */
function elicitAppends(holder: ReplExecution): (count: number) => Operation<void> {
  const inner = holder.stream.onAppend;
  const slots = new Map<number, ReturnType<typeof withResolvers<void>>>();
  const slot = (count: number): ReturnType<typeof withResolvers<void>> => {
    const existing = slots.get(count);
    if (existing !== undefined) {
      return existing;
    }
    const created = withResolvers<void>();
    slots.set(count, created);
    return created;
  };
  let seen = 0;
  const written: string[] = [];
  holder.stream.onAppend = (event) => {
    inner?.(event);
    written.push(event.type === "yield" ? event.description.type : "close");
    if (event.type === "yield" && event.description.type === "elicit") {
      seen += 1;
      slot(seen).resolve();
    }
  };
  return function* (count: number): Operation<void> {
    if (seen >= count) {
      return;
    }
    yield* race([
      slot(count).operation,
      (function* (): Operation<void> {
        yield* sleep(5000);
        throw new Error(
          `only ${seen} of ${count} answers were journaled; the journal took ${written.join(", ")}`,
        );
      })(),
    ]);
  };
}

/** Every answer the entry has retained, in the order they were recorded. */
function answers(model: ReplModel): readonly ReplElicitation[] {
  const found: ReplElicitation[] = [];
  const walk = (scope: ReplScope): void => {
    found.push(...scope.elicitations);
    for (const child of scope.scopes) {
      walk(child);
    }
  };
  for (const entry of model.entries) {
    walk(entry.scope);
  }
  return found;
}

/** Tab until the control this key names holds focus, the way a person reaches it. */
function* focusTo(tree: ReplTree<ReplAction>, key: string): Operation<void> {
  for (let press = 0; press < 200; press++) {
    if (keyed(tree) === key) {
      return;
    }
    yield* tree.dispatch({ kind: "key", key: "Tab" });
  }
  throw new Error(`focus never reached ${key}`);
}

/** One Tab, and where it left focus. */
function* tabbed(tree: ReplTree<ReplAction>): Operation<string | undefined> {
  yield* tree.dispatch({ kind: "key", key: "Tab" });
  return keyed(tree);
}

describe("F1 — the form's conditional means exactly what Core validates", () => {
  beforeAll(() => useTempFileCompiler());

  /** What this reader did with a schema, as a refusal path or a drawn condition. */
  function* readingOf(schema: Json): Operation<string> {
    try {
      const form = readQuestionForm(schema);
      return `drew a condition on ${form.condition?.field ?? "nothing"}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("F1: a numeric tested type is false where a string equality would be true", function* () {
    const schema: Json = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      additionalProperties: false,
      if: {
        type: "object",
        properties: { a: { type: "number", const: "x" } },
        required: ["a"],
      },
      // `b` is declared here because Core compiles in strict mode, which
      // requires a `required` name to be defined in the same subschema.
      then: { type: "object", required: ["b"], properties: { b: { type: "string" } } },
    };

    // What Core actually does: `a` is the string "x", the tested type is
    // number, so the condition is false, `then` never applies and `b` is not
    // required. The object validates.
    const prepared = yield* prepareElicitation(schema, "Elicit");
    expect(validateParsed(prepared.validate, { a: "x" })).toEqual([]);

    // A form that reduced this to `a === "x"` would demand `b` for an answer
    // Core accepts without it, so the reader refuses rather than disagree.
    expect(yield* readingOf(schema)).toContain("$.if.properties.a.type");
  });

  it("F1: an if with no required also matches the field being absent", function* () {
    const schema: Json = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      additionalProperties: false,
      if: { type: "object", properties: { a: { const: "x" } } },
      then: { type: "object", required: ["b"], properties: { b: { type: "string" } } },
    };

    // What Core actually does: `properties` does not require `a` to exist, so
    // the condition holds for an object with no `a` at all, `then` applies and
    // the missing `b` is reported.
    const prepared = yield* prepareElicitation(schema, "Elicit");
    expect(validateParsed(prepared.validate, {}).length).toBeGreaterThan(0);

    // A form that waited for `a === "x"` before asking for `b` would never ask
    // for a field Core already requires, so the reader refuses.
    expect(yield* readingOf(schema)).toContain("$.if.required");
  });
});

/**
 * The modal ring holds every control the modal places (#870 UI10/UI16).
 *
 * A drawn control Tab cannot reach is a control only a pointer-using person has,
 * and this product's keyboard path is meant to be complete. The ring is recorded
 * from the tree's own answer rather than from the screen, because a focus marker
 * is one frame behind and `>` appears on the screen for other reasons.
 */
/**
 * Every key the open drawer owns, read from the described tree.
 *
 * The modal's subtree and nothing else. A control the footer still places while a
 * drawer is open — the announcement that opens it, for one — is on the screen but
 * is deliberately not in the ring: focus that walked out of an open drawer would
 * let a keystroke reach what the drawer is covering.
 */
function* modalKeys(view: ReplView, engine?: ReplRenderer): Operation<Set<string>> {
  const found = new Set<string>();
  const collect = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    found.add(read.key);
    for (const child of read.children ?? []) {
      collect(child);
    }
  };
  const walk = (description: ReplDescription<ReplAction>): void => {
    const read = readDescription(description);
    if (read.key === "drawer:open") {
      for (const child of read.children ?? []) {
        collect(child);
      }
      return;
    }
    for (const child of read.children ?? []) {
      walk(child);
    }
  };
  for (const description of yield* seenView(view, engine)) {
    walk(description);
  }
  return found;
}

describe("F3 — every placed modal control is in the ring", () => {
  beforeAll(() => useTempFileCompiler());

  it("UI16: Tab walks one whole cycle and Backtab walks it in reverse, inside the modal", function* () {
    // A short question, so the form's own fields and choices are placed in the
    // same frame as the drawer's controls: the ring has to hold both kinds.
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const tree = yield* useReplTree<ReplAction>();
    // A real one-entry history under it, so the row names the entry the question
    // belongs to rather than a readiness with no entry in it.
    const recorded = yield* retained();
    // One window action first. The drawer's top rule and side inset are part of
    // its measured rectangle, so at 72x20 the content window is one row shorter
    // than this form's rows and `[submit]` is in the next one. Advanced through
    // the control a person presses, against the admission the frame measured,
    // rather than by setting an offset: what the ring must hold is what a frame
    // really placed.
    const atTop = opened(live);
    const state = reduceRepl(
      atTop,
      { kind: "scroll", delta: 1 },
      recorded.model,
      live,
      yield* admissionOf(atTop, live, recorded.model, NARROW),
    ).state;
    const view = reading(state, live, recorded.model, NARROW, undefined);
    yield* applied(tree, view);

    // Every control this frame actually placed and can be pointed at. What a
    // pointer can reach is the set a keystroke has to be able to reach too.
    const placed = yield* placedKeys(tree, view);
    const inside = yield* modalKeys(view);
    const targetable = [...placed.entries()]
      .filter(([key, can]) => can && inside.has(key))
      .map(([key]) => key);
    expect(targetable.length).toBeGreaterThan(4);

    // One complete cycle: Tab until focus returns where it started.
    const forward: string[] = [];
    const first = keyed(tree);
    expect(first).toBeDefined();
    forward.push(first ?? "");
    for (let press = 0; press < 200; press++) {
      const at = yield* tabbed(tree);
      if (at === first) {
        break;
      }
      expect(at).toBeDefined();
      forward.push(at ?? "");
    }

    // Nothing the modal placed is missing from it.
    for (const key of targetable) {
      expect([key, forward.includes(key)]).toEqual([key, true]);
    }
    // Named, so a regression that drops one of these says which.
    for (const key of ["drawer:close", "footer:history", "footer:exit", "drawer:form:submit"]) {
      expect([key, forward.includes(key)]).toEqual([key, true]);
    }
    // And nothing outside the modal is in it: a ring that walked out of an open
    // drawer would let a keystroke reach the screen the drawer is covering.
    for (const key of forward) {
      expect([key, inside.has(key), placed.get(key)]).toEqual([key, true, true]);
    }

    // The reverse cycle visits the same ring the other way round.
    const backward: string[] = [];
    for (let press = 0; press < 200; press++) {
      yield* tree.dispatch({ kind: "key", key: "Backtab" });
      const at = keyed(tree);
      if (at === first) {
        break;
      }
      backward.push(at ?? "");
    }
    expect([...backward].reverse()).toEqual(forward.slice(1));

    // And what the row says while each of those nodes really holds focus. The
    // drawer reparents the footer's two controls into itself, so asking the
    // drawer what Enter does would tell somebody standing on `[exit]` that Enter
    // answers a question — and the next thing they do is press it.
    const promised: readonly { readonly key: string; readonly action: string }[] = [
      { key: "drawer:close", action: "Enter closes" },
      { key: "footer:exit", action: "Enter exits" },
      { key: "footer:history", action: "Enter opens" },
      { key: "drawer:form:submit", action: "Enter answers" },
      { key: "drawer:scroll:down", action: "Enter scrolls" },
      { key: "drawer:choice:decision:Approve", action: "Enter chooses" },
    ];
    for (const { key, action } of promised) {
      yield* focusTo(tree, key);
      expect(keyed(tree)).toBe(key);
      const row = rowsOf(yield* seenView(reading(state, live, recorded.model, NARROW, key))).find(
        (one) => one.key === "guidance",
      );
      // This reading's one recorded entry has settled, so the row names the
      // readiness rather than the question. The `Entry 1 question` spelling is
      // asserted where an entry is really waiting, in the rendered journey.
      expect([key, row?.label]).toEqual([
        key,
        `Ready for Entry 2 · ${action} · Esc closes · Tab/Shift+Tab move`,
      ]);
      expect([key, (row?.label ?? "").length <= NARROW.columns]).toEqual([key, true]);
    }
  });
});

/**
 * Form validation and lifecycle readiness are two channels (#870 UI17).
 *
 * A schema rejecting an answer and the execution refusing a submission are
 * different refusals of different things, and they are shown in different places:
 * what the schema said goes under the field it is about, and what the readiness
 * said goes in the one row that says what the execution is doing. A screen that
 * put either in the other's place would answer a question nobody asked.
 */
describe("F2 — an invalid answer is not a lifecycle refusal", () => {
  beforeAll(() => useTempFileCompiler());

  it("UI17: the field keeps its own explanation, and the state row still says the state", function* () {
    // A short question, so the whole form — the message under its field included
    // — is reachable inside the drawer's window rather than past the end of it.
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const recorded = yield* retained();

    // What the schema said about one field, carried where the reducer carries it.
    const invalid = Object.freeze({
      ...opened(live),
      form: Object.freeze({
        ...opened(live).form,
        messages: Object.freeze([{ field: "decision", message: "decision is required" }]),
      }),
    });
    // One window action, for the row the drawer's top rule and side inset take
    // out of its measured content window at 72x20. The validation row is the
    // last of this form's rows, so it is in the window after the first one.
    const advanced = reduceRepl(
      invalid,
      { kind: "scroll", delta: 1 },
      recorded.model,
      live,
      yield* admissionOf(invalid, live, recorded.model, NARROW),
    ).state;
    const rows = rowsOf(
      yield* seenView(reading(advanced, live, recorded.model, NARROW, undefined)),
    );

    // Under the form, about the field, in its own row.
    const under = rows.find((one) => one.key.startsWith("drawer:invalid:"));
    expect(under?.label).toContain("decision is required");

    // And the state row is untouched by it: it says what the execution is doing,
    // which is not "your answer was rejected".
    const guidance = rows.find((one) => one.key === "guidance")?.label ?? "";
    expect(guidance).not.toContain("decision is required");
    expect(guidance).not.toContain("required");
    // Still the drawer's own sentence, with the way out and the keys.
    expect(guidance).toContain("Esc closes");
    expect(guidance.length).toBeLessThanOrEqual(NARROW.columns);

    // The two live in different places, so neither can be mistaken for the other.
    expect(invalid.refusal).toBe(undefined);
    expect(invalid.form.messages.length).toBe(1);
  });
});

describe("F3 — the drawers that show a retained reading (#875 R1)", () => {
  /** A value long enough that no drawer can show all of it at once. */
  const LONG_VALUE = Object.freeze(
    Array.from({ length: 60 }, (_unused, at) => `line-${String(at).padStart(2, "0")}`),
  );

  function scopeWith(key: string, bindings: readonly { name: string; value: Json }[]): ReplScope {
    return Object.freeze({
      key,
      kind: "entry",
      name: key,
      path: "entry.md",
      source: "",
      position: undefined,
      marker: `yield:${key}:1`,
      bindings: Object.freeze([...bindings]),
      elicitations: Object.freeze([]),
      generated: Object.freeze([]),
      scopes: Object.freeze([]),
    });
  }

  /**
   * Two entries, each holding a binding called `plan`, with different values.
   *
   * The shape that proves offsets are kept per *reading* rather than per drawer:
   * the same name in two scopes is two readings, and one is not the other.
   */
  function twoScopes(): ReplModel {
    const entries = [1, 2].map((order) =>
      Object.freeze({
        key: `entry-${order}`,
        order,
        source: "hello",
        path: "entry.md",
        scope: scopeWith(`entry-${order}`, [
          { name: "plan", value: LONG_VALUE.map((line) => `${line}-entry-${order}`) },
        ]),
        transcript: Object.freeze([]),
        checkpoints: Object.freeze([]),
        terminal: undefined,
        settled: true,
        bindings: Object.freeze([]),
        turns: Object.freeze([]),
      }),
    );
    return Object.freeze({
      selection: undefined,
      head: true,
      entries: Object.freeze(entries),
      settled: true,
      terminal: undefined,
      checkpoints: Object.freeze([]),
      transcript: Object.freeze([]),
      turns: Object.freeze([]),
      sessions: Object.freeze([]),
    });
  }

  /** One state reading the named binding inside the named entry's scope. */
  function openBinding(scope: string, name: string, offsets: Record<string, number> = {}) {
    const base = initialState("drawers");
    return Object.freeze({
      ...base,
      route: Object.freeze({
        ...base.route,
        scopes: Object.freeze([scope]),
        drawers: Object.freeze([{ kind: "binding" as const, name }]),
      }),
      viewports: Object.freeze({ ...base.viewports, readings: Object.freeze(offsets) }),
    });
  }

  /** The drawer's content rows this view describes, by key. */
  function* drawerRows(
    state: ReplState,
    model: ReplModel,
    size = NARROW,
    engine?: ReplRenderer,
  ): Operation<string[]> {
    const view = reading(state, asking(undefined), model, size);
    return (yield* seenView(view, engine))
      .flatMap((description) => flattenKeys(description))
      .filter((key) => key.startsWith("drawer:value:"));
  }

  /** Every key one description tree holds, outermost first. */
  function flattenKeys(description: ReplDescription<ReplAction>): string[] {
    const read = readDescription(description);
    return [read.key, ...read.children.flatMap((child) => flattenKeys(child))];
  }

  it("TL3: a binding's value is windowed, and a hidden row is in nothing", function* () {
    const engine = yield* useReplRenderer(NARROW);
    const model = twoScopes();
    const state = openBinding("entry-1", "plan");

    const first = yield* drawerRows(state, model, NARROW, engine);
    expect(first.length).toBeGreaterThan(0);
    // Windowed: this value has sixty lines and no supported drawer is that tall.
    expect(first.length).toBeLessThan(LONG_VALUE.length);

    // The last content row is absent — not clipped. It has no node, so it is
    // in no cell, no target and no focus cycle.
    const tree = yield* useReplTree<ReplAction>();
    const view = reading(state, asking(undefined), model, NARROW);
    yield* applied(tree, view, engine);
    const mounted = tree.mounted().map((node) => tree.keyOf(node));
    const hidden = `drawer:value:${LONG_VALUE.length - 1}`;
    expect(first).not.toContain(hidden);
    expect(mounted).not.toContain(hidden);

    // Reached by scrolling, the way a person reaches it: one press at a time
    // from the clamp the frame is showing.
    let offsets: Record<string, number> = {};
    let reached = false;
    for (let press = 0; press < 200; press += 1) {
      const at = openBinding("entry-1", "plan", offsets);
      const rows = yield* drawerRows(at, model, NARROW, engine);
      if (rows.includes(hidden)) {
        reached = true;
        break;
      }
      const window = (yield* admissionOf(at, asking(undefined), model, NARROW, engine)).windows.get(
        DRAWER_WINDOW,
      );
      if (window === undefined || !window.more) {
        break;
      }
      const key = readingKeyOf(at, { kind: "binding", name: "plan" });
      if (key === undefined) {
        break;
      }
      offsets = { ...offsets, [key]: window.from + 1 };
    }
    expect(reached).toBe(true);
  });

  it("TL3: two bindings with one name in two scopes keep separate offsets", function* () {
    const engine = yield* useReplRenderer(NARROW);
    const model = twoScopes();
    const firstKey = readingKeyOf(openBinding("entry-1", "plan"), {
      kind: "binding",
      name: "plan",
    });
    const secondKey = readingKeyOf(openBinding("entry-2", "plan"), {
      kind: "binding",
      name: "plan",
    });
    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    // The same name, two scopes, two readings.
    expect(firstKey).not.toBe(secondKey);

    // One reading scrolled well down; the other has never been opened.
    const offsets = { [firstKey ?? ""]: 20 };
    const scrolled = yield* drawerRows(
      openBinding("entry-1", "plan", offsets),
      model,
      NARROW,
      engine,
    );
    const fresh = yield* drawerRows(openBinding("entry-2", "plan", offsets), model, NARROW, engine);

    // The scrolled one is showing row twenty; the fresh one starts at its own
    // first row, because the offset it was handed is not its.
    expect(scrolled[0]).toBe("drawer:value:20");
    expect(fresh[0]).toBe("drawer:value:0");

    // And revisiting the first finds its own position again.
    const revisited = yield* drawerRows(
      openBinding("entry-1", "plan", offsets),
      model,
      NARROW,
      engine,
    );
    expect(revisited[0]).toBe("drawer:value:20");
  });

  it("TL3: a stored offset past the end is clamped to what the frame shows", function* () {
    const engine = yield* useReplRenderer(NARROW);
    const model = twoScopes();
    const key = readingKeyOf(openBinding("entry-1", "plan"), { kind: "binding", name: "plan" });
    const far = openBinding("entry-1", "plan", { [key ?? ""]: 10_000 });

    const window = (yield* admissionOf(far, asking(undefined), model, NARROW, engine)).windows.get(
      DRAWER_WINDOW,
    );
    expect(window).toBeDefined();
    if (window === undefined) {
      return;
    }
    // Clamped, and the clamp is the last window this reading has.
    expect(window.from).toBe(window.total - window.capacity);
    expect(window.more).toBe(false);
    const rows = yield* drawerRows(far, model, NARROW, engine);
    expect(rows).toContain(`drawer:value:${LONG_VALUE.length - 1}`);
  });

  it("TL3: scrolling a retained reading changes that offset and nothing else", function* () {
    const engine = yield* useReplRenderer(NARROW);
    const model = twoScopes();
    const before = openBinding("entry-1", "plan");
    const admission = yield* admissionOf(before, asking(undefined), model, NARROW, engine);

    const after = reduceRepl(
      before,
      { kind: "scroll", delta: 1 },
      model,
      asking(undefined),
      admission,
    ).state;

    const key = readingKeyOf(before, { kind: "binding", name: "plan" }) ?? "";
    expect(after.viewports.readings[key]).toBe(1);
    // Nothing else of the reading moved: not the route a location encodes, not
    // the selected History position, not the draft, not an answer.
    expect(after.route).toEqual(before.route);
    expect(after.draft).toBe(before.draft);
    expect(after.form).toEqual(before.form);
    expect(after.route.at).toBe(before.route.at);
    expect(after.viewports.sessions).toBe(before.viewports.sessions);
    expect(after.viewports.entries).toBe(before.viewports.entries);
    expect(after.viewports.permission).toBe(before.viewports.permission);
    // And the other reading's offset is untouched.
    const other =
      readingKeyOf(openBinding("entry-2", "plan"), {
        kind: "binding",
        name: "plan",
      }) ?? "";
    expect(after.viewports.readings[other]).toBeUndefined();
  });
});

describe("F3 — the History drawer is a window over every position (#875 R1)", () => {
  /** More positions than any supported drawer can show at once. */
  const POSITIONS = Object.freeze(
    Array.from({ length: 60 }, (_unused, at) => ({
      marker: `yield:__root__:${at}`,
      kind: "scope" as const,
      label: `position ${String(at).padStart(2, "0")}`,
    })),
  );

  function withPositions(): ReplModel {
    return Object.freeze({ ...EMPTY_MODEL, checkpoints: POSITIONS });
  }

  function openHistory(offsets: Record<string, number> = {}) {
    const base = initialState("history");
    return Object.freeze({
      ...base,
      route: Object.freeze({
        ...base.route,
        drawers: Object.freeze([{ kind: "history" as const }]),
      }),
      viewports: Object.freeze({ ...base.viewports, readings: Object.freeze(offsets) }),
    });
  }

  function* markerKeys(
    state: ReplState,
    model: ReplModel,
    engine?: ReplRenderer,
  ): Operation<string[]> {
    const view = reading(state, asking(undefined), model, NARROW);
    const walk = (description: ReplDescription<ReplAction>): string[] => {
      const read = readDescription(description);
      return [read.key, ...read.children.flatMap((child) => walk(child))];
    };
    return (yield* seenView(view, engine))
      .flatMap((description) => walk(description))
      .filter((key) => key.startsWith("drawer:marker:"));
  }

  it("TL3: the final position is absent until the window reaches it", function* () {
    const engine = yield* useReplRenderer(NARROW);
    const model = withPositions();
    const last = `drawer:marker:${POSITIONS[POSITIONS.length - 1].marker}`;

    const first = yield* markerKeys(openHistory(), model, engine);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(POSITIONS.length);
    expect(first).not.toContain(last);

    // Not mounted either, so it is in no cell, no target and no focus cycle.
    const tree = yield* useReplTree<ReplAction>();
    yield* applied(tree, reading(openHistory(), asking(undefined), model, NARROW), engine);
    expect(tree.mounted().map((node) => tree.keyOf(node))).not.toContain(last);

    // Reached through the drawer's own control, one press at a time.
    const key = readingKeyOf(openHistory(), { kind: "history" }) ?? "";
    let offsets: Record<string, number> = {};
    let reached = false;
    for (let press = 0; press < 200; press += 1) {
      const at = openHistory(offsets);
      if ((yield* markerKeys(at, model, engine)).includes(last)) {
        reached = true;
        break;
      }
      const window = (yield* admissionOf(at, asking(undefined), model, NARROW, engine)).windows.get(
        DRAWER_WINDOW,
      );
      if (window === undefined || !window.more) {
        break;
      }
      offsets = { ...offsets, [key]: window.from + 1 };
    }
    expect(reached).toBe(true);

    // And once it is there, it is a real control: mounted, and reachable.
    const atEnd = openHistory({ [key]: POSITIONS.length });
    const settledTree = yield* useReplTree<ReplAction>();
    yield* applied(settledTree, reading(atEnd, asking(undefined), model, NARROW), engine);
    expect(settledTree.mounted().map((node) => settledTree.keyOf(node))).toContain(last);
  });

  it("TL3: scrolling History selects no position", function* () {
    const engine = yield* useReplRenderer(NARROW);
    const model = withPositions();
    const before = openHistory();
    const admission = yield* admissionOf(before, asking(undefined), model, NARROW, engine);

    const after = reduceRepl(
      before,
      { kind: "scroll", delta: 1 },
      model,
      asking(undefined),
      admission,
    ).state;

    // The window moved. The selected position did not, and neither did the
    // route a location encodes — selecting a position is `select-marker`, and
    // a scroll is not that.
    const key = readingKeyOf(before, { kind: "history" }) ?? "";
    expect(after.viewports.readings[key]).toBe(1);
    expect(after.route.at).toBeUndefined();
    expect(after.route.at).toBe(before.route.at);
    expect(after.route.inspect).toBe(before.route.inspect);
    expect(after.route).toEqual(before.route);
    expect(after.draft).toBe(before.draft);

    // Selecting one, by contrast, is exactly what moves it.
    const chosen = reduceRepl(
      after,
      { kind: "select-marker", marker: POSITIONS[1].marker },
      model,
      asking(undefined),
      admission,
    ).state;
    expect(chosen.route.at).toBe(POSITIONS[1].marker);
    expect(chosen.route.inspect).toBe(true);
  });
});

describe("F3 — a narrow frame offers no inspection control (#875 R1)", () => {
  beforeAll(() => useTempFileCompiler());

  /** Every inspection control among these keys, sorted, so a diff names them. */
  const inspecting = (keys: Iterable<string | undefined>): string[] =>
    [...keys]
      .filter(
        (key): key is string =>
          key !== undefined && (key.startsWith("binding:") || key.startsWith("elicit:")),
      )
      .sort();

  /** One whole focus cycle, in the direction this key walks it. */
  function* ring(tree: ReplTree<ReplAction>, key: "Tab" | "Backtab"): Operation<string[]> {
    const first = keyed(tree);
    const walked: string[] = [first ?? ""];
    for (let press = 0; press < 200; press += 1) {
      yield* tree.dispatch({ kind: "key", key });
      const at = keyed(tree);
      if (at === first) {
        return walked;
      }
      walked.push(at ?? "");
    }
    throw new Error(`focus never came back round with ${key}`);
  }

  it("TL11: a recorded binding and answer are in a wide frame and in no part of a narrow one", function* () {
    const recorded = yield* retained();
    const live = asking(undefined);
    const state = withScope(initialState("frames"), recorded.scope);

    // Wide, where there is an inspection region: both rows are placed, drawn and
    // targetable. Without this the absence below would be absence of nothing.
    const wideTree = yield* useReplTree<ReplAction>();
    const wideView = reading(state, live, recorded.model, WIDE);
    const widePlaced = yield* placedKeys(wideTree, wideView);
    expect(inspecting(widePlaced.keys()).length).toBeGreaterThan(0);
    expect(widePlaced.get(`elicit:${recorded.marker}`)).toBe(true);
    expect(inspecting(widePlaced.keys()).some((key) => key.startsWith("binding:"))).toBe(true);

    // Narrow, where there is not.
    const tree = yield* useReplTree<ReplAction>();
    const view = reading(state, live, recorded.model, NARROW);
    const placed = yield* placedKeys(tree, view);
    const described = rowsOf(presentationFor(view, yield* contextOf(view)).descriptions);
    const forward = yield* ring(tree, "Tab");
    const back = yield* ring(tree, "Backtab");
    // Pre-assert: there is a ring for these controls to be absent from.
    expect(forward.length).toBeGreaterThan(2);
    expect(back.length).toBe(forward.length);
    // One answer asked six ways, together so a regression names every way it came
    // back: absent from the description, which is where it has to be absent first
    // because a row offered and then left out of the frame is a node that mounts
    // anyway; absent from the tree; absent from the frame, so in no drawn cell;
    // in no pointer target; and absent from the whole focus ring both ways round.
    expect({
      described: inspecting(described.map((one) => one.key)),
      mounted: inspecting(tree.mounted().map((node) => tree.keyOf(node))),
      placed: inspecting(placed.keys()),
      targets: inspecting([...placed.entries()].filter(([, can]) => can).map(([key]) => key)),
      forward: inspecting(forward),
      back: inspecting(back),
    }).toEqual({
      described: [],
      mounted: [],
      placed: [],
      targets: [],
      forward: [],
      back: [],
    });

    // What a narrow frame keeps is what the reader chose: the scope is still
    // selected and the route is the route they are on.
    expect(view.state.route.scopes).toEqual([recorded.scope]);
    expect(view.selection.scope?.key).toBe(recorded.scope);
    // And the recorded answer is still in the model, whatever this size offers.
    expect(answers(recorded.model).some((one) => one.marker === recorded.marker)).toBe(true);
  });

  it("TL11: dismissing a recorded answer at a narrow size lands focus on a drawn control", function* () {
    const recorded = yield* retained();
    const live = asking(undefined);
    // The drawer a wider window opened, still open after the window narrowed.
    const open = Object.freeze({
      ...withScope(initialState("frames"), recorded.scope),
      route: Object.freeze({
        ...withScope(initialState("frames"), recorded.scope).route,
        drawers: Object.freeze([
          Object.freeze({ kind: "recorded-elicit" as const, marker: recorded.marker }),
        ]),
      }),
    });
    const tree = yield* useReplTree<ReplAction>();
    const view = reading(open, live, recorded.model, NARROW);
    yield* applied(tree, view);
    expect(keyed(tree)?.startsWith("drawer:")).toBe(true);

    // Dismissed. The row this drawer came from is not one a narrow frame offers,
    // so focus settles on a control this frame drew rather than on a node behind
    // nothing.
    const closed = reduceRepl(
      open,
      { kind: "close-drawer" },
      recorded.model,
      live,
      yield* admissionOf(open, live, recorded.model),
    ).state;
    expect(closed.route.drawers).toEqual([]);
    const after = reading(closed, live, recorded.model, NARROW, keyed(tree));
    const placed = yield* placedKeys(tree, after);
    const landed = keyed(tree);
    expect(landed).toBeDefined();
    expect(inspecting([landed])).toEqual([]);
    // Drawn, and reachable by a pointer: whatever focus found is a row this frame
    // actually placed.
    expect(placed.get(landed ?? "")).toBe(true);
  });
});

describe("F3 — one committed frame, in the one order this product allows", () => {
  /**
   * A renderer whose measurement can be held open.
   *
   * The seam TL9 needs, and nothing production has: `measure` suspends, so a
   * test can look at the tree *while* the frame is still being measured and
   * nothing has been admitted yet.
   */
  function holding(renderer: ReplRenderer): {
    readonly renderer: ReplRenderer;
    release(): void;
    asked(): number;
  } {
    let waiters: (() => void)[] = [];
    let asked = 0;
    let open = true;
    return {
      renderer: {
        *measure(ops, size) {
          asked += 1;
          if (open) {
            const waiter = withResolvers<void>();
            waiters.push(() => waiter.resolve());
            yield* waiter.operation;
          }
          return yield* renderer.measure(ops, size);
        },
        draw: (request) => renderer.draw(request),
        resize: (size) => renderer.resize(size),
        last: () => renderer.last(),
        engines: () => renderer.engines(),
      },
      release() {
        open = false;
        const releasing = waiters;
        waiters = [];
        for (const one of releasing) {
          one();
        }
      },
      asked: () => asked,
    };
  }

  it("TL9: a held measurement changes no tree, no focus and no committed frame", function* () {
    const renderer = yield* useReplRenderer(NARROW);
    const tree = yield* useReplTree<ReplAction>();
    const held = holding(renderer);
    const view = reading(initialState("frames"), asking(undefined), EMPTY_MODEL, NARROW);

    const revision = tree.frame().id;
    expect(tree.mounted()).toEqual([]);

    const running = yield* spawn(() => commitReplFrame(tree, held.renderer, view, 0, undefined));
    yield* sleep(0);
    yield* sleep(0);
    yield* sleep(0);

    // The measurement is outstanding, and this is the whole of what has
    // happened: nothing is mounted, the revision has not moved, nothing holds
    // focus, and the renderer has committed no frame to acknowledge.
    expect(held.asked()).toBeGreaterThan(0);
    expect(tree.mounted()).toEqual([]);
    expect(tree.frame().id).toBe(revision);
    expect(tree.focused()).toBeUndefined();
    expect(renderer.last()).toBeUndefined();

    held.release();
    const committed = yield* running;
    if (!committed.ok) {
      throw committed.error;
    }
    // And only now is any of it true.
    expect(tree.mounted().length).toBeGreaterThan(0);
    expect(tree.frame().id).not.toBe(revision);
    expect(renderer.last()).toBeDefined();
    expect(committed.value.rendered.map.targets.length).toBeGreaterThan(0);
  });

  it("TL9: a resize under a held measurement abandons the frame before reconciliation", function* () {
    const renderer = yield* useReplRenderer(NARROW);
    const tree = yield* useReplTree<ReplAction>();
    const held = holding(renderer);
    const view = reading(initialState("frames"), asking(undefined), EMPTY_MODEL, NARROW);

    const revision = tree.frame().id;
    /** What the terminal reports when the frame asks again, which it does last. */
    let reported: ReplTerminalSize = NARROW;
    const running = yield* spawn(() =>
      commitReplFrame(tree, held.renderer, view, 0, undefined, function* () {
        return reported;
      }),
    );
    yield* sleep(0);
    yield* sleep(0);
    yield* sleep(0);
    expect(held.asked()).toBeGreaterThan(0);

    // The window is dragged while the measurement is outstanding. Every capacity
    // this frame is about to read describes a terminal that is no longer there.
    reported = WIDE;
    held.release();
    const committed = yield* running;

    expect(committed.ok).toBe(false);
    if (!committed.ok) {
      expect(isStaleFrame(committed.error)).toBe(true);
      expect(committed.error.message).toContain("72x20");
      expect(committed.error.message).toContain("160x36");
    }
    // And stale preparation reached nothing: no node is mounted, the revision has
    // not moved, nothing holds focus, and no frame was drawn — so no target names
    // a row that this terminal no longer has.
    expect(tree.mounted()).toEqual([]);
    expect(tree.frame().id).toBe(revision);
    expect(tree.focused()).toBeUndefined();
    expect(renderer.last()).toBeUndefined();
  });

  it("TL9: a measurement that fails commits nothing at all", function* () {
    const renderer = yield* useReplRenderer(NARROW);
    const tree = yield* useReplTree<ReplAction>();
    const view = reading(initialState("frames"), asking(undefined), EMPTY_MODEL, NARROW);

    const refusing: ReplRenderer = {
      // deno-lint-ignore require-yield
      *measure(): Operation<Result<ReplMeasured>> {
        return Err(new ReplRenderError("this measurement cannot be taken"));
      },
      draw: (request) => renderer.draw(request),
      resize: (size) => renderer.resize(size),
      last: () => renderer.last(),
      engines: () => renderer.engines(),
    };

    const outcome = yield* commitReplFrame(tree, refusing, view, 0, undefined);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("cannot be taken");
    }
    // Nothing mounted and no frame committed: a failure before admission
    // leaves no half-interactive screen behind.
    expect(tree.mounted()).toEqual([]);
    expect(renderer.last()).toBeUndefined();
  });
});
