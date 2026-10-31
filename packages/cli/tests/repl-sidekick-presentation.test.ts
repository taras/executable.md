/** Read Sidekick work from the pane and controls the terminal actually shows. */

import {
  MOUNTED_AGENT,
  OTHER_MOUNTED_AGENT,
  mountedExecution,
  awaited,
  appendGate,
  operationGate,
  useMountedHost,
} from "./support/mounted-repl.ts";
import { FsApi, ensureDir, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { API } from "@executablemd/runtime";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { ensure, withResolvers, scoped, sleep } from "effection";
import { decodeLocation } from "../src/repl/route.ts";
import { ReplHost } from "../src/repl/host.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  SIDEKICK_FILE,
  SidekickHistoryError,
  readSidekickRecords,
} from "../src/repl/sidekick/history.ts";
import { renderReceipt } from "../src/repl/sidekick/controls.ts";
import { projectSidekick } from "../src/repl/sidekick/model.ts";
import { projectRepl } from "../src/repl/model.ts";
import { sidekickChatRows, sidekickTurnRows } from "../src/repl/program.ts";
import type { MountedHost } from "./support/mounted-repl.ts";
import type { SidekickRecord } from "../src/repl/sidekick/history.ts";
import { awaitedFact } from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";
import type { ReplPage, ScreenReading } from "./support/repl-page.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import type { Operation } from "effection";
import { expect } from "@executablemd/test-support/expect";

import { useReplPage } from "./support/repl-page.ts";
import {
  COMPOSER,
  replaceAgent,
  openHistory,
  openConfigure,
  tab,
  scrollDrawerTo,
  chooseOffered,
  applyConfigure,
  answerField,
  selectPane,
  closeDrawer,
  entrySettles,
  DRAFT_VALUE,
  draftText,
  pasteDraft,
  composerHolds,
  DRAFT,
  draftHolds,
  intoComposer,
  intoDraft,
  sendMessage,
  SIDEKICK,
  SIDEKICK_CONTROLS,
  SIDEKICK_PANE,
  sidekickIdle,
  sidekickShows,
  stopSidekick,
  typed,
} from "./support/screen-journeys.ts";

const WIDE = { columns: 160, rows: 36 };
const NARROW = { columns: 72, rows: 20 };

describe("Sidekick presentation: visible work owns its controls", () => {
  it("sends one message through the Sidekick pane and reads the reply", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    yield* sendMessage(page, "explain the entry");
    yield* page.until("the Sidekick reply", (one) => sidekickShows(one, "Noted."));
    yield* page.until("the Sidekick returning to Send", sidekickIdle);
    expect(page.screen().found("[send]", SIDEKICK_PANE)).toBe(1);
  });

  it("keeps the composer separate from the Draft", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* intoComposer(page);
    yield* typed(page, "a Sidekick question");
    const reading = page.screen();
    expect(composerHolds(reading, "a Sidekick question")).toBe(true);
    expect(draftHolds(reading, "a Sidekick question")).toBe(false);
    expect(reading.found("[send]", { onRow: DRAFT })).toBe(1);
  });

  it("routes one visible surface at narrow size and recovers when widened", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows(SIDEKICK)).toBe(false);
    expect(narrow.shows(COMPOSER)).toBe(false);
    expect(narrow.occurrences("[send]")).toBe(1);
    const wide = yield* page.resize(WIDE);
    expect(wide.shows(SIDEKICK)).toBe(true);
    expect(wide.shows(COMPOSER)).toBe(true);
    expect(wide.occurrences("[send]")).toBe(2);
  });

  it("shows Stop while a Sidekick turn is held and restores Send after Stop", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({
      held: true,
      reply: "<Output>never reached</Output>\n",
    });
    yield* sendMessage(page, "hold this turn");
    yield* page.until("the Sidekick Stop", (one) => one.found("[stop]", SIDEKICK_CONTROLS) === 1);
    yield* stopSidekick(page);
    yield* page.until("the Sidekick returning to Send", sidekickIdle);
    expect(page.screen().shows("never reached")).toBe(false);
  });
});

function chatHas(reading: ScreenReading, text: string): boolean {
  return reading.found(text, reading.shows("DRAFT") ? { rightOf: "DRAFT" } : undefined) > 0;
}

function chatLines(reading: ScreenReading, anchor: string): string[] {
  const column = reading.locate(
    anchor,
    reading.shows("DRAFT") ? { rightOf: "DRAFT" } : undefined,
  ).column;
  const start = reading.locate(reading.shows("SIDEKICK") ? "SIDEKICK" : "Sidekick").row;
  const end = reading.shows(COMPOSER)
    ? reading.locate(COMPOSER).row - 2
    : reading.locate("HISTORY").row;

  return reading.rows.slice(start + 1, end).map((row) => row.slice(column).trim());
}

function* exchange(page: ReplPage, text: string, answer: string): Operation<void> {
  page.repl.fake.script({ reply: `<Output>${answer}</Output>\n` });
  yield* sendMessage(page, text);
  yield* page.until("the reply", (one) => chatHas(one, answer.split("\n")[0]));
  yield* page.until("the Sidekick at rest", sidekickIdle);
}

describe("Tier CF — complete messages and following the newest reply", () => {
  it("CF1: a message with its own lines keeps every one of them when the next arrives", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const wide = "a-very-long-line-that-cannot-fit-this-pane-and-must-be-cut-across-rows";
    const first = ["one-A", "one-B", "", "one-C", wide].join("\n");
    yield* exchange(page, "first", first);
    const before = chatLines(page.screen(), "[S] one-A");
    const at = (rows: readonly string[], text: string): number =>
      rows.findIndex((row) => row.endsWith(text));
    for (const part of ["one-A", "one-B", "one-C"]) {
      expect(before.some((row) => row.endsWith(part))).toBe(true);
    }
    expect(before.join("")).toContain(wide);
    expect(at(before, "one-A")).toBeLessThan(at(before, "one-B"));
    expect(before[at(before, "one-B") + 1]).toBe("");
    yield* exchange(page, "second", "two-A\ntwo-B");
    const after = chatLines(page.screen(), "[S] one-A");
    for (const part of ["one-A", "one-B", "one-C", "two-A", "two-B"]) {
      expect(after.some((row) => row.endsWith(part))).toBe(true);
    }
    expect(after.join("")).toContain(wide);
    expect(at(after, "one-C")).toBeLessThan(at(after, "two-A"));
    expect(at(after, "two-A")).toBeLessThan(at(after, "two-B"));
    expect(page.screen().shows(COMPOSER)).toBe(true);
    expect(page.screen().found("[send]", { onRow: DRAFT })).toBe(1);
    yield* awaitedFact("two saved replies", function* () {
      return (
        (yield* settledReading(page.repl)).chat.filter((one) => one.kind === "response").length ===
        2
      );
    });
    const replies = (yield* settledReading(page.repl)).chat.filter(
      (one) => one.kind === "response",
    );
    expect(JSON.stringify(replies[0])).toContain("one-C");
  });

  it("CF2: a chat whose window filled shows its newest reply, at every size", function* () {
    const page = yield* useReplPage({ size: WIDE });
    for (let number = 1; number <= 12; number += 1) {
      yield* exchange(page, `ask-${number}`, `ANSWER-${number}`);
    }
    const read = yield* settledReading(page.repl);
    expect(read.chat.filter((one) => one.kind === "response")).toHaveLength(12);
    const fed = page.repl.terminal.fed;
    yield* page.until("the latest reply following without input", (one) =>
      chatHas(one, "[S] ANSWER-12"),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1"))).toBe(false);
    expect(JSON.stringify(read.chat)).toContain("ANSWER-1");
    for (const size of [{ columns: 120, rows: 30 }, NARROW, WIDE]) {
      const reading = yield* page.resize(size);
      expect(chatHas(reading, "[S] ANSWER-12")).toBe(true);
    }
    for (
      let press = 0;
      press < 60 && !page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1"));
      press += 1
    ) {
      const before = page.screen().index;
      yield* chatWheel(page, "up");
      yield* page.until("the earlier messages", (one) => one.index > before);
      if (
        page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1")) &&
        !chatHas(page.screen(), "[S] ANSWER-12")
      ) {
        break;
      }
    }
    expect(page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1"))).toBe(true);
  });
});

function* finishDraft(page: ReplPage): Operation<string | undefined> {
  page.repl.terminal.end();
  yield* awaited("the command returning", () => page.repl.outcome() !== undefined);
  const outcome = page.repl.outcome();
  if (outcome === undefined || !outcome.ok) {
    throw new Error("the command returned no successful location");
  }
  const decoded = decodeLocation(outcome.value.location);
  if (!decoded.ok) {
    throw decoded.error;
  }
  return decoded.value.draft;
}

function* filesHeld(root: string, prefix = ""): Operation<string[]> {
  const found: string[] = [];
  for (const entry of yield* FsApi.operations.readdirDirents(root)) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(yield* filesHeld(join(root, entry.name), name)));
    } else {
      found.push(name);
    }
  }
  return found.sort();
}

function* publishedPairs(root: string): Operation<string[]> {
  try {
    return (yield* readdir(join(root, PAIRED_DIRECTORY))).sort();
  } catch {
    return [];
  }
}

function personMessages(records: readonly SidekickRecord[]): string[] {
  return records.filter((record) => record.kind === "message").map((record) => record.text);
}

const TWO_STEP_ENTRY = [
  "```js eval",
  'const first = "the held step";',
  "```",
  "",
  "<Output>{first}</Output>",
  "",
  "```js eval",
  'const second = "the released step";',
  "```",
  "",
  "<Output>{second}</Output>",
  "",
].join("\n");
const FILLING_REPLY = [
  '<Let as="code" select="code">',
  "````xmd",
  "Replaced by the reply.",
  "````",
  "</Let>",
  "<REPL.EntryInput>{code}</REPL.EntryInput>",
  "<Output>Filled it.</Output>",
  "",
].join("\n");

function* compose(page: ReplPage, text: string): Operation<void> {
  yield* intoComposer(page);
  yield* typed(page, text);
}

function sendComposed(page: ReplPage): Operation<void> {
  return page.press("[send]", SIDEKICK_CONTROLS);
}

describe("Sidekick acquisition, durable handoff and acknowledgements", () => {
  it("M1: a fresh command shows its Sidekick, asks the agent nothing, and keeps focus on the draft", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const first = page.screen();
    for (const label of ["BINDINGS", "SIDEKICK", "No messages yet.", COMPOSER]) {
      expect(first.shows(label)).toBe(true);
    }
    expect(first.found("[send]", SIDEKICK_CONTROLS)).toBe(1);
    expect([
      page.repl.fake.created,
      page.repl.fake.ensured,
      page.repl.fake.prompts,
      page.repl.fake.started,
    ]).toEqual([[], [], [], false]);
    yield* typed(page, "startup draft");
    expect(draftHolds(page.screen(), "startup draft")).toBe(true);
    expect(composerHolds(page.screen(), "startup draft")).toBe(false);
    yield* compose(page, "startup composer");
    expect(composerHolds(page.screen(), "startup composer")).toBe(true);
    expect([page.repl.fake.ensured, page.repl.fake.prompts]).toEqual([[], []]);
    expect(yield* finishDraft(page)).toBe("startup draft");
  });

  it("M1: a legacy execution is reopened unchanged, and publishes no pair", function* () {
    const host = yield* useMountedHost();
    yield* ensureDir(host.root);
    const path = join(host.root, "legacy-one.jsonl");
    yield* writeTextFile(path, "");
    const before = yield* readTextFile(path);
    const files = yield* filesHeld(host.root);
    const page = yield* useReplPage({ host, location: "xmd://repl/legacy-one/entries" });
    yield* page.until("the empty Sidekick", (one) => one.shows("No messages yet."));
    expect(yield* readTextFile(path)).toBe(before);
    yield* intoComposer(page);
    expect(yield* filesHeld(host.root)).toEqual(files);
    expect(host.fake.ensured).toEqual([]);
    expect(host.fake.prompts).toEqual([]);
  });

  it("M2: a legacy Send waits for the entry record in flight, then publishes one pair", function* () {
    const gate = appendGate();
    const host = yield* useMountedHost({ gate });
    const execution = "legacy-hot";
    const legacy = join(host.root, `${execution}.jsonl`);
    yield* ensureDir(host.root);
    yield* writeTextFile(legacy, "");
    host.fake.script({ reply: "<Output>Noted.</Output>\n" });
    const pair = {
      entries: join(host.root, PAIRED_DIRECTORY, execution, ENTRIES_FILE),
      sidekick: join(host.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE),
    };
    // A native append can expose its body before its final newline reaches disk.
    yield* ReplHost.around(
      {
        *appendRecord([path, record], next) {
          if (path === pair.sidekick && record.startsWith('{"kind":"response"')) {
            yield* next(path, record.slice(0, -1));
            yield* next(path, "\n");
          } else {
            yield* next(path, record);
          }
        },
      },
      { at: "max" },
    );
    const finishing = gate.holdNext((path, record) => path === pair.sidekick && record === "\n");
    const page = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    const running = gate.holdNext((path) => path === legacy && gate.reaching(legacy) >= 1);
    yield* pasteDraft(page, TWO_STEP_ENTRY);
    yield* page.key("Enter");
    yield* running.started();
    yield* page.until(
      "the admitted source leaving the draft",
      (one) => one.found("second =", DRAFT_VALUE) === 0,
    );
    yield* compose(page, "explain");
    yield* sendComposed(page);
    yield* sleep(100);
    expect(host.fake.ensured).toEqual([]);
    expect(host.fake.prompts).toEqual([]);
    expect(running.released).toBe(false);
    expect(yield* publishedPairs(host.root)).toEqual([]);
    yield* compose(page, "!");
    expect(composerHolds(page.screen(), "!")).toBe(true);
    yield* draftText(page, "next", ["Tab", "Tab", "Tab", "Tab"]);
    running.release();
    yield* page.until("the reply arriving", (one) => one.shows("Noted."));
    yield* finishing.started();
    expect(sidekickIdle(page.screen())).toBe(false);
    let refusal: unknown;
    try {
      yield* readSidekickRecords(pair.sidekick);
    } catch (caught) {
      refusal = caught;
    }
    expect(refusal).toBeInstanceOf(SidekickHistoryError);
    expect(refusal).toMatchObject({
      message: "this execution's chat history ends in a record that was never finished writing.",
    });
    finishing.release();
    yield* page.until("the Sidekick finishing its saved reply", sidekickIdle);
    yield* entrySettles(page, 1, "ok");
    expect(yield* publishedPairs(host.root)).toEqual([execution]);
    const retained = yield* readTextFile(legacy);
    const records = retained.split("\n").filter((line) => line.length > 0);
    expect(records.length).toBeGreaterThan(1);
    expect((yield* readTextFile(pair.entries)).startsWith(retained)).toBe(true);
    expect((yield* host.repository.open(execution)).chat.form).toBe("paired");
    expect((yield* readSidekickRecords(pair.sidekick))[0]).toMatchObject({
      kind: "owner",
      execution,
      origin: { bytes: new TextEncoder().encode(retained).length, records: records.length },
    });
    expect(host.fake.prompts).toHaveLength(1);
    expect(host.fake.ensured).toHaveLength(1);
    expect(host.fake.prompts[0]).toContain("explain");
    expect(host.fake.prompts[0]).not.toContain("explain!");
    expect(personMessages(yield* readSidekickRecords(pair.sidekick))).toEqual(["explain"]);
    expect(page.screen().shows("[U] explain")).toBe(true);
    const reachedLegacy = gate.reaching(legacy);
    yield* awaited("the next record reaching the pair", () => gate.reaching(pair.entries) > 0);
    expect(gate.reaching(legacy)).toBe(reachedLegacy);
    expect(yield* readTextFile(legacy)).toBe(retained);
    expect(yield* finishDraft(page)).toBe("next");
  });

  it("M4: acceptance clears Message while delayed saved acknowledgement preserves newer edits", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    page.repl.fake.script({ reply: FILLING_REPLY });
    page.repl.fake.script({ reply: "<Output>Understood.</Output>\n" });
    yield* draftText(page, "mine");
    const saving = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"message"'),
    );
    yield* compose(page, "ask");
    yield* sendComposed(page);
    yield* saving.started();
    yield* compose(page, "!");
    yield* draftText(page, "X", ["Tab", "Tab", "Tab", "Tab"]);
    saving.release();
    yield* page.until("the reply arriving", (one) => one.shows("Understood."));
    expect(personMessages((yield* settledReading(page.repl)).chat)).toEqual(["ask"]);
    expect(page.repl.fake.prompts[0]).toContain("ask");
    expect(page.repl.fake.prompts[0]).not.toContain("ask!");
    expect(composerHolds(page.screen(), "!")).toBe(true);
    expect(draftHolds(page.screen(), "mineX")).toBe(true);
    expect(page.repl.fake.prompts[1] ?? "").toContain("taken the shared draft over");
    expect(yield* finishDraft(page)).toBe("mineX");
  });

  it("M4: control — with nothing typed after it, the same message clears the box", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    page.repl.fake.script({ reply: FILLING_REPLY });
    page.repl.fake.script({ reply: "<Output>Understood.</Output>\n" });
    yield* draftText(page, "mine");
    const saving = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"message"'),
    );
    yield* compose(page, "ask");
    yield* sendComposed(page);
    yield* saving.started();
    saving.release();
    yield* page.until("the reply arriving", (one) => one.shows("Understood."));
    expect(composerHolds(page.screen(), "ask")).toBe(false);
    expect(page.repl.fake.prompts[1] ?? "").toContain("Entry input updated.");
    expect(page.repl.fake.prompts[1] ?? "").not.toContain("taken the shared draft over");
    expect(page.screen().found("Replaced by the reply.", DRAFT_VALUE)).toBe(1);
  });

  it("M5: while generation is held, Send remains beside Stop without starting unrequested work", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ held: true, reply: "<Output>Done.</Output>\n" });
    yield* compose(page, "ask");
    yield* page.type("\r\r");
    yield* page.repl.fake.holdingTurns(1);
    expect(page.repl.fake.prompts).toHaveLength(1);
    expect(personMessages((yield* settledReading(page.repl)).chat)).toEqual(["ask"]);
    yield* page.until("the Sidekick working", (one) => one.shows("[S] working"));
    expect(page.screen().found("[stop]", SIDEKICK_CONTROLS)).toBe(1);
    expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(1);
    expect(page.screen().found("[send]", { onRow: DRAFT })).toBe(1);
    yield* compose(page, "then this");
    page.repl.fake.releaseTurn();
    yield* page.until("the reply arriving", (one) => one.shows("Done."));
    yield* page.until("the pane at rest", sidekickIdle);
    expect(composerHolds(page.screen(), "then this")).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(1);
  });

  it("M5: the first reply appears while its follow-up is held, with nothing pressed", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "<Output>First answer.</Output>\n<REPL.Bindings />\n" });
    page.repl.fake.script({ held: true, reply: "<Output>Second answer.</Output>\n" });
    yield* sendMessage(page, "ask");
    yield* page.repl.fake.holdingTurns(1);
    const fed = page.repl.terminal.fed;
    yield* page.until("the first answer without input", (one) => one.shows("[S] First answer."));
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().found("[stop]", SIDEKICK_CONTROLS)).toBe(1);
    expect(page.screen().shows("Second answer.")).toBe(false);
    expect(page.repl.fake.prompts).toHaveLength(2);
    page.repl.fake.releaseTurn();
    yield* page.until("the follow-up", (one) => one.shows("[S] Second answer."));
    yield* page.until("the pane at rest", sidekickIdle);
    expect(page.repl.fake.prompts).toHaveLength(2);
  });

  it("M5: control — an ordinary entry's own progress reaches the screen with no further key", function* () {
    const page = yield* useReplPage();
    yield* pasteDraft(page, TWO_STEP_ENTRY);
    yield* page.key("Enter");
    const fed = page.repl.terminal.fed;
    yield* page.until("the entry output without input", (one) => one.shows("the released step"));
    expect(page.repl.terminal.fed).toBe(fed);
    expect([page.repl.fake.ensured, page.repl.fake.prompts]).toEqual([[], []]);
  });
});

