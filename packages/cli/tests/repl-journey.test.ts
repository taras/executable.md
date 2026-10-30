/** The mounted REPL journey, driven by terminal input and visible outcomes. */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ReplHost } from "../src/repl/host.ts";
import { sleep, scoped, spawn, suspend } from "effection";
import type { ReplOutcome } from "../src/repl/program.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { Result, Operation } from "effection";
import { Elicitation, useTempFileCompiler } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { readTextFile, readdir, writeTextFile, ensureDir } from "@effectionx/fs";
import { serializeDurableEvent, parseDurableEvent } from "@executablemd/durable-streams";
import { projectRepl } from "../src/repl/model.ts";
import { PAIRED_DIRECTORY, ENTRIES_FILE } from "../src/repl/sidekick/history.ts";
import { join } from "node:path";
import { encodeLocation, decodeLocation } from "../src/repl/route.ts";
import {
  referenceEvents,
  referenceSource,
  REFERENCE_DIRECTORY,
} from "./fixtures/repl/reference.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { ReplPage, ScreenReading } from "./support/repl-page.ts";
import {
  recordingTerminal,
  useMountedHost,
  mountedExecution,
  awaited,
} from "./support/mounted-repl.ts";
import type { MountedRepl } from "./support/mounted-repl.ts";

import { useReplPage } from "./support/repl-page.ts";
import {
  composerHolds,
  intoComposer,
  typed,
  tab,
  closeDrawer,
  DRAFT_VALUE,
  draftText,
  entrySettles,
  openHistory,
  pasteDraft,
} from "./support/screen-journeys.ts";

const WIDE = { columns: 160, rows: 36 };
const NARROW = { columns: 72, rows: 20 };

