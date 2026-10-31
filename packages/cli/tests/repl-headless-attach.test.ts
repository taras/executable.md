import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { race, scoped, sleep, spawn } from "effection";
import type { Operation } from "effection";
import { attachChildUi } from "../src/headless/ui.ts";
import { useReplScreen } from "../src/repl/screen.ts";
import { Reply, SidekickTransport } from "../src/sidekick-acp/protocol.ts";
import { presentation } from "../src/headless/ui-schema.ts";
import { attachmentDescriptor, requestAttachment } from "../src/sidekick-acp/client.ts";
import { useHeadlessFixture, START_CHILD, promptChild } from "./support/headless-repl.ts";
import { recordingTerminal } from "./support/mounted-repl.ts";
import type { Terminal } from "./support/mounted-repl.ts";
import { z } from "zod";
import { useTerminalScreen } from "./support/terminal-screen.ts";
import { withResolvers } from "effection";
import { XmdResponse } from "@executablemd/acp";

function visible(terminal: Terminal, text: string): Operation<void> {
  return race([
    (function* () {
      while (!terminal.screen?.rows().join("\n").includes(text)) {
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

function press(terminal: Terminal, label: string): void {
  const rows = terminal.screen?.rows() ?? [];
  const matches = rows.flatMap((text, row) => {
    const column = text.indexOf(label);
    return column < 0 ? [] : [{ row, column }];
  });
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Expected one ${label}: ${rows.join("\n")}`);
  }
  terminal.feed(`\x1b[<0;${matches[0].column + 1};${matches[0].row + 1}M`);
}

describe("headless live UI", () => {
  it("H4/H5/J3: attached UI and capable ACP share the actual conditional question and permission owners", function* () {
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
    const ui = yield* spawn(function* () {
      yield* terminal.install();
      yield* attachChildUi(held.reference.sessionId);
    });
    yield* visible(terminal.terminal, "[answer sidekick]");
    expect((yield* attachmentDescriptor(held.path)).conversation).toBe(
      held.descriptor.conversation,
    );
    press(terminal.terminal, "[answer sidekick]");
    yield* visible(terminal.terminal, "[submit]");
    yield* visible(terminal.terminal, "Shared conditional question.");
    press(terminal.terminal, "( ) approve");
    yield* visible(terminal.terminal, "(x) approve");
    const before = terminal.terminal.drawn;
    press(terminal.terminal, "[submit]");
    yield* terminal.terminal.after(before);
    expect(held.root.session.elicitation.pending).toBe(pending);
    expect(pending.submit({ decision: "approve", reason: "reviewed" }).kind).toBe("answered");
    const answered = yield* asking.value.join();
    if (!answered.ok) {
      throw answered.error;
    }
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
    yield* visible(terminal.terminal, "asks: Write");
    press(terminal.terminal, "asks: Write");
    yield* visible(terminal.terminal, "[Allow]");
    press(terminal.terminal, "[Allow]");
    const completed = yield* working.value.join();
    if (!completed.ok) {
      throw completed.error;
    }
    const late = XmdResponse.parse(
      yield* requestAttachment(held.path, {
        method: "child-response",
        kind: "permission",
        requestId: permission.requestId,
        presentationId: permission.presentationId,
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
        question: {
          requestId: address.requestId,
          invalidUiStayedPending: true,
          correctedEmbedded: true,
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
    const next = yield* spawn(function* () {
      yield* recovered.install();
      yield* attachChildUi(held.reference.sessionId);
    });
    yield* visible(recovered.terminal, "[detach]");
    recovered.terminal.end();
    yield* next;
    yield* held.task.halt();
  });
});
