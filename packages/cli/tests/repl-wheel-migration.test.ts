import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep } from "effection";
import type { Operation } from "effection";
import { useReplPage } from "./support/repl-page.ts";
import type { PageKey, ReplPage, ScreenCell } from "./support/repl-page.ts";
import {
  sendMessage,
  openConfigure,
  replaceAgent,
  applyConfigure,
} from "./support/screen-journeys.ts";
import { OTHER_MOUNTED_AGENT } from "./support/mounted-repl.ts";
import { REFERENCE_DIRECTORY } from "./fixtures/repl/reference.ts";

function* key(page: ReplPage, name: PageKey): Operation<void> {
  const before = page.screen().index;
  yield* page.key(name);
  yield* page.until(`write after ${name}`, (one) => one.index > before);
  yield* sleep(30);
}
function* wheel(page: ReplPage, direction: "up" | "down", at: ScreenCell): Operation<void> {
  const before = page.screen().index;
  yield* page.wheel(direction, at);
  yield* page.until(`write after ${direction}`, (one) => one.index > before);
  yield* sleep(30);
}
function* ticks(
  page: ReplPage,
  direction: "up" | "down",
  at: ScreenCell,
  count: number,
): Operation<void> {
  for (let tick = 0; tick < count; tick += 1) {
    yield* wheel(page, direction, at);
  }
}
function catalogRow(page: ReplPage, order: number): string {
  const match = page.screen().rows.find((row) => new RegExp(`(?:^|\\s)${order}\\. \\[`).test(row));
  if (match === undefined) {
    throw new Error(page.describe());
  }
  return match;
}
function hasCatalogRow(page: ReplPage, order: number): boolean {
  return page.screen().rows.some((row) => new RegExp(`(?:^|\\s)${order}\\. \\[`).test(row));
}
function absentButtons(page: ReplPage): void {
  for (const label of ["[↑ earlier]", "[↓ later]", "[Scroll up]", "[Scroll down]"]) {
    expect(page.screen().shows(label)).toBe(false);
  }
}