describe("REPL journey: a person drives the running command", () => {
  it("submits a Draft through the terminal and sees its settled History mark", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* pasteDraft(page, 'output("one done");');
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    expect(page.screen().shows("one done")).toBe(true);
    expect(page.screen().shows("1 ✓")).toBe(true);
  });

  it("keeps the Draft across a modal and a resize", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* draftText(page, "draft survives");
    yield* openHistory(page);
    expect(page.screen().shows("[close]")).toBe(true);
    yield* closeDrawer(page);
    const narrow = yield* page.resize(NARROW);
    expect(narrow.found("draft survives", { after: " DRAFT" })).toBe(1);
    const wide = yield* page.resize(WIDE);
    expect(wide.found("draft survives", DRAFT_VALUE)).toBe(1);
  });

  it("publishes no screen reading while a terminal write is held", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const terminal = page.repl.terminal;
    const before = page.screen().index;
    terminal.holdNextPresent();
    yield* page.type("held until released");
    yield* awaited("the held write", () => terminal.holdPresent !== undefined);
    expect(page.screen().index).toBe(before);
    expect(page.screen().shows("held until released")).toBe(false);
    terminal.holdPresent?.release();
    yield* page.until("the held write landing", (one) => one.shows("held until released"));
  });

  it("hands a failed presentation to the command owner unchanged", function* () {
    const failure = new Error("presentation failed");
    let mounted: MountedRepl | undefined;
    let caught: unknown;
    try {
      yield* scoped(function* (): Operation<void> {
        const page = yield* useReplPage({ size: WIDE });
        mounted = page.repl;
        yield* spawn(() => page.until("a screen that never arrives", () => false));
        yield* awaited(
          "a wait subscribed to the next frame",
          () => page.repl.terminal.waiting === 1,
        );
        page.repl.terminal.failNextPresent(failure);
        yield* page.key("Tab");
        yield* suspend();
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(mounted?.outcome()).toBeUndefined();
  });
});

function* catalog(page: ReplPage): Operation<void> {
  yield* page.press("Entries", { onRow: "Entries" });
  yield* page.until("the Entries catalog", (one) => one.shows("[close]"));
}

function* selectCatalog(page: ReplPage, label: string): Operation<void> {
  yield* catalog(page);
  yield* page.press(label);
  yield* page.until("the catalog closing", (one) => !one.shows("[close]"));
}

function trail(one: ScreenReading): string {
  return one.rows.find((row) => row.includes("› Entry")) ?? "";
}

function* leaveWithLocation(page: ReplPage): Operation<string> {
  page.repl.terminal.end();
  yield* awaited("the command leaving", () => page.repl.outcome() !== undefined);
  const result = page.repl.outcome();
  if (result === undefined) {
    throw new Error("the command returned no outcome");
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value.location;
}

function route(location: string) {
  const parsed = decodeLocation(location);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

const FIRST_COLD = '```js eval\nconst token = "alpha";\n```\n\nOne: {token}\n';
const SECOND_COLD =
  '```js eval\nconst carried = `${token}-again`;\n```\n\nTwo: {carried}\n\n<Checklist title="Resize scope" steps={2} />\n';

describe("REPL retained readings across every terminal size", () => {
  it("TL10: every size and a refusal keep the nested reading, and a cold open restores it", function* () {
    const dataRoot = yield* useTemporary("xmd-tl10-");
    let path = "";
    const standing = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY], size: WIDE });
      for (const [index, source] of [FIRST_COLD, SECOND_COLD].entries()) {
        yield* pasteDraft(page, source);
        yield* page.key("Enter");
        yield* entrySettles(page, index + 1, "ok");
      }
      yield* selectCatalog(page, "entry-2");
      expect(trail(page.screen())).toContain("Entry 2");
      yield* openHistory(page);
      yield* page.press("Component admitted");
      yield* page.until("the component checkpoint", (one) => one.shows("[live]"));
      yield* closeDrawer(page);
      yield* selectCatalog(page, "component Checklist");
      expect(trail(page.screen())).toContain("Checklist");
      yield* intoComposer(page);
      yield* typed(page, "and what changed");
      for (let press = 0; press < 6; press += 1) {
        yield* tab(page);
      }
      yield* page.type("keep this draft");
      yield* page.until(
        "the frozen reading taking a Draft edit",
        (one) => one.found("keep this draft", { after: "DRAFT" }) === 1,
      );
      yield* catalog(page);
      yield* closeDrawer(page);
      const kept = function* (): Operation<void> {
        expect(trail(page.screen())).toContain("Entry 2");
        expect(trail(page.screen())).toContain("Checklist");
        expect(page.screen().shows("[live]")).toBe(true);
        expect(page.screen().found("keep this draft", { after: "DRAFT" })).toBe(1);
        yield* catalog(page);
        const shown = page.screen();
        expect(shown.shows("1. [ok] entry-1")).toBe(true);
        expect(shown.shows("2. [unfinished] entry-2")).toBe(true);
        expect(shown.shows("component Checklist")).toBe(true);
        yield* closeDrawer(page);
      };
      for (const size of [{ columns: 120, rows: 30 }, NARROW]) {
        const resized = yield* page.resize(size);
        expect(resized.rows).toHaveLength(size.rows);
        expect(resized.rows.filter((row) => row.trimEnd().length > size.columns)).toEqual([]);
        yield* kept();
      }
      const refused = yield* page.resize({ columns: 60, rows: 15 });
      expect(refused.shows("needs at least 72x20")).toBe(true);
      expect(refused.shows("[live]")).toBe(false);
      expect(refused.shows("Checklist")).toBe(false);
      expect(refused.rows.filter((row) => /\[[^\]]*\]/.test(row))).toEqual([]);
      yield* page.resize(WIDE);
      yield* kept();
      expect(composerHolds(page.screen(), "and what changed")).toBe(true);
      for (const label of ["entry-1", "entry-2", "component Checklist"]) {
        yield* selectCatalog(page, label);
        expect(trail(page.screen())).toContain(label === "entry-1" ? "Entry 1" : "Entry 2");
      }
      const location = yield* leaveWithLocation(page);
      const where = route(location);
      expect(where.scopes).toEqual(["entry-2", "Checklist-1"]);
      expect(where.at).toBeDefined();
      expect(where.inspect).toBe(true);
      expect(where.draft).toBe("keep this draft");
      expect(where.surface).toBe("entries");
      path = join(page.repl.root, "v1", where.execution, "entries.jsonl");
      return location;
    });
    const before = yield* readTextFile(path);
    yield* scoped(function* () {
      const performed = { reads: 0, compiles: 0, asked: 0 };
      yield* API.Fs.around({
        *readTextFile([file], next) {
          if (file.endsWith(".md")) {
            performed.reads += 1;
          }
          return yield* next(file);
        },
      });
      yield* API.Env.around({
        *compile([source, options], next) {
          performed.compiles += 1;
          return yield* next(source, options);
        },
      });
      yield* Elicitation.around({
        *elicit([request], next) {
          performed.asked += 1;
          return yield* next(request);
        },
      });
      const page = yield* useReplPage({
        dataRoot,
        includes: [REFERENCE_DIRECTORY],
        size: WIDE,
        location: standing,
      });
      expect(trail(page.screen())).toContain("Entry 2");
      expect(trail(page.screen())).toContain("Checklist");
      expect(page.screen().shows("[live]")).toBe(true);
      expect(page.screen().found("keep this draft", DRAFT_VALUE)).toBe(1);
      yield* catalog(page);
      expect(page.screen().shows("1. [ok] entry-1")).toBe(true);
      expect(page.screen().shows("2. [unfinished] entry-2")).toBe(true);
      expect(page.screen().shows("component Checklist")).toBe(true);
      yield* closeDrawer(page);
      expect(yield* leaveWithLocation(page)).toBe(standing);
      expect(performed).toEqual({ reads: 0, compiles: 0, asked: 0 });
      expect(page.repl.fake.created).toEqual([]);
      expect(page.repl.fake.ensured).toEqual([]);
      expect(page.repl.fake.prompts).toEqual([]);
      expect(page.repl.terminal.resets).toBe(1);
    });
    expect(yield* readTextFile(path)).toBe(before);
  });
});