const PROFILES = [WIDE, { columns: 120, rows: 30 }, NARROW];
const TOO_SMALL = { columns: 60, rows: 15 };

function* openEntryCatalog(page: ReplPage): Operation<void> {
  yield* page.press("Entries", { onRow: "Entries" });
  yield* page.until("the entry catalog", (one) => one.shows("[close]"));
}

function* chooseEntry(page: ReplPage, name: string): Operation<void> {
  yield* openEntryCatalog(page);
  yield* page.press(name, { rightOf: "[close]" });
  yield* page.until("the selected entry", (one) => !one.shows("[close]"));
}

function entryTrail(reading: ScreenReading): string {
  return reading.rows.find((row) => row.includes("› Entry")) ?? "";
}

describe("Sidekick texts and reading across every profile", () => {
  it("M7: all three profiles keep both texts, the footer and one body", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "note");
    yield* compose(page, "ask");
    for (const size of PROFILES) {
      const drawn =
        page.screen().size.columns === size.columns && page.screen().size.rows === size.rows
          ? page.screen()
          : yield* page.resize(size);
      expect(drawn.rows).toHaveLength(size.rows);
      expect(drawn.shows("[exit]")).toBe(true);
      expect(composerHolds(drawn, "ask")).toBe(true);
      expect(drawn.occurrences(COMPOSER)).toBe(1);
      expect(drawn.found("[send]", SIDEKICK_CONTROLS)).toBe(1);
      if (size.columns > NARROW.columns) {
        expect(draftHolds(drawn, "note")).toBe(true);
      } else {
        expect(drawn.shows("DRAFT")).toBe(false);
        yield* openEntryCatalog(page);
        yield* closeDrawer(page);
        expect(page.screen().found("note", { after: "DRAFT" })).toBe(1);
        yield* page.resize(WIDE);
        expect(composerHolds(page.screen(), "ask")).toBe(true);
        expect(draftHolds(page.screen(), "note")).toBe(true);
      }
    }
    expect(yield* finishDraft(page)).toBe("note");
  });

  it("M7: selecting Bindings removes the Sidekick's body and its input targets", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "my entry");
    yield* compose(page, "my question");
    yield* selectPane(page, "bindings");
    expect(page.screen().shows(COMPOSER)).toBe(false);
    expect(page.screen().occurrences("[send]")).toBe(1);
    expect(page.screen().found("my entry", DRAFT_VALUE)).toBe(1);
    yield* intoComposer(page);
    expect(composerHolds(page.screen(), "my question")).toBe(true);
    expect(yield* finishDraft(page)).toBe("my entry");
  });

  it("M7: a default Sidekick shrinks to narrow Entries, and an explicit one stays", function* () {
    const page = yield* useReplPage();
    expect(page.screen().shows(COMPOSER)).toBe(true);
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows("Entries")).toBe(true);
    expect(narrow.shows(COMPOSER)).toBe(false);
    yield* page.resize(WIDE);
    yield* compose(page, "kept");
    const kept = yield* page.resize(NARROW);
    expect(kept.shows(COMPOSER)).toBe(true);
    expect(composerHolds(kept, "kept")).toBe(true);
    const expanded = yield* page.resize(WIDE);
    expect(expanded.shows(COMPOSER)).toBe(true);
    expect(composerHolds(expanded, "kept")).toBe(true);
  });

  it("M7: an older entry stays frozen while the Sidekick works, and Bindings still reads it", function* () {
    const page = yield* useReplPage();
    yield* pasteDraft(page, TWO_STEP_ENTRY);
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    yield* chooseEntry(page, "entry-1");
    expect(entryTrail(page.screen())).toContain("Entry 1");
    page.repl.fake.script({
      reply: [
        '<Let as="code" select="code">',
        "````xmd",
        "```js eval",
        'const second = "the second entry";',
        "```",
        "",
        "<Output>{second}</Output>",
        "````",
        "</Let>",
        "<REPL.EntryInput>{code}</REPL.EntryInput>",
        "<REPL.Submit />",
        "",
      ].join("\n"),
    });
    page.repl.fake.script({ reply: "<Output>Both ran.</Output>\n" });
    yield* sendMessage(page, "run two");
    yield* page.until("the second entry reported", (one) => one.shows("[S] Both ran."));
    expect(entryTrail(page.screen())).toContain("Entry 1");
    expect((yield* settledReading(page.repl)).model.entries).toHaveLength(2);
    expect(page.screen().shows("the released step")).toBe(true);
    yield* selectPane(page, "bindings");
    expect(entryTrail(page.screen())).toContain("Entry 1");
    expect(page.screen().shows("the released step")).toBe(true);
    expect(page.screen().shows(COMPOSER)).toBe(false);
    yield* intoComposer(page);
    expect(page.screen().shows("[S] Both ran.")).toBe(true);
    expect(page.screen().shows("[U] run two")).toBe(true);
  });

  it("M7: a terminal below the minimum refuses, and recovers with both texts", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "my entry");
    yield* compose(page, "my question");
    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.shows("needs at least 72x20")).toBe(true);
    expect(refused.shows("[")).toBe(false);
    expect(refused.shows(COMPOSER)).toBe(false);
    yield* page.resize(WIDE);
    expect(draftHolds(page.screen(), "my entry")).toBe(true);
    expect(composerHolds(page.screen(), "my question")).toBe(true);
    expect(yield* finishDraft(page)).toBe("my entry");
  });
});

const GATED_ENTRY_REPLY = [
  '<Let as="entry" select="code">',
  "```md",
  "<GateThing />",
  "```",
  "</Let>",
  "<REPL.EntryInput>{entry}</REPL.EntryInput>",
  "<REPL.Submit />",
  "",
].join("\n");

function* submittedUnderEdit(
  edit: boolean,
): Operation<{ entries: string[]; draft: string; edited: string | undefined }> {
  const directory = yield* useTemporary("xmd-mounted-preflight-");
  yield* writeTextFile(join(directory, "GateThing.md"), "The reserved entry ran.\n");
  const reached = withResolvers<void>();
  const allow = withResolvers<void>();
  yield* ensure(() => allow.resolve());
  let first = true;
  yield* API.Fs.around({
    *readTextFile([path], next) {
      if (first && path.endsWith("GateThing.md")) {
        first = false;
        reached.resolve();
        yield* allow.operation;
      }
      return yield* next(path);
    },
  });
  const host = yield* useMountedHost({ includes: [directory] });
  host.fake.script({ reply: GATED_ENTRY_REPLY });
  host.fake.script({ reply: "<Output>Done.</Output>\n" });
  const page = yield* useReplPage({ host });
  yield* sendMessage(page, "run this");
  yield* reached.operation;
  let edited: string | undefined;
  if (edit) {
    yield* draftText(page, "mine now", ["Tab", "Tab", "Tab", "Tab"]);
    expect(page.screen().found("mine now", DRAFT_VALUE)).toBe(1);
    edited = "<GateThing />mine now";
  }
  allow.resolve();
  yield* page.until("the response completing", (one) => one.shows("Done."));
  const read = yield* settledReading(page.repl);
  return {
    entries: read.model.entries.map((entry) => entry.key),
    draft: (yield* finishDraft(page)) ?? "",
    edited,
  };
}

describe("Sidekick submission held to the current Draft", () => {
  it("M-P2: a Draft edit during preflight admits no stale entry, and the edit survives", function* () {
    const result = yield* submittedUnderEdit(true);
    expect(result.entries).toEqual([]);
    expect(result.draft).toBe(result.edited);
    expect(result.draft).toContain("mine now");
  });
  it("M-P2: control — an unchanged Draft admits the requested entry once", function* () {
    const result = yield* submittedUnderEdit(false);
    expect(result.entries).toEqual(["entry-1"]);
    expect(result.draft).toBe("");
  });
});

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    message: { type: "string", minLength: 4 },
  },
  required: ["decision", "message"],
  additionalProperties: false,
};
const ONE_FIELD = {
  type: "object",
  properties: { message: { type: "string", minLength: 2 } },
  required: ["message"],
  additionalProperties: false,
};
function askingReply(
  message: string,
  schema: Readonly<Record<string, unknown>> = REVIEW_SCHEMA,
): string {
  return `<Elicit schema={${JSON.stringify(schema)}} as="answer">${message}</Elicit>\n`;
}
const ENTRY_ASKS =
  '<Elicit schema={{ type: "object", properties: { ok: { type: "string", enum: ["yes"] } }, required: ["ok"], additionalProperties: false }} as="said">The entry is asking.</Elicit>\n';
const ADVERTISED = {
  model: {
    selected: "balanced",
    choices: [
      { id: "balanced", name: "Balanced" },
      { id: "fast", name: "Fast" },
    ],
  },
  effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
};

function* pendingQuestion(
  page: ReplPage,
  message = "Sidekick asks.",
  schema: Readonly<Record<string, unknown>> = ONE_FIELD,
): Operation<void> {
  page.repl.fake.script({ reply: askingReply(message, schema) });
  yield* sendMessage(page, "ask");
  yield* page.until("the question notice", (one) => one.shows("[answer sidekick]"));
}

function* openedQuestion(page: ReplPage): Operation<void> {
  yield* page.press("[answer sidekick]");
  yield* page.until("the question form", (one) => one.shows("[submit]"));
}

function* historyOver(page: ReplPage): Operation<boolean> {
  yield* openHistory(page);
  yield* page.press("[close]");
  yield* page.until(
    "History leaving",
    (one) => !one.shows("History") || one.shows("[submit]") || one.shows("[refresh]"),
  );
  return page.screen().shows("[submit]");
}

function* filledQuestion(): Operation<ReplPage> {
  const page = yield* useReplPage();
  yield* pendingQuestion(page);
  yield* openedQuestion(page);
  yield* page.press("*message:");
  yield* page.type("partial");
  yield* page.until("the partial answer", (one) => one.shows("message: partial"));
  return page;
}

describe("Sidekick question announcement and modal ownership", () => {
  it("MQ1: the notice arrives with nothing pressed, and only opening shows the form", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    page.repl.fake.script({ reply: askingReply("Approve the plan?") });
    page.repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    const filing = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"component":"Elicit"'),
    );
    yield* pasteDraft(page, TWO_STEP_ENTRY);
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    yield* chooseEntry(page, "entry-1");
    yield* sendMessage(page, "review it");
    yield* filing.started();
    yield* selectPane(page, "bindings");
    yield* draftText(page, "mine", ["Tab", "Tab", "Tab"]);
    const fed = page.repl.terminal.fed;
    filing.release();
    yield* page.until("the question announcing without input", (one) =>
      one.shows("SIDEKICK (question)"),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().shows(COMPOSER)).toBe(false);
    expect(page.screen().shows("[submit]")).toBe(false);
    expect(entryTrail(page.screen())).toContain("Entry 1");
    yield* page.type("-still-draft");
    yield* page.until(
      "the original input still receiving text",
      (one) => one.found("mine-still-draft", DRAFT_VALUE) === 1,
    );
    yield* selectPane(page, "sidekick");
    yield* page.until("the notice in its pane", (one) => one.shows("[answer sidekick]"));
    expect(page.screen().shows("[submit]")).toBe(false);
    expect(composerHolds(page.screen(), "review it")).toBe(false);
    yield* openedQuestion(page);
    expect(page.screen().shows("Approve the plan?")).toBe(true);
    expect(page.screen().shows("approve")).toBe(true);
    expect(page.screen().shows("reject")).toBe(true);
    expect(yield* finishDraft(page)).toBe("mine-still-draft");
  });

  it("MQ1: control — an ordinary entry's question announces itself the same way", function* () {
    const page = yield* useReplPage();
    yield* pasteDraft(page, ENTRY_ASKS);
    yield* page.key("Enter");
    const fed = page.repl.terminal.fed;
    yield* page.until("the entry announcing without input", (one) => one.shows("[answer]"));
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.repl.fake.ensured).toEqual([]);
    expect(page.repl.fake.prompts).toEqual([]);
  });

  it("Q-P2: History over an open form closes once and leaves the form waiting", function* () {
    const page = yield* filledQuestion();
    expect(yield* historyOver(page)).toBe(true);
    expect(page.repl.outcome()).toBeUndefined();
    expect(page.screen().shows("Sidekick asks.")).toBe(true);
    expect(page.screen().shows("message: partial")).toBe(true);
  });

  it("Q-P2: control — History closes the same way with no form open", function* () {
    const page = yield* filledQuestion();
    yield* closeDrawer(page);
    yield* page.until("the question notice", (one) => one.shows("[answer sidekick]"));
    expect(yield* historyOver(page)).toBe(false);
    expect(page.repl.outcome()).toBeUndefined();
    expect(page.screen().shows("[answer sidekick]")).toBe(true);
  });
});