describe("wheel remaining migration journeys", () => {
  it("permission pages from a control-only window to its explanation and final choice", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const explanation = Array.from(
      { length: 45 },
      (_, at) => `Permission prose ${String(at).padStart(2, "0")}`,
    ).join("\n");
    page.repl.fake.script({
      requestsTool: explanation,
      manual: true,
      permissionChoices: Array.from({ length: 40 }, (_, at) => ({
        optionId: `allow-${at}`,
        name: `Choice ${String(at).padStart(2, "0")}`,
        kind: "allow_once",
      })),
    });
    yield* page.type('<Session name="permission"><Prompt text="many choices" /></Session>');
    yield* page.until("source", (one) => one.shows("</Session>"));
    yield* page.key("Enter");
    yield* page.until("permission pending", (one) => one.shows("asks: Permission prose 00"));
    yield* page.press("asks: Permission prose 00");
    yield* page.until("first option", (one) => one.shows("> [Choice 00]"));
    expect(page.screen().shows("Permission prose 44")).toBe(false);
    const choice = page.screen().locate("[Choice 00]");
    yield* ticks(page, "down", choice, 8);
    expect(page.screen().shows("> [Choice 00]")).toBe(true);
    for (let at = 0; at < 39; at += 1) {
      yield* key(page, "ArrowDown");
    }
    expect(page.screen().shows("> [Choice 39]")).toBe(true);
    expect(page.repl.fake.decisions).toHaveLength(0);
    for (let at = 0; at < 39; at += 1) {
      yield* key(page, "ArrowUp");
    }
    for (let at = 0; at < 8; at += 1) {
      yield* key(page, "PageUp");
    }
    expect(page.screen().shows("Permission prose 00")).toBe(true);
    const prose = page.screen().locate("Permission prose 01");
    yield* wheel(page, "down", prose);
    expect(page.screen().shows("Permission prose 03")).toBe(true);
    yield* wheel(page, "up", prose);
    expect(page.screen().shows("Permission prose 00")).toBe(true);
    for (let at = 0; at < 16; at += 1) {
      yield* key(page, "PageDown");
    }
    expect(page.screen().shows("[Choice 39]")).toBe(true);
    expect(page.screen().shows("[close]")).toBe(true);
    expect(page.repl.fake.decisions).toHaveLength(0);
    for (let at = 0; at < 8; at += 1) {
      yield* key(page, "PageUp");
    }
    expect(page.screen().shows("Permission prose 00")).toBe(true);
    absentButtons(page);
    for (let at = 0; at < 16; at += 1) {
      yield* key(page, "PageDown");
    }
    yield* page.press("[Choice 39]");
    yield* page.until("deliberate permission choice", () => page.repl.fake.decisions.length === 1);
    expect(page.repl.fake.prompts).toHaveLength(1);
  });

  it("narrow catalog reveals nested scopes and its final entry without selecting on wheel", function* () {
    const page = yield* useReplPage({
      size: { columns: 72, rows: 20 },
      includes: [REFERENCE_DIRECTORY],
    });
    for (let at = 1; at <= 8; at += 1) {
      const title =
        at === 1
          ? Array.from(
              { length: 70 },
              (_, row) => `Nested work ${String(row).padStart(2, "0")}`,
            ).join("\n")
          : `Catalog work ${at}`;
      yield* page.type(
        `<Checklist title={${JSON.stringify(title)}} steps={${at}} />` +
          Array.from(
            { length: 4 },
            (_, child) => `<Checklist title="Other scope ${at}-${child}" steps={${at}} />`,
          ).join(""),
      );
      yield* page.until("source ready", (one) => one.shows(`steps={${at}}`));
      yield* page.key("Enter");
      yield* page.until("settled entry", (one) => one.shows(`Ready for Entry ${at + 1}`));
    }
    yield* page.type("draft-held");
    yield* page.until("draft", (one) => one.shows("draft-held"));
    yield* page.press("Entries");
    yield* page.until("catalog", (one) => one.shows("[close]"));
    yield* key(page, "Tab");
    const cell = page.screen().locate("1. [", { onRow: catalogRow(page, 1) });
    yield* wheel(page, "down", cell);
    expect(hasCatalogRow(page, 1)).toBe(false);
    yield* wheel(page, "up", cell);
    expect(hasCatalogRow(page, 1)).toBe(true);
    for (const size of [
      { columns: 160, rows: 36 },
      { columns: 120, rows: 30 },
      { columns: 72, rows: 20 },
    ]) {
      yield* page.resize(size);
      const body = page.screen().locate("1. [", { onRow: catalogRow(page, 1) });
      yield* wheel(page, "down", body);
      expect(hasCatalogRow(page, 1)).toBe(false);
      yield* wheel(page, "up", body);
      expect(hasCatalogRow(page, 1)).toBe(true);
    }
    const catalog: string[] = [];
    for (let tick = 0; tick < 16; tick += 1) {
      yield* wheel(page, "down", cell);
      catalog.push(...page.screen().rows);
    }
    expect(catalog.join("\n")).toContain("8. [");
    const catalogEnd = [...page.screen().rows];
    yield* wheel(page, "down", cell);
    expect(page.screen().rows).toEqual(catalogEnd);
    yield* ticks(page, "up", cell, 16);
    yield* key(page, "Backtab");
    for (let at = 0; at < 7; at += 1) {
      yield* key(page, "ArrowDown");
    }
    expect(page.screen().shows("8. [")).toBe(true);
    yield* key(page, "Enter");
    yield* page.until("selected", (one) => !one.shows("[close]"));
    yield* page.press("Entries");
    yield* page.until("reopened", (one) => one.shows("[close]"));
    yield* key(page, "ArrowRight");
    expect(page.screen().shows("component Checklist")).toBe(true);
    yield* key(page, "Enter");
    yield* page.until("nested selection", (one) => !one.shows("[close]") && one.shows("Checklist"));
    yield* page.until("nested output", (one) => one.shows("Nested work 00"));
    const nested = page.screen().locate("Nested work 00");
    yield* wheel(page, "down", nested);
    expect(page.screen().shows("Nested work 00")).toBe(false);
    yield* wheel(page, "up", nested);
    expect(page.screen().shows("Nested work 00")).toBe(true);
    const seen: string[] = [];
    for (let tick = 0; tick < 90; tick += 1) {
      yield* wheel(page, "down", nested);
      seen.push(...page.screen().rows);
    }
    expect(seen.join("\n")).toContain("Nested work 35");
    expect(seen.join("\n")).toContain("Nested work 69");
    expect(seen.join("\n")).toContain("steps={1}");
    const edge = [...page.screen().rows];
    yield* wheel(page, "down", nested);
    expect(page.screen().rows).toEqual(edge);
    yield* ticks(page, "up", nested, 90);
    expect(page.screen().shows("Nested work 00")).toBe(true);
    absentButtons(page);
    yield* page.until("draft returns", (one) => one.shows("draft-held"));
    expect(page.repl.fake.prompts).toHaveLength(0);
  });

  it("recorded schema and answer remain complete inert readings", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    const schema = {
      type: "object",
      properties: {
        value: {
          type: "string",
          description: Array.from({ length: 80 }, (_, at) => `Schema witness ${at}`).join("\n"),
        },
      },
      required: ["value"],
      additionalProperties: false,
    };
    yield* page.type(
      `<Elicit as="response" schema={${JSON.stringify(schema)}}>Recorded question</Elicit>`,
    );
    yield* page.until("source", (one) => one.shows("</Elicit>"));
    yield* page.key("Enter");
    yield* page.until("answer available", (one) => one.shows("[answer]"));
    yield* page.press("[answer]");
    yield* page.until("form", (one) => one.shows("[submit]"));
    yield* page.type(Array.from({ length: 80 }, (_, at) => `Answer witness ${at}`).join(" "));
    yield* page.until("value", (one) => one.shows("Answer witness 79"));
    yield* page.press("[submit]");
    yield* page.until("settled", (one) => one.shows("Ready for Entry 2"));
    yield* page.press("Entries");
    yield* page.until("catalog", (one) => one.shows("[close]"));
    yield* page.press("1. [");
    yield* page.until("catalog closed", (one) => !one.shows("[close]"));
    yield* page.press("BINDINGS");
    yield* page.until("recorded opener", (one) => one.shows("answered "));
    yield* page.press("answered ");
    yield* page.until(
      "recorded answer",
      (one) => one.shows("Recorded answer") && one.shows("[close]"),
    );
    yield* key(page, "Home");
    for (const label of ["Recorded answer", "[close]", "[history]"]) {
      yield* wheel(page, "down", page.screen().locate(label));
      expect(page.screen().found('"type": "object"', { after: "Recorded answer" })).toBe(1);
    }
    const cell = page.screen().locate('"type": "object"', { after: "Recorded answer" });
    yield* wheel(page, "down", cell);
    expect(page.screen().shows('"type": "object"')).toBe(false);
    yield* wheel(page, "up", cell);
    expect(page.screen().shows('"type": "object"')).toBe(true);
    const seen: string[] = [];
    for (let tick = 0; tick < 30; tick += 1) {
      yield* wheel(page, "down", cell);
      seen.push(...page.screen().rows);
    }
    expect(seen.join("\n")).toContain("Schema witness 79");
    expect(seen.join("\n")).toContain("Answer witness 79");
    yield* ticks(page, "up", cell, 30);
    yield* key(page, "End");
    expect(page.screen().shows("Answer witness 79")).toBe(true);
    expect(page.screen().shows("[submit]")).toBe(false);
    yield* key(page, "Home");
    expect(page.screen().shows('"type": "object"')).toBe(true);
    absentButtons(page);
    expect(page.repl.fake.prompts).toHaveLength(0);
  });
  it("History alone scrolls above a held question and restores its caret", function* () {
    const page = yield* useReplPage({ size: { columns: 120, rows: 30 } });
    for (let at = 0; at < 12; at += 1) {
      yield* page.type(
        at === 11
          ? Array.from({ length: 70 }, (_, row) => `Background row ${row}`).join("\n")
          : `<Let as="history${at}" value={${at}} />`,
      );
      yield* page.until("source ready", (one) =>
        one.shows(at === 11 ? "Background row 69" : `value={${at}}`),
      );
      yield* page.key("Enter");
      yield* page.until("entry settled", (one) => one.shows(`Ready for Entry ${at + 2}`));
    }
    const preview = Array.from(
      { length: 45 },
      (_, at) => `Held question ${String(at).padStart(2, "0")}`,
    ).join("\n");
    page.repl.fake.script({
      reply: `<Elicit as="answer" schema={{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false}}>${preview}</Elicit>`,
    });
    for (let at = 0; at < 3; at += 1) {
      yield* key(page, "Tab");
    }
    yield* page.type("question");
    yield* page.until("message", (one) => one.shows("question"));
    yield* page.key("Enter");
    yield* page.until("question waiting", (one) => one.shows("[answer sidekick]"));
    yield* page.press("[answer sidekick]");
    yield* page.until("form", (one) => one.shows("[submit]"));
    yield* page.type("held-value");
    yield* page.until("value", (one) => one.shows("= held-value"));
    yield* key(page, "ArrowLeft");
    const uncovered = page.screen().locate("Background row 0");
    yield* wheel(page, "down", uncovered);
    expect(page.screen().shows("Background row 0")).toBe(true);
    expect(page.screen().shows("held-value")).toBe(true);
    yield* page.press("[history]");
    yield* page.until(
      "History covers question",
      (one) => one.shows("History") && !one.shows("[submit]"),
    );
    yield* key(page, "Tab");
    const marker = page
      .screen()
      .rows.flatMap((row) => row.match(/\d+ · Entry \d+ admitted/)?.[0] ?? [])[0];
    if (marker === undefined) {
      throw new Error(page.describe());
    }
    const cell = page.screen().locate(marker);
    yield* wheel(page, "down", cell);
    expect(page.screen().shows(marker)).toBe(false);
    yield* wheel(page, "up", cell);
    expect(page.screen().shows(marker)).toBe(true);
    yield* ticks(page, "down", cell, 25);
    expect(page.screen().shows("[live]")).toBe(false);
    yield* ticks(page, "up", cell, 25);
    yield* page.key("Escape");
    yield* page.until(
      "held form returns",
      (one) => one.shows("= held-value") && one.shows("[submit]"),
    );
    yield* key(page, "Tab");
    yield* key(page, "Backtab");
    yield* page.type("X");
    yield* page.until("saved caret", (one) => one.shows("held-valuXe"));
    expect(page.repl.fake.prompts).toHaveLength(1);
    yield* page.press("[history]");
    yield* page.until("History reopened", (one) => one.shows("History") && !one.shows("[submit]"));
    yield* sleep(30);
    for (let at = 0; at < 23; at += 1) {
      yield* key(page, "ArrowDown");
    }
    expect(page.screen().shows("> 24 · Entry outcome recorded")).toBe(true);
    expect(page.screen().shows("[live]")).toBe(false);
    yield* key(page, "ArrowUp");
    yield* key(page, "Enter");
    yield* page.until("explicit historical selection", (one) => one.shows("[live]"));
  });

  it("resize refusal and a terminal burst preserve the independent reading and Draft", function* () {
    const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
    yield* page.type(
      Array.from({ length: 90 }, (_, at) =>
        at === 3 ? "" : `Resize work ${String(at).padStart(2, "0")}`,
      ).join("\n"),
    );
    yield* page.until("source", (one) => one.shows("Resize work 89"));
    yield* page.key("Enter");
    yield* page.until("settled", (one) => one.shows("Ready for Entry 2"));
    yield* page.type("draft-retained");
    yield* page.until("Draft", (one) => one.shows("draft-retained"));
    const cell = page.screen().locate("Resize work 00");
    const blankAbove = page.screen().locate("Resize work 02");
    const blank = { column: blankAbove.column, row: blankAbove.row + 1 };
    yield* wheel(page, "down", blank);
    expect(page.screen().shows("Resize work 00")).toBe(false);
    yield* wheel(page, "up", blank);
    expect(page.screen().shows("Resize work 00")).toBe(true);
    const empty = page.screen().locate("No messages yet.");
    for (const direction of ["up", "down"] satisfies readonly ("up" | "down")[]) {
      yield* wheel(page, direction, { column: empty.column, row: empty.row + 1 });
      expect(page.screen().shows("Resize work 00")).toBe(true);
    }
    for (const label of ["DRAFT", "HISTORY", "BINDINGS"]) {
      yield* wheel(page, "down", page.screen().locate(label));
      expect(page.screen().shows("Resize work 00")).toBe(true);
    }
    const before = page.screen().index;
    page.repl.terminal.feed(`\x1b[<65;${cell.column + 1};${cell.row + 1}M`.repeat(3));
    yield* page.until(
      "burst moved nine rows",
      (one) => one.index > before && one.shows("Resize work 08") && !one.shows("Resize work 07"),
    );
    let refused = false;
    for (const size of [
      { columns: 120, rows: 30 },
      { columns: 72, rows: 20 },
      { columns: 50, rows: 10 },
      { columns: 72, rows: 20 },
      { columns: 160, rows: 36 },
    ]) {
      yield* page.resize(size);
      if (size.columns === 50) {
        expect(page.screen().shows("needs at least")).toBe(true);
        refused = true;
      } else {
        expect(page.screen().shows("draft-retained")).toBe(true);
        if (refused && size.columns === 72) {
          yield* key(page, "Tab");
        }
      }
    }
    expect(page.screen().shows("Resize work 08")).toBe(true);
    yield* page.type("!");
    yield* page.until("focus survived", (one) => one.shows("draft-retained!"));
    yield* page.press("Entries");
    yield* page.until("catalog remount", (one) => one.shows("[close]"));
    yield* wheel(page, "down", cell);
    yield* page.key("Escape");
    yield* page.until("work returns", (one) => !one.shows("[close]"));
    expect(page.screen().shows("Resize work 08")).toBe(true);
    expect(page.screen().shows("draft-retained!")).toBe(true);
    absentButtons(page);
  });
  it("previous chat and explicit turn reveal stay independent of current streaming", function* () {
    const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
    page.repl.fake.script({
      reply: `<Output>${Array.from({ length: 65 }, (_, at) => `Old row ${String(at).padStart(2, "0")}`).join("\n")}</Output>`,
    });
    yield* sendMessage(page, "old-first");
    yield* page.until("old tail", (one) => one.shows("Old row 64") && !one.shows("[stop]"));
    yield* openConfigure(page);
    yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
    yield* applyConfigure(page);
    yield* page.until("new chat", (one) => one.shows("No messages yet."));
    page.repl.fake.script({
      deltas: [
        `<Output>${Array.from({ length: 60 }, (_, at) => `New row ${String(at).padStart(2, "0")}`).join("\n")}`,
        "\nNew live tail</Output>",
      ],
      holdsEachPiece: true,
    });
    yield* sendMessage(page, "new-current");
    yield* page.repl.fake.streamingTurns(1);
    yield* page.until("new preview", (one) => one.shows("New row 59"));
    const newCell = page.screen().locate("New row 59");
    yield* ticks(page, "up", newCell, 3);
    const inspected = page
      .screen()
      .rows.filter((row) => row.includes("New row"))
      .map((row) => row.slice(row.lastIndexOf("New row")));
    yield* page.press("old-first", { rightOf: "TRANSCRIPT" });
    yield* page.until(
      "previous chat reveal",
      (one) =>
        one.shows("[Back to current chat]") && one.found("Old row 00", { rightOf: "BINDINGS" }) > 0,
    );
    const oldCell = page.screen().locate("Old row 00", { rightOf: "BINDINGS" });
    yield* wheel(page, "down", oldCell);
    expect(page.screen().found("Old row 00", { rightOf: "BINDINGS" })).toBe(0);
    yield* wheel(page, "up", oldCell);
    expect(page.screen().shows("Old row 00")).toBe(true);
    yield* ticks(page, "down", oldCell, 30);
    expect(page.screen().shows("Old row 64")).toBe(true);
    page.repl.fake.releaseDeltas();
    yield* sleep(90);
    expect(page.screen().shows("Old row 64")).toBe(true);
    expect(page.screen().shows("New live tail")).toBe(false);
    yield* page.press("old-first", { rightOf: "TRANSCRIPT" });
    yield* page.until(
      "turn explicitly revealed again",
      (one) => one.found("Old row 00", { rightOf: "BINDINGS" }) > 0,
    );
    yield* page.press("[Back to current chat]");
    yield* page.until("current restored", (one) => !one.shows("[Back to current chat]"));
    expect(
      page
        .screen()
        .rows.filter((row) => row.includes("New row"))
        .map((row) => row.slice(row.lastIndexOf("New row"))),
    ).toEqual(inspected);
    expect(page.screen().shows("New live tail")).toBe(false);
    expect(page.repl.fake.prompts).toHaveLength(2);
    absentButtons(page);
  });
});
