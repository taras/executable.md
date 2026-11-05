import { isJsonObject, parseJson } from "@executablemd/core";
import { AgentConversationProvider, Plugin } from "@executablemd/core/api";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, spawn, withResolvers } from "effection";
import type { Operation, Stream, Subscription } from "effection";
import type { AgentPromptEvent } from "@executablemd/core";
import type { ReplPluginInstallation } from "../api.ts";
import { writeTextFile } from "@effectionx/fs";
import { useHostFiles } from "@executablemd/runtime";
import { installTodoSource } from "../src/node-todo-source.ts";
import { todoPlugin } from "../src/repl/todo/plugin.ts";
import { useTodo } from "../src/repl/todo/service.ts";
import { createSidekickAdmission, useSidekickDispatch } from "../src/repl/sidekick/dispatch.ts";
import type { SidekickDispatch, SidekickExchange } from "../src/repl/sidekick/dispatch.ts";
import { records, useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";

/**
 * One contributed conversation decoration, composed where a retained turn is.
 *
 * A retained turn dispatches its captured provider directly, so a selected
 * Plugin reaches its content through `repl.sidekick()` rather than through
 * ordinary `Agent` routing. `compose` enriches the delegated text; `bracket`
 * holds one resource open around the composed stream, which is what a case
 * about joined cleanup needs.
 */
function composing(
  name: string,
  compose: (text: string) => string,
  bracket?: () => Operation<void>,
): Plugin {
  return Plugin({
    name,
    *install(): Operation<ReplPluginInstallation> {
      return {
        repl: {
          *sidekick(): Operation<void> {
            const retained = yield* AgentConversationProvider.expect();
            if (retained === undefined) {
              throw new Error(`${name} found no conversation provider to compose`);
            }
            yield* AgentConversationProvider.set({
              agent: retained.agent.bind(retained),
              session: retained.session.bind(retained),
              options: retained.options.bind(retained),
              // deno-lint-ignore require-yield
              *prompt(text, options): Operation<Stream<AgentPromptEvent, string>> {
                return resource<Subscription<AgentPromptEvent, string>>(function* (provide) {
                  if (bracket !== undefined) {
                    yield* ensure(bracket);
                  }
                  yield* provide(yield* yield* retained.prompt(compose(text), options));
                });
              },
            });
          },
        },
      };
    },
  });
}

function* setup(extra: readonly Plugin[] = []) {
  yield* useHostFiles();
  yield* installTodoSource();
  const host = yield* useHarness(undefined, { plugins: [todoPlugin, ...extra] });
  const todo = yield* useTodo(host.workspace);
  const dispatch = yield* useSidekickDispatch({
    owner: host.owner,
    admission: createSidekickAdmission(),
    execution: host.execution.id,
    workspace: host.workspace,
    changed() {},
  });
  return { host, todo, dispatch };
}
function* send(dispatch: SidekickDispatch, text: string): Operation<SidekickExchange> {
  const result = yield* dispatch.send(text);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

describe("TODO context on independently admitted prompts", () => {
  it("sends only the selected middle-task edit in ordinary provider input", function* () {
    const { host, todo, dispatch } = yield* setup();
    const source = "- [ ] before-neighbour-Q901\n- [ ] middle-Q901\n- [ ] after-neighbour-Q901\n";
    yield* writeTextFile(host.workspace + "/todo.md", source);
    yield* todo.apply("@@ -2 +2 @@\n-- [ ] middle-Q901\n+- [x] middle-Q901\n");
    expect(todo.pending[0].items).toHaveLength(3);
    expect(todo.pending[0].items[1]).toEqual({ text: "middle-Q901", completed: true });
    host.fake.script({ reply: "<Output>reviewed delta</Output>" });
    const sent = yield* send(dispatch, "review the selected edit");
    expect((yield* sent.completion).ok).toBe(true);
    const input = host.fake.prompts[0];
    expect(input).toContain("+- [x] middle-Q901");
    expect(input).not.toContain('"items":[');
    for (const neighbour of ["before-neighbour-Q901", "after-neighbour-Q901"]) {
      expect(input).not.toContain("-- [ ] " + neighbour);
      expect(input).not.toContain("+- [ ] " + neighbour);
      expect(input.split(neighbour).length - 1).toBeLessThanOrEqual(1);
    }
    expect((yield* todo.read()).items[1].completed).toBe(true);
    expect(todo.pending).toEqual([]);
    expect(todo.recovery).toBe(false);
  });

  it("selects ordered finite deltas at activation and leaves late edits pending without idle drain", function* () {
    const { host, todo, dispatch } = yield* setup();
    host.fake.script({ reply: "<Output>first</Output>", held: true });
    host.fake.script({ reply: "<Output>second</Output>", held: true });
    host.fake.script({ reply: "<Output>third</Output>" });
    const first = yield* send(dispatch, "active");
    yield* host.fake.startedTurns(1);
    const second = yield* send(dispatch, "already queued");
    yield* todo.save("", "- [ ] one\n");
    yield* todo.save("- [ ] one\n", "- [x] two\n");
    expect(dispatch.queue.pending).toHaveLength(1);
    expect((yield* todo.read()).items[0].text).toBe("two");
    host.fake.releaseTurn();
    expect((yield* first.completion).ok).toBe(true);
    yield* host.fake.startedTurns(2);
    const selected = host.fake.prompts[1];
    expect(selected).toContain('"origin":"human"');
    expect(selected.indexOf("+- [ ] one")).toBeLessThan(selected.indexOf("+- [x] two"));
    yield* todo.save("- [x] two\n", "- [ ] late\n");
    host.fake.releaseTurn();
    expect((yield* second.completion).ok).toBe(true);
    expect(todo.pending).toHaveLength(1);
    expect(host.fake.prompts).toHaveLength(2);
    const third = yield* send(dispatch, "explicit next");
    expect((yield* third.completion).ok).toBe(true);
    expect(host.fake.prompts[2]).toContain("+- [ ] late");
    expect(host.fake.prompts[2]).not.toContain("one");
    expect(host.fake.prompts[2]).not.toContain("fresh recovery state");
    expect(todo.pending).toEqual([]);
    const saved = yield* records(host.execution);
    expect(
      saved
        .filter((one) => one.kind === "message")
        .map((one) => (one.kind === "message" ? one.text : "")),
    ).toEqual(["active", "already queued", "explicit next"]);
  });

  it("recovers from fresh file state only on another explicit request and returns to delta input", function* () {
    const { host, todo, dispatch } = yield* setup();
    yield* todo.save("", "- [ ] committed\n");
    host.fake.script({ reply: "incomplete", stopReason: "max_tokens" });
    const failed = yield* send(dispatch, "fail");
    expect((yield* failed.completion).ok).toBe(false);
    expect(todo.recovery).toBe(true);
    expect(todo.pending).toHaveLength(1);
    yield* writeTextFile(`${host.workspace}/todo.md`, "- [x] current outside\n");
    yield* todo.refresh();
    expect(host.fake.prompts).toHaveLength(1);
    expect((yield* dispatch.resume()).ok).toBe(true);
    host.fake.script({ reply: "another incomplete", stopReason: "max_tokens" });
    const failedAgain = yield* send(dispatch, "explicit recovery failure");
    expect((yield* failedAgain.completion).ok).toBe(false);
    expect(host.fake.prompts[1]).toContain("Current TODO checklist (fresh recovery state)");
    expect(host.fake.prompts[1]).toContain('"text":"current outside"');
    yield* writeTextFile(`${host.workspace}/todo.md`, "- [ ] newer outside\n");
    expect((yield* dispatch.resume()).ok).toBe(true);
    host.fake.script({ reply: "<Output>recovered</Output>" });
    const recovered = yield* send(dispatch, "explicit recovery success");
    expect((yield* recovered.completion).ok).toBe(true);
    expect(host.fake.prompts[2]).toContain('"text":"newer outside"');
    expect(host.fake.prompts[2]).not.toContain('"text":"current outside"');
    expect(todo.recovery).toBe(false);
    expect(todo.pending).toEqual([]);
    host.fake.script({ reply: "<Output>ordinary</Output>" });
    const ordinary = yield* send(dispatch, "ordinary next");
    expect((yield* ordinary.completion).ok).toBe(true);
    expect(host.fake.prompts[3]).not.toContain("TODO checklist");
    expect(host.fake.prompts[3]).not.toContain("Committed TODO changes");
  });

  it("keeps edits outside all sixteen queue slots and retains them after Stop", function* () {
    const { host, todo, dispatch } = yield* setup();
    host.fake.script({ reply: "", manual: true });
    const active = yield* send(dispatch, "active");
    yield* host.fake.startedTurns(1);
    for (let index = 0; index < 16; index++) {
      yield* send(dispatch, `waiting ${index}`);
    }
    yield* todo.save("", "- [ ] survives\n");
    expect(dispatch.queue.pending).toHaveLength(16);
    expect(todo.pending).toHaveLength(1);
    dispatch.hold();
    yield* active.cancel();
    expect(todo.recovery).toBe(true);
    expect((yield* todo.read()).items[0].text).toBe("survives");
    expect(host.fake.prompts).toHaveLength(1);
  });
  it("retains both typed control results and delivers their ordinary feedback", function* () {
    const { host, todo, dispatch } = yield* setup();
    yield* todo.save("", "- [ ] shared\n");
    host.fake.script({ reply: '<Sidekick.Todo as="items" />' });
    host.fake.script({
      reply:
        '<Sidekick.Todo as="items">\n```diff\n@@ -1 +1 @@\n-- [ ] shared\n+- [x] shared\n```\n</Sidekick.Todo>',
    });
    host.fake.script({ reply: "<Output>done</Output>" });
    const sent = yield* send(dispatch, "read and complete");
    expect((yield* sent.completion).ok).toBe(true);
    expect(host.fake.prompts).toHaveLength(3);
    expect(host.fake.prompts[1]).toContain('"completed": false');
    expect(host.fake.prompts[2]).toContain('"completed": true');
    const saved = yield* records(host.execution);
    expect(
      saved.filter((one) => one.kind === "control" && one.component === "Sidekick.Todo"),
    ).toHaveLength(2);
    const intents = saved.filter((one) => one.kind === "feedback" && one.turn === null);
    const acknowledgements = saved.filter((one) => one.kind === "feedback" && one.turn !== null);
    expect(intents).toHaveLength(2);
    expect(acknowledgements).toHaveLength(2);
    for (let index = 0; index < intents.length; index++) {
      const intent = intents[index];
      const acknowledgement = acknowledgements[index];
      expect(intent.kind === "feedback" && acknowledgement.kind === "feedback" && intent.text).toBe(
        acknowledgement.kind === "feedback" && acknowledgement.text,
      );
    }
  });

  it("retires observations only after composed cleanup joins and keeps recovery after cleanup failure", function* () {
    for (const fails of [false, true]) {
      const entered = withResolvers<void>();
      const release = withResolvers<void>();
      let state = () => ({ pending: 0, recovery: false });
      let failure: unknown;
      let successful: boolean | undefined;
      try {
        yield* scoped(function* () {
          const { host, todo, dispatch } = yield* setup([
            composing(
              "owned-cleanup",
              (text) => text,
              function* () {
                entered.resolve();
                yield* release.operation;
                if (fails) {
                  throw new Error("composed cleanup failed");
                }
              },
            ),
          ]);
          state = () => ({ pending: todo.pending.length, recovery: todo.recovery });
          yield* todo.save("", "- [ ] retained through cleanup\n");
          host.fake.script({ reply: "<Output>canonical source</Output>" });
          const asking = yield* spawn(function* () {
            return yield* (yield* send(dispatch, "request")).completion;
          });
          yield* entered.operation;
          expect(todo.pending).toHaveLength(1);
          release.resolve();
          const result = yield* asking;
          successful = result.ok;
          if (!fails) {
            expect(result.ok).toBe(true);
            expect(todo.pending).toEqual([]);
          }
        });
      } catch (error) {
        failure = error;
      }
      if (fails) {
        expect(successful).toBe(false);
        expect(failure).toBeUndefined();
        expect(state()).toEqual({ pending: 1, recovery: true });
      } else {
        expect(failure).toBeUndefined();
      }
    }
  });

  it("uses selected Plugin prompt middleware and retains identical final canonical and feedback input", function* () {
    const { host, todo, dispatch } = yield* setup([
      composing("todo-context-example", (text) => text + "\nSelected Plugin context."),
    ]);
    yield* todo.save("", "- [ ] shared\n");
    host.fake.script({ reply: '<Sidekick.Todo as="items" />' });
    host.fake.script({ reply: "<Output>done</Output>" });
    const sent = yield* send(dispatch, "original person source");
    expect((yield* sent.completion).ok).toBe(true);
    expect(host.fake.prompts).toHaveLength(2);
    expect(host.fake.prompts[1]).toContain("Selected Plugin context.");
    const saved = yield* records(host.execution);
    const original = saved.find((one) => one.kind === "message");
    expect(original?.kind === "message" && original.text).toBe("original person source");
    const feedback = saved.filter((one) => one.kind === "feedback");
    expect(feedback).toHaveLength(2);
    for (const one of feedback) {
      expect(one.kind === "feedback" && one.text).toBe(host.fake.prompts[1]);
    }
    const canonical = saved.flatMap((one) => {
      if (one.kind !== "event") {
        return [];
      }
      const event = parseJson(JSON.parse(one.event));
      if (
        !isJsonObject(event) ||
        !isJsonObject(event.description) ||
        event.description.type !== "agent_prompt"
      ) {
        return [];
      }
      return [event.description.input];
    });
    expect(canonical).toEqual(host.fake.prompts);
  });
});
