import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, ensure, race, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { numbered, pointLabel } from "../src/repl/navigation.ts";
import { registerComponents } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { z } from "zod";
import { runReplSubmit, sourceFrames, submitStatus } from "../src/sidekick-acp/submit.ts";
import {
  Envelope,
  MAX_FRAME,
  MAX_TEXT,
  Reply,
  SidekickTransport,
  SubmitRecord,
} from "../src/sidekick-acp/protocol.ts";
import type { Wire } from "../src/sidekick-acp/protocol.ts";
import { useHeadlessFixture } from "./support/headless-repl.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { ReplEntryHost } from "../src/repl-entry-installation.ts";
import { ReplHost } from "../src/repl/host.ts";
import { useSecretScannerFactory } from "../../core/src/secrets/policy.ts";
import { recordingTerminal } from "./support/mounted-repl.ts";
import { attachChildUi } from "../src/headless/ui.ts";

type Fixture = ReturnType<typeof useHeadlessFixture> extends Operation<infer T> ? T : never;
function gate() {
  const entered = withResolvers<void>();
  const released = withResolvers<void>();
  return {
    entered: entered.operation,
    enter: entered.resolve,
    release: released.resolve,
    wait: released.operation,
  };
}
function deadline<T>(operation: Operation<T>): Operation<T> {
  return race([
    operation,
    (function* (): Operation<never> {
      yield* sleep(15000);
      throw new Error("The controlled direct-submit boundary did not settle.");
    })(),
  ]);
}
function command(
  fixture: Fixture,
  source: string | (() => Operation<ReturnType<typeof Ok<string>>>),
  interrupt: Operation<void> = suspend(),
  observe: (record: SubmitRecord) => void = () => {},
) {
  const records: SubmitRecord[] = [];
  const errors: string[] = [];
  const changed = withResolvers<void>();
  const admitted = withResolvers<void>();
  return {
    records,
    errors,
    admitted: admitted.operation,
    changed: changed.operation,
    run: runReplSubmit(
      ["repl", "submit", "--attach", fixture.reference.sessionId, "-"],
      typeof source === "string"
        ? function* () {
            return Ok(source);
          }
        : source,
      interrupt,
      function* (record) {
        records.push(record);
        observe(record);
        if (record.kind === "admitted") {
          admitted.resolve();
        }
        changed.resolve();
      },
      (message) => errors.push(message),
    ),
  };
}
function child(fixture: Fixture) {
  const root = fixture.children[0];
  if (root === undefined) {
    throw new Error("The genuine disposable child did not become ready.");
  }
  return root;
}
function* wireTo(fixture: Fixture): Operation<Wire> {
  const { wire, descriptor } = yield* (yield* SidekickTransport.expect()).connect(fixture.path);
  yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
  expect(Reply.parse(yield* wire.receive())).toMatchObject({
    id: 0,
    kind: "value",
    value: descriptor,
  });
  return wire;
}
function* replyTo(wire: Wire, id: number): Operation<Reply> {
  while (true) {
    const reply = Reply.parse(yield* wire.receive());
    if (reply.id === id) {
      return reply;
    }
  }
}
const QUESTION =
  '<Elicit as="answer" schema={{type:"object",properties:{decision:{type:"string"}},required:["decision"],additionalProperties:false}}>Continue?</Elicit>';
const HOLD =
  '---\nreturns: {type: object}\n---\n<AssertEquals actual={2 + 2} expected={4} />\n<Return value={{status: "hold"}} />';