describe("REPL startup below the minimum terminal size", () => {
  it("J1: a terminal below the minimum refuses, and recovers when it grows", function* () {
    const terminal = yield* scoped(function* () {
      const page = yield* useReplPage({ size: { columns: 40, rows: 10 } });
      const refusal = page.screen();
      expect(refusal.shows("needs at least 72x20")).toBe(true);
      expect(refusal.shows("Make the window")).toBe(true);
      expect(refusal.shows("press Escape")).toBe(true);
      expect(refusal.shows("[")).toBe(false);
      expect(refusal.shows("Sessions")).toBe(false);
      const grown = yield* page.resize(WIDE);
      expect(grown.shows("TRANSCRIPT")).toBe(true);
      expect(grown.shows("[exit]")).toBe(true);
      yield* leaveWithLocation(page);
      return page.repl.terminal;
    });
    expect(terminal.resets).toBe(1);
    expect(terminal.readers).toBe(0);
  });
});

function* executionJournal(page: ReplPage): Operation<string> {
  const execution = yield* mountedExecution(page.repl);
  return join(page.repl.root, PAIRED_DIRECTORY, execution, ENTRIES_FILE);
}

function* journalRecords(page: ReplPage): Operation<string[]> {
  return (yield* readTextFile(yield* executionJournal(page)))
    .split("\n")
    .filter((line) => line.length > 0);
}