function* configureOpened(page: ReplPage): Operation<void> {
  yield* openConfigure(page);
  yield* page.until("the advertised models", (one) => one.shows("Balanced"));
}

function* configured(page: ReplPage): Operation<void> {
  yield* page.until("Configure closing", (one) => !one.shows("[refresh]"));
}

describe("PV3/PV4: question and Configure editing", () => {
  it("keeps each value's middle caret across close and a held History drawer", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* page.type("draft-kept");
    yield* page.until("the Draft value", (one) => one.shows("draft-kept"));
    yield* pendingQuestion(page);
    yield* openedQuestion(page);
    yield* page.type("ab界");
    yield* page.until("the answer value", (one) => one.shows("message: ab界"));
    yield* page.key("ArrowLeft");
    yield* sleep(30);
    yield* page.type("!");
    yield* page.until("the answer middle caret", (one) => one.shows("message: ab!界"));
    yield* page.key("Escape");
    yield* page.until(
      "the held question notice",
      (one) => one.shows("[answer sidekick]") && !one.shows("[submit]"),
    );
    yield* openedQuestion(page);
    yield* page.type("?");
    yield* page.until("the reopened answer caret", (one) => one.shows("message: ab!?界"));
    yield* page.key("Escape");
    yield* page.until("the question closing", (one) => !one.shows("[submit]"));
    yield* openConfigure(page);
    yield* page.key("Home");
    yield* sleep(30);
    yield* page.key("ArrowRight");
    yield* sleep(30);
    yield* page.type("X");
    yield* page.until("the Agent middle caret", (one) => one.shows("Agent: sXcribe"));
    yield* page.key("Backspace");
    yield* page.until("the Agent value restored", (one) => one.shows("Agent: scribe"));
    yield* tab(page);
    yield* tab(page);
    yield* page.key("Enter");
    yield* page.until(
      "History over Configure",
      (one) => one.shows("History") && !one.shows("[refresh]"),
    );
    yield* tab(page);
    yield* tab(page);
    yield* page.key("ArrowRight");
    yield* page.until("held History Exit guidance", (one) => one.shows("Enter exits"));
    yield* page.key("ArrowLeft");
    yield* page.until("held History opener guidance", (one) => one.shows("Enter opens History"));
    yield* page.key("Backtab");
    yield* sleep(30);
    yield* page.key("Enter");
    yield* page.until("the held Configure restored", (one) => one.shows("[refresh]"));
    // Explicit restoration is the History opener; ordinary Content entry is Agent.
    yield* page.key("Backtab");
    yield* sleep(30);
    yield* page.key("Backtab");
    yield* sleep(30);
    yield* page.type("!");
    yield* page.until("the Agent caret survived History", (one) => one.shows("Agent: s!cribe"));
    expect(page.screen().found("draft-kept", { after: "DRAFT" })).toBe(1);
  });
});

describe("Configure keyboard, retained values and window ownership", () => {
  it("CFG6: local arrows reach Configure choices, and Close or Escape return to its opener", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* draftText(page, "note");
    yield* configureOpened(page);
    yield* page.key("Alt+ArrowDown");
    yield* page.key("Alt+ArrowDown");
    yield* page.key("Enter");
    yield* page.until("the second choice selected by keyboard", (one) => one.shows("(x) Fast"));
    yield* page.key("ArrowUp");
    yield* page.key("Enter");
    yield* page.until("Up returning to the first choice", (one) => one.shows("(x) Balanced"));
    yield* page.type("zz");
    yield* page.key("Escape");
    yield* configured(page);
    expect(draftHolds(page.screen(), "note")).toBe(true);
    expect(composerHolds(page.screen(), "zz")).toBe(false);
    yield* page.key("Enter");
    yield* page.until("the opener receiving Enter after Escape", (one) => one.shows("[refresh]"));
    yield* page.press("[close]");
    yield* configured(page);
    yield* page.key("Enter");
    yield* page.until("the opener receiving Enter after Close", (one) => one.shows("[refresh]"));
    yield* page.key("Escape");
    yield* configured(page);
    yield* draftText(page, "-more", ["Backtab"]);
    expect(yield* finishDraft(page)).toBe("note-more");
  });

  it("CFG6: a choice below the drawer's window is reached by scrolling to it", function* () {
    const page = yield* useReplPage();
    const many = Array.from({ length: 64 }, (_, at) => ({
      id: `model-${at + 1}`,
      name: `Model ${at + 1}`,
    }));
    page.repl.fake.configuration({ model: { selected: "model-1", choices: many }, effort: {} });
    yield* page.press("[configure scribe]");
    yield* page.until("the advertised models", (one) => one.shows("Model 1"));
    expect(page.screen().shows("( ) Model 64")).toBe(false);
    for (let at = 0; at < 64; at += 1) {
      yield* page.key("Alt+ArrowDown");
      yield* sleep(30);
    }
    yield* page.until("keyboard reveal of Model 64", (one) => one.shows("( ) Model 64"));
    yield* chooseOffered(page, "Model 64");
    expect(page.screen().shows("(x) Model 64")).toBe(true);
    yield* scrollDrawerTo(page, "[apply]");
    yield* applyConfigure(page);
    yield* configured(page);
    yield* page.until("the pane's Send", sidekickIdle);
    yield* awaitedFact("the saved preference", function* () {
      return (yield* settledReading(page.repl)).chat.some((one) => one.kind === "preferences");
    });
    const saved = (yield* settledReading(page.repl)).chat.filter(
      (one) => one.kind === "preferences",
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ model: "model-64" });
  });

  it("CFG6: a half-filled Sidekick question keeps its values across Configure", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    page.repl.fake.script({ reply: "<Output>Ready.</Output>\n" });
    yield* sendMessage(page, "hello");
    yield* page.until("the first reply", (one) => one.shows("Ready."));
    yield* page.until("the idle Sidekick", sidekickIdle);
    yield* configureOpened(page);
    yield* closeDrawer(page);
    yield* pendingQuestion(page, "Approve the plan?", REVIEW_SCHEMA);
    page.repl.fake.script({ reply: "<Output>Thanks for deciding.</Output>\n" });
    yield* openedQuestion(page);
    yield* answerField(page, "message", "ok");
    yield* page.press("( ) approve");
    yield* page.until("the partial answer", (one) => one.shows("message: ok"));
    yield* closeDrawer(page);
    yield* configureOpened(page);
    yield* chooseOffered(page, "Fast");
    yield* closeDrawer(page);
    yield* openedQuestion(page);
    expect(page.screen().shows("(x) approve")).toBe(true);
    expect(page.screen().shows("message: ok")).toBe(true);
    yield* page.key("Alt+ArrowDown");
    yield* page.key("Alt+ArrowDown");
    yield* page.type("ay");
    yield* page.until("the complete value", (one) => one.shows("message: okay"));
    yield* page.press("[submit]");
    yield* page.until("the reply that was waiting", (one) => one.shows("Thanks for deciding."));
    expect(JSON.parse(page.repl.fake.prompts[2] ?? "")).toEqual({
      decision: "approve",
      message: "okay",
    });
  });

  it("CFG6: control — an explicitly selected narrow Sidekick draws Configure and takes its keys", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* draftText(page, "note");
    yield* intoComposer(page);
    yield* configureOpened(page);
    yield* page.resize(NARROW);
    expect(page.screen().shows("Balanced")).toBe(true);
    yield* page.type("-two");
    yield* page.until("the narrow Agent field taking keys", (one) =>
      one.shows("Agent: scribe-two"),
    );
    expect(page.screen().shows("DRAFT")).toBe(false);
    yield* page.press("[close]");
    yield* configured(page);
    yield* openEntryCatalog(page);
    yield* closeDrawer(page);
    expect(page.screen().found("note", { after: "DRAFT" })).toBe(1);
    expect(yield* finishDraft(page)).toBe("note");
  });

  it("CX3: Escape closes History first, and Configure under its own rule after", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* draftText(page, "note");
    yield* configureOpened(page);
    yield* chooseOffered(page, "Fast");
    yield* openHistory(page);
    yield* page.key("Escape");
    yield* page.until("History closing over Configure", (one) => one.shows("[refresh]"));
    expect(page.repl.outcome()).toBeUndefined();
    expect(page.screen().shows("(x) Fast")).toBe(true);
    yield* page.key("Escape");
    yield* configured(page);
    expect((yield* settledReading(page.repl)).chat.some((one) => one.kind === "preferences")).toBe(
      false,
    );
    yield* configureOpened(page);
    expect(page.screen().shows("(x) Fast")).toBe(false);
    expect(yield* finishDraft(page)).toBe("note");
  });
});

function transcriptLines(reading: ScreenReading): string[] {
  const heading = reading.locate("Entries");
  return reading.rows.map((row) => row.slice(0, heading.column));
}

function transcriptHas(reading: ScreenReading, text: string): boolean {
  return transcriptLines(reading).some((row) => row.includes(text));
}

function* chooseTurn(page: ReplPage, text: string): Operation<void> {
  const row = transcriptLines(page.screen()).find((one) => one.includes(text));
  if (row === undefined) {
    throw new Error(`no Transcript row says ${text}. ${page.describe()}`);
  }
  yield* page.press(text, { onRow: row.trim() });
}

function* newConversation(page: ReplPage): Operation<void> {
  yield* openConfigure(page);
  yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
  yield* page.until("the new conversation offer", (one) => one.shows("[start new conversation]"));
  yield* applyConfigure(page);
  yield* configured(page);
  yield* page.until("the new empty conversation", (one) => one.shows("No messages yet."));
}

function* twoChats(page: ReplPage, withOlderFailure = false): Operation<void> {
  page.repl.fake.configuration(ADVERTISED);
  page.repl.fake.script({ reply: "<Output>Older answer.</Output>\n" });
  if (withOlderFailure) {
    page.repl.fake.script({ reply: "<Output>Older attempt.</Output>\n", stopReason: "max_tokens" });
  }
  page.repl.fake.script({ reply: "<Output>Newer answer.</Output>\n" });
  yield* sendMessage(page, "older ask");
  yield* page.until("the older answer", (one) => sidekickShows(one, "Older answer."));
  yield* page.until("the first chat idle", sidekickIdle);
  if (withOlderFailure) {
    yield* sendMessage(page, "older failed");
    yield* page.until("the older failure", (one) => transcriptHas(one, "older failed · failed"));
    yield* page.until("the first chat idle", sidekickIdle);
  }
  yield* newConversation(page);
  if (withOlderFailure) {
    yield* page.until("failure hold after agent replacement", (one) => one.shows("[Resume queue]"));
    yield* page.press("[Resume queue]");
    yield* page.until("explicit failure hold release", (one) => !one.shows("[Resume queue]"));
  }
  yield* sendMessage(page, "newer ask");
  yield* page.until("the newer answer", (one) => sidekickShows(one, "Newer answer."));
  yield* page.until("the new chat idle", sidekickIdle);
}

function assertReadOnly(reading: ScreenReading): void {
  expect(reading.shows("[Back to current chat]")).toBe(true);
  for (const absent of [COMPOSER, "[configure", "[retry]", "[answer sidekick]"]) {
    expect(reading.shows(absent)).toBe(false);
  }
  for (const absent of ["[send]", "[stop]"]) {
    expect(reading.found(absent, { rightOf: "[Back to current chat]" })).toBe(0);
  }
}

function* backToCurrent(page: ReplPage, reply = "Newer answer."): Operation<void> {
  yield* page.press("[Back to current chat]");
  yield* page.until("the current chat", (one) => sidekickShows(one, reply));
}

