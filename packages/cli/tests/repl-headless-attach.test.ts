import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createSignal, race, scoped, sleep, spawn } from "effection";
import type { Operation, Scope } from "effection";
import { api } from "effection/experimental";
import { attachChildUi } from "../src/headless/ui.ts";
import { ReplTerminal } from "../src/repl/terminal.ts";
import { useReplScreen } from "../src/repl/screen.ts";
import { Reply, SidekickTransport } from "../src/sidekick-acp/protocol.ts";
import { applied, physical, presentation } from "../src/headless/ui-schema.ts";
import { attachmentDescriptor, requestAttachment } from "../src/sidekick-acp/client.ts";
import { useHeadlessFixture, START_CHILD, promptChild } from "./support/headless-repl.ts";
import { recordingTerminal } from "./support/mounted-repl.ts";
import type { Terminal } from "./support/mounted-repl.ts";
import { z } from "zod";
import { useTerminalScreen } from "./support/terminal-screen.ts";
import { withResolvers } from "effection";
import { XmdResponse } from "@executablemd/acp";

type AppliedFrames = WeakMap<Terminal, () => Operation<void>>;

function* observeAppliedFrames(terminal: Terminal, appliedFrames: AppliedFrames): Operation<void> {
  const transport = yield* SidekickTransport.expect();
  const applied = createSignal<void, void>();
  const changes = yield* applied;
  let acknowledged = 0;
  appliedFrames.set(terminal, function* () {
    while (acknowledged < terminal.drawn) {
      yield* changes.next();
    }
  });
  yield* SidekickTransport.set({
    ...transport,
    *connect(path) {
      const connected = yield* transport.connect(path);
      const wire = connected.wire;
      return {
        ...connected,
        wire: {
          ...wire,
          *send(value) {
            const frame = appliedAcknowledgement(value);
            const drawn = terminal.drawn;
            yield* wire.send(value);
            if (frame) {
              acknowledged = drawn;
              applied.send();
            }
          },
        },
      };
    },
  });
}

function appliedAcknowledgement(value: unknown): boolean {
  const parsed = applied.safeParse(value);
  return parsed.success && parsed.data.applied;
}

function visible(terminal: Terminal, text: string, appliedFrames?: AppliedFrames): Operation<void> {
  return race([
    (function* () {
      while (true) {
        const applied = appliedFrames?.get(terminal);
        if (applied !== undefined) {
          yield* applied();
        }
        if (terminal.screen?.rows().join("\n").includes(text)) {
          return;
        }
        yield* terminal.after(terminal.drawn);
      }
    })(),
    (function* (): Operation<never> {
      yield* sleep(10000);
      console.error(`Waiting for ${text}: ${terminal.screen?.rows().join("\n")}`);
      throw new Error(
        `The attached screen did not show ${JSON.stringify(text)}: ${terminal.screen?.rows().join("\n")}`,
      );
    })(),
  ]);
}