function* retainedModel(page: ReplPage) {
  const records = yield* journalRecords(page);
  const events = records.map((record) => {
    const parsed = parseDurableEvent(record);
    if (!parsed.ok) {
      throw parsed.error;
    }
    return parsed.value;
  });
  const projected = projectRepl(events);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

function referencePage(): Operation<ReplPage> {
  return useReplPage({ size: WIDE, includes: [REFERENCE_DIRECTORY] });
}

function* referenceAsking(page: ReplPage): Operation<string> {
  const source = yield* referenceSource();
  yield* pasteDraft(page, source);
  yield* page.key("Enter");
  yield* page.until("the entry asking", (one) => one.shows("[answer]"));
  return source;
}

function* answerReference(page: ReplPage): Operation<void> {
  yield* page.press("[answer]");
  yield* page.until("the entry form", (one) => one.shows("[submit]"));
  yield* page.press("( ) approve");
  yield* entrySettles(page, 1, "ok");
}

function* commandReturned(page: ReplPage) {
  yield* awaited("the command returning", () => page.repl.outcome() !== undefined);
  const outcome = page.repl.outcome();
  if (outcome === undefined) {
    throw new Error("the command returned without an outcome");
  }
  return outcome;
}

function released(terminal: MountedRepl["terminal"]): void {
  expect(terminal.resets).toBe(1);
  expect(terminal.readers).toBe(0);
  expect(terminal.listeners).toBe(0);
  expect(terminal.raw.at(-1)).toBe(false);
}

describe("REPL original admission and terminal exit claims", () => {
  it("J1: pasting the reference entry puts all of it in the draft and the location", function* () {
    const page = yield* referencePage();
    const source = yield* referenceSource();
    const before = page.repl.terminal.presented.length;
    yield* pasteDraft(page, source);
    expect(page.repl.terminal.presented.length - before).toBeLessThan(4);
    const tail = source.trimEnd().split("\n").at(-1) ?? "";
    expect(page.screen().found(tail, DRAFT_VALUE)).toBe(1);
    expect(source).toContain("\n\n");
    expect(yield* journalRecords(page)).toEqual([]);
    const location = route(yield* leaveWithLocation(page));
    expect(location.draft).toBe(source);
    expect(location.surface).toBe("entries");
    expect(location.at).toBeUndefined();
  });

  it("J1: submitting admits exactly that source, and the run settles", function* () {
    const terminal = yield* scoped(function* () {
      const page = yield* referencePage();
      const source = yield* referenceAsking(page);
      const records = yield* journalRecords(page);
      expect(records.length).toBeGreaterThan(0);
      for (const line of records) {
        expect(parseDurableEvent(line).ok).toBe(true);
      }
      const model = yield* retainedModel(page);
      expect(model.entries.map((entry) => entry.key)).toEqual(["entry-1"]);
      expect(model.entries[0]?.source).toBe(source);
      expect(model.entries[0]?.settled).toBe(false);
      expect(page.screen().shows("[answer]")).toBe(true);
      yield* leaveWithLocation(page);
      return page.repl.terminal;
    });
    released(terminal);
  });

  it("J1: the question is answered through the terminal, and the answer settles", function* () {
    const terminal = yield* scoped(function* () {
      const page = yield* referencePage();
      yield* referenceAsking(page);
      expect(page.screen().shows("( ) approve")).toBe(false);
      yield* answerReference(page);
      const lines = yield* journalRecords(page);
      expect(lines.some((line) => line.includes("elicit"))).toBe(true);
      for (let press = 0; press < 60 && !page.screen().shows("Decision: approve"); press += 1) {
        const before = page.screen().index;
        yield* page.press("[↓ later]", { rightOf: "Entries" });
        yield* page.until("the reading advancing", (one) => one.index > before);
      }
      expect(page.screen().shows("Decision: approve")).toBe(true);
      expect(page.screen().shows("TRANSCRIPT")).toBe(true);
      expect(page.screen().shows("(none retained)")).toBe(true);
      expect((yield* retainedModel(page)).entries[0]?.settled).toBe(true);
      expect(yield* leaveWithLocation(page)).toContain("xmd://repl/");
      return page.repl.terminal;
    });
    released(terminal);
  });

  it("J1: starting with no location creates one execution and focuses an empty draft", function* () {
    const terminal = yield* scoped(function* () {
      const page = yield* referencePage();
      const files = yield* readdir(join(page.repl.root, PAIRED_DIRECTORY));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
      expect(yield* journalRecords(page)).toEqual([]);
      for (const label of [
        "TRANSCRIPT",
        "(none retained)",
        "Entries",
        "No entry yet",
        "Type here",
      ]) {
        expect(page.screen().shows(label)).toBe(true);
      }
      yield* page.type("startup draft");
      yield* page.until(
        "the initial Draft taking the text",
        (one) => one.found("startup draft", DRAFT_VALUE) === 1,
      );
      expect(page.screen().found("startup draft", { after: "message the sidekick" })).toBe(0);
      const location = route(yield* leaveWithLocation(page));
      expect(location.execution).toBe(files[0]);
      expect(location.draft).toBe("startup draft");
      expect(location.scopes).toEqual([]);
      return page.repl.terminal;
    });
    released(terminal);
  });

  it("J1: Control-C ends the command and prints the location", function* () {
    const terminal = yield* scoped(function* () {
      const page = yield* referencePage();
      const execution = yield* mountedExecution(page.repl);
      yield* page.type("\x03");
      const result = yield* commandReturned(page);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.location).toBe(`xmd://repl/${execution}/entries`);
        expect(result.value.refusal).toBeUndefined();
      }
      return page.repl.terminal;
    });
    released(terminal);
  });

  it("J1: input queued behind Control-C starts nothing and appends nothing", function* () {
    const page = yield* referencePage();
    yield* page.type("\x03# queued behind an interrupt\r");
    const outcome = yield* commandReturned(page);
    expect(outcome.ok).toBe(true);
    expect(yield* journalRecords(page)).toEqual([]);
    expect(page.repl.fake.prompts).toEqual([]);
    if (outcome.ok) {
      expect(route(outcome.value.location).draft).toBeUndefined();
    }
    released(page.repl.terminal);
  });

  it("J1: no other chord ends it, so what leaves is the key and not the modifier", function* () {
    const page = yield* referencePage();
    yield* page.type("\x1ba\x08\x1b[15~");
    yield* page.type("z");
    yield* page.until("the following key arriving", (one) => one.found("z", DRAFT_VALUE) === 1);
    expect(page.repl.outcome()).toBeUndefined();
    expect(route(yield* leaveWithLocation(page)).draft).toBe("z");
  });

  it("J1: a control chord inserts nothing into the draft", function* () {
    const page = yield* referencePage();
    yield* page.type("\x1ba\x08\x1b[15~");
    expect(route(yield* leaveWithLocation(page)).draft).toBeUndefined();
  });

  it("J1: a document that cannot be admitted leaves the draft and an empty journal", function* () {
    const page = yield* referencePage();
    yield* pasteDraft(page, "<Nowhere />");
    yield* page.key("Enter");
    yield* page.until("the admission refusal", (one) => one.shows("Nowhere") && one.shows("!"));
    expect(yield* journalRecords(page)).toEqual([]);
    expect(page.screen().found("<Nowhere />", DRAFT_VALUE)).toBe(1);
    expect(route(yield* leaveWithLocation(page)).draft).toBe("<Nowhere />");
    released(page.repl.terminal);
  });

  it("J1: a second entry is refused, and history does not change", function* () {
    const page = yield* referencePage();
    yield* referenceAsking(page);
    const admitted = yield* journalRecords(page);
    expect(admitted.length).toBeGreaterThan(0);
    yield* pasteDraft(page, "<Json value={1} />");
    yield* page.key("Enter");
    yield* page.until("the unfinished entry refusal", (one) => one.shows("has not finished"));
    expect(yield* journalRecords(page)).toEqual(admitted);
    expect(page.screen().found("<Json value={1} />", DRAFT_VALUE)).toBe(1);
    expect(route(yield* leaveWithLocation(page)).draft).toBe("<Json value={1} />");
  });
});