describe("Transcript ownership and immutable older chat readings", () => {
  it("SS1: both sections hold their own work, settled in the order each finishes", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ held: true, reply: "ENTRY-DONE" });
    page.repl.fake.script({ deltas: ["<Output>Side ans", "wer.</Output>\n"], holdAfter: 1 });
    yield* pasteDraft(page, '<Session name="planner"><Prompt text="ask-entry" /></Session>\n');
    yield* page.key("Enter");
    yield* page.repl.fake.holdingTurns(1);
    yield* sendMessage(page, "ask side");
    yield* page.repl.fake.streamingTurns(1);
    const listed = yield* page.until(
      "both owners listed",
      (one) => transcriptHas(one, "ask-entry") && transcriptHas(one, "ask side"),
    );
    expect(transcriptHas(listed, "Entry agents")).toBe(false);
    expect(transcriptHas(listed, MOUNTED_AGENT)).toBe(true);
    page.repl.fake.releaseDeltas();
    yield* page.until("the later-started turn completing first", (one) =>
      transcriptHas(one, "ask side · completed"),
    );
    expect((yield* settledReading(page.repl)).model.turns).toEqual([]);
    page.repl.fake.releaseTurn();
    yield* page.until("the entry turn being recorded", (one) =>
      transcriptLines(one).some(
        (row) => row.includes("[A] ask-e") && row.includes("completed, recorded"),
      ),
    );
    const lines = transcriptLines(page.screen());
    expect(lines.filter((line) => line.includes("ask side"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("[A] ask-e"))).toHaveLength(1);
    const read = yield* settledReading(page.repl);
    expect(read.model.turns).toHaveLength(1);
    expect(read.model.turns[0]?.input).toBe("ask-entry");
    expect(read.chat.some((record) => record.kind === "message")).toBe(true);
    expect(read.model.sessions).toHaveLength(1);
  });

  it("SS1: a turn that renders nothing is announced at begin and keeps its row", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "<Output>First answer.</Output>\n<REPL.Bindings />\n" });
    page.repl.fake.script({ held: true, reply: "<REPL.Bindings />\n" });
    yield* sendMessage(page, "read it");
    yield* page.until("the first reply", (one) => sidekickShows(one, "First answer."));
    yield* page.repl.fake.holdingTurns(1);
    const fed = page.repl.terminal.fed;
    yield* page.until("the empty follow-up announced", (one) =>
      transcriptLines(one).some(
        (row) => row.includes("Automatic feed") && row.includes("generating"),
      ),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().shows("REPL.Bindings")).toBe(false);
    page.repl.fake.releaseTurn();
    yield* page.until("the empty follow-up saved", (one) =>
      transcriptLines(one).some(
        (row) => row.includes("Automatic feed") && row.includes("completed"),
      ),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().shows("REPL.Bindings")).toBe(false);
    expect(
      transcriptLines(page.screen()).filter((row) => row.includes("Automatic feed")),
    ).toHaveLength(1);
    expect(transcriptLines(page.screen()).filter((row) => row.includes("read it"))).toHaveLength(1);
  });

  it("SS7: a fresh Transcript says nothing is retained, and an unreadable chat history is refused with its reason", function* () {
    yield* scoped(function* () {
      const page = yield* useReplPage();
      expect(transcriptHas(page.screen(), "(none retained)")).toBe(true);
      for (const label of ["Entry agents", "No entry turns", "No Sidekick turns"]) {
        expect(transcriptHas(page.screen(), label)).toBe(false);
      }
      expect(page.screen().shows("No messages yet.")).toBe(true);
    });
    const host = yield* useMountedHost();
    const first = yield* useReplPage({ host });
    yield* exchange(first, "say once", "Said once.");
    const execution = yield* mountedExecution(first.repl);
    yield* finishDraft(first);
    const path = join(host.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE);
    yield* writeTextFile(path, (yield* readTextFile(path)) + "{not a record\n");
    const page = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    yield* page.until(
      "the unreadable chat reason",
      (one) => one.shows("chat history holds a record this") && one.shows("cannot read (record"),
    );
    expect(page.screen().shows("[exit]")).toBe(true);
    expect(page.screen().shows(COMPOSER)).toBe(false);
    expect(page.screen().shows("No messages yet.")).toBe(false);
    expect(page.screen().shows("(none retained)")).toBe(false);
  });

  it("SS4: activating an older turn opens its chat read-only, and Back comes home", function* () {
    const page = yield* useReplPage();
    yield* twoChats(page);
    yield* compose(page, "not sent yet");
    const before = {
      prompts: page.repl.fake.prompts.length,
      ensured: page.repl.fake.ensured.length,
      chat: (yield* settledReading(page.repl)).chat.length,
    };
    expect((yield* settledReading(page.repl)).model.entries).toHaveLength(0);
    yield* chooseTurn(page, "older ask");
    const reading = yield* page.until("the older chat", (one) =>
      sidekickShows(one, "[S] Older answer."),
    );
    expect(sidekickShows(reading, "Newer answer.")).toBe(false);
    assertReadOnly(reading);
    expect(page.repl.fake.prompts).toHaveLength(before.prompts);
    expect(page.repl.fake.ensured).toHaveLength(before.ensured);
    expect((yield* settledReading(page.repl)).chat).toHaveLength(before.chat);
    expect((yield* settledReading(page.repl)).model.entries).toHaveLength(0);
    yield* backToCurrent(page);
    expect(composerHolds(page.screen(), "not sent yet")).toBe(true);
    expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(1);
    expect(page.screen().shows("[Back to current chat]")).toBe(false);
  });

  it("SS4: the active chat keeps its controls, and a current update leaves the reading alone", function* () {
    const page = yield* useReplPage();
    yield* twoChats(page);
    page.repl.fake.script({ held: true, reply: "<Output>Arrived later.</Output>\n" });
    yield* sendMessage(page, "one more");
    yield* page.repl.fake.holdingTurns(1);
    yield* chooseTurn(page, "older ask");
    yield* page.until("the older chat", (one) => sidekickShows(one, "Older answer."));
    const fed = page.repl.terminal.fed;
    page.repl.fake.releaseTurn();
    yield* page.until("the current reply recorded", (one) =>
      transcriptHas(one, "one more · completed"),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(sidekickShows(page.screen(), "Older answer.")).toBe(true);
    expect(sidekickShows(page.screen(), "Arrived later.")).toBe(false);
    expect(page.screen().shows(COMPOSER)).toBe(false);
    yield* backToCurrent(page, "Arrived later.");
    expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(1);
    expect(page.screen().shows(`[configure ${OTHER_MOUNTED_AGENT}]`)).toBe(true);
  });

  it("SS4: a pending question and its partial answer survive reading an older chat", function* () {
    const page = yield* useReplPage();
    yield* twoChats(page);
    yield* pendingQuestion(page, "Approve the plan?", REVIEW_SCHEMA);
    page.repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    yield* openedQuestion(page);
    yield* page.type("appr");
    yield* page.until("the partial decision", (one) => one.shows("decision: appr"));
    yield* closeDrawer(page);
    const answer = page.screen().locate("[answer sidekick]");
    yield* chooseTurn(page, "older ask");
    yield* page.until("the older chat", (one) => sidekickShows(one, "Older answer."));
    for (const absent of [
      "Approve the plan?",
      "decision: appr",
      "[submit]",
      "[answer sidekick]",
      COMPOSER,
    ]) {
      expect(page.screen().shows(absent)).toBe(false);
    }
    assertReadOnly(page.screen());
    page.repl.terminal.feed(`\x1b[<0;${answer.column + 1};${answer.row + 1}M`);
    yield* sleep(100);
    expect(page.screen().shows("[submit]")).toBe(false);
    expect(sidekickShows(page.screen(), "Older answer.")).toBe(true);
    expect(page.screen().shows("Noted.")).toBe(false);
    yield* draftText(page, "my entry", ["Tab", "Tab", "Tab"]);
    yield* page.press("[Back to current chat]");
    yield* page.until("the question notice coming home", (one) => one.shows("[answer sidekick]"));
    expect(page.screen().shows("[submit]")).toBe(false);
    yield* openedQuestion(page);
    expect(page.screen().shows("decision: appr")).toBe(true);
    expect(page.screen().shows("Noted.")).toBe(false);
    expect(page.screen().found("my entry", DRAFT_VALUE)).toBe(1);
    expect(yield* finishDraft(page)).toBe("my entry");
  });
});

function* questionThroughKeyboard(explicit: boolean): Operation<ReplPage> {
  const page = yield* useReplPage();
  page.repl.fake.script({ reply: askingReply("Sidekick asks.", ONE_FIELD) });
  if (explicit) {
    yield* intoComposer(page);
  } else {
    for (let press = 0; press < 4; press += 1) {
      yield* page.key("Backtab");
    }
  }
  yield* page.type("ask");
  yield* page.until("the composer reached by keyboard", (one) => composerHolds(one, "ask"));
  expect(draftHolds(page.screen(), "ask")).toBe(false);
  yield* sendComposed(page);
  yield* page.until("the question notice", (one) => one.shows("[answer sidekick]"));
  yield* openedQuestion(page);
  yield* page.type("partial");
  yield* page.until("the partial answer", (one) => one.shows("message: partial"));
  return page;
}

describe("Sidekick resize ownership", () => {
  it("Q-P1: a form hidden by a resize does not consume Draft typing", function* () {
    const page = yield* questionThroughKeyboard(false);
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows("[submit]")).toBe(false);
    yield* draftText(page, "ordinary", ["Tab"]);
    yield* page.until(
      "the visible Draft taking text",
      (one) => one.found("ordinary", { after: "DRAFT" }) === 1,
    );
    yield* page.resize(WIDE);
    yield* page.until("the form returning", (one) => one.shows("[submit]"));
    expect(page.screen().shows("partialordinary")).toBe(false);
    expect(page.screen().shows("message: partial")).toBe(true);
    expect(page.screen().found("ordinary", DRAFT_VALUE)).toBe(1);
    expect(yield* finishDraft(page)).toBe("ordinary");
  });

  it("Q-P1: control — an explicitly selected form still edits its own field", function* () {
    const page = yield* questionThroughKeyboard(true);
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows("[submit]")).toBe(true);
    expect(narrow.shows("DRAFT")).toBe(false);
    yield* page.type(" more");
    yield* page.until("the visible form taking text", (one) => one.shows("message: partial more"));
    yield* page.resize(WIDE);
    expect(page.screen().found("partial more", DRAFT_VALUE)).toBe(0);
    expect(yield* finishDraft(page)).toBeUndefined();
  });

  it("CFG6: History over Configure closes once, and a hidden Configure takes no keys", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* draftText(page, "note");
    yield* configureOpened(page);
    expect(yield* historyOver(page)).toBe(false);
    expect(page.repl.outcome()).toBeUndefined();
    expect(page.screen().shows("[refresh]")).toBe(true);
    expect((yield* page.resize(NARROW)).shows("[refresh]")).toBe(false);
    yield* page.type("-more");
    yield* page.until(
      "the visible Draft receiving the text",
      (one) => one.found("note-more", { after: "DRAFT" }) === 1,
    );
    yield* page.resize(WIDE);
    yield* page.until("Configure returning", (one) => one.shows("[refresh]"));
    expect(page.screen().shows("Balanced")).toBe(true);
    expect(page.screen().shows("scribe-more")).toBe(false);
    expect(yield* finishDraft(page)).toBe("note-more");
  });
});

const LONG_FIELDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "last",
];
const LONG_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    LONG_FIELDS.map((name) => [name, { type: "string", description: `What ${name} is for.` }]),
  ),
  required: ["one"],
  additionalProperties: false,
};

function* scrollFormTo(page: ReplPage, label: string, direction: "up" | "down"): Operation<void> {
  for (let press = 0; press < 100 && !page.screen().shows(label); press += 1) {
    const before = page.screen().index;
    yield* page.key(direction === "down" ? "PageDown" : "PageUp");
    yield* page.until("the form scrolling", (one) => one.index > before);
  }
  expect(page.screen().shows(label)).toBe(true);
}

function atSize(page: ReplPage, size: { columns: number; rows: number }): Operation<ScreenReading> {
  return page.screen().size.columns === size.columns && page.screen().size.rows === size.rows
    ? (function* () {
        return page.screen();
      })()
    : page.resize(size);
}

describe("Sidekick drawers across every supported size", () => {
  it("MQ4: the form stays inside its own pane at every size, and survives a refusal", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "mine");
    yield* pendingQuestion(page, "Fill this in.", LONG_SCHEMA);
    yield* compose(page, "later");
    yield* page.press("[answer sidekick]");
    yield* page.until(
      "the long form opening",
      (one) => one.shows("Fill this in.") && one.shows("one:"),
    );
    yield* page.type("first");
    yield* page.until("the partial value", (one) => one.shows("one: first"));
    expect(page.screen().shows("last:")).toBe(false);
    expect(page.screen().shows("[submit]")).toBe(true);
    yield* scrollFormTo(page, "last:", "down");
    expect(page.screen().shows("last:")).toBe(true);
    yield* scrollFormTo(page, "Fill this in.", "up");
    for (const size of PROFILES) {
      const reading = yield* atSize(page, size);
      expect(reading.shows("Fill this in.")).toBe(true);
      expect(reading.shows("one: first")).toBe(true);
      expect(reading.occurrences("[close]")).toBe(1);
      expect(reading.shows("[exit]")).toBe(true);
      if (size.columns > NARROW.columns) {
        expect(reading.found("mine", DRAFT_VALUE)).toBe(1);
      } else {
        expect(reading.shows("DRAFT")).toBe(false);
      }
    }
    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.shows("needs at least 72x20")).toBe(true);
    expect(refused.shows("[")).toBe(false);
    for (const size of [NARROW, WIDE]) {
      yield* page.resize(size);
      yield* page.until("the partial form returning", (one) => one.shows("one: first"));
    }
    expect(page.screen().found("mine", DRAFT_VALUE)).toBe(1);
    yield* page.press("[close]");
    yield* page.until("the question notice returning", (one) => one.shows("[answer sidekick]"));
    expect(page.screen().shows("[close]")).toBe(false);
    yield* selectPane(page, "bindings");
    for (const absent of ["[close]", "[answer sidekick]", "Fill this in."]) {
      expect(page.screen().shows(absent)).toBe(false);
    }
    yield* selectPane(page, "sidekick");
    expect(page.screen().shows("[close]")).toBe(false);
    expect(composerHolds(page.screen(), "later")).toBe(true);
    yield* page.press("[answer sidekick]");
    yield* page.until("the same partial form reopening", (one) => one.shows("one: first"));
    expect(yield* finishDraft(page)).toBe("mine");
  });

  it("CFG6: Configure stays inside its pane at every size, and survives a refusal", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    yield* draftText(page, "note");
    yield* compose(page, "ask");
    yield* configureOpened(page);
    yield* chooseOffered(page, "Fast");
    for (const size of PROFILES) {
      const reading = yield* atSize(page, size);
      expect(reading.shows("(x) Fast")).toBe(true);
      expect(reading.shows("[refresh]")).toBe(true);
      expect(reading.occurrences("[close]")).toBe(1);
      expect(reading.shows("[exit]")).toBe(true);
      if (size.columns > NARROW.columns) {
        expect(reading.found("note", DRAFT_VALUE)).toBe(1);
      } else {
        expect(reading.shows("DRAFT")).toBe(false);
      }
    }
    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.shows("needs at least 72x20")).toBe(true);
    expect(refused.shows("[refresh]")).toBe(false);
    yield* page.resize(WIDE);
    yield* page.until("Configure restoring its unapplied choice", (one) => one.shows("(x) Fast"));
    expect(page.screen().found("note", DRAFT_VALUE)).toBe(1);
    yield* page.key("Escape");
    yield* configured(page);
    expect(composerHolds(page.screen(), "ask")).toBe(true);
    yield* page.key("Enter");
    yield* page.until("the restored opener activating", (one) => one.shows("[refresh]"));
    expect(yield* finishDraft(page)).toBe("note");
  });

  it("CX4: Configure choices page without window buttons", function* () {
    const many = Array.from({ length: 64 }, (_, at) => ({
      id: `model-${at + 1}`,
      name: `Model ${at + 1}`,
    }));
    const page = yield* useReplPage();
    page.repl.fake.configuration({ model: { selected: "model-1", choices: many }, effort: {} });
    yield* page.press("[configure scribe]");
    yield* page.until("the advertised models", (one) => one.shows("Model 1"));
    for (const { size, choice } of [
      { size: WIDE, choice: 64 },
      { size: { columns: 120, rows: 30 }, choice: 63 },
    ]) {
      yield* atSize(page, size);
      expect(page.screen().found("[↑ scroll up]", { rightOf: "[close]" })).toBe(0);
      expect(page.screen().found("[↓ scroll down]", { rightOf: "[close]" })).toBe(0);
      expect(page.screen().found("[↑ earlier]", { rightOf: "[close]" })).toBe(0);
      expect(page.screen().found("[↓ later]", { rightOf: "[close]" })).toBe(0);
      expect(page.screen().shows("[↑ earlier]")).toBe(false);
      expect(page.screen().shows(`( ) Model ${choice}`)).toBe(false);
      yield* scrollDrawerTo(page, `( ) Model ${choice}`);
      yield* chooseOffered(page, `Model ${choice}`);
      expect(page.screen().shows(`(x) Model ${choice}`)).toBe(true);
      for (let press = 0; press < 100 && !page.screen().shows("Model 1"); press += 1) {
        const before = page.screen().index;
        yield* page.key("PageUp");
        yield* page.until("the choices scrolling back", (one) => one.index > before);
      }
      expect(page.screen().shows("Model 1")).toBe(true);
    }
  });
});

function* pairBytes(
  root: string,
  execution: string,
): Operation<{ entries: string; sidekick: string }> {
  const directory = join(root, PAIRED_DIRECTORY, execution);
  return {
    entries: yield* readTextFile(join(directory, ENTRIES_FILE)),
    sidekick: yield* readTextFile(join(directory, SIDEKICK_FILE)),
  };
}

function* refusedLocation(host: MountedHost, location: string): Operation<string> {
  return yield* scoped(function* () {
    const page = yield* useReplPage({ host, location });
    expect(page.screen().shows("[exit]")).toBe(true);
    yield* page.press("[exit]");
    yield* awaited("the refused command returning", () => page.repl.outcome() !== undefined);
    const result = page.repl.outcome();
    if (result === undefined || result.ok) {
      throw new Error("this location did not refuse");
    }
    return result.error.message;
  });
}

