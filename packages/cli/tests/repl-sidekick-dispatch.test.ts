import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { createSidekickAdmission, SidekickOrigin, useSidekickDispatch } from "../src/repl/sidekick/dispatch.ts";
import type { SidekickDispatch, SidekickExchange } from "../src/repl/sidekick/dispatch.ts";
import { ReplHost } from "../src/repl/host.ts";
import { SidekickOwnerError } from "../src/repl/sidekick/owner.ts";
import { records, useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { awaiting, mountedReading, sendMessage, shows, useMountedRepl } from "./fixtures/repl/issue-883/mounted-program.ts";

function service(held: Harness, admission = createSidekickAdmission()): Operation<SidekickDispatch> {
  return useSidekickDispatch({ owner: held.owner, admission, execution: held.execution.id, workspace: held.workspace, changed() {} });
}
function* send(dispatch: SidekickDispatch, text: string): Operation<SidekickExchange> {
  const admitted = yield* dispatch.send(text);
  if (!admitted.ok) { throw admitted.error; }
  return admitted.value;
}

function fills(source: string): string {
  return ['<Let as="code" select="code">', "```xmd", source, "```", "</Let>", "<REPL.EntryInput>{code}</REPL.EntryInput>"].join("\n");
}

describe("shared Sidekick dispatch", () => {
  it("keeps the mounted UI's real controls, generated entry and final answer", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: fills("<Output>generated</Output>\n") + "\n<REPL.Submit />\n<Output>Working.</Output>" });
    repl.fake.script({ reply: "<Output>Done through shared dispatch.</Output>" });
    yield* sendMessage(repl, "write the controlled entry");
    yield* awaiting(repl.terminal, "the final shared-dispatch answer", one => shows(one, "Done through shared dispatch."));
    const read = yield* mountedReading(repl);
    expect(repl.fake.prompts).toHaveLength(2);
    expect(read.model.entries[0]?.source).toBe("<Output>generated</Output>\n");
    expect(read.model.entries[0]?.terminal?.output).toContain("generated");
    const message = read.chat.find(one => one.kind === "message");
    if (message?.kind !== "message") { throw new Error("saved UI message missing"); }
    expect(message.origin).toEqual({ kind: "ui" });
    expect(typeof message.id).toBe("string");
    expect(read.chat.filter(one => one.kind === "control").length).toBeGreaterThan(0);
    expect(read.chat.filter(one => one.kind === "response")).toHaveLength(2);
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
    yield* scoped(function* () { yield* first.observe(); });
    const refused = yield* dispatch.send("burst duplicate");
    expect(refused.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);
    expect((yield* records(held.execution)).filter(one => one.kind === "message")).toHaveLength(1);
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
    if (one === undefined) { throw new Error("acknowledged message association missing"); }
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
    if (!result.ok) { throw result.error; }
    expect(result.value.output).toContain("Completed A.");
    const completed = first.snapshot;
    expect(completed.terminal).toBe(result);
    const reference = completed.message;
    if (reference === undefined) { throw new Error("A saved reference missing"); }
    const changes = yield* held.owner.changes;
    const second = yield* send(dispatch, "exchange B");
    yield* held.fake.streamingTurns(1);
    while (held.owner.previewing?.output !== "Streaming B.") { yield* changes.next(); }
    expect(second.snapshot.live?.phase).toBe("generating");
    expect(second.snapshot.preview?.output).toBe("Streaming B.");
    const turns = held.fake.prompts.length;
    const chat = yield* records(held.execution);
    const entries = yield* held.execution.stream.readAll();
    expect(first.snapshot).toEqual(completed);
    const direct = yield* scoped(function* () { return (yield* first.observe()).snapshot; });
    expect(direct).toEqual(completed);
    const followed = dispatch.follow(reference);
    if (!followed.ok) { throw followed.error; }
    expect(followed.value.snapshot).toEqual(completed);
    const observed = yield* scoped(function* () { return (yield* followed.value.observe()).snapshot; });
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
      while (snapshot.terminal === undefined) { snapshot = (yield* observed.changes.next()).value; }
      return snapshot;
    });
    const result = yield* exchange.completion;
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof SidekickOwnerError)) { throw new Error("whole-exchange failure missing"); }
    expect(result.error.partial?.output).toContain("Earlier answer.");
    expect((yield* observer).terminal?.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(2);
  });

  it("keeps composer and held draft ownership for ACP-origin work", function* () {
    let acknowledgements = 0;
    const held = yield* useHarness(undefined, {
      state: initial => Object.freeze({ ...initial, message: "unsent human text", draft: "held human draft", takenOver: true }),
      *acknowledge() { acknowledgements += 1; },
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
    const held = yield* useHarness(undefined, { *fill() {
      yield* ensure(function* () { cleaned = true; });
      entered.resolve();
      yield* suspend();
      return Ok(undefined);
    } });
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
    if (!inspecting.ok) { throw inspecting.error; }
    expect((yield* dispatch.send("refuse before turn")).ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(0);
    expect((yield* records(held.execution)).filter(one => one.kind === "message")).toHaveLength(0);
    admission.releaseConfiguration(inspecting.value);
    held.fake.script({ reply: "", manual: true });
    const exchange = yield* send(dispatch, "working");
    yield* held.fake.startedTurns(1);
    expect(admission.configure("inspect", undefined).ok).toBe(false);
    const save = admission.configure("save", undefined);
    if (!save.ok) { throw save.error; }
    expect(admission.configure("replace", undefined).ok).toBe(false);
    admission.releaseConfiguration(save.value);
    const replace = admission.configure("replace", undefined);
    expect(replace.ok).toBe(true);
    if (replace.ok) { admission.releaseConfiguration(replace.value); }
    yield* exchange.cancel();
  });
  it("publishes the opaque reference only after actual message append acknowledgement", function* () {
    const held = yield* useHarness();
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    yield* ReplHost.around({ *appendRecord([file, record], next) {
      if (JSON.parse(record).kind === "message") {
        entered.resolve();
        yield* release.operation;
      }
      yield* next(file, record);
    } });
    held.fake.script({ reply: "<Output>acknowledged</Output>" });
    const dispatch = yield* service(held);
    const exchange = yield* send(dispatch, "hold the append");
    yield* entered.operation;
    expect(exchange.snapshot.message).toBe(undefined);
    expect(held.fake.prompts).toHaveLength(0);
    release.resolve();
    expect((yield* exchange.completion).ok).toBe(true);
    const reference = exchange.snapshot.message;
    if (reference === undefined) { throw new Error("saved reference missing after acknowledgement"); }
    expect((yield* records(held.execution)).some(one => one.kind === "message" && one.id === reference.id)).toBe(true);
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
