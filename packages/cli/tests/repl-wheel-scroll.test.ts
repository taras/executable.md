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
      yield* key(page, "Home");
      yield* key(page, "ArrowRight");
      const option = page.screen().locate("(x) pick-34");
      const visible = page.screen().rows.filter((row) => row.includes("( ) pick-"));
      for (let tick = 0; tick < 3; tick += 1) {
        yield* wheel(page, "up", option);
      }
      expect(page.screen().rows.filter((row) => row.includes("( ) pick-"))).toEqual(visible);
      yield* page.type("!");
      yield* page.until("wheel kept the field and caret", (one) => one.shows("p!ick-34"));
      for (let pageNo = 0; pageNo < 12 && !page.screen().shows("Preview row 0"); pageNo += 1) {
        yield* key(page, "PageUp");
      }
      expect(page.screen().shows("Preview row 0")).toBe(true);
      expect(page.screen().shows("[submit]")).toBe(true);
      expect(page.screen().shows("[close]")).toBe(true);
      for (
        let pageNo = 0;
        pageNo < 16 && !page.screen().shows("Final field witness");
        pageNo += 1
      ) {
        yield* key(page, "PageDown");
      }
      expect(page.screen().shows("Final field witness")).toBe(true);
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