describe("Older chats retain their identity across failure and cold opening", () => {
  it("SS2: a current failure read beside an older chat leaves its items alone", function* () {
    const page = yield* useReplPage();
    yield* twoChats(page, true);
    page.repl.fake.script({
      deltas: ["<Output>Current half.</Output>\n", "<REPL.Bindings />\n"],
      holdAfter: 1,
      stopReason: "refusal",
    });
    yield* sendMessage(page, "goes wrong");
    yield* page.repl.fake.streamingTurns(1);
    yield* chooseTurn(page, "older ask");
    yield* page.until("the older answer", (one) => sidekickShows(one, "Older answer."));
    const olderRows = function* () {
      const read = projectSidekick((yield* settledReading(page.repl)).chat);
      if (!read.ok) {
        throw read.error;
      }
      const older = read.value.conversations[0]?.id;
      return sidekickChatRows(read.value, undefined).filter((one) => one.conversation === older);
    };
    const before = yield* olderRows();
    expect(before.map((one) => one.kind)).toEqual(["person", "reply", "person", "incomplete"]);
    expect(new Set(before.map((one) => one.key)).size).toBe(before.length);
    for (const absent of ["goes wrong", "Current half."]) {
      expect(sidekickShows(page.screen(), absent)).toBe(false);
    }
    expect(sidekickShows(page.screen(), "(unfinished)")).toBe(true);
    expect(chatLines(page.screen(), "[S] Older answer.").join(" ")).toContain("max_tokens");
    const looking = chatLines(page.screen(), "[S] Older answer.").filter(
      (line) => line !== "" && line !== "[S] working",
    );
    page.repl.fake.releaseDeltas();
    yield* page.until("the current failure being saved", (one) =>
      transcriptHas(one, "goes wrong · failed"),
    );
    expect(yield* olderRows()).toEqual(before);
    expect(
      chatLines(page.screen(), "[S] Older answer.").filter(
        (line) => line !== "" && line !== "[S] working",
      ),
    ).toEqual(looking);
    for (const absent of ["goes wrong", "Current half."]) {
      expect(sidekickShows(page.screen(), absent)).toBe(false);
    }
    yield* backToCurrent(page, "goes wrong");
    expect(chatLines(page.screen(), "[U] goes wrong").join(" ")).toContain("refusal");
  });

  it("SS5: the same older chat is selected read-only, with no provider work and no writes", function* () {
    const dataRoot = yield* useTemporary("xmd-ss5-cold-");
    let root = "";
    let execution = "";
    const location = yield* scoped(function* () {
      const host = yield* useMountedHost({ dataRoot });
      root = host.root;
      const page = yield* useReplPage({ host });
      yield* twoChats(page);
      yield* chooseTurn(page, "older ask");
      yield* page.until("the older chat", (one) => sidekickShows(one, "Older answer."));
      execution = yield* mountedExecution(page.repl);
      yield* page.press("[exit]");
      yield* awaited("the first command returning", () => page.repl.outcome() !== undefined);
      const outcome = page.repl.outcome();
      if (outcome === undefined || !outcome.ok) {
        throw new Error("the first command did not return its location");
      }
      return outcome.value.location;
    });
    const before = yield* pairBytes(root, execution);
    expect(location).toContain("sidekick=");
    expect(location).toContain("view=sidekick");
    const cold = yield* useMountedHost({ dataRoot });
    const page = yield* useReplPage({ host: cold, location });
    expect(sidekickShows(page.screen(), "Older answer.")).toBe(true);
    expect(sidekickShows(page.screen(), "Newer answer.")).toBe(false);
    assertReadOnly(page.screen());
    expect(cold.fake.created).toEqual([]);
    expect(cold.fake.ensured).toEqual([]);
    expect(cold.fake.prompts).toEqual([]);
    expect(yield* pairBytes(root, execution)).toEqual(before);
  });

  it("SS5: selecting another surface and coming back does not forget the pinned chat", function* () {
    const page = yield* useReplPage();
    yield* exchange(page, "only ask", "Only answer.");
    yield* chooseTurn(page, "only ask");
    yield* page.until("the explicit selection", (one) => one.shows("[Back to current chat]"));
    expect(page.screen().shows(COMPOSER)).toBe(true);
    expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(1);
    yield* selectPane(page, "bindings");
    yield* selectPane(page, "sidekick");
    yield* page.until("the pinned chat returning", (one) => sidekickShows(one, "Only answer."));
    expect(page.screen().shows("[Back to current chat]")).toBe(true);
    yield* openEntryCatalog(page);
    yield* closeDrawer(page);
    yield* selectPane(page, "sidekick");
    expect(sidekickShows(page.screen(), "Only answer.")).toBe(true);
    expect(page.screen().shows("[Back to current chat]")).toBe(true);
  });

  it("SS2: a chat whose setup failed opens read-only, saying what became of it", function* () {
    const dataRoot = yield* useTemporary("xmd-ss2-setup-");
    let root = "";
    let execution = "";
    yield* scoped(function* () {
      const first = yield* useMountedHost({ dataRoot });
      root = first.root;
      const page = yield* useReplPage({ host: first });
      first.fake.configuration(ADVERTISED);
      first.fake.unavailable(OTHER_MOUNTED_AGENT, new Error("that agent will not start here"));
      yield* exchange(page, "only ask", "The only answer.");
      yield* openConfigure(page);
      yield* replaceAgent(page, OTHER_MOUNTED_AGENT);
      yield* applyConfigure(page);
      yield* page.until("the setup failure", (one) => one.shows("will not start"));
      execution = yield* mountedExecution(page.repl);
      yield* finishDraft(page);
    });
    const before = yield* pairBytes(root, execution);
    const read = projectSidekick(
      yield* readSidekickRecords(join(root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE)),
    );
    if (!read.ok) {
      throw read.error;
    }
    const broken = read.value.conversations.find((one) => one.phase === "failed");
    expect(broken?.failure).toContain("will not start");
    expect(read.value.turns.filter((one) => one.conversation === broken?.id)).toEqual([]);
    if (broken === undefined) {
      throw new Error("the failed setup is missing from the history");
    }
    const cold = yield* useMountedHost({ dataRoot });
    const page = yield* useReplPage({
      host: cold,
      location: `xmd://repl/${execution}/sessions?view=sidekick&right=sidekick&sidekick=${encodeURIComponent(broken.id)}`,
    });
    yield* page.until("the failed chat's status", (one) => sidekickShows(one, "Setup failed:"));
    expect(sidekickShows(page.screen(), "Setup failed: that agent will")).toBe(true);
    expect(sidekickShows(page.screen(), "The only answer.")).toBe(false);
    assertReadOnly(page.screen());
    expect([cold.fake.created, cold.fake.ensured, cold.fake.prompts]).toEqual([[], [], []]);
    expect(yield* pairBytes(root, execution)).toEqual(before);
    yield* backToCurrent(page, "The only answer.");
    expect(page.screen().shows(`[configure ${MOUNTED_AGENT}]`)).toBe(true);
    expect(yield* pairBytes(root, execution)).toEqual(before);
  });

  it("SS2: an unknown chat refuses cold before an unfinished entry could resume", function* () {
    const dataRoot = yield* useTemporary("xmd-ss2-unfinished-");
    let root = "";
    let execution = "";
    yield* scoped(function* () {
      const first = yield* useMountedHost({ dataRoot });
      root = first.root;
      const page = yield* useReplPage({ host: first });
      yield* exchange(page, "chat ask", "Chat answer.");
      first.fake.script({ held: true, reply: "ENTRY-NEVER" });
      yield* pasteDraft(
        page,
        '<Session name="planner"><Prompt text="unfinished-entry" /></Session>\n',
        ["Tab", "Tab", "Tab", "Tab"],
      );
      yield* page.key("Enter");
      yield* first.fake.holdingTurns(1);
      execution = yield* mountedExecution(page.repl);
    });
    const before = yield* pairBytes(root, execution);
    const cold = yield* useMountedHost({ dataRoot });
    const opened = yield* cold.repository.open(execution);
    const projected = projectRepl(yield* opened.stream.readAll());
    if (!projected.ok) {
      throw projected.error;
    }
    const unfinished = projected.value.entries.filter((entry) => !entry.settled);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.source).toContain("unfinished-entry");
    expect(
      yield* refusedLocation(
        cold,
        `xmd://repl/${execution}/entries?view=sidekick&sidekick=never-held`,
      ),
    ).toContain("never-held");
    expect([cold.fake.created, cold.fake.ensured, cold.fake.prompts]).toEqual([[], [], []]);
    expect(yield* pairBytes(root, execution)).toEqual(before);
    const page = yield* useReplPage({
      host: cold,
      location: `xmd://repl/${execution}/entries?view=sidekick`,
    });
    yield* page.until("the valid location reaching its screen", (one) => one.shows("Chat answer."));
    expect(page.repl.outcome()).toBeUndefined();
  });

  it("SS2: an unknown or unselectable chat refuses cold, before anything can run", function* () {
    const dataRoot = yield* useTemporary("xmd-ss2-unselectable-");
    let root = "";
    let execution = "";
    yield* scoped(function* () {
      const first = yield* useMountedHost({ dataRoot });
      root = first.root;
      const page = yield* useReplPage({ host: first });
      yield* exchange(page, "only ask", "Only answer.");
      yield* pasteDraft(page, TWO_STEP_ENTRY, ["Tab", "Tab", "Tab", "Tab"]);
      yield* page.key("Enter");
      yield* entrySettles(page, 1, "ok");
      execution = yield* mountedExecution(page.repl);
      yield* finishDraft(page);
    });
    const before = yield* pairBytes(root, execution);
    const cold = yield* useMountedHost({ dataRoot });
    const legacy = join(cold.root, "legacy-selector.jsonl");
    yield* writeTextFile(legacy, "");
    for (const scenario of [
      {
        location: `xmd://repl/${execution}/entries?view=sidekick&sidekick=never-held`,
        reason: "never-held",
      },
      {
        location: "xmd://repl/legacy-selector/entries?sidekick=anything",
        reason: "no Sidekick history",
      },
    ]) {
      expect(yield* refusedLocation(cold, scenario.location)).toContain(scenario.reason);
      expect([cold.fake.created, cold.fake.ensured, cold.fake.prompts]).toEqual([[], [], []]);
      expect(yield* pairBytes(root, execution)).toEqual(before);
      expect(yield* readTextFile(legacy)).toBe("");
    }
    expect(yield* publishedPairs(root)).toEqual([execution]);
  });
});

function* conversationChoices(page: ReplPage): Operation<string[]> {
  yield* page.press(" ▾");
  yield* page.until("the offered conversations", (one) => one.shows("All conversations"));
  return page
    .screen()
    .rows.filter((row) => row.trimStart().startsWith("xmd:v1:"))
    .flatMap((row) => {
      const match = row.match(/xmd:v1:[a-z0-9:]+…?/);
      return match === null ? [] : [match[0]];
    });
}

function* filterChoice(page: ReplPage, choice: string): Operation<void> {
  const row = page.screen().rows.find((one) => one.trimStart().startsWith(choice));
  if (row === undefined) {
    throw new Error(`no choice for ${choice}: ${page.describe()}`);
  }
  yield* page.press(choice, { onRow: row });
  yield* page.until("the chosen filter", (one) => !one.shows("All conversations"));
}

function selectedFilter(one: ScreenReading): string | undefined {
  return one.rows.find((row) => row.includes(" ▾"))?.match(/xmd:v1:[a-z0-9:]+…?/)?.[0];
}

function promptEntry(text: string): string {
  return `<Session name="planner"><Prompt text="${text}" /></Session>\n`;
}

function* appendBoundary(stopped: boolean): Operation<void> {
  const dataRoot = yield* useTemporary("xmd-ss3-boundary-");
  const operations = operationGate();
  let execution = "";
  let observed = "";
  yield* scoped(function* () {
    const host = yield* useMountedHost({ dataRoot, operations });
    const page = yield* useReplPage({ host });
    page.repl.fake.script({ reply: "<Output>Never saved.</Output>\n", turnId: "sk-turn-stop" });
    const hold = operations.holdNext((path, record) => {
      if (!path.endsWith(SIDEKICK_FILE) || !record.includes("agent_prompt")) {
        return false;
      }
      observed = /xmd:v1:[0-9a-f:]+/.exec(record)?.[0] ?? "";
      return true;
    });
    yield* compose(page, "stop me");
    yield* sendComposed(page);
    yield* hold.started();
    expect(observed).not.toBe("");
    expect(hold.holding).toBe(true);
    const offered = yield* conversationChoices(page);
    expect(offered).toHaveLength(1);
    yield* filterChoice(page, offered[0]);
    const standing = selectedFilter(page.screen());
    expect(standing).toBeDefined();
    expect(transcriptHas(page.screen(), "stop me")).toBe(true);
    if (stopped) {
      yield* stopSidekick(page);
      yield* awaited("the operation abandoning its append", () => hold.abandoned);
      expect(hold.holding).toBe(false);
    } else {
      hold.release();
      yield* page.until("the released turn completed", (one) =>
        transcriptHas(one, "stop me · completed"),
      );
      yield* page.until("the released cycle idle", sidekickIdle);
    }
    expect(
      operations.appended.some(
        (one) => one.path.endsWith(SIDEKICK_FILE) && one.record.includes("agent_prompt"),
      ),
    ).toBe(!stopped);
    const saved = yield* settledReading(page.repl);
    expect(personMessages(saved.chat)).toEqual(["stop me"]);
    expect(
      saved.chat.filter((one) => one.kind === "event" && one.event.includes("agent_prompt")),
    ).toHaveLength(stopped ? 0 : 1);
    const projected = projectSidekick(saved.chat);
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.turns).toHaveLength(stopped ? 0 : 1);
    expect(selectedFilter(page.screen())).toBe(standing);
    execution = yield* mountedExecution(page.repl);
    yield* finishDraft(page);
  });
  const cold = yield* useMountedHost({ dataRoot });
  const location = `xmd://repl/${execution}/sessions?session=${encodeURIComponent(observed)}`;
  if (stopped) {
    expect(yield* refusedLocation(cold, location)).toContain(observed);
  } else {
    const page = yield* useReplPage({ host: cold, location });
    expect(selectedFilter(page.screen())).toBeDefined();
    expect(transcriptHas(page.screen(), "stop me")).toBe(true);
  }
  expect(cold.fake.created).toEqual([]);
  expect(cold.fake.prompts).toEqual([]);
}