function* locate(
  terminal: Terminal,
  label: string,
  appliedFrames: AppliedFrames,
): Operation<{ row: number; column: number }> {
  const applied = appliedFrames.get(terminal);
  if (applied !== undefined) {
    yield* applied();
  }
  const rows = terminal.screen?.rows() ?? [];
  const matches = rows.flatMap((text, row) => {
    const column = text.indexOf(label);
    return column < 0 ? [] : [{ row, column }];
  });
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Expected one ${label}: ${rows.join("\n")}`);
  }
  return matches[0];
}

function pressAt(terminal: Terminal, at: { row: number; column: number }): void {
  terminal.feed(`\x1b[<0;${at.column + 1};${at.row + 1}M`);
}

function* press(terminal: Terminal, label: string, appliedFrames: AppliedFrames): Operation<void> {
  pressAt(terminal, yield* locate(terminal, label, appliedFrames));
}

describe("headless renderer lifetime", () => {
  it("releases every detached renderer scope while the exact child remains live", function* () {
    const live = new Set<Scope>();
    const parents = new WeakMap<Scope, Scope>();
    const changed = createSignal<void, void>();
    yield* api.Scope.around({
      create([parent], next) {
        const result = next(parent);
        live.add(result[0]);
        parents.set(result[0], parent);
        changed.send();
        return result;
      },
      *destroy([scope], next) {
        try {
          yield* next(scope);
        } finally {
          // Parent teardown also joins children whose destructor bypasses Scope.destroy.
          for (const held of live) {
            let ancestor: Scope | undefined = held;
            while (ancestor !== undefined && ancestor !== scope) {
              ancestor = parents.get(ancestor);
            }
            if (ancestor === scope) {
              live.delete(held);
            }
          }
          changed.send();
        }
      },
    });
    const held = yield* useHeadlessFixture();
    for (let cycle = 0; cycle < 4; cycle++) {
      const baseline = new Set(live);
      const terminal = recordingTerminal();
      const ui = yield* spawn(function* () {
        yield* terminal.install();
        yield* attachChildUi(held.reference.sessionId);
      });
      yield* visible(terminal.terminal, "[detach]");
      if (cycle > 0) {
        const first = yield* scoped(function* () {
          const screen = yield* useTerminalScreen(terminal.terminal.size);
          // Opening ReplScreen writes terminal modes before the first frame.
          screen.feed(terminal.terminal.presented[1] ?? new Uint8Array());
          return screen.rows().join("\n");
        });
        expect(first).toContain("retained renderer draft");
      }
      if (cycle === 0) {
        terminal.terminal.feed("retained renderer draft");
      }
      yield* visible(terminal.terminal, "retained renderer draft");
      const attached = [...live].filter((scope) => !baseline.has(scope));
      expect(attached.length).toBeGreaterThan(0);
      terminal.terminal.end();
      yield* ui;
      // The first frame mounts the root-owned tree; later generations reuse it.
      if (cycle > 0) {
        yield* race([
          (function* () {
            const changes = yield* changed;
            while (attached.some((scope) => live.has(scope))) {
              yield* changes.next();
            }
          })(),
          (function* () {
            yield* sleep(5000);
            throw new Error(
              `Detached UI retained ${attached.filter((scope) => live.has(scope)).length} scopes`,
            );
          })(),
        ]);
      }
      expect(terminal.terminal.readers).toBe(0);
      expect(terminal.terminal.listeners).toBe(0);
      expect(yield* attachmentDescriptor(held.path)).toEqual(held.descriptor);
    }
    yield* held.task.halt();
  });
});

describe("headless live UI", () => {
  it("H4/H5/J3: attached UI and capable ACP share the actual conditional question and permission owners", function* () {
    const appliedFrames = new WeakMap<Terminal, () => Operation<void>>();
    const conditional = {
      type: "object",
      additionalProperties: false,
      properties: {
        decision: { type: "string", enum: ["approve", "reject"] },
        reason: { type: "string" },
      },
      required: ["decision"],
      if: {
        properties: { decision: { type: "string", const: "approve" } },
        required: ["decision"],
      },
      then: { required: ["reason"], properties: { reason: { type: "string", minLength: 8 } } },
    };
    const questionAddress = withResolvers<{ requestId: string; presentationId: string }>();
    const permissionAddress = withResolvers<{ requestId: string; presentationId: string }>();
    const held = yield* useHeadlessFixture(
      (input) => {
        const original = input.onElicitation;
        if (original === undefined) {
          throw new Error("The capable embedded callback is absent.");
        }
        return {
          ...input,
          onElicitation(request, context) {
            questionAddress.resolve(
              z
                .object({ requestId: z.string(), presentationId: z.string() })
                .passthrough()
                .parse(request._meta?.["executablemd.xmd-question/v1"]),
            );
            return original(request, context);
          },
        };
      },
      undefined,
      undefined,
      {
        permission(request) {
          permissionAddress.resolve(
            z
              .object({ requestId: z.string(), presentationId: z.string() })
              .strict()
              .parse(request.raw._meta?.["executablemd.xmd-permission/v1"]),
          );
        },
      },
    );
    const bindingEntry =
      '<Let as="sharedToken" value="same-live-child-binding" /><Output>{sharedToken}</Output>';
    held.host.fake.script({
      reply: `<Let as="code" select="code">\n\x60\x60\x60xmd\n${bindingEntry}\n\x60\x60\x60\n</Let><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`,
    });
    held.host.fake.script({
      reply: `<Elicit as="answer" schema={${JSON.stringify(conditional)}}>Shared conditional question.</Elicit>`,
    });
    held.host.fake.script({ reply: "<Output>Shared question completed.</Output>" });
    const questions = yield* held.root.session.elicitation.changes;
    const asking = yield* held.root.session.submit(
      promptChild("Ask the shared conditional question."),
    );
    if (!asking.ok) {
      throw asking.error;
    }
    let pending = held.root.session.elicitation.pending;
    while (pending === undefined) {
      pending = (yield* questions.next()).value;
    }
    const address = yield* questionAddress.operation;
    const old = z
      .object({ presentationId: z.string() })
      .passthrough()
      .parse(
        yield* requestAttachment(held.path, {
          method: "child-offer",
          requestId: address.requestId,
        }),
      );
    const terminal = recordingTerminal();
    let holdSubmit: { row: number; column: number } | undefined;
    const interceptedSubmit = withResolvers<z.infer<typeof physical>>();
    const releaseSubmit = withResolvers<void>();
    const deliveredSubmit = withResolvers<void>();
    const ui = yield* spawn(function* () {
      yield* terminal.install();
      yield* observeAppliedFrames(terminal.terminal, appliedFrames);
      const transport = yield* SidekickTransport.expect();
      yield* SidekickTransport.set({
        ...transport,
        *connect(path) {
          const connected = yield* transport.connect(path);
          const wire = connected.wire;
          return {
            ...connected,
            wire: {
              ...wire,
              *send(value) {
                const packet = physical.safeParse(value);
                if (
                  holdSubmit !== undefined &&
                  packet.success &&
                  packet.data.kind === "pointer" &&
                  packet.data.at.row === holdSubmit.row &&
                  packet.data.at.column === holdSubmit.column
                ) {
                  holdSubmit = undefined;
                  interceptedSubmit.resolve(packet.data);
                  console.log(JSON.stringify({ observation: "late-ui-press-held", packet: value }));
                  yield* releaseSubmit.operation;
                  yield* wire.send(value);
                  deliveredSubmit.resolve();
                } else {
                  yield* wire.send(value);
                }
              },
            },
          };
        },
      });
      yield* attachChildUi(held.reference.sessionId);
    });
    yield* visible(terminal.terminal, "[answer sidekick]", appliedFrames);
    const retainedOutput = yield* requestAttachment(held.path, {
      method: "entry",
      entry: 1,
      view: "output",
    });
    const retainedSource = yield* requestAttachment(held.path, {
      method: "entry",
      entry: 1,
      view: "source",
    });
    expect(JSON.stringify(retainedOutput)).toContain("same-live-child-binding");
    const sourcePage = z
      .object({
        text: z.string(),
        execution: z.string(),
        conversation: z.string(),
        entry: z.number(),
        status: z.string(),
      })
      .passthrough()
      .parse(retainedSource);
    expect(sourcePage.text).toBe(bindingEntry);
    expect(sourcePage).toMatchObject({
      execution: held.descriptor.execution,
      conversation: held.descriptor.conversation,
      entry: 1,
      status: "completed",
    });
    yield* press(terminal.terminal, "Entries", appliedFrames);
    yield* visible(terminal.terminal, ">   1. [ok]", appliedFrames);
    const selecting = terminal.terminal.drawn;
    yield* press(terminal.terminal, "1. [ok]", appliedFrames);
    yield* terminal.terminal.after(selecting);
    yield* visible(terminal.terminal, "Enter submits · Type here", appliedFrames);
    const switching = terminal.terminal.drawn;
    yield* press(terminal.terminal, "BINDINGS", appliedFrames);
    yield* terminal.terminal.after(switching);
    yield* visible(terminal.terminal, "sharedToken =", appliedFrames);
    yield* visible(terminal.terminal, "same-live-child-binding", appliedFrames);
    yield* press(terminal.terminal, "SIDEKICK", appliedFrames);
    yield* visible(terminal.terminal, "[answer sidekick]", appliedFrames);

    expect((yield* attachmentDescriptor(held.path)).conversation).toBe(
      held.descriptor.conversation,
    );
    yield* press(terminal.terminal, "[answer sidekick]", appliedFrames);
    yield* visible(terminal.terminal, "[submit]", appliedFrames);
    yield* visible(terminal.terminal, "Shared conditional question.", appliedFrames);
    yield* visible(terminal.terminal, "Enter answers", appliedFrames);
    yield* press(terminal.terminal, "( ) approve", appliedFrames);
    yield* visible(terminal.terminal, "(x) approve", appliedFrames);
    yield* press(terminal.terminal, "[submit]", appliedFrames);
    yield* visible(terminal.terminal, "must have required property 'reason'", appliedFrames);
    yield* visible(terminal.terminal, "Shared conditional question.", appliedFrames);
    expect(held.root.session.elicitation.pending).toBe(pending);
    const retainedSubmit = yield* locate(terminal.terminal, "[submit]", appliedFrames);
    holdSubmit = retainedSubmit;
    pressAt(terminal.terminal, retainedSubmit);
    const lateUiPacket = yield* interceptedSubmit.operation;
    expect(lateUiPacket).toEqual({ kind: "pointer", at: retainedSubmit });
    expect(held.root.session.elicitation.pending).toBe(pending);
    expect(pending.submit({ decision: "approve", reason: "reviewed" }).kind).toBe("answered");
    const answered = yield* asking.value.join();
    if (!answered.ok) {
      throw answered.error;
    }
    expect(held.root.session.elicitation.pending).toBeUndefined();
    yield* visible(terminal.terminal, "Shared question completed.", appliedFrames);
    const joinedOutput = z.string().parse(answered.value);
    const promptsBeforeLateUi = held.host.fake.prompts.length;
    const questionsBeforeLateUi = held.root.session.elicitation.asked;
    const afterLate = terminal.terminal.drawn;
    releaseSubmit.resolve();
    yield* deliveredSubmit.operation;
    yield* terminal.terminal.after(afterLate);
    expect(held.root.session.elicitation.pending).toBeUndefined();
    expect(held.root.session.elicitation.asked).toBe(questionsBeforeLateUi);
    expect(held.host.fake.prompts).toHaveLength(promptsBeforeLateUi);
    expect(yield* asking.value.join()).toEqual(answered);
    expect(joinedOutput).toContain("Shared question completed.");
    expect(held.host.fake.prompts.at(-1)).toContain('"reason": "reviewed"');
    const afterStaleTarget = terminal.terminal.drawn;
    pressAt(terminal.terminal, retainedSubmit);
    yield* terminal.terminal.after(afterStaleTarget);
    yield* visible(terminal.terminal, "Shared question completed.", appliedFrames);
    expect(terminal.terminal.screen?.rows().join("\n")).not.toContain("[submit]");
    expect(held.root.session.elicitation.pending).toBeUndefined();
    const stale = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "question",
        requestId: address.requestId,
        presentationId: old.presentationId,
        value: { action: "accept", content: { decision: "reject" } },
      }),
    );
    expect(stale).toMatchObject({ event: "response", outcome: "stale" });
    const source =
      '<Agent name="scribe"><Session name="tool"><Prompt>Use the native tool.</Prompt></Session></Agent>';
    held.host.fake.script({
      reply: `<Let as="code" select="code">\n\x60\x60\x60xmd\n${source}\n\x60\x60\x60\n</Let><REPL.EntryInput>{code}</REPL.EntryInput><REPL.Submit />`,
    });
    held.host.fake.script({ requestsTool: "Write", reply: "Synthetic native work completed." });
    held.host.fake.script({ reply: "<Output>Permission round completed.</Output>" });
    const working = yield* held.root.session.submit(promptChild("Run the permission entry."));
    if (!working.ok) {
      throw working.error;
    }
    const permission = yield* permissionAddress.operation;
    const stalePermission = z
      .object({ presentationId: z.string() })
      .passthrough()
      .parse(
        yield* requestAttachment(held.path, {
          method: "child-offer",
          requestId: permission.requestId,
        }),
      );
    expect(stalePermission.presentationId).not.toBe(permission.presentationId);
    yield* visible(terminal.terminal, "asks: Write", appliedFrames);
    yield* press(terminal.terminal, "asks: Write", appliedFrames);
    yield* visible(terminal.terminal, "[Allow]", appliedFrames);
    yield* visible(terminal.terminal, "Enter decides", appliedFrames);
    terminal.terminal.feed("\r");
    const completed = yield* working.value.join();
    if (!completed.ok) {
      throw completed.error;
    }
    const late = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "permission",
        requestId: permission.requestId,
        presentationId: stalePermission.presentationId,
        value: { outcome: { outcome: "selected", optionId: "allow" } },
      }),
    );
    expect(late).toMatchObject({ event: "response", outcome: "stale" });
    expect(held.host.fake.decisions).toEqual(["allow_once"]);
    console.log(
      JSON.stringify({
        journey: "J3",
        sessionId: held.reference.sessionId,
        execution: held.descriptor.execution,
        conversation: held.descriptor.conversation,
        selectedEntry: 1,
        sharedBinding: "same-live-child-binding",
        historyComparedThroughAcp: true,
        question: {
          requestId: address.requestId,
          invalidUiStayedPending: true,
          correctedEmbedded: true,
          lateUiPacket,
          lateUiDeliveredAfterJoin: true,
          lateUiChangedAnswerOrSuccessor: false,
          stale: stale.event === "response" ? stale.outcome : stale.event,
        },
        permission: {
          requestId: permission.requestId,
          uiChoice: "allow_once",
          stale: late.event === "response" ? late.outcome : late.event,
        },
      }),
    );
    terminal.terminal.end();
    yield* ui;
    yield* held.task.halt();
  });
  it("H2/J2: an active parent keeps every draft frame, input owner and terminal mode through child startup, work, failure and Shutdown", function* () {
    const held = yield* useHeadlessFixture();
    const parent = recordingTerminal();
    const attached = yield* spawn(function* () {
      yield* parent.install();
      yield* held.view.connect(yield* useReplScreen());
    });
    yield* visible(parent.terminal, "[detach]");
    parent.terminal.feed("parent draft remains");
    yield* visible(parent.terminal, "parent draft remains");
    const baseline = parent.terminal.drawn;
    const readers = parent.terminal.readers;
    const listeners = parent.terminal.listeners;
    const start = yield* held.root.session.submit(
      START_CHILD.replace('as="child"', 'as="another"'),
    );
    if (!start.ok) {
      throw start.error;
    }
    const started = yield* start.value.join();
    if (!started.ok) {
      throw started.error;
    }
    held.host.fake.script({ reply: "<Output>Child completed work.</Output>" });
    const work = yield* held.root.session.submit(
      promptChild("Perform child work.").replaceAll("child.sessionId", "another.sessionId"),
    );
    if (!work.ok) {
      throw work.error;
    }
    const worked = yield* work.value.join();
    if (!worked.ok) {
      throw worked.error;
    }
    held.host.fake.script({ reply: "partial child failure", stopReason: "max_tokens" });
    const failure = yield* held.root.session.submit(
      promptChild("Exercise child failure.").replaceAll("child.sessionId", "another.sessionId"),
    );
    if (!failure.ok) {
      throw failure.error;
    }
    expect((yield* failure.value.join()).ok).toBe(false);
    const shutdown = yield* held.root.session.submit(
      "<XMD.Session.Shutdown sessionId={another.sessionId} />",
    );
    if (!shutdown.ok) {
      throw shutdown.error;
    }
    const stopped = yield* shutdown.value.join();
    if (!stopped.ok) {
      throw stopped.error;
    }
    expect(parent.terminal.raw).toEqual([true]);
    expect(parent.terminal.readers).toBe(readers);
    expect(parent.terminal.listeners).toBe(listeners);
    const observed = yield* useTerminalScreen(parent.terminal.size);
    for (const [index, bytes] of parent.terminal.presented.entries()) {
      observed.feed(bytes);
      if (index >= baseline) {
        expect(observed.rows().join("\n")).toContain("parent draft remains");
        expect(observed.rows().join("\n")).toContain("Type here");
      }
    }
    parent.terminal.feed(" editable");
    yield* visible(parent.terminal, "parent draft remains editable");
    console.log(
      JSON.stringify({
        journey: "J2",
        terminal: "real ReplScreen over owned recording terminal and xterm emulator",
        observedFrames: parent.terminal.presented.length - baseline,
        raw: parent.terminal.raw,
        readers,
        listeners,
        draftAndFocusPreserved: true,
      }),
    );
    parent.terminal.end();
    yield* attached;
    expect(parent.terminal.readers).toBe(0);
    expect(parent.terminal.listeners).toBe(0);
    yield* held.task.halt();
  });
  it("H4: refuses takeover, retains the draft and advances once across EOF and reattachment", function* () {
    const held = yield* useHeadlessFixture();
    const first = recordingTerminal();
    const ui = yield* spawn(function* () {
      yield* first.install();
      yield* attachChildUi(held.reference.sessionId);
    });
    yield* visible(first.terminal, "[detach]");
    first.terminal.feed("draft retained");
    yield* visible(first.terminal, "draft retained");
    const second = recordingTerminal();
    const refused = yield* scoped(function* () {
      yield* second.install();
      try {
        yield* attachChildUi(held.reference.sessionId);
      } catch (error) {
        return String(error);
      }
      throw new Error("A second UI took over the live child.");
    });
    expect(refused).toContain("already has an interactive UI");
    expect(second.terminal.raw).toEqual([]);
    expect(first.terminal.raw).toEqual([true]);
    first.terminal.end();
    yield* ui;
    expect(first.terminal.readers).toBe(0);
    expect(first.terminal.listeners).toBe(0);
    expect(first.terminal.raw).toEqual([true, false]);
    held.host.fake.script({ reply: "<Output>effect happened once</Output>" });
    held.host.fake.script({ reply: "<Output>Detached work finished.</Output>" });
    const mapping = z
      .object({ attachment: z.string() })
      .strict()
      .parse(yield* requestAttachment(held.path, { method: "attach", cwd: held.descriptor.cwd }));
    yield* requestAttachment(held.path, {
      method: "prompt",
      attachment: mapping.attachment,
      text: "Complete detached work.",
    });
    const third = recordingTerminal();
    const reattached = yield* spawn(function* () {
      yield* third.install();
      yield* attachChildUi(held.reference.sessionId);
    });
    yield* visible(third.terminal, "draft retained");
    expect(held.host.fake.prompts).toHaveLength(1);
    const beforeWheel = third.terminal.drawn;
    third.terminal.feed("\x1b[<65;110;15M");
    yield* third.terminal.after(beforeWheel);
    yield* visible(third.terminal, "draft retained");
    const rows = third.terminal.screen?.rows() ?? [];
    const row = rows.findIndex((one) => one.includes("[detach]"));
    const column = rows[row]?.indexOf("[detach]") ?? -1;
    expect(row).toBeGreaterThanOrEqual(0);
    expect(column).toBeGreaterThanOrEqual(0);
    third.terminal.feed(`\x1b[<0;${column + 2};${row + 1}M`);
    yield* reattached;
    expect(third.terminal.readers).toBe(0);
    expect(third.terminal.listeners).toBe(0);
    yield* held.task.halt();
  });

  it("H4: applies numbered frames only at matching dimensions and releases an outstanding frame on loss", function* () {
    const held = yield* useHeadlessFixture();
    yield* scoped(function* () {
      const { wire, descriptor } = yield* (yield* SidekickTransport.expect()).connect(held.path);
      yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
      expect(Reply.parse(yield* wire.receive()).kind).toBe("value");
      yield* wire.send({ id: 1, request: { method: "ui", size: { columns: 120, rows: 30 } } });
      expect(Reply.parse(yield* wire.receive()).kind).toBe("value");
      let frame = presentation.parse(yield* wire.receive());
      const projected = yield* useTerminalScreen(frame.size);
      projected.feed(Uint8Array.from(frame.bytes));
      const row = projected.rows().findIndex((one) => one.includes("[detach]"));
      const column = projected.rows()[row]?.indexOf("[detach]") ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(column).toBeGreaterThanOrEqual(0);
      yield* wire.send({ kind: "pointer", at: { column, row } });
      yield* wire.send({ kind: "wheel", at: { column: 90, row: 12 }, direction: "down" });
      yield* wire.send({
        kind: "input",
        event: { kind: "text", text: "same-size input survived" },
      });
      yield* wire.send({
        kind: "applied",
        sequence: frame.sequence,
        size: frame.size,
        applied: true,
      });
      do {
        frame = presentation.parse(yield* wire.receive());
        projected.feed(Uint8Array.from(frame.bytes));
        yield* wire.send({
          kind: "applied",
          sequence: frame.sequence,
          size: frame.size,
          applied: true,
        });
      } while (!projected.rows().join("\n").includes("same-size input survived"));
      expect(projected.rows().join("\n")).toContain("[detach]");
      expect((yield* attachmentDescriptor(held.path)).execution).toBe(held.descriptor.execution);
      yield* wire.send({ kind: "eof" });
      let end = Reply.safeParse(yield* wire.receive());
      while (!end.success) {
        end = Reply.safeParse(yield* wire.receive());
      }
      expect(end.data).toMatchObject({ kind: "value", value: { detached: true } });
    });
    yield* scoped(function* () {
      const { wire, descriptor } = yield* (yield* SidekickTransport.expect()).connect(held.path);
      yield* wire.send({ id: 0, request: { method: "hello", descriptor } });
      expect(Reply.parse(yield* wire.receive()).kind).toBe("value");
      yield* wire.send({ id: 1, request: { method: "ui", size: { columns: 120, rows: 30 } } });
      expect(Reply.parse(yield* wire.receive()).kind).toBe("value");
      const old = presentation.parse(yield* wire.receive());
      expect(old.sequence).toBe(1);
      const unapplied = yield* useTerminalScreen(old.size);
      unapplied.feed(Uint8Array.from(old.bytes));
      const row = unapplied.rows().findIndex((one) => one.includes("[detach]"));
      const column = unapplied.rows()[row]?.indexOf("[detach]") ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(column).toBeGreaterThanOrEqual(0);
      yield* wire.send({ kind: "pointer", at: { column, row } });
      yield* wire.send({ kind: "wheel", at: { column: 90, row: 12 }, direction: "down" });
      yield* wire.send({ kind: "resize", size: { columns: 100, rows: 26 } });
      yield* wire.send({
        kind: "applied",
        sequence: old.sequence,
        size: { columns: 100, rows: 26 },
        applied: false,
      });
      const resized = presentation.parse(yield* wire.receive());
      expect(resized.sequence).toBe(2);
      expect(resized.size).toEqual({ columns: 100, rows: 26 });
      const released = Reply.parse(yield* wire.receive());
      expect(released).toMatchObject({ kind: "value", value: { detached: true } });
      expect((yield* attachmentDescriptor(held.path)).execution).toBe(held.descriptor.execution);
    });
    const recovered = recordingTerminal();
    const applying = withResolvers<void>();
    const release = withResolvers<void>();
    const refused = withResolvers<void>();
    const acknowledged = withResolvers<void>();
    const acknowledgements: z.infer<typeof applied>[] = [];
    const transport = yield* SidekickTransport.expect();
    const next = yield* spawn(function* () {
      yield* recovered.install();
      yield* SidekickTransport.set({
        ...transport,
        *connect(path) {
          const connected = yield* transport.connect(path);
          const wire = connected.wire;
          return {
            ...connected,
            wire: {
              ...wire,
              *send(value) {
                const parsed = applied.safeParse(value);
                if (parsed.success) {
                  acknowledgements.push(parsed.data);
                  if (parsed.data.applied) {
                    acknowledged.resolve();
                  } else {
                    refused.resolve();
                  }
                }
                yield* wire.send(value);
              },
            },
          };
        },
      });
      let writes = 0;
      yield* ReplTerminal.around({
        *write([bytes], next) {
          if (writes === 1) {
            applying.resolve();
            yield* release.operation;
          }
          writes += 1;
          yield* next(bytes);
        },
      });
      yield* attachChildUi(held.reference.sessionId);
    });
    yield* applying.operation;
    expect(acknowledgements).toEqual([]);
    recovered.terminal.resized({ columns: 100, rows: 26 });
    release.resolve();
    yield* refused.operation;
    expect(acknowledgements[0]).toMatchObject({
      sequence: 1,
      size: { columns: 100, rows: 26 },
      applied: false,
    });
    yield* acknowledged.operation;
    expect(acknowledgements.at(-1)).toMatchObject({
      size: { columns: 100, rows: 26 },
      applied: true,
    });
    yield* visible(recovered.terminal, "[detach]");
    recovered.terminal.end();
    yield* next;
    yield* held.task.halt();
  });
});
