import { Agent, isJsonObject, parseJson } from "@executablemd/core";
import { Plugin } from "@executablemd/core/api";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, resource, scoped, spawn, withResolvers } from "effection";
import type { Operation, Result, Stream, Subscription } from "effection";
import type { AgentPromptEvent } from "@executablemd/core";
import type { ReplPluginInstallation } from "../api.ts";
import { writeTextFile } from "@effectionx/fs";
import { useHostFiles } from "@executablemd/runtime";
import { installTodoSource } from "../src/node-todo-source.ts";
import { todoPlugin } from "../src/repl/todo/plugin.ts";
import { useTodo } from "../src/repl/todo/service.ts";
import { createSidekickAdmission, useSidekickDispatch } from "../src/repl/sidekick/dispatch.ts";
import type { SidekickDispatch, SidekickExchange } from "../src/repl/sidekick/dispatch.ts";
import { coldReservations, retainResolution } from "../src/repl/sidekick/admission.ts";
import { records, useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";

/** What one composing layer did, so a case can say it did it exactly once. */
interface Layer {
  /** Each text this layer delegated onward, in order. */
  readonly delegated: string[];
  /** How many times a subscription acquired this layer's own resource. */
  subscriptions: number;
}

function layer(): Layer {
  return { delegated: [], subscriptions: 0 };
}

/**
 * One contributed content layer, where a held turn's composition belongs.
 *
 * A held turn ends at its own terminal, and everything above that terminal is
 * ordinary `Agent.prompt` middleware — so a selected Plugin reaches a held
 * turn's content by registering at the default `max` from `repl.sidekick()`,
 * exactly as it would for a document. `compose` enriches the delegated text;
 * `bracket` holds one resource open around the composed stream, which is what
 * a case about joined cleanup needs.
 *
 * Registration order is the library's: within one scope the earlier `max`
 * registration is the outermost, so the first Plugin installed sees the
 * person's own text and the last one sees what every layer above it added.
 */
function composing(
  name: string,
  compose: (text: string) => string,
  record: Layer = layer(),
  bracket?: () => Operation<void>,
): Plugin & { readonly layer: Layer } {
  return Object.assign(
    Plugin({
      name,
      *install(): Operation<ReplPluginInstallation> {
        return {
          repl: {
            *sidekick(): Operation<void> {
              yield* Agent.around({
                // deno-lint-ignore require-yield
                *prompt([text, options], next): Operation<Stream<AgentPromptEvent, string>> {
                  return resource<Subscription<AgentPromptEvent, string>>(function* (provide) {
                    record.subscriptions += 1;
                    if (bracket !== undefined) {
                      yield* ensure(bracket);
                    }
                    const composed = compose(text);
                    record.delegated.push(composed);
                    yield* provide(yield* yield* next(composed, options));
                  });
                },
              });
            },
          },
        };
      },
    }),
    { layer: record },
  );
}

/**
 * Settle the entry writer and retain the complete unresolved Submit set, as the
 * loop's own `reconcileSubmits` does.
 *
 * The fixture's, not a production helper: what a post-Stop instruction needs
 * before it is bound is this reconciliation, and a case about a checklist
 * composed into such an instruction has to supply it the way the loop supplies
 * it rather than reach for an API nothing in the product would call.
 */
function reconciling(host: Harness): () => Operation<Result<void>> {
  return function* () {
    if (host.execution.chat.form !== "paired") {
      throw new Error("Recovery requires its acknowledged paired history.");
    }
    yield* host.execution.stream.settled();
    const entries = host.session.reading(undefined);
    if (!entries.ok) {
      throw entries.error;
    }
    const findings = yield* coldReservations(
      yield* host.execution.chat.writer.readAll(),
      entries.value.model.entries,
      host.execution.chat.location.entries,
    );
    if (!findings.ok) {
      return findings;
    }
    for (const finding of findings.value) {
      yield* retainResolution(host.execution.chat.writer, finding);
    }
    return Ok(undefined);
  };
}

function* setup(extra: readonly Plugin[] = [], reconciles = false) {
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
    ...(reconciles ? { reconcile: reconciling(host) } : {}),
  });
  return { host, todo, dispatch };
}
/** The input each canonical `agent_prompt` description retained, in order. */
function canonicalInputs(saved: readonly { kind: string; event?: string }[]): unknown[] {
  return saved.flatMap((one) => {
    if (one.kind !== "event" || one.event === undefined) {
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
    // Every turn here — the two failures, the recovery and the ordinary one —
    // retained exactly the text it delegated, so the fresh full current state
    // a recovery sends is the state the journal says was sent.
    expect(canonicalInputs(yield* records(host.execution))).toEqual(host.fake.prompts);
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
              layer(),
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
    // Two contributed layers beside TODO's own, each adding text only it could
    // have added: a constant-only witness could not say which layer ran, in
    // what order, or how many times.
    const first = composing("todo-context-first", (text) => text + "\nfirst layer.");
    const second = composing("todo-context-second", (text) => text + "\nsecond layer.");
    const { host, todo, dispatch } = yield* setup([first, second]);
    yield* todo.save("", "- [ ] shared\n");
    host.fake.script({ reply: '<Sidekick.Todo as="items" />' });
    host.fake.script({ reply: "<Output>done</Output>" });
    const sent = yield* send(dispatch, "original person source");
    expect((yield* sent.completion).ok).toBe(true);
    expect(host.fake.prompts).toHaveLength(2);
    expect(host.fake.prompts[1]).toContain("first layer.");
    expect(host.fake.prompts[1]).toContain("second layer.");

    // One selection and one delegation per layer per turn, and no layer
    // subscribed twice: a second subscription would be a second native turn.
    expect(first.layer.delegated).toHaveLength(2);
    expect(second.layer.delegated).toHaveLength(2);
    expect(first.layer.subscriptions).toBe(2);
    expect(second.layer.subscriptions).toBe(2);

    // The documented order, read off what each layer was handed rather than
    // asserted about the library: the earlier `max` registration in one scope
    // is the outermost, so the first contribution saw text without the
    // second's line and the second saw the first's.
    expect(first.layer.delegated[0]).not.toContain("second layer.");
    expect(second.layer.delegated[0]).toContain("first layer.");
    // TODO registers from its own `repl.sidekick()` before either of these
    // contributions, so its committed-change text is already present by the
    // time the first one composes.
    expect(first.layer.delegated[0]).toContain("Committed TODO changes");

    const saved = yield* records(host.execution);
    const original = saved.find((one) => one.kind === "message");
    expect(original?.kind === "message" && original.text).toBe("original person source");
    const feedback = saved.filter((one) => one.kind === "feedback");
    expect(feedback).toHaveLength(2);
    for (const one of feedback) {
      expect(one.kind === "feedback" && one.text).toBe(host.fake.prompts[1]);
    }
    const canonical = canonicalInputs(saved);
    // Exact equality, not substring presence: the text the provider received,
    // the text the journal retained and the text the host acknowledged are one
    // text, and the person's own message stays separately original.
    expect(canonical).toEqual(host.fake.prompts);
    expect(canonical[1]).toBe(second.layer.delegated[1]);
    expect(canonical.every((input) => input !== "original person source")).toBe(true);
  });
  it("sends one post-Stop instruction with the fresh checklist and retires only its selection", function* () {
    const { host, todo, dispatch } = yield* setup([], true);
    host.fake.script({ reply: "<REPL.Bindings />\n" });
    // The automatic feedback turn, streaming and unfinished. A Stop of a turn
    // that never started and a Stop of one in flight are different joins, and
    // the exchange this case is about is the second.
    host.fake.script({ deltas: ["<Output>Reading", " the bindings.</Output>"], holdAfter: 1 });
    const asked = yield* send(dispatch, "Report this session's bindings.");
    yield* host.fake.streamingTurns(1);
    expect(host.fake.prompts).toHaveLength(2);
    dispatch.hold();
    yield* asked.cancel("human");
    expect((yield* asked.completion).ok).toBe(false);

    const stopped = yield* records(host.execution);
    const intent = stopped.findIndex((one) => one.kind === "feedback" && one.turn === null);
    const stops = stopped.flatMap((one, at) => (one.kind === "human-stop" ? [at] : []));
    expect(intent).toBeGreaterThan(-1);
    expect(stops).toHaveLength(1);
    // After the feedback it joined, which is what says the record follows the
    // exchange rather than racing it.
    expect(stops[0]).toBeGreaterThan(intent);
    const reading = host.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    const conversation = reading.value.active;
    expect(reading.value.unestablished).toEqual([{ conversation, turn: null }]);
    expect(reading.value.recoveryPending).toBe(true);
    // The Stop left the checklist owed rather than retired, which is the state
    // the next independently allowed prompt has to read fresh.
    expect(todo.recovery).toBe(true);
    expect(todo.pending).toEqual([]);

    yield* todo.save("", "- [ ] committed-while-held-Q1157\n");
    expect(todo.pending).toHaveLength(1);
    const waiting = yield* send(dispatch, "Report the bindings again, from the current checklist.");
    expect(waiting.snapshot.state).toBe("queued");
    expect(dispatch.queue.held?.kind).toBe("stopped");
    // Nothing reached the provider and nothing was saved: a waiting instruction
    // is not an ordinary message yet.
    expect(host.fake.prompts).toHaveLength(2);
    expect(yield* records(host.execution)).toEqual(stopped);

    yield* writeTextFile(
      `${host.workspace}/todo.md`,
      "- [x] committed-while-held-Q1157\n- [ ] later-outside-Q1157\n",
    );
    yield* todo.refresh();
    host.fake.script({ reply: "<Output>The current checklist.</Output>", held: true });
    expect((yield* dispatch.resume()).ok).toBe(true);
    yield* host.fake.holdingTurns(1);
    expect(host.fake.prompts).toHaveLength(3);
    const input = host.fake.prompts[2];
    expect(input).toContain("Report the bindings again, from the current checklist.");
    expect(input).toContain("acceptance remains unknown");
    expect(input).toContain("Current TODO checklist (fresh recovery state)");
    // What the file says now, including the change made while the instruction
    // waited — not the delta the pending observation was recorded from.
    expect(input).toContain('"text":"later-outside-Q1157"');
    expect(input).not.toContain("Committed TODO changes");
    const old = stopped[intent];
    if (old?.kind !== "feedback") {
      throw new Error("Expected the retained feedback intent.");
    }
    // The uncertain feedback is accounted for, not resent.
    expect(input).not.toContain(old.text);

    yield* todo.save(
      "- [x] committed-while-held-Q1157\n- [ ] later-outside-Q1157\n",
      "- [x] committed-while-held-Q1157\n- [x] later-outside-Q1157\n",
    );
    expect(todo.pending).toHaveLength(2);
    expect(todo.recovery).toBe(true);
    host.fake.releaseTurn();
    const sent = yield* waiting.completion;
    if (!sent.ok) {
      throw sent.error;
    }
    expect(host.fake.prompts).toHaveLength(3);
    // Only what this turn selected retired; the edit made after its selection
    // and before its completion is still owed.
    expect(todo.pending).toHaveLength(1);
    expect(todo.pending[0].diff).toContain("+- [x] later-outside-Q1157");
    expect(todo.recovery).toBe(false);

    expect(waiting.snapshot.message?.conversation).toBe(conversation);
    const key = host.fake.turns[0]?.handle.sessionKey;
    expect(host.fake.turns[2]?.handle.sessionKey).toBe(key);
    const after = yield* records(host.execution);
    expect(
      after.flatMap((one) => (one.kind === "message" ? [[one.text, one.origin.kind]] : [])),
    ).toEqual([
      ["Report this session's bindings.", "ui"],
      ["Report the bindings again, from the current checklist.", "ui"],
    ]);
    // The control the Stopped feedback came from ran once and was not repeated,
    // and no entry was submitted for either turn to repeat.
    expect(
      after.filter((one) => one.kind === "control" && one.component === "REPL.Bindings"),
    ).toHaveLength(1);
    expect(host.session.model.entries).toEqual([]);
    expect(
      after.flatMap((one) => (one.kind === "recovery-decision" ? [[one.action, one.basis]] : [])),
    ).toEqual([["continue-original", "joined-owned-exchange"]]);
    // The first turn and the resumed one retained exactly the input they
    // delegated. The Stopped feedback turn retained none, because it completed
    // none.
    expect(canonicalInputs(after)).toEqual([host.fake.prompts[0], host.fake.prompts[2]]);
    const feedback = after.filter((one) => one.kind === "feedback");
    expect(feedback).toHaveLength(1);
    expect(feedback[0].kind === "feedback" && feedback[0].turn).toBe(null);
    const settled = host.owner.reading;
    if (!settled.ok) {
      throw settled.error;
    }
    expect(settled.value.recoveries.map((one) => one.used)).toEqual([true]);
    // Unchanged by the successful ordinary turn: the old feedback's acceptance
    // is still nobody's to establish.
    expect(settled.value.unestablished).toEqual([{ conversation, turn: null }]);
  });
});