describe("Sidekick original provider membership and cancelled append", () => {
  it("SS3: Stop before the canonical append leaves the key local and nothing saved", function* () {
    yield* appendBoundary(true);
  });
  it("SS3: control — released rather than stopped, that boundary saves its turn", function* () {
    yield* appendBoundary(false);
  });
  it("SS3: each owner's provider key is one choice of its own, and filters to that owner's row", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "ENTRY-REPLY" });
    page.repl.fake.script({ reply: "<Output>Shared answer.</Output>\n", turnId: "sk-turn-1" });
    yield* pasteDraft(page, promptEntry("entry-ask"));
    yield* page.key("Enter");
    yield* page.until(
      "the entry turn recorded",
      (one) => transcriptHas(one, "entry") && transcriptHas(one, "completed, recorded"),
    );
    yield* compose(page, "chat ask");
    yield* sendComposed(page);
    yield* page.until("the chat turn saved", (one) => transcriptHas(one, "chat ask · completed"));
    yield* page.until("the cycle idle", sidekickIdle);
    yield* page.resize(NARROW);
    yield* page.press("Sessions");
    yield* page.until("the full Transcript outlet", (one) => one.shows("All sessions"));
    const choices = yield* conversationChoices(page);
    expect(choices).toHaveLength(2);
    expect(new Set(choices).size).toBe(2);
    yield* filterChoice(page, choices[0]);
    expect(transcriptHas(page.screen(), "entry")).toBe(true);
    expect(transcriptHas(page.screen(), "chat ask")).toBe(false);
    yield* conversationChoices(page);
    yield* filterChoice(page, choices[1]);
    expect(transcriptHas(page.screen(), "chat ask")).toBe(true);
    expect(transcriptHas(page.screen(), "entry")).toBe(false);
    yield* conversationChoices(page);
    yield* page.press("All conversations");
    yield* page.until(
      "both owners' rows",
      (one) => transcriptHas(one, "entry") && transcriptHas(one, "chat ask"),
    );
  });

  it("SS3: a live key filters its own unsaved row, and survives the cycle ending", function* () {
    const gate = appendGate();
    const host = yield* useMountedHost({ gate });
    const page = yield* useReplPage({ host });
    page.repl.fake.script({ reply: "<Output>Said it.</Output>\n", turnId: "sk-turn-1" });
    const hold = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes("agent_prompt"),
    );
    yield* compose(page, "say it");
    yield* sendComposed(page);
    yield* hold.started();
    const choices = yield* conversationChoices(page);
    expect(choices).toHaveLength(1);
    yield* filterChoice(page, choices[0]);
    const standing = selectedFilter(page.screen());
    expect(standing).toBeDefined();
    expect(transcriptHas(page.screen(), "say it")).toBe(true);
    expect(personMessages((yield* settledReading(page.repl)).chat)).toEqual(["say it"]);
    hold.release();
    yield* stopSidekick(page);
    yield* page.until("idle after the saved append", sidekickIdle);
    expect(selectedFilter(page.screen())).toBe(standing);
    expect(page.screen().shows("xmd:v1:")).toBe(true);
  });

  it("SS3: a Sidekick key is selectable at an entry checkpoint that precedes it", function* () {
    const dataRoot = yield* useTemporary("xmd-ss3-prefix-");
    let execution = "";
    let marker = "";
    let entryKey = "";
    let chatKey = "";
    yield* scoped(function* () {
      const host = yield* useMountedHost({ dataRoot });
      const page = yield* useReplPage({ host });
      yield* pasteDraft(page, TWO_STEP_ENTRY);
      yield* page.key("Enter");
      yield* entrySettles(page, 1, "ok");
      const first = yield* settledReading(page.repl);
      marker = first.model.checkpoints.at(-1)?.marker ?? "";
      expect(marker).not.toBe("");
      page.repl.fake.script({ reply: "ENTRY-REPLY" });
      page.repl.fake.script({ reply: "<Output>Chat answer.</Output>\n" });
      yield* pasteDraft(page, promptEntry("later-entry"));
      yield* page.key("Enter");
      yield* page.until(
        "the second entry recorded",
        (one) => transcriptHas(one, "later") && transcriptHas(one, "completed, recorded"),
      );
      yield* compose(page, "chat ask");
      yield* sendComposed(page);
      yield* page.until(
        "the chat idle",
        (one) => chatHas(one, "Chat answer.") && sidekickIdle(one),
      );
      execution = yield* mountedExecution(page.repl);
      const read = yield* settledReading(page.repl);
      entryKey = read.model.turns.map((one) => one.sessionKey).find((one) => one.length > 0) ?? "";
      const chat = projectSidekick(read.chat);
      if (!chat.ok) {
        throw chat.error;
      }
      chatKey =
        chat.value.turns.map((one) => one.sessionKey).find((one) => one !== undefined) ?? "";
      expect(entryKey).not.toBe("");
      expect(chatKey).not.toBe("");
      expect(entryKey).not.toBe(chatKey);
      yield* finishDraft(page);
    });
    const cold = yield* useMountedHost({ dataRoot });
    const prefix = `xmd://repl/${execution}/sessions?at=${encodeURIComponent(marker)}&inspect&session=`;
    yield* scoped(function* () {
      const page = yield* useReplPage({
        host: cold,
        location: prefix + encodeURIComponent(chatKey),
      });
      expect(selectedFilter(page.screen())).toBeDefined();
      expect(transcriptHas(page.screen(), "chat ask")).toBe(true);
      expect(transcriptHas(page.screen(), "later-")).toBe(false);
      yield* finishDraft(page);
    });
    const refusal = yield* refusedLocation(cold, prefix + encodeURIComponent(entryKey));
    expect(refusal).toContain(entryKey);
    expect(refusal).toContain("had started at this history position");
  });
});

function composerRows(one: ScreenReading, anchor?: string): string[] {
  const prompt = one.locate(COMPOSER);
  const edge = anchor === undefined ? 0 : one.locate(anchor, { after: COMPOSER }).column;
  const footer = one.locate("HISTORY");
  return one.rows.slice(prompt.row + 1, footer.row).map((row) => row.slice(edge).trimEnd());
}

function* composerPaste(
  page: ReplPage,
  text: string,
  visible = (text.split("\n").at(-1) ?? "").split(/\s+/).at(-1) ?? "",
): Operation<void> {
  const index = page.screen().index;
  yield* page.type(text);
  yield* page.until(
    "the composer's newest line",
    (one) => one.index > index && one.found(visible, { after: COMPOSER }) > 0,
  );
}

function* populateChat(page: ReplPage, count: number, prefix = "SAID"): Operation<void> {
  for (let number = 1; number <= count; number += 1) {
    yield* exchange(page, `ask-${number}`, `${prefix}-${number}`);
  }
}

describe("Sidekick original multiline composer ownership", () => {
  it("MC5: the value wraps into rows of its own, and the chat gives them room", function* () {
    const page = yield* useReplPage();
    yield* populateChat(page, 10);
    yield* intoComposer(page);
    expect(composerRows(page.screen())).toHaveLength(1);
    yield* composerPaste(page, "a question whose words have to wrap onto another row of the pane");
    const wrapped = composerRows(page.screen(), "a question");
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join(" ")).toContain("a question whose words");
    expect(wrapped.join(" ")).toContain("another row of the pane");
    yield* composerPaste(page, "\nx\n\né́ 広い", "い");
    const pasted = composerRows(page.screen(), "a question");
    expect(pasted.length).toBeGreaterThan(wrapped.length);
    expect(pasted).toContain("x");
    expect(pasted).toContain("");
    expect(pasted.join(" ")).toContain("広");
    expect(pasted.join(" ")).toContain("い");
    expect(chatHas(page.screen(), "SAID-10")).toBe(true);
    for (const label of [COMPOSER, "[history]", "[exit]"]) {
      expect(page.screen().shows(label)).toBe(true);
    }
    expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(1);
    for (let i = 0; i < 12; i += 1) {
      yield* page.key("Backspace");
    }
    yield* page.until("the value shrinking", (one) => composerRows(one).length < pasted.length);
    expect(yield* finishDraft(page)).toBeUndefined();
  });

  it("MC6: six rows at most, and Send carries the original text once", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    page.repl.fake.script({ reply: "<Output>Understood.</Output>\n" });
    yield* intoComposer(page);
    const text = Array.from({ length: 9 }, (_, i) => `LINE-${i + 1}`).join("\n");
    yield* composerPaste(page, text);
    const shown = composerRows(page.screen(), "LINE-9");
    expect(shown).toHaveLength(6);
    expect(shown.at(-1)).toBe("LINE-9");
    expect(shown).not.toContain("LINE-1");
    const hold = gate.holdNext(
      (path, record) => path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"message"'),
    );
    yield* sendComposed(page);
    yield* hold.started();
    yield* composerPaste(page, "NEWER-1\nNEWER-2\nNEWER-3");
    const newer = composerRows(
      page.screen(),
      page.screen().shows("NEWER-3") ? "NEWER-3" : "while busy",
    );
    expect(newer.length).toBeGreaterThan(1);
    hold.release();
    yield* page.until("the acknowledged multiline message", (one) => chatHas(one, "Understood."));
    expect(personMessages((yield* settledReading(page.repl)).chat)).toEqual([text]);
    expect(page.repl.fake.prompts).toHaveLength(1);
    expect(page.repl.fake.prompts[0]).toContain("LINE-1");
    expect(page.repl.fake.prompts[0]).toContain("LINE-9");
    expect(page.repl.fake.prompts[0]).not.toContain("NEWER-1");
    expect(
      composerRows(page.screen(), page.screen().shows("NEWER-3") ? "NEWER-3" : "while busy"),
    ).toEqual(newer);
  });

  it("MC6: control — an acknowledged Send leaves one blank value row", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "<Output>Done.</Output>\n" });
    yield* intoComposer(page);
    yield* composerPaste(page, "one\ntwo\nthree");
    expect(composerRows(page.screen()).length).toBeGreaterThan(1);
    yield* sendComposed(page);
    yield* page.until("the value acknowledged", (one) => chatHas(one, "Done."));
    expect(composerRows(page.screen())).toHaveLength(1);
    expect(personMessages((yield* settledReading(page.repl)).chat)).toEqual(["one\ntwo\nthree"]);
  });

  it("MC7: the value, its focus and its height survive every size and a held turn", function* () {
    const page = yield* useReplPage();
    yield* populateChat(page, 8);
    yield* intoComposer(page);
    const original = Array.from({ length: 8 }, (_, i) => `ROW-${i + 1}`).join("\n");
    yield* composerPaste(page, original);
    expect(composerRows(page.screen())).toHaveLength(6);
    for (const size of [{ columns: 120, rows: 30 }, NARROW]) {
      yield* page.resize(size);
      expect(composerRows(page.screen()).join("\n")).toContain("ROW-8");
      expect(composerRows(page.screen()).length).toBeGreaterThanOrEqual(1);
      expect(composerRows(page.screen()).length).toBeLessThanOrEqual(6);
      expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(1);
      expect(chatHas(page.screen(), "SAID-8")).toBe(true);
    }
    const refused = yield* page.resize(TOO_SMALL);
    expect(refused.shows("72x20")).toBe(true);
    expect(refused.shows("[send]")).toBe(false);
    yield* page.resize(WIDE);
    expect(composerRows(page.screen())).toHaveLength(6);
    yield* selectPane(page, "bindings");
    yield* selectPane(page, "sidekick");
    expect(composerRows(page.screen()).join("\n")).toContain("ROW-8");
    page.repl.fake.script({ held: true, reply: "<Output>Held answer.</Output>\n" });
    yield* intoComposer(page);
    yield* composerPaste(page, "go");
    yield* sendComposed(page);
    yield* page.repl.fake.holdingTurns(1);
    yield* composerPaste(page, "while busy\nline two");
    const newer = composerRows(
      page.screen(),
      page.screen().shows("NEWER-3") ? "NEWER-3" : "while busy",
    );
    page.repl.fake.releaseTurn();
    yield* page.until("the held reply arriving", (one) => chatHas(one, "Held answer."));
    expect(
      composerRows(page.screen(), page.screen().shows("NEWER-3") ? "NEWER-3" : "while busy"),
    ).toEqual(newer);
    expect(page.repl.fake.prompts).toHaveLength(9);
    expect(page.repl.fake.prompts[8]).not.toContain("while busy");
    expect(yield* finishDraft(page)).toBeUndefined();
  });
});

function submitting(source: string): string {
  return [
    '<Let as="code" select="code">',
    "````xmd",
    source,
    "````",
    "</Let>",
    "<REPL.EntryInput>{code}</REPL.EntryInput>",
    "<REPL.Submit />",
    "",
  ].join("\n");
}

const HI_FIRST = "<Output>the first entry</Output>";
const HI_SECOND = "<Output>the second entry</Output>";
const HI_THIRD = "<Output>the third entry</Output>";
const HI_FAILING = '```js eval\nthrow new Error("the third entry failed");\n```';

function* entryRun(page: ReplPage, source: string, ordinal: number): Operation<void> {
  yield* pasteDraft(page, source);
  yield* page.key("Enter");
  yield* entrySettles(page, ordinal, "ok");
}

function* freezeFirst(page: ReplPage): Operation<void> {
  yield* openHistory(page);
  yield* page.press("2 · Entry outcome recorded");
  yield* page.until("the first entry's outcome selected", (one) => one.shows("[live]"));
}

function* leaveLocation(page: ReplPage): Operation<string> {
  page.repl.terminal.end();
  yield* awaited("the command returning its location", () => page.repl.outcome() !== undefined);
  const result = page.repl.outcome();
  if (result === undefined || !result.ok) {
    throw new Error("the command returned no successful location");
  }
  return result.value.location;
}

function* recordedReceipt(page: ReplPage, said: string): Operation<void> {
  yield* awaitedFact(`the saved receipt ${said}`, function* () {
    return (yield* settledReading(page.repl)).chat.some(
      (one) => one.kind === "feedback" && one.text.includes(said),
    );
  });
}

function submitIntent(chat: readonly SidekickRecord[]) {
  for (const one of [...chat].reverse()) {
    if (one.kind === "control" && one.submit !== undefined) {
      return one.submit;
    }
  }
  throw new Error("no Submit intent was retained");
}

function* historicalSubmit(historical: boolean, failed: boolean): Operation<void> {
  const dataRoot = yield* useTemporary("xmd-hi-submit-");
  const location = yield* scoped(function* () {
    const page = yield* useReplPage({ dataRoot });
    yield* entryRun(page, HI_FIRST, 1);
    yield* entryRun(page, HI_SECOND, 2);
    if (historical) {
      yield* freezeFirst(page);
    }
    return yield* leaveLocation(page);
  });
  const page = yield* useReplPage({ dataRoot, location });
  if (historical) {
    yield* closeDrawer(page);
    yield* page.press("[live]");
    yield* page.until("the acknowledged head", (one) => !one.shows("[live]"));
  }
  const source = failed ? HI_FAILING : HI_THIRD;
  page.repl.fake.script({ reply: submitting(source) });
  yield* compose(page, "run one more");
  yield* sendComposed(page);
  yield* entrySettles(page, 3, failed ? "err" : "ok");
  const receipt = `Entry entry-3 ${failed ? "failed" : "completed"}.`;
  yield* recordedReceipt(page, receipt);
  const read = yield* settledReading(page.repl);
  expect(read.model.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
  expect(read.model.entries.map((one) => one.terminal?.status)).toEqual([
    "ok",
    "ok",
    failed ? "err" : "ok",
  ]);
  expect(read.model.entries[2]?.source).toBe(source);
  const intent = submitIntent(read.chat);
  expect([intent.entry, intent.ordinal, intent.source]).toEqual(["entry-3", 2, source]);
  const feedback = read.chat
    .flatMap((one) => (one.kind === "feedback" ? [one.text] : []))
    .join("\n");
  expect(feedback).toContain(receipt);
  expect(feedback).toContain(
    failed
      ? "Inspect its saved evidence with <REPL.Entry.Journal entry={3} />."
      : "Read what it printed with <REPL.Entry.Output entry={3} />.",
  );
  expect(feedback).not.toContain("entry={1}");
  expect(feedback).not.toContain("entry={2}");
  if (failed) {
    expect(feedback).toContain("It failed:");
  }
}

describe("Sidekick original acknowledged history submission identity", () => {
  for (const arm of [
    { name: "opened at the first entry", historical: true },
    { name: "control: opened at the head", historical: false },
  ]) {
    it(`HI1: ${arm.name}, a reply's Submit names the entry it actually ran`, function* () {
      yield* historicalSubmit(arm.historical, false);
    });
  }
  it("HI2: a failed entry's intent, receipt and read target all name that entry", function* () {
    yield* historicalSubmit(true, true);
  });
  it("HI2b: a failure released while an earlier position is selected still names its own entry", function* () {
    const gate = appendGate();
    const page = yield* useReplPage({ gate });
    yield* entryRun(page, HI_FIRST, 1);
    yield* entryRun(page, HI_SECOND, 2);
    const hold = gate.holdNext(
      (path, record) => path.endsWith(ENTRIES_FILE) && record.includes('"type":"close"'),
    );
    page.repl.fake.script({ reply: submitting(HI_FAILING) });
    page.repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    yield* compose(page, "run one that fails");
    yield* sendComposed(page);
    yield* hold.started();
    yield* freezeFirst(page);
    yield* closeDrawer(page);
    hold.release();
    yield* page.until("the failure's followup", (one) => sidekickShows(one, "Noted."));
    expect(page.screen().shows("[live]")).toBe(true);
    const read = yield* settledReading(page.repl);
    expect(read.model.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(read.model.entries[2]?.terminal?.status).toBe("err");
    expect(submitIntent(read.chat).entry).toBe("entry-3");
    const feedback = read.chat
      .flatMap((one) => (one.kind === "feedback" ? [one.text] : []))
      .join("\n");
    expect(feedback).toContain("Entry entry-3 failed.");
    expect(feedback).toContain("Inspect its saved evidence with <REPL.Entry.Journal entry={3} />.");
    expect(feedback).not.toContain("entry={1}");
    expect(feedback).not.toContain("entry={2}");
    expect(
      renderReceipt({
        entry: "entry-3",
        status: "failed",
        failure: "the third entry failed",
        read: { entry: "entry-3" },
      }),
    ).toContain("Inspect its saved evidence with <REPL.Entry.Journal entry={3} />.");
  });
  it("HI3: frozen, Run establishes nothing; live, it admits the next entry", function* () {
    const dataRoot = yield* useTemporary("xmd-hi-person-");
    const location = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot });
      yield* entryRun(page, HI_FIRST, 1);
      yield* entryRun(page, HI_SECOND, 2);
      yield* freezeFirst(page);
      return yield* leaveLocation(page);
    });
    const page = yield* useReplPage({ dataRoot, location });
    yield* closeDrawer(page);
    for (let press = 0; press < 40 && !page.screen().shows("Enter unavailable"); press += 1) {
      yield* tab(page);
    }
    yield* page.type(HI_THIRD);
    yield* page.until(
      "the frozen Draft holding its source",
      (one) => one.found(HI_THIRD, DRAFT_VALUE) === 1,
    );
    yield* page.key("Enter");
    yield* page.until("the frozen Run refusal", (one) => one.shows("live head"));
    expect((yield* settledReading(page.repl)).model.entries).toHaveLength(2);
    expect(page.screen().found(HI_THIRD, DRAFT_VALUE)).toBe(1);
    yield* page.press("[live]");
    yield* page.until("the live head restored", (one) => !one.shows("[live]"));
    yield* intoDraft(page);
    yield* page.key("Enter");
    yield* entrySettles(page, 3, "ok");
    expect(page.screen().found(HI_THIRD, DRAFT_VALUE)).toBe(0);
    const read = yield* settledReading(page.repl);
    expect(read.model.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(read.model.entries[2]?.source).toBe(HI_THIRD);
  });
});

