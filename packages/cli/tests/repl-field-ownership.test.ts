import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  askingFor,
  initialState,
  NO_AGENT,
  presentedDrawer,
  reduceRepl,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import type { ReplLive, ReplState } from "../src/repl/application.ts";
import { readQuestionForm } from "../src/repl/elicitation.ts";
import type { ReplQuestion } from "../src/repl/elicitation.ts";
import type { ReplInputEvent } from "../src/repl/description.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { journalModel } from "./fixtures/repl/journals.ts";
import { usePresenter } from "./fixtures/repl/presentation.ts";

describe("owned field destination after question withdrawal", () => {
  for (const field of ["message", "draft"]) {
    it(`does not redirect the withdrawn ${field} answer's edits to either composer`, function* () {
      const model = yield* journalModel([]);
      const question = {
        key: "question-before-withdrawal",
        message: "Answer this question",
        form: readQuestionForm({
          type: "object",
          properties: { [field]: { type: "string" } },
          required: [field],
          additionalProperties: false,
        }),
      };
      const sidekick = {
        chat: [],
        busy: true,
        agent: "scribe",
        refusal: undefined,
        question,
        requested: undefined,
        verified: undefined,
        conversation: "owned",
        reading: "owned",
        current: true,
        turns: [],
        availability: { chats: ["owned"], sessions: [], refusal: undefined },
      };
      const live: ReplLive = {
        output: "",
        question: undefined,
        expansion: "playing",
        pausable: false,
        running: false,
        agent: NO_AGENT,
        lifecycle: NO_LIFECYCLE,
        sidekick,
      };
      let state = askingFor(
        {
          ...initialState("owned"),
          draft: "draft-kept",
          message: "message-kept",
          draftCaret: { value: "draft-kept", offset: 2 },
          messageCaret: { value: "message-kept", offset: 3 },
        },
        question,
      );
      state = reduceRepl(
        state,
        { kind: "open-sidekick-question", question: question.key },
        model,
        live,
      ).state;
      if (state.asking === undefined) {
        throw new Error("question is not open");
      }
      state = {
        ...state,
        asking: {
          ...state.asking,
          form: {
            ...state.asking.form,
            values: { [field]: field === "message" ? state.message : state.draft },
          },
        },
      };
      const resolved = viewFor(state, model, live, { columns: 160, rows: 36 });
      if (!resolved.ok) {
        throw resolved.error;
      }
      const view = withWorkspace(resolved.value, workspaceOf(model));
      const presenter = yield* usePresenter(view.size);
      yield* presenter.commit(view);
      const id = presenter.tree.focused();
      expect(id === undefined ? undefined : presenter.tree.keyOf(id)).toBe(`drawer:value:${field}`);
      const events = [
        { kind: "text", text: "!" },
        { kind: "key", key: "Backspace" },
        { kind: "key", key: "ArrowLeft" },
      ] satisfies readonly ReplInputEvent[];
      for (const event of events) {
        const dispatched = yield* presenter.tree.dispatch(event);
        if (!dispatched.ok) {
          throw dispatched.error;
        }
        if (dispatched.value.outcome !== "action") {
          throw new Error("the current answer field did not claim text");
        }
        expect(dispatched.value.action).toMatchObject({
          purpose: "sidekick-answer",
          question: question.key,
          field,
        });
        const valid = reduceRepl(
          state,
          dispatched.value.action,
          model,
          live,
          undefined,
          presentedDrawer(view),
        );
        expect(valid.state.asking).not.toEqual(state.asking);
        expect(valid.state.draft).toBe(state.draft);
        expect(valid.state.message).toBe(state.message);
        expect(valid.state.draftCaret).toEqual(state.draftCaret);
        expect(valid.state.messageCaret).toEqual(state.messageCaret);
        const withdrawn: ReplLive = {
          ...live,
          sidekick: { ...sidekick, question: undefined, busy: false },
        };
        const replaced: ReplLive = {
          ...live,
          sidekick: { ...sidekick, question: { ...question, key: "replacement-question" } },
        };
        for (const [current, latest] of [
          [state, withdrawn],
          [state, replaced],
          [{ ...state, heldHistory: true }, live],
        ] satisfies readonly (readonly [ReplState, ReplLive])[]) {
          const result = reduceRepl(
            current,
            dispatched.value.action,
            model,
            latest,
            undefined,
            presentedDrawer(view),
          );
          expect(result.state.draft).toBe("draft-kept");
          expect(result.state.message).toBe("message-kept");
          expect(result.state.draftCaret).toEqual(state.draftCaret);
          expect(result.state.messageCaret).toEqual(state.messageCaret);
          expect(result.state.asking).toEqual(state.asking);
        }
      }
    });
  }
});

describe("owned entry field destination after question replacement", () => {
  it("refuses old entry edits without changing either composer or the new question", function* () {
    const model = yield* journalModel([]);
    const question: ReplQuestion = {
      message: "Entry question",
      form: readQuestionForm({
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      }),
      submit() {
        throw new Error("editing must not submit");
      },
    };
    const live: ReplLive = {
      output: "",
      question,
      expansion: "playing",
      pausable: false,
      running: false,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    };
    const opened = reduceRepl(
      {
        ...initialState("owned-entry"),
        draft: "draft-kept",
        message: "message-kept",
        draftCaret: { value: "draft-kept", offset: 2 },
        messageCaret: { value: "message-kept", offset: 3 },
      },
      { kind: "open-drawer", drawer: { kind: "live-elicit" } },
      model,
      live,
    ).state;
    const state = { ...opened, form: { ...opened.form, values: { message: "message-kept" } } };
    const resolved = viewFor(state, model, live, { columns: 160, rows: 36 });
    if (!resolved.ok) {
      throw resolved.error;
    }
    const view = withWorkspace(resolved.value, workspaceOf(model));
    const presenter = yield* usePresenter(view.size);
    yield* presenter.commit(view);
    const id = presenter.tree.focused();
    expect(id === undefined ? undefined : presenter.tree.keyOf(id)).toBe("drawer:value:message");
    const events = [
      { kind: "text", text: "!" },
      { kind: "key", key: "Backspace" },
      { kind: "key", key: "ArrowLeft" },
    ] satisfies readonly ReplInputEvent[];
    for (const event of events) {
      const dispatched = yield* presenter.tree.dispatch(event);
      if (!dispatched.ok) {
        throw dispatched.error;
      }
      if (dispatched.value.outcome !== "action") {
        throw new Error("field did not handle edit");
      }
      const valid = reduceRepl(
        state,
        dispatched.value.action,
        model,
        live,
        undefined,
        presentedDrawer(view),
      );
      expect(valid.state.form).not.toEqual(state.form);
      expect(valid.state.message).toBe(state.message);
      expect(valid.state.draft).toBe(state.draft);
      for (const latest of [
        { ...live, question: undefined },
        { ...live, question: { ...question, message: "Replacement question" } },
      ]) {
        const result = reduceRepl(
          state,
          dispatched.value.action,
          model,
          latest,
          undefined,
          presentedDrawer(view),
        );
        expect(result.state.form).toEqual(state.form);
        expect(result.state.draft).toBe(state.draft);
        expect(result.state.message).toBe(state.message);
        expect(result.state.draftCaret).toEqual(state.draftCaret);
        expect(result.state.messageCaret).toEqual(state.messageCaret);
      }
    }
  });
});
