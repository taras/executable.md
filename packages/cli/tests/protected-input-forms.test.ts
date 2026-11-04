import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { spawn } from "effection";
import { when } from "@effectionx/converge";
import { Elicitation, ElicitationProviderError } from "@executablemd/core";
import { useReplElicitation } from "../src/repl/elicitation.ts";

const schema = {
  type: "object",
  properties: {
    code: { type: "string", minLength: 6, writeOnly: true },
    public: { type: "string" },
  },
  required: ["code", "public"],
  additionalProperties: false,
};

describe("protected local forms", () => {
  it("marks secret presentation and observes a safe submission while resolving the live answer", function* () {
    const questions = yield* useReplElicitation();
    const task = yield* spawn(() =>
      Elicitation.operations.elicit({ schema, message: "Enter code." }),
    );
    yield* when(function* () {
      expect(questions.pending).toBeDefined();
    });
    const question = questions.pending;
    if (question === undefined) {
      throw new Error("No active question.");
    }
    expect(question.form.fields.map((field) => field.secret)).toEqual([true, false]);
    const value = String(Math.floor(100000 + Math.random() * 900000));
    const invalid = question.submit({ code: value.slice(0, 2), public: "useful" });
    expect(invalid.kind).toBe("invalid");
    expect(JSON.stringify(invalid).includes(value.slice(0, 2))).toBe(false);
    const outcome = question.submit({ code: value, public: "useful" });
    expect(
      JSON.stringify(outcome) ===
        JSON.stringify({ kind: "answered", answer: { code: "[redacted]", public: "useful" } }),
    ).toBe(true);
    expect(JSON.stringify(yield* task).includes(value)).toBe(true);
    yield* when(function* () {
      expect(questions.pending).toBeUndefined();
    });
  });

  it("refuses the correlated live question once without making an answer", function* () {
    const questions = yield* useReplElicitation();
    let refused = false;
    const task = yield* spawn(function* () {
      try {
        yield* Elicitation.operations.elicit({ schema, message: "Enter code." });
      } catch (error) {
        refused = error instanceof ElicitationProviderError;
      }
    });
    yield* when(function* () {
      expect(questions.pending).toBeDefined();
    });
    const question = questions.pending;
    if (question === undefined || question.refuse === undefined) {
      throw new Error("No question refusal owner.");
    }
    const error = new ElicitationProviderError("Protected input requires a live responder.");
    question.refuse(error);
    question.refuse(error);
    yield* task;
    expect(refused).toBe(true);
    expect(questions.pending).toBeUndefined();
  });
});

import { useSidekickQuestions } from "../src/repl/sidekick/questions.ts";
import { elicit } from "@executablemd/core";
import { scoped } from "effection";

describe("protected provider observations before validation", () => {
  it("projects invalid answers and withholds a projection failure without a raw fallback", function* () {
    for (const invalidPublic of [false, true]) {
      yield* scoped(function* () {
        const asking = yield* useSidekickQuestions();
        let value = "";
        const outcomes: unknown[] = [];
        yield* Elicitation.around(
          {
            *elicit() {
              value = String(Math.floor(100000 + Math.random() * 900000));
              return {
                code: { invalid: value },
                public: invalidPublic ? () => undefined : "useful",
              };
            },
          },
          { at: "min" },
        );
        let failed = false;
        try {
          yield* asking.answering(
            {
              *began() {
                return 0;
              },
              *settled(_order, outcome, observed) {
                outcomes.push({ outcome, observed });
              },
            },
            () => elicit({ schema, message: "Enter input." }),
          );
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
        expect(JSON.stringify(outcomes).includes(value)).toBe(false);
        expect(JSON.stringify(outcomes).includes("[redacted]")).toBe(!invalidPublic);
        expect(JSON.stringify(outcomes).includes("useful")).toBe(!invalidPublic);
      });
    }
  });
});

import { useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { createChildRequests } from "../src/headless/requests.ts";

describe("question cancellation keeps its original owner", () => {
  it("leaves unmarked ACP cancel pending, then Stop withdraws it without an answer", function* () {
    const held = yield* useHarness();
    held.fake.script({
      reply:
        '<Elicit schema={{type:"object",properties:{public:{type:"string"}},required:["public"],additionalProperties:false}} as="answer">Public question.</Elicit>',
    });
    const running = yield* spawn(() => held.owner.message("Ask the public question."));
    yield* when(function* () {
      expect(held.owner.questions.pending).toBeDefined();
    });
    const question = held.owner.questions.pending;
    let serial = 0;
    const requests = createChildRequests(held.owner, held.session, () => `request-${++serial}`);
    const input = requests.list().find((one) => one.kind === "question");
    if (input === undefined) {
      throw new Error("No correlated question.");
    }
    const offered = requests.offer(input.requestId);
    if (offered === null) {
      throw new Error("No active presentation.");
    }
    const result = requests.respond({
      kind: "question",
      requestId: input.requestId,
      presentationId: offered.presentationId,
      value: { action: "cancel" },
    });
    expect(result.event === "response" && result.outcome === "not-submitted").toBe(true);
    expect(held.owner.questions.pending).toBe(question);
    expect(question?.active).toBe(true);
    yield* held.owner.stop();
    yield* running;
    expect(held.owner.questions.pending).toBeUndefined();
    expect(question?.active).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);
  });

  it("halts a pending marked provider and refuses its stale submission", function* () {
    const questions = yield* useReplElicitation();
    const task = yield* spawn(() =>
      Elicitation.operations.elicit({ schema, message: "Protected question." }),
    );
    yield* when(function* () {
      expect(questions.pending).toBeDefined();
    });
    const question = questions.pending;
    yield* task.halt();
    expect(questions.pending).toBeUndefined();
    expect(question?.active).toBe(false);
    expect(question?.submit({ code: "stale", public: "useful" }).kind).toBe("invalid");
  });
});
