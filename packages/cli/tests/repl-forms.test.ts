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
import { race, sleep, spawn, withResolvers } from "effection";
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
  reduceRepl,
  viewFor,
} from "../src/repl/application.ts";
import type {
  ReplAction,
  ReplLive,
  ReplState,
  ReplTransition,
  ReplView,
} from "../src/repl/application.ts";
import { layout, NARROW } from "../src/repl/layout.ts";
import { fields, readDescription } from "../src/repl/description.ts";
import type { ReplDescription } from "../src/repl/description.ts";
import { ENTRY_SCOPE, projectRepl } from "../src/repl/model.ts";
import type { ReplElicitation, ReplModel, ReplScope } from "../src/repl/model.ts";
import { useReplTree } from "../src/repl/reconcile.ts";
import { replSurface } from "../src/repl/application.ts";
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

/** Confirmation: one required enum. */
const CONFIRM_SCHEMA: Json = {
  type: "object",
  properties: { decision: { type: "string", enum: ["Approve", "Decline"] } },
  required: ["decision"],
  additionalProperties: false,
};

const EMPTY_MODEL: ReplModel = Object.freeze({
  head: true,
  entry: undefined,
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
  return { output: "", question, expansion: "playing", pausable: false };
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

function drive(
  state: ReplState,
  live: ReplLive,
  actions: readonly ReplAction[],
): { state: ReplState; transitions: ReplTransition[] } {
  let current = state;
  const transitions: ReplTransition[] = [];
  for (const action of actions) {
    const transition = reduceRepl(current, action, EMPTY_MODEL, live, NARROW);
    transitions.push(transition);
    current = transition.state;
  }
  return { state: current, transitions };
}

describe("F2 — invalid stays open; valid is exact", () => {
  it("F2: choosing Request changes with no feedback keeps the question and says why", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA);
    const live = asking(asked.question);
    const { state, transitions } = drive(opened(live), live, [
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
    const { state } = drive(opened(live), live, [
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
    const { state } = drive(opened(live), live, [
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
    const { state } = drive(opened(live), live, [{ kind: "type", text: "xmd", field: "project" }]);
    expect(asked.question.submit(state.form.values).kind).toBe("invalid");
    yield* sleep(0);
    expect(asked.answer()).toBe(undefined);
  });

  it("F2: confirmation returns exactly its offered decision", function* () {
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const { state } = drive(opened(live), live, [
      { kind: "choose", field: "decision", option: "Decline" },
    ]);
    expect(asked.question.submit(state.form.values).kind).toBe("answered");
    yield* sleep(0);
    expect(asked.answer()).toEqual({ decision: "Decline" });
  });

  it("F2: an option the field does not offer puts nothing into the form", function* () {
    const asked = yield* askingFor(CONFIRM_SCHEMA);
    const live = asking(asked.question);
    const { state, transitions } = drive(opened(live), live, [
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
    const { state } = drive(opened(live), live, [
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
    const { state, transitions } = drive(opened(live), live, [
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
    const reopened = drive(state, live, [{ kind: "open-drawer", drawer: { kind: "live-elicit" } }]);
    expect(reopened.state.form.values).toEqual({});
  });

  it("F2: an astral scalar survives typing, and one erase removes one scalar", function* () {
    const asked = yield* askingFor(DETAILS_SCHEMA);
    const live = asking(asked.question);
    const typed = drive(opened(live), live, [{ kind: "type", text: "é漢🙂", field: "project" }]);
    expect(typed.state.form.values["project"]).toBe("é漢🙂");
    // One Unicode scalar, not one UTF-16 code unit: erasing the emoji leaves
    // the two characters before it whole rather than half a surrogate pair.
    const erased = drive(typed.state, live, [{ kind: "erase", field: "project" }]);
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
  const resolved = viewFor(state, model, live, size, focused);
  if (!resolved.ok) {
    throw resolved.error;
  }
  return resolved.value;
}

/** The descriptions this state produces, or the failure that stopped it. */
function seen(state: ReplState, live: ReplLive, size = NARROW, focused?: string) {
  return describeApplication(reading(state, live, EMPTY_MODEL, size, focused));
}

function framed(state: ReplState, live: ReplLive, size = NARROW, focused?: string) {
  return rowsOf(seen(state, live, size, focused));
}

const DRAFT = Array.from({ length: 40 }, (_, line) => `draft line ${line}`).join("\n");

describe("F3 — complete content and reachable navigation", () => {
  /** Every key layout actually placed, with whether it can be pointed at. */
  function* placedKeys(
    tree: ReplTree<ReplAction>,
    view: ReplView,
  ): Operation<Map<string, boolean>> {
    yield* applied(tree, view);
    const frame = layout(NARROW, replSurface(tree, view));
    const keys = new Map<string, boolean>();
    for (const cell of frame.cells) {
      const key = tree.keyOf(cell.node);
      if (key !== undefined) {
        keys.set(key, cell.targetable);
      }
    }
    return keys;
  }

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
      const next = reduceRepl(state, { kind: "scroll", delta: 1 }, EMPTY_MODEL, live, NARROW).state;
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

  it("F3: the viewport walks the whole message before the form controls", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA, DRAFT);
    const live = asking(asked.question);
    const shown = (rows: ReturnType<typeof framed>): string[] =>
      rows.filter((one) => one.key.startsWith("drawer:message:")).map((one) => one.label.trim());

    const first = framed(opened(live), live);
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
      const rows = framed(state, live);
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
      const next = reduceRepl(state, { kind: "scroll", delta: 1 }, EMPTY_MODEL, live, NARROW).state;
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
    state = reduceRepl(state, { kind: "scroll", delta: 1 }, EMPTY_MODEL, live, NARROW).state;
    expect(state.form.offset).toBe(held);
    const back = reduceRepl(state, { kind: "scroll", delta: -1 }, EMPTY_MODEL, live, NARROW).state;
    expect(back.form.offset).toBe(held - 1);

    // And scrolling changed no value and no route.
    expect(back.form.values).toEqual({});
    expect(back.route.drawers.map((one) => one.kind)).toEqual(["live-elicit"]);
  });

  it("F3: the one History control is inside the drawer while it is open", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA);
    const live = asking(asked.question);
    const descriptions = seen(opened(live), live);
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

  it("F3: the footer trigger is one bounded line, and the drawer holds it all", function* () {
    const asked = yield* askingFor(PLAN_SCHEMA, DRAFT);
    const live = asking(asked.question);
    // Closed: the footer offers the question without becoming the transcript.
    const closed = framed(initialState("forms"), live);
    const trigger = closed.find((one) => one.key === "footer:asked");
    expect(trigger).toBeDefined();
    expect(trigger?.label.includes("\n")).toBe(false);
    expect(trigger?.label).toContain("draft line 0");
    expect(trigger?.label).not.toContain("draft line 1");
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
    const transition = reduceRepl(open, dispatched.value.action, session.model, held, NARROW);
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

    view = reading(state, liveReading(session), session.model, NARROW, between);
    expect(focusClaim(view)).toBe(`elicit:${caused.marker}`);
    yield* applied(tree, view);
    const landed = keyed(tree);
    expect(landed).toBe(`elicit:${caused.marker}`);
    expect(landed).not.toBe(`elicit:${before.marker}`);
    expect(landed).not.toBe(`elicit:${newest.marker}`);

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
    const closed = reduceRepl(open, { kind: "close-drawer" }, recorded.model, live, NARROW).state;
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
  const entry = projected.value.entry;
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

/** Commit one view into the real tree, refusing to assert past a rejected set. */
function* applied(tree: ReplTree<ReplAction>, view: ReplView): Operation<void> {
  const result = yield* tree.apply(describeApplication(view));
  if (!result.ok) {
    throw result.error;
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
  if (model.entry !== undefined) {
    walk(model.entry);
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