function* performedWork() {
  const reads: string[] = [];
  const performed = { reads, compiles: 0, asked: 0 };
  yield* API.Fs.around({
    *readTextFile([path], next) {
      performed.reads.push(path);
      return yield* next(path);
    },
  });
  yield* API.Env.around({
    *compile([source, options], next) {
      performed.compiles += 1;
      return yield* next(source, options);
    },
  });
  yield* Elicitation.around({
    *elicit([request], next) {
      performed.asked += 1;
      return yield* next(request);
    },
  });
  return performed;
}

function* corruptPage() {
  const host = yield* useMountedHost();
  yield* ensureDir(host.root);
  const path = join(host.root, "broken.jsonl");
  yield* writeTextFile(path, "{not a record}\n");
  const performed = yield* performedWork();
  const page = yield* useReplPage({ host, location: "xmd://repl/broken/entries" });
  return { page, path, performed };
}

function* leaveRefusal(page: ReplPage) {
  yield* page.press("[exit]");
  return yield* commandReturned(page);
}

describe("REPL original refusals before replay and terminal ownership", () => {
  it("J1: Control-C leaves a refusal, and it is still a refusal", function* () {
    const { page } = yield* corruptPage();
    expect(page.screen().shows("cannot read")).toBe(true);
    yield* page.type("\x03");
    expect((yield* commandReturned(page)).ok).toBe(false);
    released(page.repl.terminal);
  });

  it("J1: a corrupt history refuses atomically, with no append and no session", function* () {
    const { page, path, performed } = yield* corruptPage();
    expect(page.screen().shows("cannot read")).toBe(true);
    expect((yield* leaveRefusal(page)).ok).toBe(false);
    expect(performed).toEqual({ reads: [], compiles: 0, asked: 0 });
    expect(yield* readTextFile(path)).toBe("{not a record}\n");
    released(page.repl.terminal);
  });

  it("J1: a malformed location reaches no path, no file and no terminal", function* () {
    const dataRoot = yield* useTemporary("xmd-malformed-location-");
    const { terminal, install } = recordingTerminal();
    yield* install();
    const host = yield* useMountedHost({ dataRoot });
    const outcome = yield* runReplProgram({ location: "xmd://repl//repl", profile: host.profile });
    expect(outcome.ok).toBe(false);
    expect(yield* readdir(dataRoot)).toEqual([]);
    expect(terminal.raw).toEqual([]);
    expect(terminal.resets).toBe(0);
    expect(terminal.readers).toBe(0);
  });

  it("J1: a piped invocation refuses before a history file exists", function* () {
    const dataRoot = yield* useTemporary("xmd-piped-invocation-");
    const { terminal, install } = recordingTerminal(WIDE, false);
    yield* install();
    const host = yield* useMountedHost({ dataRoot });
    let outcome: Result<ReplOutcome> | undefined;
    yield* spawn(function* () {
      outcome = yield* runReplProgram({ profile: host.profile });
    });
    yield* awaited("the piped invocation refusing", () => outcome !== undefined);
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) {
      expect(outcome.error.message).toContain("not available over a pipe");
    }
    expect(yield* readdir(dataRoot)).toEqual([]);
    expect(terminal.raw).toEqual([]);
    expect(terminal.presented).toEqual([]);
    expect(terminal.resets).toBe(0);
    terminal.end();
  });

  it("J1: a route naming a scope the history never had refuses before anything replays", function* () {
    const dataRoot = yield* useTemporary("xmd-invalid-scope-");
    let path = "";
    const location = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY] });
      yield* referenceAsking(page);
      path = yield* executionJournal(page);
      expect((yield* retainedModel(page)).settled).toBe(false);
      const base = route(yield* leaveWithLocation(page));
      return encodeLocation({ ...base, scopes: ["entry-1", "Nowhere-9"] });
    });
    const before = yield* readTextFile(path);
    const performed = yield* performedWork();
    const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY], location });
    expect(page.screen().shows("holds no Nowhere-9")).toBe(true);
    expect((yield* leaveRefusal(page)).ok).toBe(false);
    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
    expect(yield* readTextFile(path)).toBe(before);
  });

  it("J1: a stale live-question URL refuses against a finished execution", function* () {
    const dataRoot = yield* useTemporary("xmd-stale-question-");
    let path = "";
    const location = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY] });
      yield* referenceAsking(page);
      yield* answerReference(page);
      expect((yield* retainedModel(page)).settled).toBe(true);
      path = yield* executionJournal(page);
      const base = route(yield* leaveWithLocation(page));
      return encodeLocation({ ...base, scopes: ["entry-1"], drawers: [{ kind: "live-elicit" }] });
    });
    expect(location).toContain("+elicit");
    const before = yield* readTextFile(path);
    const performed = yield* performedWork();
    const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY], location });
    expect(page.screen().shows("nothing is being asked")).toBe(true);
    expect((yield* leaveRefusal(page)).ok).toBe(false);
    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
    expect(yield* readTextFile(path)).toBe(before);
  });

  it("J1: an answered history with its root still open refuses the same URL", function* () {
    yield* useTempFileCompiler();
    const events = yield* referenceEvents();
    expect(events.at(-1)?.type).toBe("close");
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    yield* ensureDir(host.root);
    const path = join(host.root, "unclosed.jsonl");
    const kept = events
      .slice(0, -1)
      .map((event) => serializeDurableEvent(event))
      .join("");
    yield* writeTextFile(path, kept);
    const projected = projectRepl(events.slice(0, -1));
    if (!projected.ok) {
      throw projected.error;
    }
    expect(projected.value.settled).toBe(false);
    expect(projected.value.entries[0]?.scope.elicitations[0]?.answer).toEqual({
      decision: "approve",
    });
    const performed = yield* performedWork();
    const page = yield* useReplPage({
      host,
      location: `xmd://repl/unclosed/entries/${projected.value.entries[0]?.key ?? ""}/+elicit`,
    });
    expect(page.screen().shows("nothing is being asked")).toBe(true);
    expect((yield* leaveRefusal(page)).ok).toBe(false);
    expect(yield* readTextFile(path)).toBe(kept);
    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
  });
});