function* chatWheel(page: ReplPage, direction: "up" | "down"): Operation<void> {
  const one = page.screen();
  const composer = one.shows(COMPOSER)
    ? one.locate(COMPOSER)
    : one.locate("[Back to current chat]");
  yield* page.wheel(direction, {
    column: composer.column,
    row: one.shows(COMPOSER) ? composer.row - 3 : composer.row + 2,
  });
}
function shownChat(one: ScreenReading): string[] {
  const scope = one.shows("DRAFT") ? { rightOf: "DRAFT" } : undefined;
  const anchor = one.rows
    .flatMap((row) =>
      [...row.matchAll(/\[[US]\] /g)].map((match) => row.slice(match.index).trimEnd()),
    )
    .find((label) => one.found(label, scope) === 1);
  if (anchor === undefined) {
    throw new Error(`no visible chat item: ${one.rows.join("\n")}`);
  }
  return chatLines(one, anchor);
}
function* chatScroll(
  page: ReplPage,
  direction: "up" | "down",
  until: (one: ScreenReading) => boolean,
): Operation<void> {
  for (let press = 0; press < 150 && !until(page.screen()); press += 1) {
    const index = page.screen().index;
    yield* chatWheel(page, direction);
    yield* page.until("the chat's new reading", (one) => one.index > index);
  }
  expect(until(page.screen())).toBe(true);
}
function* savedResponses(page: ReplPage, count: number): Operation<void> {
  yield* awaitedFact(`${count} saved responses`, function* () {
    return (
      (yield* settledReading(page.repl)).chat.filter((one) => one.kind === "response").length >=
      count
    );
  });
  yield* page.until("the saved cycle idle", sidekickIdle);
}
function* reachTurn(
  page: ReplPage,
  label: string,
  direction: "up" | "down" = "down",
): Operation<void> {
  if (!transcriptHas(page.screen(), label)) {
    yield* atSize(page, NARROW);
    yield* page.press("Sessions");
    yield* page.until(
      "the Sessions outlet",
      (one) => one.shows("All sessions") || one.shows("All sessions ▾"),
    );
    for (let press = 0; press < 150 && !transcriptHas(page.screen(), label); press += 1) {
      const index = page.screen().index;
      yield* page.wheel(direction, { column: 2, row: page.screen().locate("Sessions").row + 3 });
      yield* page.until("the Transcript's next rows", (one) => one.index > index);
    }
  }
  yield* chooseTurn(page, label);
  yield* page.until("the selected chat opening", (one) => one.shows("[Back to current chat]"));
  yield* atSize(page, WIDE);
}
function* twoOverflowingChats(page: ReplPage): Operation<void> {
  page.repl.fake.configuration(ADVERTISED);
  for (let i = 1; i <= 10; i += 1) {
    yield* exchange(page, `old-${i}`, `OLD-${i}\nmore`);
  }
  yield* newConversation(page);
  for (let i = 1; i <= 10; i += 1) {
    yield* exchange(page, `new-${i}`, `NEW-${i}\nmore`);
  }
}

describe("Sidekick original independent readings and streaming rows", () => {
  it("CF-P1: scrolling an older chat leaves the current chat's own reading alone", function* () {
    const page = yield* useReplPage();
    yield* twoOverflowingChats(page);
    expect(chatHas(page.screen(), "NEW-10")).toBe(true);
    yield* reachTurn(page, "old-1 ", "up");
    yield* chatScroll(page, "up", (one) => !chatHas(one, "OLD-10"));
    yield* backToCurrent(page, "NEW-10");
    expect(chatHas(page.screen(), "NEW-10")).toBe(true);
  });
  it("CF-P1: control — a deliberate current reading also survives the visit", function* () {
    const page = yield* useReplPage();
    yield* twoOverflowingChats(page);
    yield* chatScroll(page, "up", (one) => !chatHas(one, "NEW-10"));
    const held = shownChat(page.screen());
    yield* reachTurn(page, "old-1 ", "up");
    yield* page.press("[Back to current chat]");
    yield* page.until("the current controls returning", (one) => one.shows(COMPOSER));
    expect(shownChat(page.screen())).toEqual(held);
  });
  it("CF3: a reading somebody scrolled to stays put while the next reply saves", function* () {
    const page = yield* useReplPage();
    yield* populateChat(page, 12, "ANSWER");
    yield* chatScroll(page, "up", (one) => !chatHas(one, "ANSWER-12"));
    const held = shownChat(page.screen());
    page.repl.fake.script({ held: true, reply: "<Output>ANSWER-13</Output>\n" });
    yield* compose(page, "ask-13");
    yield* sendComposed(page);
    yield* page.repl.fake.holdingTurns(1);
    page.repl.fake.releaseTurn();
    yield* savedResponses(page, 13);
    expect(JSON.stringify((yield* settledReading(page.repl)).chat)).toContain("ANSWER-13");
    expect(chatHas(page.screen(), "ANSWER-13")).toBe(false);
    expect(shownChat(page.screen())).toEqual(held);
    yield* chatScroll(page, "down", (one) => chatHas(one, "ANSWER-13"));
    yield* exchange(page, "ask-14", "ANSWER-14");
  });
  it("CF-E1: a held reply grows into another row, and settles in the same item", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "mine");
    const first = `<Output>BEGIN\n${Array.from({ length: 30 }, (_, i) => `ROW-${i + 1}`).join("\n")}`;
    page.repl.fake.script({
      deltas: [first, "\nTAIL-LAST</Output>\n"],
      holdsEachPiece: true,
      holdAfter: 2,
    });
    yield* compose(page, "grow");
    yield* sendComposed(page);
    yield* page.repl.fake.streamingTurns(1);
    yield* composerPaste(page, "later");
    yield* page.until("the preview's newest row", (one) => chatHas(one, "ROW-30"));
    const fed = page.repl.terminal.fed;
    expect(
      (yield* settledReading(page.repl)).chat.filter((one) => one.kind === "response"),
    ).toHaveLength(0);
    expect(chatHas(page.screen(), "BEGIN")).toBe(false);
    page.repl.fake.releaseDeltas();
    yield* page.until("the preview growing", (one) => chatHas(one, "TAIL-LAST"));
    expect(page.repl.terminal.fed).toBe(fed);
    expect(
      (yield* settledReading(page.repl)).chat.filter((one) => one.kind === "response"),
    ).toHaveLength(0);
    page.repl.fake.releaseDeltas();
    yield* savedResponses(page, 1);
    const responses = (yield* settledReading(page.repl)).chat.filter(
      (one) => one.kind === "response",
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ response: "response:1", hasOutput: true });
    expect(chatHas(page.screen(), "TAIL-LAST")).toBe(true);
    expect(page.repl.terminal.fed).toBe(fed);
    expect(composerHolds(page.screen(), "later")).toBe(true);
    expect(yield* finishDraft(page)).toBe("mine");
  });

  it("SS7: a held turn's every material fact arrives with nothing pressed", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ deltas: ["<Output>Half", " said.</Output>\n"], holdsEachPiece: true });
    yield* compose(page, "hold it");
    yield* sendComposed(page);
    yield* page.repl.fake.streamingTurns(1);
    const fed = page.repl.terminal.fed;
    yield* page.until("the generating status", (one) => transcriptHas(one, "hold it · generating"));
    expect(page.repl.terminal.fed).toBe(fed);
    yield* page.until(
      "the acknowledged composer clearing",
      (one) => !composerHolds(one, "hold it"),
    );
    page.repl.fake.releaseDeltas();
    yield* page.until("the completed status", (one) => transcriptHas(one, "hold it · completed"));
    expect(chatHas(page.screen(), "Half said.")).toBe(true);
    expect(page.repl.terminal.fed).toBe(fed);
  });
  it("SS7: a saved Prompt and a reply still being evaluated are two facts, unpressed", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: submitting(promptEntry("held entry")) });
    page.repl.fake.script({ held: true, reply: "ENTRY-ANSWER" });
    yield* compose(page, "evaluate it");
    yield* sendComposed(page);
    yield* page.repl.fake.holdingTurns(1);
    const fed = page.repl.terminal.fed;
    yield* page.until("the evaluation status", (one) => transcriptHas(one, "evaluating the reply"));
    const read = yield* settledReading(page.repl);
    expect(
      read.chat.filter((one) => one.kind === "event" && one.event.includes("agent_prompt")),
    ).toHaveLength(1);
    expect(read.chat.some((one) => one.kind === "response")).toBe(false);
    page.repl.fake.releaseTurn();
    yield* page.until("the completed evaluation", (one) =>
      transcriptHas(one, "evaluate it · completed"),
    );
    expect(page.screen().found("evaluate it", { rightOf: "TRANSCRIPT" })).toBeGreaterThan(0);
    expect(page.repl.terminal.fed).toBe(fed);
  });
});

describe("Sidekick original interrupted identities and native input routes", () => {
  it("SS6: an interrupted first message leaves every later row its own identity", function* () {
    const host = yield* useMountedHost();
    const first = yield* useReplPage({ host });
    first.repl.fake.script({ held: true, reply: "<Output>Unrecorded.</Output>\n" });
    yield* compose(first, "unrecorded");
    yield* sendComposed(first);
    yield* first.repl.fake.holdingTurns(1);
    yield* stopSidekick(first);
    yield* first.until("the cancelled first generation", sidekickIdle);
    const execution = yield* mountedExecution(first.repl);
    yield* leaveLocation(first);
    const page = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    yield* exchange(page, "saved ask", "Saved reply.");
    page.repl.fake.script({ reply: "<Output>Half said.</Output>\n", stopReason: "max_tokens" });
    yield* compose(page, "failed ask");
    yield* sendComposed(page);
    yield* page.until("the later failed turn", (one) => transcriptHas(one, "failed ask · failed"));
    const read = yield* settledReading(page.repl);
    expect(read.chat.flatMap((one) => (one.kind === "response" ? [one.response] : []))).toEqual([
      "response:2",
    ]);
    const projected = projectSidekick(read.chat);
    if (!projected.ok) {
      throw projected.error;
    }
    const turns = sidekickTurnRows(projected.value, undefined);
    expect(new Set(turns.map((one) => one.key)).size).toBe(turns.length);
    expect(turns.map((one) => [one.turn, one.state])).toEqual([
      [1, "completed"],
      [2, "failed"],
    ]);
    expect(turns[0]?.key).toContain("response:2");
    expect(turns[1]?.key).toContain(":turn:");
    const chat = sidekickChatRows(projected.value, undefined);
    expect(new Set(chat.map((one) => one.key)).size).toBe(chat.length);
    expect(
      transcriptLines(page.screen()).filter((row) => row.includes("saved ask ·")),
    ).toHaveLength(1);
    expect(
      transcriptLines(page.screen()).filter((row) => row.includes("failed ask ·")),
    ).toHaveLength(1);
  });

  it("SS6: a real automatic turn nobody answered opens as its own inert anchor", function* () {
    const dataRoot = yield* useTemporary("xmd-ss6-inert-");
    const gate = appendGate();
    const execution = yield* scoped(function* () {
      const host = yield* useMountedHost({ dataRoot, gate });
      const page = yield* useReplPage({ host });
      page.repl.fake.script({ reply: "<Output>First answer.</Output>\n<REPL.Bindings />\n" });
      page.repl.fake.script({ reply: "<REPL.Bindings />\n" });
      let seen = 0;
      const held = gate.holdNext(
        (path, record) =>
          path.endsWith(SIDEKICK_FILE) && record.includes('"kind":"response"') && ++seen === 2,
      );
      yield* compose(page, "read it");
      yield* sendComposed(page);
      yield* held.started();
      return yield* mountedExecution(page.repl);
    });
    const cold = yield* useMountedHost({ dataRoot });
    const page = yield* useReplPage({ host: cold, location: `xmd://repl/${execution}/sessions` });
    yield* page.until(
      "the saved automatic status",
      (one) => transcriptHas(one, "Automatic") && transcriptHas(one, "Turn"),
    );
    expect(page.screen().shows("REPL.Bindings")).toBe(false);
    yield* reachTurn(page, "Automatic");
    yield* page.until("the inert automatic anchor", (one) =>
      sidekickShows(one, "Automatic feedback · Turn saved"),
    );
    const rows = shownChat(page.screen()).map((row) => row.replace(/^\s*\[[US]\]\s/, "").trim());
    const at = rows.findIndex((row) => row.includes("Automatic feedback"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(
      rows
        .slice(at, at + 3)
        .join(" ")
        .trim(),
    ).toBe("Automatic feedback · Turn saved; no evaluated reply recorded.");
    expect(sidekickShows(page.screen(), "First answer.")).toBe(true);
    expect(page.screen().shows("REPL.Bindings")).toBe(false);
    expect(cold.fake.created).toEqual([]);
    expect(cold.fake.prompts).toEqual([]);
  });

  it("UH2: pointer and keyboard each reach both tabs, and neither composer loses text", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "kept entry");
    yield* compose(page, "kept question");
    for (let press = 0; press < 1; press += 1) {
      const index = page.screen().index;
      yield* page.key("Backtab");
      yield* page.until("the preceding control", (one) => one.index > index);
    }
    yield* page.key("Backtab");
    yield* page.key("Enter");
    yield* page.until("keyboard selecting Bindings", (one) => !one.shows(COMPOSER));
    yield* page.key("ArrowRight");
    yield* page.key("Enter");
    yield* page.until("keyboard selecting Sidekick", (one) => one.shows(COMPOSER));
    expect(composerHolds(page.screen(), "kept question")).toBe(true);
    yield* selectPane(page, "bindings");
    yield* selectPane(page, "sidekick");
    expect(page.screen().shows("[selected]")).toBe(false);
    expect(composerHolds(page.screen(), "kept question")).toBe(true);
    expect(yield* finishDraft(page)).toBe("kept entry");
  });

  it("UH5: an open History drawer still says Esc closes, and closing keeps both texts", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "kept entry");
    yield* compose(page, "kept question");
    yield* tab(page);
    yield* page.key("Enter");
    yield* page.until("the keyboard-opened History drawer", (one) => one.shows("[close]"));
    expect(page.screen().shows("Esc closes")).toBe(true);
    expect(page.screen().shows("Tab regions Alt↑↓")).toBe(true);
    yield* page.key("Escape");
    yield* page.until("History closing once", (one) => !one.shows("[close]"));
    expect(composerHolds(page.screen(), "kept question")).toBe(true);
    expect(yield* finishDraft(page)).toBe("kept entry");
  });

  it("UH4: resizing through narrow and back keeps both texts, and narrow grows no tabs", function* () {
    const page = yield* useReplPage();
    yield* draftText(page, "kept entry");
    for (let i = 0; i < 4; i += 1) {
      const index = page.screen().index;
      yield* page.key("Backtab");
      yield* page.until("the default composer's route", (one) => one.index > index);
    }
    yield* typed(page, "kept question");
    yield* page.resize({ columns: 120, rows: 30 });
    expect(page.screen().shows("BINDINGS")).toBe(true);
    expect(page.screen().shows("SIDEKICK")).toBe(true);
    expect(page.screen().shows("[selected]")).toBe(false);
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows("BINDINGS")).toBe(false);
    expect(narrow.shows("SIDEKICK")).toBe(false);
    expect(narrow.shows(COMPOSER)).toBe(false);
    expect(narrow.found("kept entry", DRAFT_VALUE)).toBe(1);
    yield* page.resize(WIDE);
    expect(composerHolds(page.screen(), "kept question")).toBe(true);
    expect(yield* finishDraft(page)).toBe("kept entry");
  });

  it("R3: the drawer opens through its own action and its field takes text", function* () {
    const page = yield* useReplPage();
    yield* intoComposer(page);
    yield* page.resize(NARROW);
    page.repl.fake.script({
      reply: askingReply("Which rounding rule?", {
        type: "object",
        properties: { rule: { type: "string", title: "Rounding rule" } },
        required: ["rule"],
        additionalProperties: false,
      }),
    });
    yield* typed(page, "which rule");
    yield* sendComposed(page);
    yield* page.until(
      "the question's own notice",
      (one) => one.shows("[answer sidekick]") && !one.shows("[close]"),
    );
    yield* openedQuestion(page);
    yield* page.type("half up, to the cent");
    yield* page.until("the named field receiving text", (one) => one.shows("half up, to the cent"));
    expect(page.screen().shows("Which rounding rule?")).toBe(true);
    expect(page.screen().shows("Rounding rule")).toBe(true);
    expect(page.screen().shows("[close]")).toBe(true);
  });
});