describe("direct headless submission", () => {
  it("A: transfers a complete large UTF-8 program once, with consumption credit, values and project placement", function* () {
    const directory = yield* useTemporary("xmd-direct-project-");
    yield* API.Env.around(
      {
        *cwd() {
          return directory;
        },
      },
      { at: "min" },
    );
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    const collector = gate();
    yield* ensure(collector.release);
    const original = root.direct.submit;
    let held = true;
    let ended = false;
    let acknowledgements = 0;
    root.direct.submit = (source, onAdmitted) =>
      original(
        {
          *[Symbol.iterator]() {
            const subscription = yield* source;
            return {
              *next() {
                if (held) {
                  held = false;
                  collector.enter();
                  yield* collector.wait;
                }
                const next = yield* subscription.next();
                if (next.done) {
                  ended = true;
                }
                return next;
              },
            };
          },
        },
        (submission) => {
          expect(ended).toBe(true);
          acknowledgements += 1;
          onAdmitted?.(submission);
        },
      );
    const transport = yield* SidekickTransport.expect();
    const firstPart = withResolvers<void>();
    const frames: z.infer<typeof Envelope>[] = [];
    yield* SidekickTransport.set({
      ...transport,
      *connect(path) {
        const connected = yield* transport.connect(path);
        return {
          ...connected,
          wire: {
            ...connected.wire,
            *send(value) {
              const envelope = Envelope.parse(value);
              if (envelope.request.method === "submit-source") {
                frames.push(envelope);
                firstPart.resolve();
              }
              yield* connected.wire.send(value);
            },
          },
        };
      },
    });
    let effects = 0;
    yield* API.Files.around({
      *writeTextFile([input], next) {
        effects += 1;
        return yield* next(input);
      },
    });
    const padding = '😀"\\\n'.repeat(150000);
    const source = `---\nreturns: {type: object}\n---\n\x60\x60\x60text\n${padding}\n\x60\x60\x60\n<AssertEquals actual={2 + 2} expected={4} />\n<File path="tail.txt">tail ran once</File>\n<Return value={{status: "hold"}} />`;
    expect(new TextEncoder().encode(JSON.stringify({ source })).length).toBeGreaterThan(MAX_FRAME);
    const call = command(fixture, source);
    const running = yield* spawn(() => deadline(call.run));
    yield* collector.entered;
    yield* firstPart.operation;
    expect(frames).toHaveLength(1);
    expect(root.session.model.entries).toHaveLength(0);
    expect(call.records).toEqual([]);
    collector.release();
    expect(yield* running).toBe(0);
    expect(effects).toBe(1);
    expect(acknowledgements).toBe(1);
    expect(yield* readTextFile(`${directory}/tail.txt`)).toBe("tail ran once");
    expect(root.session.model.entries).toHaveLength(1);
    expect(root.session.model.entries[0]?.source).toBe(source);
    expect(call.errors).toEqual([]);
    expect(call.records.filter((one) => one.kind === "admitted")).toHaveLength(1);
    expect(call.records[0]?.kind).toBe("admitted");
    expect(call.records.at(-1)).toMatchObject({
      kind: "finished",
      joined: true,
      outcome: "completed",
      result: { value: { status: "hold" } },
      journal: "completed",
    });
    for (const frame of frames) {
      expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThanOrEqual(MAX_FRAME);
      if (frame.request.method === "submit-source") {
        expect(new TextEncoder().encode(frame.request.text).length).toBeLessThanOrEqual(MAX_TEXT);
      }
    }
    expect(
      frames
        .flatMap((frame) => (frame.request.method === "submit-source" ? [frame.request.text] : []))
        .join(""),
    ).toBe(source);
    expect(frames.at(-1)?.request).toMatchObject({ method: "submit-source", done: true });
    const next = command(fixture, '---\nreturns: {type: "null"}\n---\n<Return value={null} />');
    expect(yield* deadline(next.run)).toBe(0);
    expect(next.records.at(-1)).toMatchObject({ result: { value: null }, outcome: "completed" });
    expect(fixture.host.fake.prompts).toHaveLength(0);
  });

  it("A: refuses a second unread part and credits text plus done only after terminal consumption", function* () {
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    const beforeText = gate();
    const beforeDone = gate();
    yield* ensure(() => {
      beforeText.release();
      beforeDone.release();
    });
    const original = root.direct.submit;
    root.direct.submit = (source, admitted) =>
      original(
        {
          *[Symbol.iterator]() {
            const subscription = yield* source;
            let first = true;
            return {
              *next() {
                const at = first ? beforeText : beforeDone;
                first = false;
                at.enter();
                yield* at.wait;
                return yield* subscription.next();
              },
            };
          },
        },
        admitted,
      );
    yield* scoped(function* () {
      const wire = yield* wireTo(fixture);
      yield* wire.send({ id: 1, request: { method: "submit" } });
      yield* beforeText.entered;
      yield* wire.send({
        id: 2,
        request: { method: "submit-source", submit: 1, text: HOLD, done: true },
      });
      yield* wire.send({
        id: 3,
        request: { method: "submit-source", submit: 1, text: "must not queue", done: false },
      });
      expect(yield* deadline(replyTo(wire, 3))).toMatchObject({ kind: "error" });
      expect(root.session.model.entries).toHaveLength(0);
      beforeText.release();
      yield* beforeDone.entered;
      yield* wire.send({ id: 4, request: { method: "status" } });
      expect(yield* deadline(replyTo(wire, 4))).toMatchObject({ kind: "value" });
      expect(root.session.model.entries).toHaveLength(0);
      beforeDone.release();
      const received: Reply[] = [];
      while (!received.some((reply) => reply.id === 1 && reply.kind === "value")) {
        received.push(Reply.parse(yield* wire.receive()));
      }
      expect(received.filter((reply) => reply.id === 2)).toHaveLength(1);
      expect(received.find((reply) => reply.id === 2)?.kind).toBe("value");
      expect(root.session.model.entries).toHaveLength(1);
      expect(root.session.model.entries[0]?.source).toBe(HOLD);
    });
  });

  it("A: discards failed/EOF/cancelled prefixes and begins no transfer on input failure", function* () {
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    for (const interrupt of [false, true]) {
      yield* scoped(function* () {
        const wire = yield* wireTo(fixture);
        yield* wire.send({ id: 1, request: { method: "submit" } });
        yield* wire.send({
          id: 2,
          request: {
            method: "submit-source",
            submit: 1,
            text: '<File path="never">prefix</File>',
            done: false,
          },
        });
        expect(yield* replyTo(wire, 2)).toMatchObject({ kind: "value" });
        if (interrupt) {
          yield* wire.send({ id: 3, request: { method: "submit-interrupt", submit: 1 } });
          const replies: Reply[] = [];
          while (!replies.some((reply) => reply.id === 1 && reply.kind === "value")) {
            replies.push(Reply.parse(yield* wire.receive()));
          }
          expect(replies.find((reply) => reply.id === 1 && reply.kind === "value")).toMatchObject({
            value: {
              outcome: "interrupted",
              submission: null,
              result: null,
              error: null,
              journal: null,
            },
          });
        }
      });
      yield* deadline(fixture.input.joinedConnections());
    }
    expect(root.session.model.entries).toHaveLength(0);
    const collector = gate();
    const withdrawn = withResolvers<void>();
    const direct = root.direct.submit;
    root.direct.submit = function* (source, onAdmitted) {
      yield* ensure(withdrawn.resolve);
      collector.enter();
      yield* collector.wait;
      return yield* direct(source, onAdmitted);
    };
    yield* scoped(function* () {
      const wire = yield* wireTo(fixture);
      yield* wire.send({ id: 1, request: { method: "submit" } });
      yield* collector.entered;
      yield* wire.send({
        id: 2,
        request: { method: "submit-source", submit: 1, text: "unread prefix", done: false },
      });
      yield* wire.send({ id: 3, request: { method: "status" } });
      expect(yield* replyTo(wire, 3)).toMatchObject({ kind: "value" });
    });
    yield* deadline(fixture.input.joinedConnections());
    yield* deadline(withdrawn.operation);
    root.direct.submit = direct;
    expect(root.session.model.entries).toHaveLength(0);
    const before = root.session.admits();
    expect(before.ok).toBe(true);
    let consumedPrefix = false;
    let rejectedPrefix = false;
    try {
      yield* root.direct.submit({
        *[Symbol.iterator]() {
          return {
            *next(): Operation<IteratorResult<string, void>> {
              if (!consumedPrefix) {
                consumedPrefix = true;
                return { done: false, value: "prefix that never executes" };
              }
              throw new Error("Controlled source subscription failure.");
            },
          };
        },
      });
    } catch {
      rejectedPrefix = true;
    }
    expect(consumedPrefix).toBe(true);
    expect(rejectedPrefix).toBe(true);
    expect(root.session.model.entries).toHaveLength(0);
    const transport = yield* SidekickTransport.expect();
    let connects = 0;
    yield* SidekickTransport.set({
      ...transport,
      *connect(path) {
        connects += 1;
        return yield* transport.connect(path);
      },
    });
    const records: SubmitRecord[] = [];
    const errors: string[] = [];
    const failed = yield* runReplSubmit(
      ["repl", "submit", "--attach", fixture.reference.sessionId, "-"],
      function* () {
        return Err(new Error("input failed with partial source"));
      },
      suspend(),
      function* (record) {
        records.push(record);
      },
      (message) => errors.push(message),
    );
    expect(failed).toBe(1);
    expect(connects).toBe(0);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    const empty = command(fixture, "");
    expect(yield* deadline(empty.run)).toBe(0);
    expect(empty.records.at(-1)).toMatchObject({ outcome: "completed", result: { value: "" } });
    expect(root.session.model.entries).toHaveLength(1);
    const ordinary = yield* root.session.submit("");
    if (!ordinary.ok) {
      throw ordinary.error;
    }
    expect(yield* ordinary.value.join()).toEqual(Ok(""));
    const usable = command(fixture, HOLD);
    expect(yield* deadline(usable.run)).toBe(0);
  });

  it("A/B: joins interrupted source credit and collector cleanup before its final record", function* () {
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    const cleanup = gate();
    const collecting = withResolvers<void>();
    const offered = withResolvers<void>();
    const rejected = withResolvers<void>();
    const interrupt = withResolvers<void>();
    yield* ensure(cleanup.release);
    const direct = root.direct.submit;
    root.direct.submit = function* (source, onAdmitted) {
      yield* ensure(function* () {
        cleanup.enter();
        yield* cleanup.wait;
      });
      collecting.resolve();
      yield* suspend();
      return yield* direct(source, onAdmitted);
    };
    const transport = yield* SidekickTransport.expect();
    yield* SidekickTransport.set({
      ...transport,
      *connect(path) {
        const connection = yield* transport.connect(path);
        return {
          ...connection,
          wire: {
            ...connection.wire,
            *send(frame) {
              yield* connection.wire.send(frame);
              const parsed = Envelope.parse(frame);
              if (parsed.request.method === "submit-source") {
                offered.resolve();
              }
            },
            *receive() {
              const reply = Reply.parse(yield* connection.wire.receive());
              if (reply.id === 2 && reply.kind === "error") {
                rejected.resolve();
              }
              return reply;
            },
          },
        };
      },
    });
    const call = command(fixture, HOLD, interrupt.operation);
    const task = yield* spawn(() => deadline(call.run));
    yield* deadline(collecting.operation);
    yield* deadline(offered.operation);
    interrupt.resolve();
    yield* deadline(cleanup.entered);
    yield* deadline(rejected.operation);
    cleanup.release();
    expect(yield* task).toBe(130);
    yield* deadline(fixture.input.joinedConnections());
    expect(call.records).toEqual([
      {
        kind: "finished",
        submission: null,
        joined: true,
        outcome: "interrupted",
        result: null,
        error: null,
        journal: null,
      },
    ]);
    expect(root.session.model.entries).toHaveLength(0);
    root.direct.submit = direct;
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
  });

  it("B: waits for owned cleanup after success and releases the shared slot afterwards", function* () {
    const cleanup = gate();
    let armed = false;
    yield* ensure(cleanup.release);
    yield* ReplEntryHost.set(function* () {
      const hold = armed;
      return {
        *install() {
          if (hold) {
            yield* ensure(function* () {
              cleanup.enter();
              yield* cleanup.wait;
            });
          }
        },
      };
    });
    const fixture = yield* useHeadlessFixture();
    armed = true;
    const first = command(fixture, HOLD);
    const running = yield* spawn(() => deadline(first.run));
    yield* cleanup.entered;
    expect(first.records.some((one) => one.kind === "finished")).toBe(false);
    const second = command(fixture, HOLD);
    expect(yield* deadline(second.run)).toBe(1);
    expect(second.records).toEqual([]);
    armed = false;
    cleanup.release();
    expect(yield* running).toBe(0);
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
  });

  it("B: interrupts unadmitted startup, joins its cleanup and releases its reservation", function* () {
    const startup = gate();
    const cleanup = gate();
    yield* ensure(() => {
      startup.release();
      cleanup.release();
    });
    let armed = false;
    yield* ReplEntryHost.set(function* () {
      if (armed) {
        yield* ensure(function* () {
          cleanup.enter();
          yield* cleanup.wait;
        });
        startup.enter();
        yield* startup.wait;
      }
      return {};
    });
    const fixture = yield* useHeadlessFixture();
    armed = true;
    const signal = withResolvers<void>();
    const call = command(fixture, HOLD, signal.operation);
    const task = yield* spawn(() => deadline(call.run));
    yield* startup.entered;
    signal.resolve();
    yield* cleanup.entered;
    expect(call.records).toEqual([]);
    expect(child(fixture).session.model.entries).toHaveLength(0);
    cleanup.release();
    expect(yield* task).toBe(130);
    expect(call.records).toEqual([
      {
        kind: "finished",
        submission: null,
        joined: true,
        outcome: "interrupted",
        result: null,
        error: null,
        journal: null,
      },
    ]);
    armed = false;
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
  });

  for (const holdAcknowledgement of [false, true]) {
    it(`B: retains exact admission before public acknowledgement and joins repeated Stop: ${holdAcknowledgement}`, function* () {
      const cleanup = gate();
      const acknowledgement = gate();
      yield* ensure(() => {
        cleanup.release();
        acknowledgement.release();
      });
      let armed = false;
      yield* ReplEntryHost.set(function* () {
        const hold = armed;
        return {
          *install() {
            if (hold) {
              yield* ensure(function* () {
                cleanup.enter();
                yield* cleanup.wait;
              });
            }
          },
        };
      });
      const fixture = yield* useHeadlessFixture();
      armed = true;
      const transport = yield* SidekickTransport.expect();
      let stops = 0;
      const root = child(fixture);
      const stop = root.session.stopEntry;
      root.session.stopEntry = function* (key) {
        stops += 1;
        return yield* stop(key);
      };
      yield* SidekickTransport.set({
        ...transport,
        *connect(path) {
          const connection = yield* transport.connect(path);
          return {
            ...connection,
            wire: {
              ...connection.wire,
              *receive() {
                const reply = yield* connection.wire.receive();
                const parsed = Reply.safeParse(reply);
                if (
                  holdAcknowledgement &&
                  parsed.success &&
                  parsed.data.kind === "update" &&
                  SubmitRecord.parse(parsed.data.value).kind === "admitted"
                ) {
                  acknowledgement.enter();
                  yield* acknowledgement.wait;
                }
                return reply;
              },
            },
          };
        },
      });
      const signal = withResolvers<void>();
      const call = command(fixture, QUESTION, signal.operation);
      const task = yield* spawn(() => deadline(call.run));
      if (holdAcknowledgement) {
        yield* acknowledgement.entered;
      } else {
        yield* call.admitted;
      }
      expect(root.session.model.entries).toHaveLength(1);
      signal.resolve();
      signal.resolve();
      yield* cleanup.entered;
      expect(stops).toBe(1);
      expect(call.records.some((one) => one.kind === "finished")).toBe(false);
      acknowledgement.release();
      cleanup.release();
      expect(yield* task).toBe(130);
      expect(call.records[0]?.kind).toBe("admitted");
      expect(call.records.at(-1)).toMatchObject({
        kind: "finished",
        submission: { entry: "entry-1" },
        outcome: "interrupted",
        journal: "cancelled",
      });
      armed = false;
      expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
    });
  }

  it("B: fixes natural completion and refuses late control without stopping a successor", function* () {
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    yield* scoped(function* () {
      const wire = yield* wireTo(fixture);
      yield* wire.send({ id: 1, request: { method: "submit" } });
      yield* wire.send({
        id: 2,
        request: { method: "submit-source", submit: 1, text: HOLD, done: true },
      });
      let final: SubmitRecord | undefined;
      while (final === undefined) {
        const reply = Reply.parse(yield* wire.receive());
        if (reply.id === 1 && reply.kind === "value") {
          final = SubmitRecord.parse(reply.value);
        }
      }
      expect(submitStatus(final)).toBe(0);
      const second = yield* root.session.submit(QUESTION);
      if (!second.ok) {
        throw second.error;
      }
      yield* wire.send({ id: 3, request: { method: "submit-interrupt", submit: 1 } });
      expect(yield* replyTo(wire, 3)).toMatchObject({ kind: "error" });
      expect(root.session.live).toBe(true);
      expect(root.session.printing?.entry).toBe("entry-2");
      yield* wire.send({ id: 1, request: { method: "submit" } });
      expect(yield* replyTo(wire, 1)).toMatchObject({ kind: "error" });
      expect(root.session.printing?.entry).toBe("entry-2");
      expect(submitStatus(final)).toBe(0);
      expect((yield* root.session.stopEntry(second.value.entry)).ok).toBe(true);
    });
  });

  for (const known of [false, true]) {
    it(`C: connection loss detaches observation without Stop or resubmission, known identity: ${known}`, function* () {
      const fixture = yield* useHeadlessFixture();
      const root = child(fixture);
      const transport = yield* SidekickTransport.expect();
      let stops = 0;
      const originalStop = root.session.stopEntry;
      root.session.stopEntry = function* (key) {
        stops += 1;
        return yield* originalStop(key);
      };
      let dropped = false;
      yield* SidekickTransport.set({
        ...transport,
        *connect(path) {
          const connection = yield* transport.connect(path);
          return {
            ...connection,
            wire: {
              ...connection.wire,
              *receive() {
                const value = yield* connection.wire.receive();
                const parsed = Reply.safeParse(value);
                if (
                  !dropped &&
                  parsed.success &&
                  parsed.data.id === 1 &&
                  parsed.data.kind === "update"
                ) {
                  const record = SubmitRecord.parse(parsed.data.value);
                  if (
                    (!known && record.kind === "admitted") ||
                    (known && record.kind === "progress")
                  ) {
                    dropped = true;
                    connection.wire.close();
                    throw new Error("Lost observation.");
                  }
                }
                return value;
              },
            },
          };
        },
      });
      const call = command(fixture, QUESTION);
      expect(yield* deadline(call.run)).toBe(2);
      yield* deadline(fixture.input.joinedConnections());
      expect(call.records.at(-1)).toMatchObject({
        kind: "unavailable",
        submission: known ? { entry: "entry-1" } : null,
      });
      expect(stops).toBe(0);
      expect(root.session.model.entries).toHaveLength(1);
      const questions = yield* root.session.elicitation.changes;
      while (root.session.elicitation.pending === undefined) {
        yield* questions.next();
      }
      root.session.elicitation.pending.submit({ decision: "continue" });
      expect((yield* root.session.join()).ok).toBe(true);
      expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
      expect(fixture.host.fake.prompts).toHaveLength(0);
    });
  }

  it("D: reports an ordinary failure separately from its failed journal", function* () {
    const fixture = yield* useHeadlessFixture();
    const call = command(fixture, "<AssertEquals actual={1} expected={2} />");
    expect(yield* deadline(call.run)).toBe(1);
    expect(call.errors).toEqual([]);
    expect(call.records.at(-1)).toMatchObject({
      kind: "finished",
      outcome: "failed",
      result: null,
      error: { name: "AssertionReport" },
      journal: "failed",
    });
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
  });

  it("D: retains a pre-agent fatal persistence failure and refuses successors", function* () {
    let armed = false;
    yield* ReplHost.around({
      *appendRecord([path, text], next) {
        const record = z.object({ type: z.string() }).passthrough().safeParse(JSON.parse(text));
        if (armed && record.success && record.data.type === "close") {
          throw new Error("Controlled fatal terminal persistence failure.");
        }
        yield* next(path, text);
      },
    });
    const fixture = yield* useHeadlessFixture();
    armed = true;
    const call = command(fixture, HOLD);
    expect(yield* deadline(call.run)).toBe(1);
    expect(call.records.at(-1)).toMatchObject({
      kind: "finished",
      submission: { entry: "entry-1" },
      outcome: "failed",
      journal: "unfinished",
    });
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(1);
    expect(child(fixture).session.model.entries).toHaveLength(1);
    expect(fixture.host.fake.prompts).toHaveLength(0);
  });

  it("D: owner loss before joined outcome reports unavailable rather than a reconstructed ending", function* () {
    const fixture = yield* useHeadlessFixture();
    const call = command(fixture, QUESTION);
    const task = yield* spawn(() => deadline(call.run));
    yield* call.admitted;
    yield* fixture.task.halt();
    expect(yield* task).toBe(2);
    expect(call.records.at(-1)).toMatchObject({
      kind: "unavailable",
      submission: { entry: "entry-1" },
    });
    expect(call.records.some((record) => record.kind === "finished")).toBe(false);
    expect(fixture.host.fake.prompts).toHaveLength(0);
  });

  it("D: actual cleanup failure outranks requested interruption", function* () {
    let armed = false;
    const cleanup = gate();
    yield* ReplEntryHost.set(function* () {
      const fail = armed;
      return {
        *install() {
          if (fail) {
            yield* ensure(() => {
              cleanup.enter();
              throw new Error("Controlled owned cleanup failure.");
            });
          }
        },
      };
    });
    const fixture = yield* useHeadlessFixture();
    armed = true;
    const signal = withResolvers<void>();
    const call = command(fixture, QUESTION, signal.operation);
    const running = yield* spawn(() => deadline(call.run));
    yield* call.admitted;
    signal.resolve();
    yield* cleanup.entered;
    expect(yield* running).toBe(1);
    expect(call.records.at(-1)).toMatchObject({
      kind: "finished",
      outcome: "failed",
      journal: "cancelled",
      error: { message: "Controlled owned cleanup failure." },
    });
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(1);
  });

  it("C: coalesces slow output observation while the session completes independently", function* () {
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    const writer = gate();
    yield* ensure(writer.release);
    let writes = 0;
    let outstanding = 0;
    let maximum = 0;
    let changes = 0;
    const output = yield* root.session.outputs;
    yield* spawn(function* () {
      while (!(yield* output.next()).done) {
        changes += 1;
      }
    });
    const records: SubmitRecord[] = [];
    const call = runReplSubmit(
      ["repl", "submit", "--attach", fixture.reference.sessionId, "-"],
      function* () {
        return Ok(
          Array.from(
            { length: 160 },
            (_, index) => `line ${index} 😀\n\n<AssertEquals actual={1} expected={1} />\n\n`,
          ).join(""),
        );
      },
      suspend(),
      function* (record) {
        writes += 1;
        outstanding += 1;
        maximum = Math.max(maximum, outstanding);
        if (writes === 1) {
          writer.enter();
          yield* writer.wait;
        }
        records.push(record);
        outstanding -= 1;
      },
      (message) => {
        throw new Error(message);
      },
    );
    const task = yield* spawn(() => deadline(call));
    yield* writer.entered;
    expect((yield* deadline(root.session.join())).ok).toBe(true);
    expect(changes).toBeGreaterThan(64);
    expect(writes).toBe(1);
    expect(maximum).toBe(1);
    expect(root.session.live).toBe(false);
    writer.release();
    expect(yield* task).toBe(0);
    yield* deadline(fixture.input.joinedConnections());
    expect(records[0]?.kind).toBe("admitted");
    expect(records.at(-1)).toMatchObject({ kind: "finished", outcome: "completed" });
    expect(records.length).toBeLessThan(64);
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
  });

  for (const submitter of ["person", "sidekick"]) {
    it(`E: shares the root reservation with ${submitter} and preserves composers`, function* () {
      const startup = gate();
      yield* ensure(startup.release);
      let armed = false;
      yield* ReplEntryHost.set(function* () {
        if (armed) {
          startup.enter();
          yield* startup.wait;
        }
        return {};
      });
      const fixture = yield* useHeadlessFixture();
      const root = child(fixture);
      const terminal = recordingTerminal();
      const ui = yield* spawn(function* () {
        yield* terminal.install();
        yield* attachChildUi(fixture.reference.sessionId);
      });
      yield* fixture.input.ready(terminal.terminal);
      if (submitter === "person") {
        armed = true;
        yield* fixture.input.input(terminal.terminal, "Person draft source.");
        yield* fixture.input.input(terminal.terminal, "\r");
      } else {
        fixture.host.fake.script({
          reply: "<REPL.EntryInput>Sidekick reserved source.</REPL.EntryInput><REPL.Submit />",
        });
        fixture.host.fake.script({ reply: "<Output>Sidekick done.</Output>" });
        armed = true;
        yield* spawn(() => root.owner.message("Submit the controlled source."));
      }
      yield* startup.entered;
      yield* fixture.input.input(terminal.terminal, "\t");
      const before = terminal.terminal.screen?.rows().join("\n");
      const refused = command(fixture, HOLD);
      expect(yield* deadline(refused.run)).toBe(1);
      expect(refused.records).toEqual([]);
      yield* fixture.input.ready(terminal.terminal);
      expect(terminal.terminal.screen?.rows().join("\n")).toBe(before);
      armed = false;
      startup.release();
      expect((yield* deadline(root.session.join())).ok).toBe(true);
      terminal.terminal.end();
      yield* ui;
      expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
    });
  }

  it("E: excludes a response-owned test slot until its joined cleanup ends", function* () {
    const test = gate();
    const cleanup = gate();
    yield* ensure(() => {
      test.release();
      cleanup.release();
    });
    const fixture = yield* useHeadlessFixture(undefined, undefined, undefined, undefined, {
      *testingHarness() {
        yield* ensure(function* () {
          cleanup.enter();
          yield* cleanup.wait;
        });
        test.enter();
        yield* test.wait;
        return {};
      },
    });
    const root = child(fixture);
    yield* ensureDir(`${root.workspace}/components`);
    yield* writeTextFile(
      `${root.workspace}/components/held.test.md`,
      '<Test name="pass"><AssertEquals actual={1} expected={1} /></Test>',
    );
    fixture.host.fake.script({ reply: '<REPL.Test path="components/held.test.md" />' });
    const message = yield* spawn(() => root.owner.message("Run the controlled isolated test."));
    yield* test.entered;
    const refused = command(fixture, HOLD);
    expect(yield* deadline(refused.run)).toBe(1);
    expect(refused.records).toEqual([]);
    const stopped = yield* spawn(() => root.owner.stop());
    yield* cleanup.entered;
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(1);
    cleanup.release();
    yield* stopped;
    yield* message;
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
  });

  it("E: direct admission leaves both composers and a human takeover untouched", function* () {
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    const terminal = recordingTerminal();
    const ui = yield* spawn(function* () {
      yield* terminal.install();
      yield* attachChildUi(fixture.reference.sessionId);
    });
    yield* fixture.input.ready(terminal.terminal);
    yield* fixture.input.input(terminal.terminal, "Human draft stays.");
    for (const label of ["BINDINGS", "SIDEKICK"]) {
      const rows = terminal.terminal.screen?.rows() ?? [];
      const row = rows.findIndex((one) => one.includes(label));
      const column = rows[row]?.indexOf(label) ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(column).toBeGreaterThanOrEqual(0);
      yield* fixture.input.input(terminal.terminal, `\x1b[<0;${column + 2};${row + 1}M`);
    }
    yield* fixture.input.input(terminal.terminal, "Unsent message stays.");
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
    yield* fixture.input.ready(terminal.terminal);
    const after = terminal.terminal.screen?.rows().join("\n") ?? "";
    expect(after).toContain("Human draft stays.");
    expect(after).toContain("Unsent message stays.");
    expect((yield* root.reads.fill("must refuse takeover")).ok).toBe(false);
    terminal.terminal.end();
    yield* ui;
  });

  it("E: rechecks live-head readiness after direct preflight and preserves newer edits", function* () {
    const preparation = gate();
    let holding = false;
    yield* ensure(preparation.release);
    yield* API.Fs.around({
      *readTextFile([path], next) {
        if (holding && path.endsWith("DirectGate.md")) {
          holding = false;
          preparation.enter();
          yield* preparation.wait;
        }
        return yield* next(path);
      },
    });
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    yield* ensureDir(`${root.workspace}/components`);
    yield* writeTextFile(`${root.workspace}/components/DirectGate.md`, "The gated component ran.");
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
    const point = numbered(root.session.navigation)[0];
    if (point === undefined) {
      throw new Error("No retained checkpoint to select.");
    }
    const terminal = recordingTerminal();
    const ui = yield* spawn(function* () {
      yield* terminal.install();
      yield* attachChildUi(fixture.reference.sessionId);
    });
    yield* fixture.input.ready(terminal.terminal);
    function* press(label: string): Operation<void> {
      yield* fixture.input.ready(terminal.terminal);
      const rows = terminal.terminal.screen?.rows() ?? [];
      const row = rows.findIndex((one) => one.includes(label));
      const column = rows[row]?.indexOf(label) ?? -1;
      if (row < 0 || column < 0) {
        throw new Error(`No ${label} control: ${rows.join("\n")}`);
      }
      yield* fixture.input.input(terminal.terminal, `\x1b[<0;${column + 2};${row + 1}M`);
    }
    holding = true;
    const call = command(fixture, "<DirectGate />");
    const task = yield* spawn(() => deadline(call.run));
    yield* preparation.entered;
    yield* fixture.input.input(terminal.terminal, "Newer human draft.");
    yield* press("[history]");
    yield* press(pointLabel(point.point, point.ordinal, point.entry));
    preparation.release();
    expect(yield* task).toBe(1);
    expect(call.records).toEqual([]);
    expect(root.session.model.entries).toHaveLength(1);
    yield* press("[close]");
    yield* press("[live]");
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
    yield* fixture.input.ready(terminal.terminal);
    expect(terminal.terminal.screen?.rows().join("\n")).toContain("Newer human draft.");
    terminal.terminal.end();
    yield* ui;
  });

  it("E: refuses unknown, mismatched and ended exact child references", function* () {
    const fixture = yield* useHeadlessFixture();
    const errors: string[] = [];
    const records: SubmitRecord[] = [];
    const call = (sessionId: string) =>
      runReplSubmit(
        ["repl", "submit", "--attach", sessionId, "-"],
        function* () {
          return Ok(HOLD);
        },
        suspend(),
        function* (record) {
          records.push(record);
        },
        (message) => errors.push(message),
      );
    expect(yield* deadline(call("00000000-0000-4000-8000-000000000002"))).toBe(1);
    const transport = yield* SidekickTransport.expect();
    yield* scoped(function* () {
      yield* SidekickTransport.set({
        ...transport,
        *connect(path) {
          const connection = yield* transport.connect(path);
          return {
            ...connection,
            descriptor: { ...connection.descriptor, owner: "different-owner" },
          };
        },
      });
      expect(yield* deadline(call(fixture.reference.sessionId))).toBe(1);
    });
    yield* scoped(function* () {
      const wire = yield* wireTo(fixture);
      for (const request of [
        { method: "submit-source", submit: 999, text: HOLD, done: true },
        { method: "submit-interrupt", submit: 999 },
      ]) {
        yield* wire.send({ id: 7, request });
        expect(yield* replyTo(wire, 7)).toMatchObject({ kind: "error" });
      }
    });
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
    const shutdown = yield* fixture.root.session.submit(
      "<XMD.Session.Shutdown sessionId={child.sessionId} />",
    );
    if (!shutdown.ok) {
      throw shutdown.error;
    }
    expect((yield* shutdown.value.join()).ok).toBe(true);
    expect(yield* deadline(call(fixture.reference.sessionId))).toBe(1);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(3);
  });

  it("F: reports its own buffered question and permission while unrelated Sidekick input remains separate", function* () {
    const fixture = yield* useHeadlessFixture();
    const root = child(fixture);
    fixture.host.fake.script({ reply: QUESTION });
    const unrelated = yield* spawn(() => root.owner.message("Ask an unrelated Sidekick question."));
    const sideChanges = yield* root.owner.questions.changes;
    while (root.owner.questions.pending === undefined) {
      yield* sideChanges.next();
    }
    const asking = withResolvers<void>();
    const own = command(
      fixture,
      `Documentation stays private.\n${QUESTION}\n<Output>Selected answer.</Output>`,
      suspend(),
      (record) => {
        if (record.kind === "progress" && record.waiting.questions === 1) {
          asking.resolve();
          expect(record.output).toEqual({ text: "", offset: 0, length: 0 });
        }
      },
    );
    const waiting = yield* spawn(() => deadline(own.run));
    yield* asking.operation;
    expect(root.owner.questions.pending).toBeDefined();
    expect(root.session.elicitation.pending).toBeDefined();
    root.session.elicitation.pending?.submit({ decision: "continue" });
    expect(yield* waiting).toBe(0);
    expect(JSON.stringify(own.records)).not.toContain("Documentation stays private");
    expect(
      own.records
        .filter((record) => record.kind === "progress")
        .every((record) => record.kind !== "progress" || record.waiting.questions <= 1),
    ).toBe(true);
    fixture.host.fake.script({ requestsTool: "Write", reply: "Own permission answered." });
    const permission = withResolvers<void>();
    const second = command(
      fixture,
      '<Agent name="scribe"><Session name="own"><Prompt text="Use a tool." /></Session></Agent>',
      suspend(),
      (record) => {
        if (record.kind === "progress" && record.waiting.permissions === 1) {
          permission.resolve();
          expect(record.waiting.questions).toBe(0);
        }
      },
    );
    const working = yield* spawn(() => deadline(second.run));
    yield* deadline(permission.operation);
    const request = root.session.agent.requests[0];
    if (request === undefined) {
      throw new Error("The entry owns no permission request.");
    }
    root.session.permissions.choose(request.key, request.choices[0]?.optionId ?? "");
    expect(yield* working).toBe(0);
    expect(root.owner.questions.pending).toBeDefined();
    yield* root.owner.stop();
    yield* unrelated;
    const ownQuestion = withResolvers<void>();
    const third = command(fixture, QUESTION, suspend(), (record) => {
      if (record.kind === "progress" && record.waiting.questions === 1) {
        ownQuestion.resolve();
      }
    });
    const thirdTask = yield* spawn(() => deadline(third.run));
    yield* deadline(ownQuestion.operation);
    fixture.host.fake.script({ requestsTool: "Unrelated Sidekick tool", reply: "unused" });
    const beforeNative = fixture.host.fake.prompts.length;
    yield* root.owner.message("Request the controlled denied native tool.");
    expect(fixture.host.fake.prompts).toHaveLength(beforeNative + 1);
    expect(root.session.agent.requests).toEqual([]);
    expect(root.session.elicitation.pending).toBeDefined();
    expect(
      third.records
        .filter((record) => record.kind === "progress")
        .every((record) => record.kind !== "progress" || record.waiting.permissions === 0),
    ).toBe(true);
    root.session.elicitation.pending?.submit({ decision: "continue" });
    expect(yield* thirdTask).toBe(0);
  });

  it("F: exposes a Unicode tail only after disclosure and keeps capture/documentation private", function* () {
    const cleanup = gate();
    let armed = false;
    yield* ensure(cleanup.release);
    yield* ReplEntryHost.set(function* () {
      const hold = armed;
      return {
        *install() {
          if (hold) {
            yield* ensure(function* () {
              cleanup.enter();
              yield* cleanup.wait;
            });
          }
        },
      };
    });
    const fixture = yield* useHeadlessFixture();
    armed = true;
    const output = '😀é\\"'.repeat(1500);
    const settling = withResolvers<void>();
    const call = command(
      fixture,
      `<Let as="hidden">private-capture-value</Let>\nDocumentation remains private.\n<Output>${output}</Output>`,
      suspend(),
      (record) => {
        if (record.kind === "progress" && record.head === "settling") {
          settling.resolve();
        }
      },
    );
    const task = yield* spawn(() => deadline(call.run));
    yield* cleanup.entered;
    yield* deadline(settling.operation);
    const snapshots = call.records.filter((record) => record.kind === "progress");
    expect(snapshots.length).toBeGreaterThan(0);
    for (const record of snapshots) {
      if (record.kind === "progress") {
        const points = Array.from(output);
        expect(Array.from(record.output.text).length).toBeLessThanOrEqual(4096);
        if (record.head === "settling") {
          expect(record.output).toEqual({
            text: points.slice(-4096).join(""),
            offset: points.length - 4096,
            length: points.length,
          });
        }
      }
    }
    expect(JSON.stringify(call.records)).not.toContain("private-capture-value");
    expect(JSON.stringify(call.records)).not.toContain("Documentation remains private");
    cleanup.release();
    expect(yield* task).toBe(0);
  });

  it("F: withholds a sensitive rendered candidate through the execution's existing scanner", function* () {
    const sensitive = ["withheld", "sensitive", "candidate"].join("-");
    let found = 0;
    yield* useSecretScannerFactory(() => ({
      *scan(text) {
        if (text.includes(sensitive)) {
          found += 1;
          return [
            {
              ruleId: "controlled",
              messageId: "SENSITIVE",
              location: { line: 1, column: 0 },
              fingerprint: "controlled",
            },
          ];
        }
        return [];
      },
    }));
    yield* registerComponents([
      {
        name: "Sensitive",
        origin: "direct-test",
        props: { type: "object", additionalProperties: false },
        *fn() {
          return sensitive;
        },
      },
    ]);
    const fixture = yield* useHeadlessFixture();
    const call = command(fixture, "<Sensitive />");
    expect(yield* deadline(call.run)).toBe(1);
    expect(found).toBeGreaterThan(0);
    expect(JSON.stringify(call.records)).not.toContain(sensitive);
    for (const record of call.records) {
      if (record.kind === "progress") {
        expect(record.output.text).toBe("");
      }
    }
  });

  it("D/H: known canonical failure keeps status 1 when final output delivery is lost", function* () {
    const fixture = yield* useHeadlessFixture();
    const records: SubmitRecord[] = [];
    let canonicalFailure = false;
    const status = yield* deadline(
      runReplSubmit(
        ["repl", "submit", "--attach", fixture.reference.sessionId, "-"],
        function* () {
          return Ok("<AssertEquals actual={1} expected={2} />");
        },
        suspend(),
        function* (record) {
          if (record.kind === "finished" && record.outcome === "failed") {
            canonicalFailure = true;
            throw new Error("Controlled final writer loss.");
          }
          records.push(record);
        },
        (message) => {
          throw new Error(message);
        },
      ),
    );
    expect(canonicalFailure).toBe(true);
    expect(status).toBe(1);
    expect(records.at(-1)).toMatchObject({ kind: "unavailable", submission: { entry: "entry-1" } });
  });

  it("H: preserves a known canonical failure when its oversized final becomes unavailable", function* () {
    const message = '😀"\\\n'.repeat(150000);
    yield* registerComponents([
      {
        name: "LargeFailure",
        origin: "direct-test",
        props: { type: "object", additionalProperties: false },
        *fn() {
          throw new Error(message);
        },
      },
    ]);
    const fixture = yield* useHeadlessFixture();
    const call = command(fixture, "<LargeFailure />");
    expect(yield* deadline(call.run)).toBe(1);
    expect(call.errors).toEqual([]);
    expect(call.records.at(-1)).toMatchObject({
      kind: "unavailable",
      submission: { entry: "entry-1" },
    });
    expect(new TextEncoder().encode(JSON.stringify(call.records.at(-1))).length).toBeLessThan(1024);
  });

  it("H: bounds encoded final delivery and preserves known failure status", function* () {
    const fixture = yield* useHeadlessFixture();
    const reference = {
      sessionId: fixture.reference.sessionId,
      execution: child(fixture).execution,
      entry: "entry-1",
    };
    const envelope = (value: string) => ({
      id: 1,
      kind: "value",
      value: {
        kind: "finished",
        submission: reference,
        joined: true,
        outcome: "completed",
        result: { value },
        error: null,
        journal: "completed",
      },
    });
    const prefix = '😀"\\\n'.repeat(10);
    const encoder = new TextEncoder();
    const oversized =
      prefix + "x".repeat(MAX_FRAME - encoder.encode(JSON.stringify(envelope(prefix))).length);
    expect(encoder.encode(JSON.stringify(envelope(oversized)) + "\n").length).toBe(MAX_FRAME + 1);
    const transport = yield* SidekickTransport.expect();
    let delivered: Reply | undefined;
    yield* SidekickTransport.set({
      ...transport,
      *connect(path) {
        const connection = yield* transport.connect(path);
        return {
          ...connection,
          wire: {
            ...connection.wire,
            *receive() {
              const reply = Reply.parse(yield* connection.wire.receive());
              if (reply.id === 1 && reply.kind !== "update") {
                delivered = reply;
              }
              return reply;
            },
          },
        };
      },
    });
    const source = `---\nreturns: {type: string}\n---\n<Return value={${JSON.stringify(oversized)}} />`;
    const call = command(fixture, source);
    expect(yield* deadline(call.run)).toBe(2);
    expect(call.records.filter((one) => one.kind === "finished")).toEqual([]);
    const final = SubmitRecord.parse(call.records.at(-1));
    expect(final).toMatchObject({
      kind: "unavailable",
      submission: { sessionId: fixture.reference.sessionId, entry: "entry-1" },
    });
    expect(delivered).toMatchObject({ id: 1, kind: "value", value: final });
    expect(new TextEncoder().encode(JSON.stringify(final)).length).toBeLessThan(1024);
    expect(submitStatus(final)).toBe(2);
    expect(submitStatus(final, true)).toBe(1);
    expect(yield* deadline(command(fixture, HOLD).run)).toBe(0);
    const frames = [...sourceFrames(source)];
    expect(
      frames
        .map((frame) => new TextEncoder().encode(JSON.stringify(frame)).length)
        .every((size) => size <= MAX_FRAME),
    ).toBe(true);
  });
});