function* noNewExecution(): Operation<void> {
  yield* ReplHost.around(
    {
      *identify(): Operation<string> {
        throw new Error("a cold open creates no execution identity");
      },
      *createExclusive(): Operation<void> {
        throw new Error("a cold open creates no history");
      },
    },
    { at: "max" },
  );
}

function* readTo(page: ReplPage, text: string): Operation<void> {
  if (page.screen().shows(text)) {
    return;
  }
  yield* catalog(page);
  yield* closeDrawer(page);
  yield* page.resize(NARROW);
  for (let press = 0; press < 100 && !page.screen().shows(text); press += 1) {
    const before = page.screen().index;
    yield* page.press("[↓ later]");
    yield* page.until("the retained reading moving", (one) => one.index > before);
  }
  expect(page.screen().shows(text)).toBe(true);
}

function* missingEntryRefusal() {
  const dataRoot = yield* useTemporary("xmd-missing-entry-");
  let path = "";
  const location = yield* scoped(function* () {
    const first = yield* useReplPage({ dataRoot });
    path = yield* executionJournal(first);
    return yield* leaveWithLocation(first);
  });
  const before = yield* readTextFile(path);
  const page = yield* useReplPage({ dataRoot, location: location + "/entry-9" });
  return { page, path, before };
}