function* silentTurns(page: ReplPage, withFailure: boolean): Operation<number> {
  page.repl.fake.configuration(ADVERTISED);
  page.repl.fake.script({ reply: "<REPL.Bindings />\n" });
  page.repl.fake.script({ reply: "Nothing to add.\n" });
  yield* compose(page, "run it");
  yield* sendComposed(page);
  yield* savedResponses(page, 2);
  let count = 2;
  if (withFailure) {
    page.repl.fake.script({ reply: "<REPL.Delete />\n" });
    page.repl.fake.script({ reply: "<Output>Fixed it.</Output>\n" });
    yield* compose(page, "break it");
    yield* sendComposed(page);
    yield* savedResponses(page, 4);
    count = 4;
  }
  yield* exchange(page, "say it", "SPOKE-ALOUD");
  for (let number = 1; number <= 10; number += 1) {
    yield* exchange(page, `ask-${number}`, `ANSWER-${number}`);
  }
  return count + 11;
}
function* readSilentAndSpoken(page: ReplPage): Operation<void> {
  yield* reachTurn(page, "run it ", "up");
  yield* page.until("the silent turn's request", (one) => sidekickShows(one, "[U] run it"));
  expect(sidekickShows(page.screen(), "ANSWER-10")).toBe(false);
  const said = shownChat(page.screen()).filter((row) => row !== "");
  const first = said.findIndex((row) => row.includes("[U] run it"));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(said[first + 1]).toContain("[U] say it");
  expect(sidekickShows(page.screen(), "answered without saying")).toBe(false);
  expect(sidekickShows(page.screen(), "Nothing to add.")).toBe(false);
  yield* reachTurn(page, "Automatic", "up");
  yield* page.until("the chain's original request", (one) => sidekickShows(one, "[U] run it"));
  expect(sidekickShows(page.screen(), "ANSWER-10")).toBe(false);
  yield* reachTurn(page, "say it ", "up");
  yield* page.until("the spoken turn's own Output", (one) => sidekickShows(one, "SPOKE-ALOUD"));
}

describe("Sidekick original reveal and cold decision coverage", () => {
  it("SS4: a turn past the chat's window is revealed, and this screen keeps its own", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    for (let i = 1; i <= 12; i += 1) {
      yield* exchange(page, `ask-${i}`, `ANSWER-${i}`);
    }
    yield* newConversation(page);
    yield* exchange(page, "newer ask", "Newer answer.");
    page.repl.fake.script({ reply: "ENTRY-ANSWER" });
    yield* intoDraft(page, ["Tab", "Tab", "Tab", "Tab"]);
    yield* entryRun(page, promptEntry("kept-entry"), 1);
    yield* draftText(page, "my entry");
    yield* compose(page, "half typed");
    yield* selectPane(page, "bindings");
    expect(page.screen().shows(COMPOSER)).toBe(false);
    yield* reachTurn(page, "ask-12 ");
    yield* page.until("the selected older turn", (one) => sidekickShows(one, "ANSWER-12"));
    expect(shownChat(page.screen()).some((row) => /ANSWER-1\b/.test(row))).toBe(false);
    assertReadOnly(page.screen());
    yield* backToCurrent(page);
    expect(composerHolds(page.screen(), "half typed")).toBe(true);
    expect(page.screen().shows(`[configure ${OTHER_MOUNTED_AGENT}]`)).toBe(true);
    expect(entryTrail(page.screen())).toContain("Entry 1");
    expect(yield* finishDraft(page)).toBe("my entry");
  });

  it("ER4: a silent turn reveals the request it answered, and composes no anchor", function* () {
    const page = yield* useReplPage();
    yield* silentTurns(page, false);
    yield* newConversation(page);
    yield* exchange(page, "newer ask", "Newer answer.");
    page.repl.fake.script({ reply: "ENTRY-ANSWER" });
    yield* intoDraft(page, ["Tab", "Tab", "Tab", "Tab"]);
    yield* entryRun(page, promptEntry("kept-entry"), 1);
    yield* draftText(page, "my entry");
    yield* compose(page, "half typed");
    yield* readSilentAndSpoken(page);
    expect(sidekickShows(page.screen(), "Newer answer.")).toBe(false);
    yield* backToCurrent(page);
    expect(composerHolds(page.screen(), "half typed")).toBe(true);
    expect(entryTrail(page.screen())).toContain("Entry 1");
    expect(yield* finishDraft(page)).toBe("my entry");
  });

  it("ER5: the same chat reopened cold makes the same decisions, and costs nothing", function* () {
    const host = yield* useMountedHost();
    const first = yield* useReplPage({ host });
    yield* silentTurns(first, true);
    const execution = yield* mountedExecution(first.repl);
    const asked = host.fake.prompts.length;
    const opened = host.fake.ensured.length;
    yield* leaveLocation(first);
    const before = yield* pairBytes(host.root, execution);
    const page = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    yield* page.until("the cold latest reply", (one) => sidekickShows(one, "ANSWER-10"));
    yield* reachTurn(page, "break it ", "up");
    yield* page.until("the recorded failure", (one) =>
      sidekickShows(one, "(failed): a generated fragment"),
    );
    yield* reachTurn(page, "say it ", "up");
    yield* page.until("the recorded spoken output", (one) => sidekickShows(one, "SPOKE-ALOUD"));
    yield* reachTurn(page, "run it ", "up");
    yield* page.until("the recorded silent request", (one) => sidekickShows(one, "[U] run it"));
    yield* reachTurn(page, "say it ", "up");
    yield* page.until("the spoken reply before choosing its earlier automatic neighbour", (one) =>
      sidekickShows(one, "SPOKE-ALOUD"),
    );
    let automatic = "";
    for (let press = 0; press < 12; press += 1) {
      automatic = page.screen().rows.find((row) => row.includes("Automatic fee")) ?? "";
      if (
        automatic.length > 0 &&
        page.screen().rows.filter((row) => row.includes(automatic)).length === 1
      ) {
        break;
      }
      const index = page.screen().index;
      yield* chatWheel(page, "down");
      yield* page.until(
        "a distinct visible row beside the repeated caption",
        (one) => one.index > index,
      );
    }
    expect(page.screen().rows.filter((row) => row.includes(automatic))).toHaveLength(1);
    yield* page.press("Automatic fee", { onRow: automatic });
    yield* page.until("the cold automatic turn's original request", (one) =>
      sidekickShows(one, "[U] run it"),
    );
    expect(sidekickShows(page.screen(), "ANSWER-10")).toBe(false);
    expect(sidekickShows(page.screen(), "Nothing to add.")).toBe(false);
    expect(sidekickShows(page.screen(), "answered without saying")).toBe(false);
    expect(sidekickShows(page.screen(), "REPL.Bindings")).toBe(false);
    expect(host.fake.prompts).toHaveLength(asked);
    expect(host.fake.ensured).toHaveLength(opened);
    expect(yield* pairBytes(host.root, execution)).toEqual(before);
  });

  it("SS7: control — an ordinary entry turn reaches the Sessions reading the same way", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "ENTRY-REPLY" });
    yield* pasteDraft(page, promptEntry("control-ask"));
    yield* page.key("Enter");
    const fed = page.repl.terminal.fed;
    yield* page.until(
      "the entry's recorded provider turn",
      (one) => transcriptHas(one, "contr") && transcriptHas(one, "completed, recorded"),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().shows("Entry agents")).toBe(false);
    expect(transcriptHas(page.screen(), MOUNTED_AGENT)).toBe(true);
    expect(transcriptLines(page.screen()).filter((row) => row.includes("contr"))).toHaveLength(1);
  });
});

describe("Sidekick original populated chat profiles", () => {
  it("SS7: three profiles keep a populated older reading, its window and the way home", function* () {
    const page = yield* useReplPage();
    page.repl.fake.configuration(ADVERTISED);
    for (let i = 1; i <= 6; i += 1) {
      yield* exchange(page, `old-${i}`, `OLD-${i}`);
    }
    yield* newConversation(page);
    yield* exchange(page, "current ask", "Current answer.");
    yield* draftText(page, "my entry", ["Tab", "Tab", "Tab", "Tab"]);
    yield* compose(page, "my q");
    yield* reachTurn(page, "old-6 ");
    yield* page.until("the populated older reading", (one) => chatHas(one, "OLD-6"));
    for (const size of PROFILES) {
      const one = yield* atSize(page, size);
      if (!chatHas(one, "OLD-6")) {
        throw new Error(`the older last turn at ${size.columns}: ${page.describe()}`);
      }
      expect(one.shows("[Back to current chat]")).toBe(true);
      expect(one.shows("[exit]")).toBe(true);
      assertReadOnly(one);
      if (size.columns >= 120) {
        expect(one.shows("TRANSCRIPT")).toBe(true);
        expect(one.shows("SIDEKICK")).toBe(true);
        expect(one.found("my entry", DRAFT_VALUE)).toBe(1);
      } else {
        expect(one.shows("DRAFT")).toBe(false);
      }
    }
    yield* page.resize(WIDE);
    yield* backToCurrent(page, "Current answer.");
    expect(composerHolds(page.screen(), "my q")).toBe(true);
    expect(yield* finishDraft(page)).toBe("my entry");
  });

  it("SS7: three profiles keep both sections, the window, Back and both texts", function* () {
    const page = yield* useReplPage();
    yield* exchange(page, "older ask", "Older answer.");
    yield* draftText(page, "my entry", ["Tab", "Tab", "Tab", "Tab"]);
    yield* compose(page, "my q");
    yield* chooseTurn(page, "older ask ");
    yield* page.until("the current chat explicitly selected", (one) =>
      one.shows("[Back to current chat]"),
    );
    for (const size of PROFILES) {
      const one = yield* atSize(page, size);
      expect(one.shows("[exit]")).toBe(true);
      expect(one.shows("[Back to current chat]")).toBe(true);
      expect(composerHolds(one, "my q")).toBe(true);
      expect(chatHas(one, "Older answer.")).toBe(true);
      expect(one.found("[send]", SIDEKICK_CONTROLS)).toBe(1);
      if (size.columns >= 120) {
        expect(one.shows("TRANSCRIPT")).toBe(true);
        expect(one.shows("SIDEKICK")).toBe(true);
        expect(one.found("my entry", DRAFT_VALUE)).toBe(1);
      } else {
        expect(one.shows("DRAFT")).toBe(false);
      }
    }
    yield* page.resize(WIDE);
    expect(yield* finishDraft(page)).toBe("my entry");
  });
});

describe("Sidekick original independent body controls", () => {
  it("BP3: both bodies stay usable through their own controls, and narrow gains no inset", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ reply: "ENTRY-REPLY" });
    yield* entryRun(page, promptEntry("entry-ask"), 1);
    yield* draftText(page, "kept entry");
    yield* compose(page, "kept question");
    yield* conversationChoices(page);
    yield* page.press("All conversations");
    yield* page.until("the chooser closing after All", (one) => !one.shows("All conversations"));
    const execution = yield* mountedExecution(page.repl);
    const before = yield* pairBytes(page.repl.root, execution);
    for (const size of [WIDE, { columns: 120, rows: 30 }]) {
      yield* atSize(page, size);
      for (const scope of [{ after: COMPOSER }, SIDEKICK_CONTROLS]) {
        const index = page.screen().index;
        const heading = page.screen().locate(scope === SIDEKICK_CONTROLS ? COMPOSER : "DRAFT");
        yield* page.wheel("down", { column: heading.column, row: heading.row - 3 });
        yield* page.until("the body's own scroll response", (one) => one.index > index);
        expect(page.screen().found("kept entry", DRAFT_VALUE)).toBe(1);
        expect(composerHolds(page.screen(), "kept question")).toBe(true);
        expect(entryTrail(page.screen())).toContain("Entry 1");
      }
    }
    yield* page.resize(NARROW);
    yield* page.press("Entries");
    yield* page.until("the narrow Entries catalog", (one) => one.shows("[close]"));
    yield* closeDrawer(page);
    expect(page.screen().shows("DRAFT")).toBe(true);
    expect(page.screen().found("kept entry", DRAFT_VALUE)).toBe(1);
    yield* page.resize(WIDE);
    expect(composerHolds(page.screen(), "kept question")).toBe(true);
    expect(yield* finishDraft(page)).toBe("kept entry");
    expect(yield* pairBytes(page.repl.root, execution)).toEqual(before);
    expect(page.repl.fake.prompts).toHaveLength(1);
  });
});
