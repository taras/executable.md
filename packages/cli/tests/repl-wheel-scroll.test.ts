import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep } from "effection";
import type { Operation } from "effection";
import { useReplPage } from "./support/repl-page.ts";
import type { PageKey, ReplPage, ScreenCell } from "./support/repl-page.ts";

function* key(page: ReplPage, name: PageKey): Operation<void> {
  const before = page.screen().index;
  yield* page.key(name);
  yield* page.until(`write after ${name}`, (one) => one.index > before);
  yield* sleep(30);
}

function* wheel(page: ReplPage, direction: "up" | "down", at: ScreenCell): Operation<void> {
  const before = page.screen().index;
  yield* page.wheel(direction, at);
  yield* page.until(`write after wheel ${direction}`, (one) => one.index > before);
  yield* sleep(30);
}

function firstChatRow(page: ReplPage): number {
  for (const row of page.screen().rows) {
    const match = /Chat row (\d+)/.exec(row);
    if (match !== null) {
      return Number(match[1]);
    }
  }
  throw new Error(`no numbered chat row: ${page.describe()}`);
}

function* typed(page: ReplPage, text: string): Operation<void> {
  yield* page.type(text);
  yield* page.until(`typed ${text}`, (one) => one.shows(text));
}

describe("wheel real consumers", () => {
  it("permission explanation is readable in both directions without deciding", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const explanation = [
      "PERMISSION-BEGIN",
      ...Array.from({ length: 40 }, (_, at) => `Permission explanation ${at}`),
      "PERMISSION-END",
    ].join("\n");
    page.repl.fake.script({
      reply: "Permission turn complete",
      requestsTool: explanation,
      manual: true,
    });
    yield* page.type('<Session name="permission"><Prompt text="permission-witness" /></Session>');
    yield* page.until("entry source ready", (one) => one.shows("</Session>"));
    yield* page.key("Enter");
    yield* page.until("pending permission", (one) => one.shows("asks: PERMISSION-BEGIN"));
    yield* page.press("asks: PERMISSION-BEGIN");
    yield* page.until("first permission choice", (one) => one.shows("> [Allow]"));
    expect(page.screen().shows("[Reject]")).toBe(true);
    for (let step = 0; step < 5; step += 1) {
      yield* key(page, "PageUp");
    }
    expect(page.screen().shows("Permission explanation 0")).toBe(true);
    expect(page.screen().shows("PERMISSION-END")).toBe(false);
    const cell = page.screen().locate("Permission explanation 0");
    yield* wheel(page, "down", cell);
    expect(page.screen().shows("Permission explanation 0")).toBe(false);
    expect(page.screen().shows("Permission explanation 2")).toBe(true);
    yield* wheel(page, "up", cell);
    expect(page.screen().shows("Permission explanation 0")).toBe(true);
    for (let tick = 0; tick < 20; tick += 1) {
      yield* wheel(page, "down", cell);
    }
    expect(page.screen().shows("Permission explanation 39")).toBe(true);
    expect(page.screen().shows("PERMISSION-END")).toBe(true);
    expect(page.screen().shows("[close]")).toBe(true);
    for (let tick = 0; tick < 20; tick += 1) {
      yield* wheel(page, "up", cell);
    }
    expect(page.screen().shows("Permission explanation 0")).toBe(true);
    expect(page.screen().shows("PERMISSION-END")).toBe(false);
    for (let step = 0; step < 8; step += 1) {
      yield* key(page, "PageDown");
    }
    expect(page.screen().shows("PERMISSION-END")).toBe(true);
    expect(page.repl.fake.decisions).toHaveLength(0);
    expect(page.repl.fake.prompts).toHaveLength(1);
  });

  it("selected work scrolls under Draft and keeps its exact keyboard route", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    yield* page.type(Array.from({ length: 70 }, (_, at) => `Work row ${at}`).join("\n"));
    yield* page.until("source ready", (one) => one.shows("Work row 69"));
    yield* page.key("Enter");
    yield* page.until("work settled", (one) => one.shows("Ready for Entry 2"));
    yield* typed(page, "draft-kept");
    const at = page.screen().locate("Work row 0");
    yield* wheel(page, "down", at);
    expect(page.screen().shows("Work row 0")).toBe(false);
    expect(page.screen().shows("Work row 3")).toBe(true);
    yield* wheel(page, "up", at);
    expect(page.screen().shows("Work row 0")).toBe(true);
    yield* key(page, "Backtab");
    yield* key(page, "Alt+ArrowDown");
    yield* key(page, "End");
    expect(page.screen().shows("Work row 69")).toBe(true);
    yield* key(page, "Home");
    expect(page.screen().shows("Work row 0")).toBe(true);
    yield* key(page, "PageDown");
    yield* key(page, "PageUp");
    expect(page.screen().shows("Work row 0")).toBe(true);
    expect(page.screen().shows("draft-kept")).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(0);
  });

  it("Configure keeps its Agent caret under wheel and nested History", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    page.repl.fake.configuration({
      model: {
        selected: "model-0",
        choices: Array.from({ length: 40 }, (_, at) => ({
          id: `model-${at}`,
          name: `Model choice ${at}`,
        })),
      },
      effort: { "model-0": { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });
    yield* page.press("[configure scribe]");
    yield* page.until("Configure open", (one) => one.shows("Agent: scribe"));
    yield* key(page, "ArrowLeft");
    yield* key(page, "Tab");
    const cell = page.screen().locate("Agent: scribe");
    yield* wheel(page, "down", cell);
    expect(page.screen().shows("Agent: scribe")).toBe(false);
    yield* wheel(page, "up", cell);
    expect(page.screen().shows("Agent: scribe")).toBe(true);
    for (let tick = 0; tick < 24; tick += 1) {
      yield* wheel(page, "down", cell);
    }
    expect(page.screen().shows("Model choice 39")).toBe(true);
    for (let tick = 0; tick < 24; tick += 1) {
      yield* wheel(page, "up", cell);
    }
    yield* key(page, "Backtab");
    yield* page.type("X");
    yield* page.until("Agent retained caret", (one) => one.shows("Agent: scribXe"));
    yield* page.press("[history]");
    yield* page.until(
      "nested History",
      (one) => one.shows("History") && !one.shows("Agent: scribXe"),
    );
    yield* page.key("Escape");
    yield* page.until("Configure restored", (one) => one.shows("Agent: scribXe"));
    yield* key(page, "Tab");
    yield* key(page, "Backtab");
    yield* page.type("Y");
    yield* page.until("Agent caret after coverage", (one) => one.shows("Agent: scribXYe"));
    expect(page.repl.fake.prompts).toHaveLength(0);
  });

  it("Sidekick question retains values while scrolling and closing its held form", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const preview = Array.from({ length: 45 }, (_, at) => `Side question ${at}`).join("\n");
    page.repl.fake.script({
      reply: `<Elicit as="response" schema={{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false}}>${preview}</Elicit>`,
    });
    for (let at = 0; at < 3; at += 1) {
      yield* key(page, "Tab");
    }
    yield* typed(page, "question please");
    yield* page.key("Enter");
    yield* page.until("Sidekick waiting", (one) => one.shows("[answer sidekick]"));
    yield* page.press("[answer sidekick]");
    yield* page.until("Sidekick form", (one) => one.shows("[submit]"));
    yield* typed(page, "held-value");
    yield* key(page, "Tab");
    const cell = page.screen().locate("= held-value");
    yield* wheel(page, "up", cell);
    expect(page.screen().shows("held-value")).toBe(false);
    yield* wheel(page, "down", cell);
    expect(page.screen().shows("held-value")).toBe(true);
    yield* key(page, "Backtab");
    for (let at = 0; at < 8; at += 1) {
      yield* key(page, "PageUp");
    }
    expect(page.screen().shows("Side question 0")).toBe(true);
    const previewCell = page.screen().locate("Side question 0");
    const seen: string[] = [];
    for (let tick = 0; tick < 24; tick += 1) {
      yield* wheel(page, "down", previewCell);
      seen.push(...page.screen().rows);
    }
    expect(seen.join("\n")).toContain("Side question 22");
    expect(seen.join("\n")).toContain("Side question 44");
    expect(page.screen().shows("held-value")).toBe(true);
    yield* page.key("Escape");
    yield* page.until(
      "closed held question",
      (one) =>
        one.shows("[answer sidekick]") &&
        !one.shows("[submit]") &&
        one.shows("Enter or click activates"),
    );
    yield* page.press("[answer sidekick]");
    yield* page.until("reopened held value", (one) => one.shows("held-value"));
    expect(page.screen().shows("[submit]")).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(1);
  });

  it("Transcript scrolls independently and keyboard reveals its last real turn", function* () {
    const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
    for (let at = 0; at < 3; at += 1) {
      yield* key(page, "Tab");
    }
    for (let at = 0; at < 18; at += 1) {
      page.repl.fake.script({ reply: `<Output>Reply witness ${at}</Output>` });
      yield* typed(page, `turn-${String(at).padStart(2, "0")}`);
      yield* page.key("Enter");
      yield* page.until(
        `turn ${at} completed`,
        (one) => one.shows(`Reply witness ${at}`) && !one.shows("[stop]"),
      );
    }
    yield* typed(page, "message-kept");
    const cell = page.screen().locate("turn-00");
    yield* wheel(page, "down", cell);
    expect(page.screen().shows("turn-00")).toBe(false);
    yield* wheel(page, "up", cell);
    expect(page.screen().shows("turn-00")).toBe(true);
    for (let tick = 0; tick < 30; tick += 1) {
      yield* wheel(page, "down", cell);
    }
    expect(page.screen().found("turn-17")).toBeGreaterThan(0);
    for (let tick = 0; tick < 30; tick += 1) {
      yield* wheel(page, "up", cell);
    }
    expect(page.screen().shows("turn-00")).toBe(true);
    expect(page.screen().shows("message-kept")).toBe(true);
    // Message -> History -> Transcript; its fixed entry is the selector.
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* key(page, "Alt+ArrowDown");
    for (let row = 0; row < 17; row += 1) {
      yield* key(page, "ArrowDown");
    }
    expect(page.screen().shows("> [U] turn-17")).toBe(true);
    expect(page.screen().shows("[Back to current chat]")).toBe(false);
    expect(page.repl.fake.prompts).toHaveLength(18);
  });

  it("retained binding reads both ends and reopens at its own position", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const value = Array.from({ length: 60 }, (_, at) => `Binding row ${at}`);
    yield* page.type(`<Let as="retained" value={${JSON.stringify(value)}} />`);
    yield* page.until("binding source ready", (one) => one.shows("Binding row 59"));
    yield* page.key("Enter");
    yield* page.until("binding retained", (one) => one.shows("Ready for Entry 2"));
    yield* page.press("Entries");
    yield* page.until("catalog", (one) => one.shows("[close]"));
    yield* page.press("1. [");
    yield* page.until("entry selected", (one) => !one.shows("[close]"));
    yield* page.press("BINDINGS");
    yield* page.until("binding opener", (one) => one.shows("retained ="));
    yield* page.press("retained =");
    yield* page.until(
      "binding drawer",
      (one) =>
        one.shows("Binding row 0") && one.shows("[close]") && one.shows("Enter does nothing"),
    );
    const cell = page.screen().locate('"Binding row 0"', { after: "Binding · retained" });
    yield* wheel(page, "down", cell);
    expect(page.screen().found('"Binding row 0"', { after: "Binding · retained" }) > 0).toBe(false);
    yield* wheel(page, "up", cell);
    expect(page.screen().found('"Binding row 0"', { after: "Binding · retained" }) > 0).toBe(true);
    yield* key(page, "End");
    expect(page.screen().shows('"Binding row 59"')).toBe(true);
    yield* page.key("Escape");
    yield* page.until("binding closed", (one) => !one.shows("[close]"));
    yield* page.press("retained =");
    yield* page.until(
      "binding held end",
      (one) =>
        one.shows('"Binding row 59"') && one.shows("[close]") && one.shows("Enter does nothing"),
    );
    yield* key(page, "Home");
    expect(page.screen().found('"Binding row 0"', { after: "Binding · retained" }) > 0).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(0);
  });

  it("retained multiline string fits complete JSON rows before wheel admission", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const value =
      "VALUE-BEGIN\n" +
      Array.from({ length: 180 }, (_, at) => `Value line ${at}`).join("\n") +
      "\nVALUE-END";
    yield* page.type(`<Let as="retained" value={${JSON.stringify(value)}} />`);
    yield* page.until("string source ready", (one) => one.shows("VALUE-END"));
    yield* page.key("Enter");
    yield* page.until("string retained", (one) => one.shows("Ready for Entry 2"));
    yield* page.press("Entries");
    yield* page.until("string catalog", (one) => one.shows("[close]"));
    yield* page.press("1. [");
    yield* page.until("string entry selected", (one) => !one.shows("[close]"));
    yield* page.press("BINDINGS");
    yield* page.until("string opener", (one) => one.shows("retained ="));
    yield* page.press("retained =");
    yield* page.until(
      "string reading owning its keys",
      (one) => one.shows("Binding · retained") && one.shows("Enter does nothing"),
    );
    const scope = { after: "Binding · retained" };
    expect(page.screen().found('"VALUE-BEGIN\\n', scope)).toBe(1);
    expect(page.screen().found("VALUE-END", scope)).toBe(0);
    const cell = page.screen().locate("VALUE-BEGIN", scope);
    yield* wheel(page, "down", cell);
    expect(page.screen().found("VALUE-BEGIN", scope)).toBe(0);
    yield* wheel(page, "up", cell);
    expect(page.screen().found("VALUE-BEGIN", scope)).toBe(1);
    for (let tick = 0; tick < 30; tick += 1) {
      yield* wheel(page, "down", cell);
    }
    expect(page.screen().found('VALUE-END"', scope)).toBe(1);
    yield* key(page, "End");
    expect(page.screen().found('VALUE-END"', scope)).toBe(1);
    yield* page.key("Escape");
    yield* page.until("string closed", (one) => !one.shows("[close]"));
    yield* page.press("retained =");
    yield* page.until(
      "string end held on reopen",
      (one) =>
        one.shows("Binding · retained") &&
        one.found('VALUE-END"', scope) === 1 &&
        one.shows("Enter does nothing"),
    );
    yield* key(page, "Home");
    expect(page.screen().found('"VALUE-BEGIN\\n', scope)).toBe(1);
    expect(page.repl.fake.prompts).toHaveLength(0);
    expect(page.screen().shows("[close]")).toBe(true);
  });

  for (const size of [
    { columns: 160, rows: 36 },
    { columns: 120, rows: 30 },
  ]) {
    it(`Sidekick chat retains composer caret and follows only at the tail at ${size.columns}x${size.rows}`, function* () {
      const page = yield* useReplPage({ size });
      yield* typed(page, "draft-kept");
      yield* key(page, "Tab");
      yield* key(page, "Tab");
      yield* key(page, "Tab");
      const rows = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, at) => `Chat row ${from + at}`).join("\n");
      page.repl.fake.script({
        deltas: [`<Output>${rows(0, 40)}`, `\n${rows(40, 60)}`, `\n${rows(60, 80)}</Output>`],
        holdsEachPiece: true,
      });
      yield* typed(page, "read this");
      yield* page.key("Enter");
      yield* page.repl.fake.streamingTurns(1);
      yield* page.until("live row 39", (one) => one.shows("Chat row 39"));
      yield* typed(page, "message-kept");
      yield* key(page, "ArrowLeft");
      const cell = page.screen().locate("Chat row 39");
      const start = firstChatRow(page);
      yield* wheel(page, "up", cell);
      expect(firstChatRow(page)).toBe(start - 3);
      const trailing = { column: cell.column + 20, row: cell.row };
      yield* wheel(page, "up", trailing);
      expect(firstChatRow(page)).toBe(start - 6);
      yield* wheel(page, "down", trailing);
      expect(firstChatRow(page)).toBe(start - 3);
      yield* page.type("!");
      yield* page.until("retained Message caret", (one) => one.shows("message-kep!t"));
      const inspected = firstChatRow(page);
      page.repl.fake.releaseDeltas();
      yield* page.repl.fake.streamingTurns(1);
      yield* sleep(60);
      expect(firstChatRow(page)).toBe(inspected);
      expect(page.screen().shows("Chat row 59")).toBe(false);
      for (let tick = 0; tick < 16; tick += 1) {
        yield* wheel(page, "down", trailing);
      }
      yield* page.until("new tail reached", (one) => one.shows("Chat row 59"));
      page.repl.fake.releaseDeltas();
      yield* page.until("following resumed", (one) => one.shows("Chat row 79"));
      yield* page.until("turn completed", (one) => !one.shows("[stop]"));
      expect(page.screen().shows("draft-kept")).toBe(true);
      expect(page.screen().shows("message-kep!t")).toBe(true);
      expect(page.screen().found("[↑ earlier]", { rightOf: "BINDINGS" }) > 0).toBe(false);
      expect(page.screen().found("[↓ later]", { rightOf: "BINDINGS" }) > 0).toBe(false);
      expect(page.repl.fake.prompts).toHaveLength(1);
      expect(page.screen().shows("No entry yet")).toBe(true);
      // Message -> History -> Transcript -> Selected work -> Draft.
      for (let step = 0; step < 4; step += 1) {
        yield* key(page, "Tab");
      }
      yield* key(page, "ArrowLeft");
      const tail = page.screen().locate("Chat row 79");
      yield* wheel(page, "up", tail);
      yield* page.type("?");
      yield* page.until("retained Draft caret", (one) => one.shows("draft-kep?t"));
      expect(page.screen().shows("message-kep!t")).toBe(true);
      expect(page.repl.fake.prompts).toHaveLength(1);
    });
  }

  for (const size of [
    { columns: 120, rows: 30 },
    { columns: 72, rows: 20 },
  ]) {
    it(`entry question pages from a control-only enum window and wheel keeps its focused value at ${size.columns}x${size.rows}`, function* () {
      const page = yield* useReplPage({ size });
      const choices = Array.from({ length: 35 }, (_, at) => `pick-${at}`);
      const preview = Array.from({ length: 40 }, (_, at) => `Preview row ${at}`).join("\n");
      const schema = {
        type: "object",
        properties: {
          decision: { type: "string", enum: choices },
          final: { type: "string", description: "Final field witness" },
        },
        required: ["decision", "final"],
        additionalProperties: false,
      };
      yield* page.type(
        `<Elicit as="response" schema={${JSON.stringify(schema)}}>${preview}</Elicit>`,
      );
      yield* page.until("source prepared", (one) => one.shows("</Elicit>"));
      yield* page.key("Enter");
      yield* page.until("entry waiting", (one) => one.shows("[answer]"));
      yield* page.press("[answer]");
      yield* page.until("question opened", (one) => one.shows("[submit]") && one.shows("pick-34"));
      expect(page.screen().shows("Preview row 0")).toBe(false);
      yield* page.type("pick-34");
      yield* page.until("enum value typed", (one) => one.shows("= pick-34"));
      const option = page.screen().locate("(x) pick-34");
      const firstChoice = () => {
        for (const row of page.screen().rows) {
          const match = /\([ x]\) pick-(\d+)/.exec(row);
          if (match !== null) {
            return Number(match[1]);
          }
        }
        throw new Error(`no enum choice: ${page.describe()}`);
      };
      const first = firstChoice();
      yield* key(page, "Tab");
      yield* wheel(page, "up", option);
      expect(firstChoice()).toBe(first - 3);
      yield* wheel(page, "down", option);
      expect(firstChoice()).toBe(first);
      yield* key(page, "Backtab");
      yield* key(page, "Home");
      yield* key(page, "ArrowRight");
      yield* wheel(page, "up", option);
      const visible = page.screen().rows.filter((row) => row.includes("( ) pick-"));
      for (let tick = 0; tick < 2; tick += 1) {
        yield* wheel(page, "up", option);
      }
      expect(page.screen().rows.filter((row) => row.includes("( ) pick-"))).toEqual(visible);
      yield* page.type("!");
      yield* page.until("wheel kept the field and caret", (one) => one.shows("p!ick-34"));
      for (let pageNo = 0; pageNo < 90 && !page.screen().shows("Preview row 0"); pageNo += 1) {
        yield* key(page, "PageUp");
      }
      expect(page.screen().shows("Preview row 0")).toBe(true);
      expect(page.screen().shows("[submit]")).toBe(true);
      expect(page.screen().shows("[close]")).toBe(true);
      for (
        let pageNo = 0;
        pageNo < 90 && !page.screen().shows("Final field witness");
        pageNo += 1
      ) {
        yield* key(page, "PageDown");
      }
      expect(page.screen().shows("Final field witness")).toBe(true);
      for (let pageNo = 0; pageNo < 90 && !page.screen().shows("p!ick-34"); pageNo += 1) {
        yield* key(page, "PageUp");
      }
      expect(page.screen().shows("p!ick-34")).toBe(true);
      yield* key(page, "PageUp");
      yield* wheel(page, "down", { column: option.column + 15, row: option.row });
      expect(page.screen().shows("[submit]")).toBe(true);
      yield* page.key("Escape");
      yield* page.until(
        "question closed without answering",
        (one) => one.shows("[answer]") && !one.shows("[close]"),
      );
      expect(page.repl.fake.prompts).toHaveLength(0);
    });
  }
});
