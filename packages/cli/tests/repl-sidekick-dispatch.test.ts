import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import {
  createSidekickAdmission,
  SidekickOrigin,
  useSidekickDispatch,
} from "../src/repl/sidekick/dispatch.ts";
import type { SidekickDispatch, SidekickExchange } from "../src/repl/sidekick/dispatch.ts";
import { ReplHost } from "../src/repl/host.ts";
import { SidekickOwnerError } from "../src/repl/sidekick/owner.ts";
import { records, useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { awaitedFact } from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";
import { useReplPage } from "./support/repl-page.ts";
import {
  asked,
  sendMessage,
  intoComposer,
  typed,
  SIDEKICK_PANE,
  COMPOSER_VALUE,
} from "./support/screen-journeys.ts";

function service(
  held: Harness,
  admission = createSidekickAdmission(),
): Operation<SidekickDispatch> {
  return useSidekickDispatch({
    owner: held.owner,
    admission,
    execution: held.execution.id,
    workspace: held.workspace,
    changed() {},
  });
}
function* send(dispatch: SidekickDispatch, text: string): Operation<SidekickExchange> {
  const admitted = yield* dispatch.send(text);
  if (!admitted.ok) {
    throw admitted.error;
  }
  return admitted.value;
}

function fills(source: string): string {
  return [
    '<Let as="code" select="code">',
    "```xmd",
    source,
    "```",
    "</Let>",
    "<REPL.EntryInput>{code}</REPL.EntryInput>",
  ].join("\n");
}

describe("shared Sidekick dispatch", () => {
  it("keeps the mounted UI's real controls, generated entry and final answer", function* () {
    const page = yield* useReplPage();
    const repl = page.repl;
    repl.fake.script({
      reply: fills("<Output>generated</Output>\n") + "\n<REPL.Submit />\n<Output>Working.</Output>",
    });
    repl.fake.script({ reply: "<Output>Done through shared dispatch.</Output>" });
    yield* asked(page, "write the controlled entry", "Done through shared dispatch.");
    yield* awaitedFact("both replies being saved", function* () {
      return (
        (yield* settledReading(repl)).chat.filter((record) => record.kind === "response").length ===
        2
      );
    });
    const read = yield* settledReading(repl);
    expect(repl.fake.prompts).toHaveLength(2);
    expect(read.model.entries[0]?.source).toBe("<Output>generated</Output>\n");
    expect(read.model.entries[0]?.terminal?.output).toContain("generated");
    const message = read.chat.find((one) => one.kind === "message");
    if (message?.kind !== "message") {
      throw new Error("saved UI message missing");
    }
    expect(message.origin).toEqual({ kind: "ui" });
    expect(typeof message.id).toBe("string");
    expect(read.chat.filter((one) => one.kind === "control").length).toBeGreaterThan(0);
    expect(read.chat.filter((one) => one.kind === "response")).toHaveLength(2);
  });

  it("accepts busy UI Send and preserves a newer composer while the queued message starts", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "<Output>first answer</Output>", held: true });
    page.repl.fake.script({ reply: "<Output>queued answer</Output>" });
    yield* sendMessage(page, "first request");
    yield* page.repl.fake.startedTurns(1);
    yield* page.until(
      "busy Send beside Stop",
      (one) => one.found("[send]", SIDEKICK_PANE) === 1 && one.found("[stop]", SIDEKICK_PANE) === 1,
    );
    yield* sendMessage(page, "waiting request");
    yield* page.key("Enter");
    yield* page.until(
      "accepted queue row and cleared composer",
      (one) => one.shows("waiting request") && one.found("waiting request", COMPOSER_VALUE) === 0,
    );
    yield* intoComposer(page);
    yield* typed(page, "newer unsent text");
    expect(page.repl.fake.prompts).toHaveLength(1);
    const before = yield* settledReading(page.repl);
    expect(before.chat.filter((one) => one.kind === "message")).toHaveLength(1);
    page.repl.fake.releaseTurn();
    yield* page.until("the queued answer", (one) => one.shows("queued answer"));
    expect(page.screen().found("newer unsent text", COMPOSER_VALUE)).toBe(1);
    expect(page.repl.fake.prompts).toHaveLength(2);
    expect(
      (yield* settledReading(page.repl)).chat.filter((one) => one.kind === "message"),
    ).toHaveLength(2);
  });

  it("holds FIFO after human Stop, bounds waiting text, and resumes without retry", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "", manual: true });
    held.fake.script({ reply: "<Output>next</Output>" });
    const admission = createSidekickAdmission();
    const dispatch = yield* service(held, admission);
    const first = yield* send(dispatch, "active");
    yield* held.fake.startedTurns(1);
    const next = yield* send(dispatch, "next");
    expect(next.snapshot.state).toBe("queued");
    expect(next.snapshot.message).toBe(undefined);
    expect(admission.configure("replace", undefined).ok).toBe(false);
    dispatch.hold();
    yield* first.cancel();
    const removed = yield* send(dispatch, "remove");
    yield* removed.cancel();
    expect((yield* removed.completion).ok).toBe(false);
    expect(dispatch.queue.held?.kind).toBe("stopped");
    expect(held.fake.prompts).toHaveLength(1);
    expect((yield* dispatch.send("é".repeat(32769))).ok).toBe(false);
    const boundary = yield* send(dispatch, "é".repeat(32768));
    const waiting: SidekickExchange[] = [next, boundary];
    for (let index = 2; index < 16; index += 1) {
      waiting.push(yield* send(dispatch, `waiting ${index}`));
    }
    expect(dispatch.queue.pending).toHaveLength(16);
    expect((yield* dispatch.send("seventeenth")).ok).toBe(false);
    for (const exchange of waiting.slice(1)) {
      yield* exchange.cancel();
    }
    expect((yield* dispatch.resume()).ok).toBe(true);
    expect((yield* next.completion).ok).toBe(true);
    expect(held.fake.prompts).toHaveLength(2);
    yield* first.cancel();
    expect(dispatch.queue.pending).toHaveLength(0);
  });

  it("joins held control cleanup before advancing mixed-origin FIFO", function* () {
    const entered = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    const held = yield* useHarness(undefined, {
      *fill() {
        yield* ensure(function* () {
          cleaning.resolve();
          yield* release.operation;
        });
        entered.resolve();
        yield* suspend();
        return Ok(undefined);
      },
    });
    held.fake.script({ reply: fills("blocked") });
    held.fake.script({ reply: "<Output>UI successor</Output>", held: true });
    held.fake.script({ reply: "<Output>ACP successor</Output>" });
    const dispatch = yield* service(held);
    const first = yield* send(dispatch, "control owner");
    yield* entered.operation;
    const ui = yield* send(dispatch, "UI successor");
    const acp = yield* scoped(function* () {
      yield* SidekickOrigin.set({ kind: "acp", attachment: "queued attachment" });
      return yield* send(dispatch, "ACP successor");
    });
    const cancelling = yield* spawn(() => first.cancel());
    yield* cleaning.operation;
    expect(dispatch.current).toBe(first);
    expect(dispatch.queue.pending.map((one) => one.text)).toEqual([
      "UI successor",
      "ACP successor",
    ]);
    expect(held.fake.prompts).toHaveLength(1);
    expect(ui.snapshot.message).toBe(undefined);
    expect(acp.snapshot.live).toBe(undefined);
    release.resolve();
    yield* cancelling;
    yield* held.fake.startedTurns(2);
    expect(dispatch.current).toBe(ui);
    expect(acp.snapshot.message).toBe(undefined);
    yield* first.cancel();
    held.fake.releaseTurn();
    expect((yield* ui.completion).ok).toBe(true);
    expect((yield* acp.completion).ok).toBe(true);
    const saved = (yield* records(held.execution)).filter((one) => one.kind === "message");
    expect(saved.map((one) => one.text)).toEqual([
      "control owner",
      "UI successor",
      "ACP successor",
    ]);
    expect(saved[2].origin).toEqual({ kind: "acp", attachment: "queued attachment" });
  });

  it("holds ordinary failure until Resume and never retries the failed item", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "incomplete", stopReason: "max_tokens", held: true });
    held.fake.script({ reply: "<Output>resumed successor</Output>" });
    const dispatch = yield* service(held);
    const first = yield* send(dispatch, "failed item");
    yield* held.fake.startedTurns(1);
    const next = yield* send(dispatch, "remaining item");
    held.fake.releaseTurn();
    expect((yield* first.completion).ok).toBe(false);
    expect(dispatch.queue.held?.kind).toBe("failure");
    expect((yield* dispatch.send("blocked new work")).ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);
    expect((yield* dispatch.resume()).ok).toBe(true);
    expect((yield* next.completion).ok).toBe(true);
    expect(held.fake.prompts).toHaveLength(2);
  });

  it("disposes unsaved pending handles when the live owner ends", function* () {
    const handles: SidekickExchange[] = [];
    yield* scoped(function* () {
      const held = yield* useHarness();
      held.fake.script({ reply: "", manual: true });
      const dispatch = yield* service(held);
      handles.push(yield* send(dispatch, "active at exit"));
      yield* held.fake.startedTurns(1);
      handles.push(yield* send(dispatch, "unsaved at exit"));
      expect(handles[1].snapshot.message).toBe(undefined);
      expect((yield* records(held.execution)).filter((one) => one.kind === "message")).toHaveLength(
        1,
      );
    });
    expect((yield* handles[0].completion).ok).toBe(false);
    expect((yield* handles[1].completion).ok).toBe(false);
    expect(handles[1].snapshot.state).toBe("settled");
    expect(handles[1].snapshot.message).toBe(undefined);
  });

  it("captures lexical origins while detached observers leave the producer reserved", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>one</Output>", held: true });
    held.fake.script({ reply: "<Output>two</Output>" });
    const admission = createSidekickAdmission();
    const dispatch = yield* service(held, admission);
    const dormant = dispatch.send("never executed");
    expect(held.fake.prompts).toHaveLength(0);
    expect(admission.message).toBe(undefined);
    void dormant;
    const first = yield* scoped(function* () {
      yield* SidekickOrigin.set({ kind: "acp", attachment: "first" });
      return yield* send(dispatch, "one");
    });
    yield* held.fake.startedTurns(1);
    yield* scoped(function* () {
      yield* first.observe();
    });
    const queued = yield* send(dispatch, "withdraw this waiting message");
    expect(queued.snapshot.state).toBe("queued");
    expect(queued.snapshot.live).toBe(undefined);
    expect(queued.snapshot.preview).toBe(undefined);
    yield* queued.cancel();
    expect((yield* queued.completion).ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);
    expect((yield* records(held.execution)).filter((one) => one.kind === "message")).toHaveLength(
      1,
    );
    expect(admission.message === undefined).toBe(false);
    held.fake.releaseTurn();
    const done = yield* first.completion;
    expect(done.ok).toBe(true);
    const second = yield* scoped(function* () {
      yield* SidekickOrigin.set({ kind: "acp", attachment: "second" });
      return yield* send(dispatch, "two");
    });
    expect((yield* second.completion).ok).toBe(true);
    expect(first.snapshot.origin).toEqual({ kind: "acp", attachment: "first" });
    expect(second.snapshot.origin).toEqual({ kind: "acp", attachment: "second" });
    const one = first.snapshot.message;
    if (one === undefined) {
      throw new Error("acknowledged message association missing");
    }
    expect(dispatch.follow(one).ok).toBe(true);
    expect(dispatch.follow({ ...one, execution: "other" }).ok).toBe(false);
    const before = yield* records(held.execution);
    dispatch.follow(one);
    expect(yield* records(held.execution)).toEqual(before);
  });

  it("keeps completed exchange facts while a successor streams and passive readers follow", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>Completed A.</Output>" });
    held.fake.script({ deltas: ["<Output>Streaming B.</Output>", "\n"], holdAfter: 1 });
    const dispatch = yield* service(held);
    const first = yield* send(dispatch, "exchange A");
    const result = yield* first.completion;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.output).toContain("Completed A.");
    const completed = first.snapshot;
    expect(completed.terminal).toBe(result);
    const reference = completed.message;
    if (reference === undefined) {
      throw new Error("A saved reference missing");
    }
    const changes = yield* held.owner.changes;
    const second = yield* send(dispatch, "exchange B");
    yield* held.fake.streamingTurns(1);
    while (held.owner.previewing?.output !== "Streaming B.") {
      yield* changes.next();
    }
    expect(second.snapshot.live?.phase).toBe("generating");
    expect(second.snapshot.preview?.output).toBe("Streaming B.");
    const turns = held.fake.prompts.length;
    const chat = yield* records(held.execution);
    const entries = yield* held.execution.stream.readAll();
    expect(first.snapshot).toEqual(completed);
    const direct = yield* scoped(function* () {
      return (yield* first.observe()).snapshot;
    });
    expect(direct).toEqual(completed);
    const followed = dispatch.follow(reference);
    if (!followed.ok) {
      throw followed.error;
    }
    expect(followed.value.snapshot).toEqual(completed);
    const observed = yield* scoped(function* () {
      return (yield* followed.value.observe()).snapshot;
    });
    expect(observed).toEqual(completed);
    expect(observed.message).toEqual(reference);
    expect(observed.terminal).toBe(result);
    expect(observed.preview?.output).not.toBe("Streaming B.");
    expect(observed.live?.response).not.toBe(second.snapshot.live?.response);
    expect(held.fake.prompts).toHaveLength(turns);
    expect(yield* records(held.execution)).toEqual(chat);
    expect(yield* held.execution.stream.readAll()).toEqual(entries);
    expect(held.owner.busy).toBe(true);
    expect(dispatch.current).toBe(second);
    held.fake.releaseDeltas();
    expect((yield* second.completion).ok).toBe(true);
    expect(first.snapshot).toEqual(completed);
  });

  it("reports a failed follow-up with earlier answer as partial evidence", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>Earlier answer.</Output>\n<REPL.Bindings />" });
    held.fake.script({ reply: "incomplete", stopReason: "max_tokens" });
    const dispatch = yield* service(held);
    const exchange = yield* send(dispatch, "inspect then answer");
    const observed = yield* exchange.observe();
    const observer = yield* spawn(function* () {
      let snapshot = observed.snapshot;
      while (snapshot.terminal === undefined) {
        snapshot = (yield* observed.changes.next()).value;
      }
      return snapshot;
    });
    const result = yield* exchange.completion;
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof SidekickOwnerError)) {
      throw new Error("whole-exchange failure missing");
    }
    expect(result.error.partial?.output).toContain("Earlier answer.");
    expect((yield* observer).terminal?.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(2);
  });

  it("keeps composer and held draft ownership for ACP-origin work", function* () {
    let acknowledgements = 0;
    const held = yield* useHarness(undefined, {
      state: (initial) =>
        Object.freeze({
          ...initial,
          message: "unsent human text",
          draft: "held human draft",
          takenOver: true,
        }),
      *acknowledge() {
        acknowledgements += 1;
      },
    });
    held.fake.script({ reply: fills("replacement") });
    held.fake.script({ reply: "<Output>Draft remained held.</Output>" });
    const dispatch = yield* service(held);
    const exchange = yield* scoped(function* () {
      yield* SidekickOrigin.set({ kind: "acp", attachment: "external" });
      return yield* send(dispatch, "try the held draft");
    });
    yield* exchange.completion;
    expect(acknowledgements).toBe(0);
    expect(held.state().message).toBe("unsent human text");
    expect(held.state().draft).toBe("held human draft");
    expect(held.fake.prompts[1]).toContain("draft");
  });

  it("joins cancellation and fences an old handle from a successor", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "", manual: true });
    held.fake.script({ reply: "<Output>successor</Output>", held: true });
    const dispatch = yield* service(held);
    const first = yield* send(dispatch, "stop this");
    yield* held.fake.startedTurns(1);
    yield* first.cancel();
    expect((yield* first.completion).ok).toBe(false);
    expect(held.owner.busy).toBe(false);
    const second = yield* send(dispatch, "keep this");
    yield* held.fake.startedTurns(2);
    yield* first.cancel();
    expect(held.owner.busy).toBe(true);
    held.fake.releaseTurn();
    expect((yield* second.completion).ok).toBe(true);
  });

  it("joins control teardown before releasing admission", function* () {
    const entered = withResolvers<void>();
    let cleaned = false;
    const held = yield* useHarness(undefined, {
      *fill() {
        yield* ensure(function* () {
          cleaned = true;
        });
        entered.resolve();
        yield* suspend();
        return Ok(undefined);
      },
    });
    held.fake.script({ reply: fills("blocked") });
    const admission = createSidekickAdmission();
    const dispatch = yield* service(held, admission);
    const exchange = yield* send(dispatch, "hold control");
    yield* entered.operation;
    expect(admission.message === undefined).toBe(false);
    yield* exchange.cancel();
    expect(cleaned).toBe(true);
    expect(admission.message).toBe(undefined);
  });

  it("retains configuration reservations and the save/replace exceptions", function* () {
    const held = yield* useHarness();
    const admission = createSidekickAdmission();
    const dispatch = yield* service(held, admission);
    const inspecting = admission.configure("inspect", undefined);
    if (!inspecting.ok) {
      throw inspecting.error;
    }
    expect((yield* dispatch.send("refuse before turn")).ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(0);
    expect((yield* records(held.execution)).filter((one) => one.kind === "message")).toHaveLength(
      0,
    );
    admission.releaseConfiguration(inspecting.value);
    held.fake.script({ reply: "", manual: true });
    const exchange = yield* send(dispatch, "working");
    yield* held.fake.startedTurns(1);
    expect(admission.configure("inspect", undefined).ok).toBe(false);
    const save = admission.configure("save", undefined);
    if (!save.ok) {
      throw save.error;
    }
    expect(admission.configure("replace", undefined).ok).toBe(false);
    admission.releaseConfiguration(save.value);
    const replace = admission.configure("replace", undefined);
    expect(replace.ok).toBe(true);
    if (replace.ok) {
      admission.releaseConfiguration(replace.value);
    }
    yield* exchange.cancel();
  });
  it("publishes the opaque reference only after actual message append acknowledgement", function* () {
    const held = yield* useHarness();
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    yield* ReplHost.around({
      *appendRecord([file, record], next) {
        if (JSON.parse(record).kind === "message") {
          entered.resolve();
          yield* release.operation;
        }
        yield* next(file, record);
      },
    });
    held.fake.script({ reply: "<Output>acknowledged</Output>" });
    const dispatch = yield* service(held);
    const exchange = yield* send(dispatch, "hold the append");
    yield* entered.operation;
    expect(exchange.snapshot.message).toBe(undefined);
    expect(held.fake.prompts).toHaveLength(0);
    release.resolve();
    expect((yield* exchange.completion).ok).toBe(true);
    const reference = exchange.snapshot.message;
    if (reference === undefined) {
      throw new Error("saved reference missing after acknowledgement");
    }
    expect(
      (yield* records(held.execution)).some(
        (one) => one.kind === "message" && one.id === reference.id,
      ),
    ).toBe(true);
  });

  it("joins cancellation requested immediately after admission", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "", manual: true });
    const dispatch = yield* service(held);
    const exchange = yield* send(dispatch, "cancel immediately");
    yield* exchange.cancel();
    expect((yield* exchange.completion).ok).toBe(false);
    expect(held.owner.busy).toBe(false);
    expect(dispatch.current).toBe(undefined);
  });
});