describe("REPL original retained readings and navigation", () => {
  it("J1: a second process reconstructs the view from the URL and the journal alone", function* () {
    const dataRoot = yield* useTemporary("xmd-binding-cold-");
    let path = "";
    const location = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY] });
      yield* referenceAsking(page);
      yield* answerReference(page);
      path = yield* executionJournal(page);
      const model = yield* retainedModel(page);
      const entry = model.entries[0]?.scope;
      const binding = entry?.bindings[0];
      const nested = entry?.scopes[0];
      const marker = model.checkpoints.at(-1)?.marker;
      if (
        entry === undefined ||
        binding === undefined ||
        nested === undefined ||
        marker === undefined
      ) {
        throw new Error("the retained run needs an entry, nested scope, binding and checkpoint");
      }
      const base = route(yield* leaveWithLocation(page));
      released(page.repl.terminal);
      return {
        url: encodeLocation({
          ...base,
          scopes: [entry.key],
          drawers: [{ kind: "binding", name: binding.name }],
          at: marker,
          inspect: true,
        }),
        binding: binding.name,
        entry: entry.name,
        nested: nested.name,
      };
    });
    const before = yield* readTextFile(path);
    yield* scoped(function* () {
      yield* noNewExecution();
      const performed = yield* performedWork();
      const page = yield* useReplPage({
        dataRoot,
        includes: [REFERENCE_DIRECTORY],
        location: location.url,
      });
      expect(page.screen().shows("[close]")).toBe(true);
      expect(page.screen().shows(`Binding · ${location.binding}`)).toBe(true);
      expect(page.screen().shows('"title": "Ship the REPL"')).toBe(true);
      yield* page.key("Escape");
      yield* page.until("the binding drawer closing", (one) => !one.shows("[close]"));
      yield* catalog(page);
      expect(page.screen().shows(location.entry)).toBe(true);
      expect(page.screen().shows(location.nested)).toBe(true);
      yield* closeDrawer(page);
      expect(trail(page.screen())).toContain("Entry 1");
      yield* readTo(page, "Decision: approve");
      expect(yield* leaveWithLocation(page)).toBe(
        encodeLocation({ ...route(location.url), drawers: [] }),
      );
      expect(performed).toEqual({ reads: [], compiles: 0, asked: 0 });
      released(page.repl.terminal);
    });
    expect(yield* readTextFile(path)).toBe(before);
  });

  it("B3: an ancestor in the trail is a control, and it selects its own prefix", function* () {
    const page = yield* referencePage();
    yield* referenceAsking(page);
    yield* selectCatalog(page, "component Checklist");
    const before = trail(page.screen());
    expect(before).toContain("Entry 1");
    expect(before).toContain("Checklist");
    expect(before.indexOf("Entry 1")).toBeLessThan(before.indexOf("Checklist"));
    yield* page.press("Entry 1", { onRow: before });
    yield* page.until(
      "the ancestor selecting its prefix",
      (one) => !trail(one).includes("Checklist"),
    );
    expect(trail(page.screen())).toContain("Entry 1");
    yield* catalog(page);
    expect(page.screen().shows("1. [unfinished] entry-1")).toBe(true);
    yield* closeDrawer(page);
    expect(route(yield* leaveWithLocation(page)).scopes).toEqual(["entry-1"]);
  });

  it("J1: an invalid navigation leaves the standing route, tree, focus and targets", function* () {
    const page = yield* referencePage();
    yield* referenceAsking(page);
    yield* selectCatalog(page, "component Checklist");
    expect(trail(page.screen())).toContain("Checklist");
    const before = yield* journalRecords(page);
    yield* openHistory(page);
    const closeAt = page.screen().locate("[close]");
    yield* page.press("Entry 1 admitted");
    yield* page.until("the navigation refusal", (one) => one.shows("!"));
    expect(page.screen().shows("History")).toBe(true);
    expect(page.screen().shows("[live]")).toBe(false);
    expect(yield* journalRecords(page)).toEqual(before);
    expect(page.screen().locate("[close]")).toEqual(closeAt);
    yield* page.press("[close]");
    yield* page.until("the same target still closing the drawer", (one) => !one.shows("[close]"));
    expect(trail(page.screen())).toContain("Checklist");
    const standing = route(yield* leaveWithLocation(page));
    expect(standing.scopes).toEqual(["entry-1", "Checklist-1"]);
    expect(standing.at).toBeUndefined();
  });

  it("UI2: below the minimum there is no exit to aim at, and Escape leaves", function* () {
    const page = yield* useReplPage({ size: { columns: 60, rows: 18 } });
    expect(page.screen().shows("60x18")).toBe(true);
    expect(page.screen().shows("larger")).toBe(true);
    expect(page.screen().shows("Escape")).toBe(true);
    expect(page.screen().shows("[")).toBe(false);
    yield* page.key("Enter");
    yield* sleep(100);
    expect(page.repl.outcome()).toBeUndefined();
    expect(page.repl.terminal.resets).toBe(0);
    yield* page.key("Escape");
    const result = yield* commandReturned(page);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.location).toContain("xmd://repl/");
    }
    released(page.repl.terminal);
  });

  it("UI2: a normal-sized refusal is left by its own visible control", function* () {
    const { page, path, before } = yield* missingEntryRefusal();
    expect(page.screen().shows("admitted")).toBe(true);
    expect(page.screen().shows("[exit]")).toBe(true);
    expect(page.screen().shows("[history]")).toBe(false);
    expect(page.screen().shows("DRAFT")).toBe(false);
    expect((yield* leaveRefusal(page)).ok).toBe(false);
    expect(yield* readTextFile(path)).toBe(before);
    released(page.repl.terminal);
  });

  it("UI2: Enter on the refusal's control leaves it too", function* () {
    const { page, path, before } = yield* missingEntryRefusal();
    expect(page.screen().shows("admitted")).toBe(true);
    yield* page.key("Enter");
    expect((yield* commandReturned(page)).ok).toBe(false);
    expect(yield* readTextFile(path)).toBe(before);
    released(page.repl.terminal);
  });
});
