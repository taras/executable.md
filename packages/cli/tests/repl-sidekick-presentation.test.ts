/** Read Sidekick work from the pane and controls the terminal actually shows. */

import { awaited, appendGate, useMountedHost } from "./support/mounted-repl.ts";
import { FsApi, ensureDir, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { sleep } from "effection";
import { decodeLocation } from "../src/repl/route.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  SIDEKICK_FILE,
  readSidekickRecords,
} from "../src/repl/sidekick/history.ts";
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
  DRAFT_VALUE,
  draftText,
  pasteDraft,
  composerHolds,
  DRAFT,
  draftHolds,
  intoComposer,
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
  const start = reading.locate("[↑ earlier]", SIDEKICK_CONTROLS).row;
  const end = reading.locate("[↓ later]", SIDEKICK_CONTROLS).row;
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
      yield* page.press("[↑ earlier]", SIDEKICK_CONTROLS);
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
    const page = yield* useReplPage({ host, location: `xmd://repl/${execution}/entries` });
    const pair = {
      entries: join(host.root, PAIRED_DIRECTORY, execution, ENTRIES_FILE),
      sidekick: join(host.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE),
    };
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
    expect(composerHolds(page.screen(), "explain!")).toBe(true);
    yield* draftText(page, "next");
    running.release();
    yield* awaited("the pair being published", () => gate.reaching(pair.sidekick) > 0);
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
    yield* page.until("the reply arriving", (one) => one.shows("Noted."));
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

  it("M4: a delayed acknowledgement clears what was sent and keeps what came after", function* () {
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
    yield* draftText(page, "X");
    saving.release();
    yield* page.until("the reply arriving", (one) => one.shows("Understood."));
    expect(personMessages((yield* settledReading(page.repl)).chat)).toEqual(["ask"]);
    expect(page.repl.fake.prompts[0]).toContain("ask");
    expect(page.repl.fake.prompts[0]).not.toContain("ask!");
    expect(composerHolds(page.screen(), "ask!")).toBe(true);
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

  it("M5: while generation is held, Stop is the control and Send cannot start a second cycle", function* () {
    const page = yield* useReplPage();
    page.repl.fake.script({ held: true, reply: "<Output>Done.</Output>\n" });
    yield* compose(page, "ask");
    yield* page.type("\r\r");
    yield* page.repl.fake.holdingTurns(1);
    expect(page.repl.fake.prompts).toHaveLength(1);
    expect(personMessages((yield* settledReading(page.repl)).chat)).toEqual(["ask"]);
    yield* page.until("the Sidekick working", (one) => one.shows("[S] working"));
    expect(page.screen().found("[stop]", SIDEKICK_CONTROLS)).toBe(1);
    expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(0);
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
