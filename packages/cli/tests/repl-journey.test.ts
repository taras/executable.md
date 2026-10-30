/** The mounted REPL journey, driven by terminal input and visible outcomes. */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ReplClock } from "../src/repl/frame.ts";
import { ReplHost } from "../src/repl/host.ts";
import { sleep, scoped, spawn, suspend, ensure, withResolvers } from "effection";
import type { ReplOutcome } from "../src/repl/program.ts";
import { runReplProgram } from "../src/repl/program.ts";
import type { Result, Operation } from "effection";
import { Elicitation, Execution, useTempFileCompiler } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { RootMetadata } from "@executablemd/core/api";
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
  selectPane,
  drawerLines,
  typed,
  tab,
  closeDrawer,
  DRAFT_VALUE,
  intoDraft,
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
      const location = yield* leaveWithLocation(page);
      expect(location).toContain("xmd://repl/");
      expect(route(location).drawers).toEqual([]);
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

function longEntry(lines: number): string {
  return `${Array.from({ length: lines }, (_, at) => (at % 4 === 3 ? "" : `<Json value={{ ordinal: ${at}, note: "line ${at} of a long entry" }} as="n${at}" />`)).join("\n")}\n`;
}

function* interactionCost(page: ReplPage, send: () => Operation<void>): Operation<number> {
  const before = page.repl.terminal.sized;
  const index = page.screen().index;
  yield* send();
  yield* page.until("the interaction's completed presentation", (one) => one.index > index);
  return page.repl.terminal.sized - before;
}

describe("REPL original interaction costs and visible exit routes", () => {
  for (const lines of [12, 222]) {
    it(`RS3: typing and traversing beside a ${lines}-line entry read the size a fixed number of times`, function* () {
      const page = yield* referencePage();
      yield* pasteDraft(page, longEntry(lines));
      yield* page.key("Enter");
      yield* entrySettles(page, 1, "ok");
      yield* selectCatalog(page, "entry-1");
      yield* intoDraft(page);
      yield* interactionCost(page, () => page.type("a"));
      const typed = [
        yield* interactionCost(page, () => page.type("b")),
        yield* interactionCost(page, () => page.type("c")),
      ];
      const erased = yield* interactionCost(page, () => page.key("Backspace"));
      const forward = yield* interactionCost(page, () => page.key("Tab"));
      const backward = yield* interactionCost(page, () => page.key("Backtab"));
      expect([lines, typed]).toEqual([lines, [4, 4]]);
      expect([lines, erased]).toEqual([lines, 4]);
      expect([lines, forward]).toEqual([lines, 4]);
      expect([lines, backward]).toEqual([lines, 4]);
      yield* leaveWithLocation(page);
    });
  }

  it("RS1: Tab moves the cue and the focus, and presents once", function* () {
    const page = yield* referencePage();
    yield* pasteDraft(page, FIRST_COLD);
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    yield* intoDraft(page);
    expect(page.screen().shows("Type here")).toBe(true);
    const before = page.repl.terminal.presented.length;
    const index = page.screen().index;
    yield* page.key("Tab");
    yield* page.until(
      "the guidance leaving Draft input",
      (one) => one.index > index && !one.shows("Type here"),
    );
    expect(page.repl.terminal.presented.length - before).toBe(1);
    const back = page.repl.terminal.presented.length;
    yield* page.key("Backtab");
    yield* page.until("the guidance returning to Draft input", (one) => one.shows("Type here"));
    expect(page.repl.terminal.presented.length - back).toBe(1);
    yield* page.type("returned draft");
    yield* page.until(
      "the returned field receiving input",
      (one) => one.found("returned draft", DRAFT_VALUE) === 1,
    );
    expect(route(yield* leaveWithLocation(page)).draft).toBe("returned draft");
  });

  it("UI2: Enter on [exit] ends the command without touching the history", function* () {
    const page = yield* referencePage();
    const path = yield* executionJournal(page);
    const before = yield* readTextFile(path);
    yield* page.key("Backtab");
    yield* page.key("Enter");
    const outcome = yield* commandReturned(page);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.refusal).toBeUndefined();
      expect(outcome.value.location).toContain("xmd://repl/");
    }
    expect(yield* readTextFile(path)).toBe(before);
    released(page.repl.terminal);
  });

  it("UI2: a pointer on [exit] is the same act as Enter on it", function* () {
    const page = yield* referencePage();
    yield* page.press("[exit]");
    const outcome = yield* commandReturned(page);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.refusal).toBeUndefined();
      expect(outcome.value.location).toContain("xmd://repl/");
    }
    released(page.repl.terminal);
  });
});

function preparationGate(startup = false) {
  const entered = withResolvers<void>();
  const gate = withResolvers<void>();
  let used = false;
  let holding = false;
  function* wait(): Operation<void> {
    used = true;
    holding = true;
    entered.resolve();
    try {
      yield* gate.operation;
    } finally {
      holding = false;
    }
  }
  return {
    reached: entered.operation,
    release: () => gate.resolve(),
    get holding() {
      return holding;
    },
    *install(): Operation<void> {
      yield* ensure(() => gate.resolve());
      if (startup) {
        yield* Execution.around({
          *document([request], next) {
            if (!used) {
              yield* wait();
            }
            return yield* next(request);
          },
        });
      } else {
        yield* API.Fs.around({
          *readTextFile([path], next) {
            if (!used && path.endsWith("Checklist.md")) {
              yield* wait();
            }
            return yield* next(path);
          },
        });
      }
    },
  };
}

function* authoredWork(): Operation<{ invoked: number }> {
  const counter = { invoked: 0 };
  let wrapped = false;
  yield* API.Env.around({
    *compile([source, options], next) {
      const block = yield* next(source, options);
      if (wrapped) {
        return block;
      }
      wrapped = true;
      return (env: Record<string, unknown>) => {
        counter.invoked += 1;
        return block(env);
      };
    },
  });
  return counter;
}

function* pausedAt(page: ReplPage, phase: string): Operation<void> {
  yield* page.until(`the submission ${phase}`, (one) => one.shows("[pause]") && one.shows(phase));
}

function* requestPause(page: ReplPage): Operation<void> {
  yield* page.press("[pause]");
  yield* pausedAt(page, "pausing");
  expect(page.screen().shows("[continue]")).toBe(false);
}

function* resumeOnce(
  page: ReplPage,
  authored: { invoked: number },
  performed: { asked: number },
): Operation<void> {
  yield* pausedAt(page, "paused");
  expect(page.screen().shows("[continue]")).toBe(true);
  expect(authored.invoked).toBe(0);
  expect(performed.asked).toBe(0);
  yield* page.press("[continue]");
  yield* page.until("the first authored question", (one) => one.shows("[answer]"));
  expect(authored.invoked).toBe(1);
  expect(performed.asked).toBe(1);
  expect((yield* retainedModel(page)).entries.map((entry) => entry.key)).toEqual(["entry-1"]);
}

describe("REPL original pause-before-admission boundaries", () => {
  for (const size of [WIDE, { columns: 120, rows: 30 }, NARROW]) {
    it(`PPA2/PPA5: Pause is offered, requested and applied to the exact entry at ${size.columns}x${size.rows}`, function* () {
      const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
      const performed = yield* performedWork();
      const authored = yield* authoredWork();
      const gate = preparationGate();
      yield* gate.install();
      const page = yield* useReplPage({ host, includes: [REFERENCE_DIRECTORY], size });
      const source = yield* referenceSource();
      yield* pasteDraft(page, source);
      yield* page.key("Enter");
      yield* gate.reached;
      yield* pausedAt(page, "preparing");
      expect(page.screen().rows).toHaveLength(size.rows);
      expect(page.screen().shows("[continue]")).toBe(false);
      expect(yield* journalRecords(page)).toEqual([]);
      yield* page.key("Backtab");
      yield* page.key("Enter");
      yield* pausedAt(page, "pausing");
      expect(gate.holding).toBe(true);
      expect(yield* journalRecords(page)).toEqual([]);
      gate.release();
      yield* resumeOnce(page, authored, performed);
      expect((yield* retainedModel(page)).entries[0]?.source).toBe(source);
      yield* leaveWithLocation(page);
      released(page.repl.terminal);
    });
  }

  it("PPA1: one burst submits and requests the pause, with no frame in between", function* () {
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    const gate = preparationGate();
    yield* gate.install();
    const page = yield* useReplPage({ host, size: WIDE });
    yield* pasteDraft(page, yield* referenceSource());
    yield* page.type("\r\x1b[Z\r");
    yield* gate.reached;
    yield* pausedAt(page, "pausing");
    expect(page.repl.outcome()).toBeUndefined();
    expect(page.screen().shows("[continue]")).toBe(false);
    gate.release();
    yield* pausedAt(page, "paused");
    expect(page.screen().shows("[continue]")).toBe(true);
    expect((yield* retainedModel(page)).entries.map((entry) => entry.key)).toEqual(["entry-1"]);
    yield* leaveWithLocation(page);
  });

  it("PPA3(a): a refused preflight discards its pause request, and the next entry plays", function* () {
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    const performed = yield* performedWork();
    const gate = preparationGate();
    yield* gate.install();
    const page = yield* useReplPage({ host, includes: [REFERENCE_DIRECTORY], size: WIDE });
    const source = '<Checklist title="held" steps={1} />\n\n<Nowhere />';
    yield* pasteDraft(page, source);
    yield* page.key("Enter");
    yield* gate.reached;
    yield* pausedAt(page, "preparing");
    yield* requestPause(page);
    gate.release();
    yield* page.until(
      "the preflight refusal clearing preparation",
      (one) => one.shows("Nowhere") && !one.shows("[pause]"),
    );
    expect(yield* journalRecords(page)).toEqual([]);
    expect(page.screen().shows("[continue]")).toBe(false);
    yield* intoDraft(page);
    for (const _ of source) {
      yield* page.key("Backspace");
    }
    const valid = yield* referenceSource();
    yield* pasteDraft(page, valid);
    yield* page.key("Enter");
    yield* page.until("the successor playing", (one) => one.shows("[answer]"));
    expect(performed.asked).toBe(1);
    expect(page.screen().shows("[continue]")).toBe(false);
    expect((yield* retainedModel(page)).entries.map((entry) => entry.source)).toEqual([valid]);
    yield* leaveWithLocation(page);
  });

  it("PPA3(b): an entry armed with no hold is disarmed by its own failure", function* () {
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    const performed = yield* performedWork();
    const authored = yield* authoredWork();
    const gate = preparationGate();
    yield* gate.install();
    let atSeam: number | undefined;
    let refused = false;
    yield* Execution.around({
      *document([request], next) {
        yield* RootMetadata.around({
          metadata(args, delegate) {
            if (refused) {
              return delegate(...args);
            }
            refused = true;
            atSeam = authored.invoked;
            throw new Error("runtime metadata refusal after root import");
          },
        });
        return yield* next(request);
      },
    });
    const page = yield* useReplPage({ host, includes: [REFERENCE_DIRECTORY], size: WIDE });
    const source = yield* referenceSource();
    yield* pasteDraft(page, source);
    yield* page.key("Enter");
    yield* gate.reached;
    yield* pausedAt(page, "preparing");
    yield* requestPause(page);
    gate.release();
    yield* entrySettles(page, 1, "err");
    yield* page.until("no failed mode remaining", (one) => !one.shows("[pause]"));
    expect(atSeam).toBe(0);
    expect(performed.asked).toBe(0);
    expect(page.screen().shows("[continue]")).toBe(false);
    yield* pasteDraft(page, source);
    yield* page.key("Enter");
    yield* page.until("the next entry playing", (one) => one.shows("[answer]"));
    expect(performed.asked).toBe(1);
    expect(authored.invoked).toBe(1);
    expect((yield* retainedModel(page)).entries.map((entry) => entry.key)).toEqual([
      "entry-1",
      "entry-2",
    ]);
    yield* leaveWithLocation(page);
  });

  it("PPA3(c): Pause during startup waits for the entry it names", function* () {
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    const performed = yield* performedWork();
    const authored = yield* authoredWork();
    const gate = preparationGate(true);
    yield* gate.install();
    const page = yield* useReplPage({ host, includes: [REFERENCE_DIRECTORY], size: WIDE });
    yield* pasteDraft(page, yield* referenceSource());
    yield* page.key("Enter");
    yield* gate.reached;
    expect(yield* journalRecords(page)).toEqual([]);
    yield* pausedAt(page, "preparing");
    yield* requestPause(page);
    expect(yield* journalRecords(page)).toEqual([]);
    expect(authored.invoked).toBe(0);
    gate.release();
    yield* resumeOnce(page, authored, performed);
    yield* leaveWithLocation(page);
  });

  it("PPA3(d): walking away from the head while a preflight is held admits nothing", function* () {
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    const gate = preparationGate();
    yield* gate.install();
    const page = yield* useReplPage({ host, size: WIDE });
    const first = "<Output>one</Output>";
    const second = '<Checklist title="second" steps={1} />';
    yield* pasteDraft(page, first);
    yield* page.key("Enter");
    yield* entrySettles(page, 1, "ok");
    yield* pasteDraft(page, second);
    yield* page.key("Enter");
    yield* gate.reached;
    yield* openHistory(page);
    yield* page.press("Entry 1 admitted");
    yield* page.until("the earlier position", (one) => one.shows("[live]"));
    gate.release();
    yield* page.until("the changed-head refusal", (one) =>
      one.shows("moved away from the live head"),
    );
    expect((yield* retainedModel(page)).entries.map((entry) => entry.source)).toEqual([first]);
    yield* closeDrawer(page);
    yield* page.press("[live]");
    yield* page.until("the live draft", (one) => !one.shows("[live]"));
    expect(route(yield* leaveWithLocation(page)).draft).toBe(second);
  });

  it("PPA4: the keyboard still works while a preflight is held, and closing discards the request", function* () {
    const dataRoot = yield* useTemporary("xmd-preflight-cold-");
    const source = '<Checklist title="held" steps={1} />';
    const location = yield* scoped(function* () {
      const host = yield* useMountedHost({ dataRoot, includes: [REFERENCE_DIRECTORY] });
      const performed = yield* performedWork();
      const gate = preparationGate();
      yield* gate.install();
      const page = yield* useReplPage({ host, includes: [REFERENCE_DIRECTORY], size: WIDE });
      yield* pasteDraft(page, source);
      yield* page.key("Enter");
      yield* gate.reached;
      yield* pausedAt(page, "preparing");
      yield* requestPause(page);
      yield* draftText(page, " and more");
      expect(gate.holding).toBe(true);
      const location = yield* leaveWithLocation(page);
      expect(gate.holding).toBe(false);
      expect(yield* journalRecords(page)).toEqual([]);
      expect(performed.asked).toBe(0);
      expect(route(location).draft).toBe(source + " and more");
      released(page.repl.terminal);
      return location;
    });
    const host = yield* useMountedHost({ dataRoot, includes: [REFERENCE_DIRECTORY] });
    yield* noNewExecution();
    const performed = yield* performedWork();
    const cold = yield* useReplPage({
      host,
      location,
      includes: [REFERENCE_DIRECTORY],
      size: WIDE,
    });
    for (const label of ["[pause]", "[continue]", "preparing", "pausing"]) {
      expect(cold.screen().shows(label)).toBe(false);
    }
    expect(cold.screen().shows(source + " and more")).toBe(true);
    expect(performed.asked).toBe(0);
    expect(performed.compiles).toBe(0);
    expect(yield* journalRecords(cold)).toEqual([]);
    expect(yield* leaveWithLocation(cold)).toBe(location);
  });
});

const JOURNEY_ONE = [
  "```js eval",
  'const token = "alpha";',
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Ready?</Elicit>',
  "",
  "One: {token}/{answer.decision}",
  "",
].join("\n");

const JOURNEY_TWO = [
  "```js eval",
  "const seen = `${token}-two`;",
  "```",
  "",
  "Two: {seen}",
  "",
  "```js eval",
  "const lost = nothingDeclaredAnywhere;",
  "```",
  "",
].join("\n");

const JOURNEY_THREE = [
  "```js eval",
  "const after = `${token}-three`;",
  "```",
  "",
  "Three: {after}",
  "",
].join("\n");

const STOPPED_ENTRY = [
  "```js eval",
  'const token = "held";',
  'output("printed before the question");',
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Go?</Elicit>',
  "",
  "One: {answer.decision}",
  "",
].join("\n");

const SIBLING_FAILS = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  "<All>",
  "<Spawn>",
  '<Elicit schema={schema} as="answer">Ready?</Elicit>',
  "</Spawn>",
  "<Spawn>",
  "```js eval",
  'yield* fetch("https://held.invalid/sibling");',
  "```",
  "</Spawn>",
  "</All>",
  "",
].join("\n");

const SHORT_QUESTION = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">Go?</Elicit>',
  "",
  "Decision: {answer.decision}",
  "",
].join("\n");

const LONG_QUESTION = [
  "```js eval",
  "const schema = {",
  '  type: "object",',
  '  properties: { decision: { type: "string", enum: ["go"] } },',
  '  required: ["decision"],',
  "  additionalProperties: false,",
  "};",
  "```",
  "",
  '<Elicit schema={schema} as="answer">' +
    "Would you like to approve the plan that was drafted for this execution, " +
    "including every file it proposes to write and every command it proposes to run?" +
    "</Elicit>",
  "",
  "Decision: {answer.decision}",
  "",
].join("\n");

function* runSource(page: ReplPage, source: string): Operation<void> {
  yield* pasteDraft(page, source);
  yield* page.key("Enter");
}

function* answerGo(page: ReplPage): Operation<void> {
  yield* page.press("[answer]");
  yield* page.until("the go question", (one) => one.shows("[submit]"));
  yield* page.press("( ) go");
  yield* page.press("[submit]");
  yield* entrySettles(page, 1, "ok");
}

describe("REPL original live output and entry lifecycle", () => {
  it("J1: text the Journal has not settled is drawn while the run is held", function* () {
    const host = yield* useMountedHost();
    const release = withResolvers<void>();
    yield* ensure(() => release.resolve());
    let held = false;
    yield* Elicitation.around({
      *elicit([request], next) {
        held = true;
        yield* release.operation;
        return yield* next(request);
      },
    });
    const page = yield* useReplPage({ host });
    const printed = "the-last-thing-this-document-prints";
    const source = `\`\`\`js eval\nconst schema = {type:"object", properties:{decision:{type:"string",enum:["yes"]}}, required:["decision"],additionalProperties:false};\n\`\`\`\n\n${printed}\n\n<Elicit schema={schema} as="answer">Decide?</Elicit>\n`;
    yield* runSource(page, source);
    yield* awaited("the unpublished question held", () => held);
    yield* page.until("the unrecorded output", (one) => one.shows(printed));
    expect(page.screen().shows("[answer]")).toBe(false);
    expect(page.screen().shows(printed)).toBe(true);
    release.resolve();
    yield* page.until("the question registering", (one) => one.shows("[answer]"));
    expect((yield* journalRecords(page)).length).toBeGreaterThan(0);
  });

  it("ER1: the invalid entry clears, and the draft, surface and position stand", function* () {
    const page = yield* referencePage();
    for (const [i, source] of ["One.\n", "Two.\n"].entries()) {
      yield* runSource(page, source);
      yield* entrySettles(page, i + 1, "ok");
    }
    yield* draftText(page, "Three.");
    yield* selectCatalog(page, "entry-2");
    yield* openHistory(page);
    yield* page.press("Entry 1 admitted");
    yield* page.until("the prefix before entry two", (one) => one.shows("[live]"));
    yield* closeDrawer(page);
    yield* catalog(page);
    expect(page.screen().shows("entry-1")).toBe(true);
    expect(page.screen().shows("entry-2")).toBe(false);
    expect(page.screen().shows("[unfinished] entry-1")).toBe(true);
    yield* closeDrawer(page);
    const standing = route(yield* leaveWithLocation(page));
    expect(standing.scopes).toEqual([]);
    expect(standing.at).toBeDefined();
    expect(standing.inspect).toBe(true);
    expect(standing.surface).toBe("entries");
    expect(standing.draft).toBe("Three.");
  });

  it("EJ1: a draft survives a refusal, inherits, fails, and is followed", function* () {
    const page = yield* referencePage();
    yield* runSource(page, JOURNEY_ONE);
    yield* page.until("entry one's question", (one) => one.shows("[answer]"));
    yield* pasteDraft(page, JOURNEY_TWO);
    const held = yield* journalRecords(page);
    yield* page.key("Enter");
    yield* page.until("the retained successor refused", (one) => one.shows("has not finished"));
    expect(yield* journalRecords(page)).toEqual(held);
    yield* answerGo(page);
    expect(page.screen().shows("One: alpha/go")).toBe(true);
    yield* intoDraft(page);
    yield* page.key("Enter");
    yield* entrySettles(page, 2, "err");
    const failed = yield* retainedModel(page);
    expect(failed.entries[1]?.source).toBe(JOURNEY_TWO);
    expect(failed.entries[1]?.bindings.find((one) => one.name === "seen")?.value).toBe("alpha-two");
    expect(failed.entries[0]?.bindings.find((one) => one.name === "token")?.value).toBe("alpha");
    yield* runSource(page, JOURNEY_THREE);
    yield* entrySettles(page, 3, "ok");
    yield* selectCatalog(page, "entry-3");
    expect(page.screen().shows("Three: alpha-three")).toBe(true);
    const settled = yield* retainedModel(page);
    expect(settled.entries.map((one) => one.key)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(settled.entries.map((one) => one.terminal?.status)).toEqual(["ok", "err", "ok"]);
    yield* catalog(page);
    for (const [index, status] of ["ok", "err", "ok"].entries()) {
      expect(page.screen().shows(`${index + 1}. [${status}] entry-${index + 1}`)).toBe(true);
    }
    yield* page.press("entry-1");
    yield* page.until("the first entry restored", (one) => trail(one).includes("Entry 1"));
    expect(page.screen().shows("One: alpha/go")).toBe(true);
    expect(page.screen().shows("Three: alpha-three")).toBe(false);
    yield* leaveWithLocation(page);
    released(page.repl.terminal);
  });

  it("EL2: Draft Stop admits no successor until the stopped entry's cleanup joins", function* () {
    const host = yield* useMountedHost();
    const release = withResolvers<void>();
    let entering = false;
    yield* Execution.around({
      *document([request], next) {
        yield* ensure(function* () {
          entering = true;
          yield* release.operation;
        });
        return yield* next(request);
      },
    });
    const page = yield* useReplPage({ host });
    yield* ensure(() => release.resolve());
    yield* runSource(page, STOPPED_ENTRY);
    yield* page.until("the stopped entry's question", (one) => one.shows("[answer]"));
    yield* page.press("[stop]", { onRow: "DRAFT" });
    yield* awaited("the entry's own held teardown", () => entering);
    yield* runSource(page, FIRST_COLD);
    yield* tab(page);
    expect((yield* retainedModel(page)).entries.map((one) => one.key)).toEqual(["entry-1"]);
    release.resolve();
    yield* page.until("joined and ready", (one) => one.shows("Ready for Entry 2"));
    yield* intoDraft(page);
    yield* page.key("Enter");
    yield* entrySettles(page, 2, "ok");
    const model = yield* retainedModel(page);
    expect(model.entries.map((one) => one.terminal?.status)).toEqual(["cancelled", "ok"]);
    expect(
      model.entries[0]?.transcript.some(
        (one) => one.kind === "output" && one.text.includes("printed before the question"),
      ),
    ).toBe(true);
    expect(model.entries[1]?.source).toBe(FIRST_COLD);
    yield* leaveWithLocation(page);
    released(page.repl.terminal);
  });

  it("UI3: a question that disappears takes its drawer, and answers nothing", function* () {
    const host = yield* useMountedHost();
    const release = withResolvers<void>();
    yield* ensure(() => release.resolve());
    yield* API.Fetch.around({
      *fetch(): Operation<never> {
        yield* release.operation;
        throw new Error("the sibling could not finish");
      },
    });
    const page = yield* useReplPage({ host });
    yield* runSource(page, SIBLING_FAILS);
    yield* page.until("the sibling's question", (one) => one.shows("[answer]"));
    yield* page.press("[answer]");
    yield* page.until("the live drawer", (one) => one.shows("[submit]"));
    release.resolve();
    yield* page.until("the question withdrawing", (one) => !one.shows("[close]"));
    yield* entrySettles(page, 1, "err");
    expect((yield* journalRecords(page)).filter((one) => one.includes("elicit"))).toEqual([]);
    yield* runSource(page, FIRST_COLD);
    yield* entrySettles(page, 2, "ok");
  });
});

function* sessions(page: ReplPage): Operation<void> {
  if (page.screen().size.columns === 72) {
    yield* page.press("Sessions");
    yield* page.until("the Transcript outlet", (one) => one.shows("All sessions"));
  } else {
    expect(page.screen().shows("TRANSCRIPT")).toBe(true);
  }
}

function directions(one: ScreenReading): string {
  return one.rows.find((row) => row.includes("Tab/Shift+Tab move"))?.trim() ?? "";
}

describe("REPL original first-use paths and question ownership", () => {
  for (const size of [WIDE, NARROW]) {
    it(
      size.columns === 72
        ? "C1: submit, answer, dismiss, reopen, settle, Sessions, History, live and exit at 72x20"
        : "UI8: the whole first-use path, using only what the screen says",
      function* () {
        const page = yield* useReplPage({ size });
        expect(directions(page.screen())).toBe(
          "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move",
        );
        yield* runSource(page, SHORT_QUESTION);
        yield* page.until("the waiting announcement", (one) => one.shows("[answer]"));
        if (size.columns === 72) {
          expect(directions(page.screen())).toBe(
            "Entry 1 question · activate answer · Type here · Tab/Shift+Tab move",
          );
        }
        yield* sessions(page);
        expect(page.screen().shows("[submit]")).toBe(false);
        yield* page.press("[answer]");
        yield* page.until("the question drawer", (one) => one.shows("[submit]"));
        yield* page.key("Escape");
        yield* page.until("the question dismissed", (one) => !one.shows("[close]"));
        expect(page.screen().shows("[answer]")).toBe(true);
        yield* page.key("Enter");
        yield* page.until("Enter reopening the unanswered question", (one) =>
          one.shows("[submit]"),
        );
        yield* page.press("( ) go");
        yield* page.press("[submit]");
        yield* entrySettles(page, 1, "ok");
        expect(page.screen().shows("[close]")).toBe(false);
        yield* catalog(page);
        expect(page.screen().shows("1. [ok] entry-1")).toBe(true);
        yield* closeDrawer(page);
        yield* sessions(page);
        yield* catalog(page);
        yield* closeDrawer(page);
        yield* draftText(page, "entry two");
        yield* openHistory(page);
        yield* page.press("Entry 1 admitted");
        yield* page.until("the frozen drawer", (one) => one.shows("[live]"));
        expect(directions(page.screen())).toContain("Esc closes");
        yield* closeDrawer(page);
        for (
          let press = 0;
          press < 40 && !directions(page.screen()).startsWith("History · Enter unavailable");
          press += 1
        ) {
          yield* tab(page);
        }
        yield* page.until("the frozen Draft guidance", (one) =>
          directions(one).startsWith("History · Enter unavailable"),
        );
        expect(directions(page.screen())).toContain("activate live");
        expect(page.screen().shows("entry two")).toBe(true);
        expect(page.screen().shows("Enter submits")).toBe(false);
        yield* page.press("[live]");
        yield* page.until("the live head", (one) => !one.shows("[live]"));
        yield* intoDraft(page);
        yield* page.key("Enter");
        yield* entrySettles(page, 2, "ok");
        expect((yield* retainedModel(page)).entries[1]?.source).toBe("entry two");
        expect(yield* leaveWithLocation(page)).toContain("xmd://repl/");
        released(page.repl.terminal);
      },
    );
  }

  it("UI1: the longest question still has a placed, targetable control at 72x20", function* () {
    const page = yield* useReplPage({ size: NARROW });
    yield* runSource(page, LONG_QUESTION);
    yield* page.until("the long question announcing", (one) => one.shows("[answer]"));
    yield* sessions(page);
    const answer = page.screen().locate("[answer]");
    const row = page.screen().rows[answer.row] ?? "";
    for (const label of ["[history]", "[exit]", "[pause]", "[answer]"]) {
      expect(row).toContain(label);
    }
    expect(answer.column + "[answer]".length).toBeLessThanOrEqual(NARROW.columns);
    yield* page.press("[answer]");
    yield* page.until(
      "the long question's form",
      (one) => one.shows("[close]") && one.shows("decision: go"),
    );
    yield* closeDrawer(page);
    expect(trail(page.screen())).toContain("Entry 1");
    yield* catalog(page);
    expect(page.screen().shows("1. [unfinished] entry-1")).toBe(true);
    yield* closeDrawer(page);
    yield* page.press("[answer]");
    yield* page.until(
      "the long question still pending",
      (one) => one.shows("[close]") && one.shows("decision: go"),
    );
  });

  it("UI4: a live question's drawer is refused wherever it cannot belong", function* () {
    const page = yield* referencePage();
    yield* runSource(page, SHORT_QUESTION);
    yield* page.until("the live question", (one) => one.shows("[answer]"));
    const before = yield* journalRecords(page);
    yield* openHistory(page);
    yield* page.press("Entry 1 admitted");
    yield* page.until(
      "the frozen question absent",
      (one) => one.shows("[live]") && !one.shows("[answer]"),
    );
    yield* closeDrawer(page);
    expect(page.screen().shows("[submit]")).toBe(false);
    yield* page.press("[live]");
    yield* page.until(
      "the live question returning",
      (one) => one.shows("[answer]") && !one.shows("[live]"),
    );
    expect(yield* journalRecords(page)).toEqual(before);
    expect(page.screen().shows("[submit]")).toBe(false);
  });

  it("UI6: the draft stays visible and intact under a drawer, and is not editable through it", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* () {
        const page = yield* useReplPage({ size });
        yield* runSource(page, SHORT_QUESTION);
        yield* page.until("the question waiting", (one) => one.shows("[answer]"));
        yield* draftText(page, "next entry");
        yield* page.press("[answer]");
        yield* page.until("the question field", (one) => one.shows("[submit]"));
        expect(page.screen().found("next entry", DRAFT_VALUE)).toBe(1);
        yield* page.type("go");
        yield* page.until("the modal field taking the keystrokes", (one) =>
          one.shows("decision: go"),
        );
        expect(page.screen().found("next entry", DRAFT_VALUE)).toBe(1);
        yield* closeDrawer(page);
        expect(route(yield* leaveWithLocation(page)).draft).toBe("next entry");
      });
    }
  });

  it("UI7: leaving strips the drawers only this process could mount", function* () {
    const dataRoot = yield* useTemporary("xmd-live-drawer-exit-");
    const kept = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot });
      yield* runSource(page, SHORT_QUESTION);
      yield* page.until("the pending question", (one) => one.shows("[answer]"));
      yield* page.press("[answer]");
      yield* page.until("the live drawer", (one) => one.shows("[submit]"));
      const path = yield* executionJournal(page);
      const bytes = yield* readTextFile(path);
      yield* page.press("[exit]");
      const outcome = yield* commandReturned(page);
      if (!outcome.ok) {
        throw outcome.error;
      }
      const location = outcome.value.location;
      expect(location).not.toContain("+elicit");
      expect(location).not.toContain("+permission");
      expect(location).toContain("/entry-1");
      expect(yield* readTextFile(path)).toBe(bytes);
      expect((yield* retainedModel(page)).entries[0]?.terminal).toBeUndefined();
      expect((yield* journalRecords(page)).filter((one) => one.includes("elicit"))).toEqual([]);
      return { location, path, bytes };
    });
    const cold = yield* useReplPage({ dataRoot, location: kept.location });
    expect(trail(cold.screen())).toContain("Entry 1");
    yield* leaveWithLocation(cold);
  });
});

describe("REPL original completed-screen lifecycle", () => {
  it("reads typing, diffs and every profile off completed presentations", function* () {
    const page = yield* referencePage();
    const terminal = page.repl.terminal;
    const top = page.screen().rows[0];
    const session = top.trim().split(/\s+/).at(-1) ?? "";
    expect(session.length).toBeGreaterThan(0);
    const before = terminal.drawn;
    yield* draftText(page, "abc");
    expect(terminal.drawn).toBeGreaterThan(before);
    expect(
      terminal.presented.some((bytes) => new TextDecoder().decode(bytes).includes(session)),
    ).toBe(true);
    expect(new TextDecoder().decode(terminal.presented.at(-1) ?? new Uint8Array())).not.toContain(
      session,
    );
    expect(page.screen().rows[0]).toBe(top);
    for (const size of [{ columns: 120, rows: 30 }, NARROW, WIDE]) {
      const one = yield* page.resize(size);
      expect(one.rows).toHaveLength(size.rows);
      expect(one.rows.filter((row) => row.length > size.columns)).toEqual([]);
      expect(one.found("abc", DRAFT_VALUE)).toBe(1);
    }
    expect(page.repl.outcome()).toBeUndefined();
  });

  it("puts a held write on the screen only once it completes, and a cancelled one never", function* () {
    const page = yield* scoped(function* () {
      const page = yield* referencePage();
      const terminal = page.repl.terminal;
      yield* draftText(page, "abc");
      const before = page.screen().index;
      terminal.holdNextPresent();
      yield* page.type("x");
      yield* awaited("the first held write", () => terminal.holdPresent !== undefined);
      expect(page.screen().index).toBe(before);
      expect(page.screen().found("abcx", DRAFT_VALUE)).toBe(0);
      terminal.holdPresent?.release();
      yield* page.until("the released reading", (one) => one.found("abcx", DRAFT_VALUE) === 1);
      terminal.holdPresent = undefined;
      terminal.holdNextPresent();
      yield* page.type("y");
      yield* awaited("the cancelled held write", () => terminal.holdPresent !== undefined);
      yield* spawn(() => page.until("the cancelled reading", () => false));
      yield* awaited("the subscribed wait", () => terminal.waiting === 1);
      return { page, index: page.screen().index, drawn: terminal.drawn, fed: terminal.fed };
    });
    expect(page.page.screen().index).toBe(page.index);
    expect(page.page.repl.terminal.drawn).toBe(page.drawn);
    expect(page.page.repl.terminal.fed).toBe(page.fed);
    expect(page.page.screen().found("abcx", DRAFT_VALUE)).toBe(1);
    released(page.page.repl.terminal);
  });

  it("hands a failed write to the command's owner unchanged and releases the screen", function* () {
    const failure = new Error("this terminal stopped accepting writes");
    let terminal: MountedRepl["terminal"] | undefined;
    let fed = 0;
    let caught: unknown;
    try {
      yield* scoped(function* () {
        const page = yield* referencePage();
        terminal = page.repl.terminal;
        yield* spawn(() => page.until("a draft holding z", () => false));
        yield* awaited("a subscribed wait", () => page.repl.terminal.waiting === 1);
        terminal.failNextPresent(failure);
        yield* page.type("z");
        fed = terminal.fed;
        yield* suspend();
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(terminal?.fed).toBe(fed);
    if (terminal === undefined) {
      throw new Error("the command never mounted its terminal");
    }
    released(terminal);
  });

  it("ends a wait the screen can no longer satisfy when the command exits", function* () {
    const page = yield* referencePage();
    const waiting = yield* spawn(function* () {
      try {
        yield* page.until("something never drawn", () => false);
      } catch (error) {
        return error;
      }
      return undefined;
    });
    yield* awaited("the subscribed wait", () => page.repl.terminal.waiting === 1);
    page.repl.terminal.end();
    expect(String(yield* waiting)).toContain("the command ended before something never drawn");
    expect(page.repl.outcome()?.ok).toBe(true);
    released(page.repl.terminal);
  });

  it("J2: a window dragged while a frame is being prepared keeps the command", function* () {
    const page = yield* referencePage();
    yield* draftText(page, "resize me");
    const execution = yield* mountedExecution(page.repl);
    const before = page.screen().index;
    page.repl.terminal.resizeAfterRead(3, NARROW);
    yield* page.type("!");
    const first = yield* page.until(
      "the first completed resized write",
      (one) => one.index > before,
    );
    expect(first.size).toEqual(NARROW);
    expect(first.found("resize me!", DRAFT_VALUE)).toBe(1);
    const churned = page.screen().index;
    page.repl.terminal.churnSize(60, NARROW);
    yield* page.type("?");
    yield* awaited("the drag ending", () => page.repl.terminal.churning() === 0);
    const last = yield* page.until(
      "the settled resize",
      (one) => one.found("resize me!?", DRAFT_VALUE) === 1,
    );
    expect(last.size).toEqual(NARROW);
    expect(last.index - churned).toBeLessThanOrEqual(1);
    expect(last.shows("needs at least")).toBe(false);
    expect(page.repl.outcome()).toBeUndefined();
    const location = route(yield* leaveWithLocation(page));
    expect(location.execution).toBe(execution);
    expect(location.draft).toBe("resize me!?");
    released(page.repl.terminal);
  });
});

const POSITION_WORDS: Readonly<Record<string, string>> = {
  entry: "Entry %E admitted",
  scope: "Component admitted",
  binding: "Bindings recorded",
  generated: "Generated XMD admitted",
  elicit: "Answer recorded",
  agent: "Agent turn recorded",
  terminal: "Entry outcome recorded",
};
function expectedPositions(
  model: ReturnType<typeof projectRepl> extends Result<infer T> ? T : never,
): string[] {
  let entries = 0;
  return model.checkpoints.map((one, index) => {
    if (one.kind === "entry") {
      entries += 1;
    }
    const words = POSITION_WORDS[one.kind];
    if (words === undefined) {
      throw new Error(`no category for ${one.kind}`);
    }
    return `${index + 1} · ${words.replace("%E", String(entries))}`;
  });
}
function positionLabels(one: ScreenReading): string[] {
  return one.rows.flatMap(
    (row) =>
      row.match(
        /\d+ · (?:Entry \d+ admitted|Component admitted|Bindings recorded|Generated XMD admitted|Answer recorded|Agent turn recorded|Entry outcome recorded)/,
      )?.[0] ?? [],
  );
}
function* allPositions(
  page: ReplPage,
  expected: readonly string[],
): Operation<{ first: string[]; reached: string[] }> {
  const first = positionLabels(page.screen());
  const seen = new Set(first);
  for (let press = 0; press < expected.length * 2 && seen.size < expected.length; press += 1) {
    const rows = page.screen().rows;
    const last = positionLabels(page.screen()).at(-1);
    if (last === undefined) {
      throw new Error(`the drawer holds no positions: ${page.describe()}`);
    }
    const at = rows.findIndex((row) => row.includes(last));
    const controlRow = rows.slice(at + 1).find((row) => row.includes("[↓ later]"));
    if (controlRow === undefined) {
      throw new Error(`no later action after ${last}`);
    }
    const index = page.screen().index;
    yield* page.press("[↓ later]", { onRow: controlRow, rightOf: "[close]" });
    yield* page.until("the next positions", (one) => one.index > index);
    for (const label of positionLabels(page.screen())) {
      seen.add(label);
    }
  }
  return {
    first,
    reached: [...seen].sort((a, b) => Number(a.split(" ")[0]) - Number(b.split(" ")[0])),
  };
}
function historyBand(one: ScreenReading): string {
  return (
    one.rows
      .find((row) => row.includes("HISTORY"))
      ?.replace(/>/g, " ")
      .trimEnd() ?? ""
  );
}
function* fourEntries(page: ReplPage): Operation<void> {
  for (const [index, source] of [
    FIRST_COLD,
    SECOND_COLD,
    '```js eval\nconst third = "third";\n```\n\nThree: {third}\n',
    '```js eval\nconst fourth = "fourth";\n```\n\nFour: {fourth}\n',
  ].entries()) {
    yield* runSource(page, source);
    yield* entrySettles(page, index + 1, "ok");
  }
}

describe("REPL original complete History and cold catalog", () => {
  it("H5: the drawer reaches them all, and four resizes keep the reading", function* () {
    const page = yield* referencePage();
    yield* fourEntries(page);
    const expected = expectedPositions(yield* retainedModel(page));
    expect(expected.length).toBeGreaterThan(8);
    yield* draftText(page, "my next entry");
    yield* openHistory(page);
    expect((yield* allPositions(page, expected)).reached).toEqual(expected);
    yield* page.press(expected.at(-1) ?? "");
    yield* page.until("the last recorded position selected", (one) => one.shows("[live]"));
    yield* closeDrawer(page);
    yield* selectCatalog(page, "entry-1");
    const band = historyBand(page.screen());
    for (const size of [{ columns: 120, rows: 30 }, NARROW, { columns: 40, rows: 10 }, WIDE]) {
      const shown = yield* page.resize(size);
      expect(shown.rows.filter((row) => row.length > size.columns)).toEqual([]);
      if (size.columns < 72) {
        expect(shown.shows("Make the window")).toBe(true);
        continue;
      }
      expect(trail(shown)).toContain("Entry 1");
      expect(shown.found("my next entry", DRAFT_VALUE)).toBe(1);
      expect(shown.shows("[live]")).toBe(true);
    }
    expect(historyBand(page.screen())).toBe(band);
    yield* page.resize(NARROW);
    yield* openHistory(page);
    const narrow = yield* allPositions(page, expected);
    expect(narrow.reached).toEqual(expected);
    expect(narrow.first.length).toBeLessThan(expected.length);
    yield* leaveWithLocation(page);
    released(page.repl.terminal);
  });

  it("H6: the settled head, the prefix, the same rail, and no work at all", function* () {
    const dataRoot = yield* useTemporary("xmd-cold-position-order-");
    const sizes = [WIDE, { columns: 120, rows: 30 }, NARROW];
    const hot = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY], size: WIDE });
      yield* fourEntries(page);
      const expected = expectedPositions(yield* retainedModel(page));
      yield* draftText(page, "my next entry");
      yield* openHistory(page);
      yield* page.press("Entry 1 admitted");
      yield* page.until("the first prefix", (one) => one.shows("[live]"));
      yield* closeDrawer(page);
      const bands: string[] = [];
      for (const size of sizes) {
        const shown =
          page.screen().size.columns === size.columns ? page.screen() : yield* page.resize(size);
        bands.push(historyBand(shown));
      }
      yield* openHistory(page);
      expect((yield* allPositions(page, expected)).reached).toEqual(expected);
      expect(positionLabels(page.screen())[0]).not.toBe(expected[0]);
      yield* closeDrawer(page);
      const path = yield* executionJournal(page);
      return { location: yield* leaveWithLocation(page), path, expected, bands };
    });
    const bytes = yield* readTextFile(hot.path);
    const host = yield* useMountedHost({ dataRoot, includes: [REFERENCE_DIRECTORY] });
    yield* noNewExecution();
    const work = yield* performedWork();
    const page = yield* useReplPage({ host, location: hot.location, size: WIDE });
    expect(page.screen().shows("HEAD · SETTLED")).toBe(true);
    for (const label of ["[pause]", "[continue]", "HEAD · LIVE", "HEAD · SETTLING"]) {
      expect(page.screen().shows(label)).toBe(false);
    }
    yield* catalog(page);
    expect(page.screen().shows("entry-1")).toBe(true);
    expect(page.screen().shows("entry-2")).toBe(false);
    yield* closeDrawer(page);
    const cold: string[] = [];
    for (const size of sizes) {
      const shown =
        page.screen().size.columns === size.columns ? page.screen() : yield* page.resize(size);
      cold.push(historyBand(shown));
    }
    expect(cold).toEqual(hot.bands);
    yield* openHistory(page);
    expect(positionLabels(page.screen())[0]).toBe(hot.expected[0]);
    expect((yield* allPositions(page, hot.expected)).reached).toEqual(hot.expected);
    yield* closeDrawer(page);
    expect(yield* leaveWithLocation(page)).toBe(hot.location);
    expect(work.compiles).toBe(0);
    expect(work.asked).toBe(0);
    expect(work.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    expect(yield* readTextFile(hot.path)).toBe(bytes);
  });

  it("EC1: the same catalog and the same selected entry, with no work and no append", function* () {
    const dataRoot = yield* useTemporary("xmd-cold-catalog-");
    const hot = yield* scoped(function* () {
      const page = yield* referencePageFor(dataRoot);
      yield* runSource(page, FIRST_COLD);
      yield* entrySettles(page, 1, "ok");
      yield* runSource(page, SECOND_COLD);
      yield* entrySettles(page, 2, "ok");
      yield* selectCatalog(page, "entry-2");
      return { location: yield* leaveWithLocation(page), path: yield* executionJournal(page) };
    });
    const bytes = yield* readTextFile(hot.path);
    const host = yield* useMountedHost({ dataRoot, includes: [REFERENCE_DIRECTORY] });
    yield* noNewExecution();
    const work = yield* performedWork();
    const page = yield* useReplPage({ host, location: hot.location });
    yield* catalog(page);
    expect(page.screen().shows("1. [ok] entry-1")).toBe(true);
    expect(page.screen().shows("2. [ok] entry-2")).toBe(true);
    yield* closeDrawer(page);
    expect(trail(page.screen())).toContain("Entry 2");
    expect(page.screen().shows("Two: alpha-again")).toBe(true);
    expect(page.screen().shows("One: alpha")).toBe(false);
    expect(
      (yield* retainedModel(page)).entries[1]?.bindings.find((one) => one.name === "carried")
        ?.value,
    ).toBe("alpha-again");
    expect(yield* leaveWithLocation(page)).toBe(hot.location);
    expect(work.compiles).toBe(0);
    expect(work.reads.filter((one) => one.endsWith(".md"))).toEqual([]);
    expect(yield* readTextFile(hot.path)).toBe(bytes);
    released(page.repl.terminal);
  });
});
function referencePageFor(dataRoot: string): Operation<ReplPage> {
  return useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY], size: WIDE });
}

describe("REPL original visible guidance and controlled typing", () => {
  it("UI1: the guidance teaches the ring that is mounted, at both sizes", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* () {
        const page = yield* useReplPage({ size });
        expect(directions(page.screen())).toBe(
          "Ready for Entry 1 · Enter submits · Type here · Tab/Shift+Tab move",
        );
        expect(page.screen().shows("Esc closes")).toBe(false);
        yield* page.key("Backtab");
        yield* page.until("the way out's guidance", (one) => one.shows("Enter exits"));
        expect(page.screen().shows("Enter submits")).toBe(false);
        expect(page.screen().shows("Ready for Entry 1")).toBe(true);
        expect(
          page.screen().shows(size.columns === 72 ? "Tab to draft" : "Tab to the draft to type"),
        ).toBe(true);
        yield* page.key("Backtab");
        yield* page.until("History's guidance", (one) => one.shows("Enter opens"));
        yield* page.key("Enter");
        yield* page.until(
          "History's closing instruction",
          (one) => one.shows("[close]") && one.shows("Esc closes"),
        );
      });
    }
  });

  it("UI9: typing at a control never reaches the draft, and the screen says why", function* () {
    const page = yield* useReplPage();
    yield* tab(page);
    yield* page.until("control guidance", (one) => !one.shows("Enter submits"));
    expect(page.screen().shows("Enter submits")).toBe(false);
    expect(page.screen().shows("Tab to the draft to type")).toBe(true);
    yield* page.type("discarded typing");
    yield* page.key("Backtab");
    yield* page.until("the Draft's own guidance", (one) => one.shows("Type here"));
    yield* draftText(page, "kept typing");
    expect(page.screen().shows("discarded typing")).toBe(false);
    expect(yield* journalRecords(page)).toEqual([]);
    expect(route(yield* leaveWithLocation(page)).draft).toBe("kept typing");
  });

  it("J1: a long draft stays exact and usable at medium, and no row crosses its region", function* () {
    const size = { columns: 120, rows: 30 };
    const page = yield* useReplPage({ size });
    const source = yield* referenceSource();
    yield* pasteDraft(page, source);
    expect(
      page.screen().found(source.trimEnd().split(/\s+/).at(-1) ?? "", DRAFT_VALUE),
    ).toBeGreaterThan(0);
    expect(page.screen().rows.every((row) => row.length <= size.columns)).toBe(true);
    expect(route(yield* leaveWithLocation(page)).draft).toBe(source);
  });

  it("UI12: a lifecycle refusal keeps the draft and goes when the entry it named ends, untouched", function* () {
    const host = yield* useMountedHost();
    const release = withResolvers<void>();
    yield* ensure(() => release.resolve());
    yield* API.Fetch.around({
      *fetch() {
        yield* release.operation;
        return {
          status: 200,
          headers: new Headers(),
          *text() {
            return "done";
          },
        };
      },
    });
    const page = yield* useReplPage({ host });
    yield* runSource(page, '```js eval\nyield* fetch("https://held.invalid/finish");\n```');
    yield* page.until(
      "the running first entry",
      (one) =>
        one.shows("Entry 1 running") &&
        one.found('fetch("https://held.invalid/finish")', DRAFT_VALUE) === 0 &&
        one.found("```", DRAFT_VALUE) === 0,
    );
    const text = "second entry, typed while the first is running";
    yield* runSource(page, text);
    yield* page.until("the temporary lifecycle refusal", (one) => one.shows("has not finished"));
    expect(page.screen().found(text, DRAFT_VALUE)).toBe(1);
    expect((yield* retainedModel(page)).entries).toHaveLength(1);
    const fed = page.repl.terminal.fed;
    release.resolve();
    yield* page.until("the refusal expiring with its entry", (one) =>
      one.shows("Ready for Entry 2"),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().shows("has not finished")).toBe(false);
    expect(route(yield* leaveWithLocation(page)).draft).toBe(text);
  });
});

describe("REPL original held reading and canonical startup", () => {
  it("J1: run, hold at a gate, inspect a prefix, return live, continue, answer, settle", function* () {
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    const gate = preparationGate();
    yield* gate.install();
    const page = yield* useReplPage({ host, size: WIDE });
    const source = yield* referenceSource();
    yield* runSource(page, source);
    yield* gate.reached;
    yield* pausedAt(page, "preparing");
    yield* requestPause(page);
    gate.release();
    yield* pausedAt(page, "paused");
    const records = yield* journalRecords(page);
    const reading = page.screen();
    yield* sleep(25);
    expect(yield* journalRecords(page)).toEqual(records);
    expect(page.screen().index).toBe(reading.index);
    expect(page.screen().rows).toEqual(reading.rows);
    expect(page.screen().shows("[answer]")).toBe(false);
    yield* openHistory(page);
    yield* page.press("Entry 1 admitted");
    yield* page.until("the recorded prefix", (one) => one.shows("[live]"));
    expect(page.screen().shows("[pause]")).toBe(false);
    expect(page.screen().rows.some((row) => row.trim().startsWith("…"))).toBe(false);
    yield* closeDrawer(page);
    yield* page.press("[live]");
    yield* page.until(
      "the held live head",
      (one) => !one.shows("[live]") && one.shows("[continue]"),
    );
    yield* page.press("[continue]");
    yield* page.until("the authored question", (one) => one.shows("[answer]"));
    yield* answerReference(page);
    yield* readTo(page, "Decision: approve");
    expect(page.screen().shows("Decision: approve")).toBe(true);
    const model = yield* retainedModel(page);
    const generated = model.transcript.find((row) => row.kind === "generated");
    expect(generated?.kind).toBe("generated");
    expect(model.entries[0]?.source).toBe(source);
    expect(model.entries[0]?.terminal?.status).toBe("ok");
    yield* leaveWithLocation(page);
    released(page.repl.terminal);
  });
  it("J1: an untouched fresh command returns its exact empty canonical location", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* () {
        const page = yield* useReplPage({ size, includes: [REFERENCE_DIRECTORY] });
        const execution = yield* mountedExecution(page.repl);
        expect(yield* journalRecords(page)).toEqual([]);
        expect(page.screen().shows("Entries")).toBe(true);
        expect(page.screen().shows("xmd://")).toBe(false);
        expect(yield* leaveWithLocation(page)).toBe(`xmd://repl/${execution}/entries`);
        released(page.repl.terminal);
      });
    }
  });
});

describe("REPL original presentation acknowledgement", () => {
  it("J1: a frame is not acknowledged until it has been presented", function* () {
    const host = yield* useMountedHost({ includes: [REFERENCE_DIRECTORY] });
    const pending: Array<() => void> = [];
    let holding = false;
    let waits = 0;
    const release = () => {
      for (const resolve of pending.splice(0)) {
        resolve();
      }
    };
    yield* ensure(release);
    yield* ReplClock.around(
      {
        *now() {
          return 0;
        },
        *wait() {
          waits += 1;
          if (holding) {
            const ready = withResolvers<void>();
            pending.push(() => ready.resolve());
            yield* ready.operation;
          }
        },
      },
      { at: "min" },
    );
    const page = yield* useReplPage({ host, size: WIDE });
    holding = true;
    yield* sleep(5);
    while (pending.length > 0) {
      release();
      yield* sleep(5);
    }
    const before = waits;
    const reading = page.screen().index;
    page.repl.terminal.holdNextPresent();
    page.repl.terminal.resized({ columns: 150, rows: 34 });
    yield* awaited("the presentation held inside its real write", () => {
      release();
      return page.repl.terminal.holdPresent !== undefined;
    });
    release();
    yield* sleep(5);
    expect(waits).toBe(before);
    expect(page.screen().index).toBe(reading);
    page.repl.terminal.holdPresent?.release();
    yield* awaited("the stream's next tick after presentation", () => {
      release();
      return waits > before;
    });
    holding = false;
    release();
    yield* leaveWithLocation(page);
    released(page.repl.terminal);
  });
});

const RETAINED_SCHEMA = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "decline"] } },
  required: ["decision"],
  additionalProperties: false,
};
const RETAINED_ANSWER = { decision: "approve" };
function* retainedAnswerLines(page: ReplPage): Operation<{ first: string[]; seen: string[] }> {
  const first = drawerLines(page.screen());
  const seen = [...first];
  const expected = [
    ...JSON.stringify(RETAINED_SCHEMA, undefined, 2).split("\n"),
    ...JSON.stringify(RETAINED_ANSWER, undefined, 2).split("\n"),
  ].map((line) => line.trim());
  for (
    let press = 0;
    press < 60 && !expected.every((line) => seen.some((row) => row.includes(line)));
    press += 1
  ) {
    const one = page.screen();
    const close = one.locate("[close]");
    const row = [...one.rows.slice(0, close.row)]
      .reverse()
      .find((line) => line.includes("[↓ later]"));
    if (row === undefined) {
      throw new Error("the recorded drawer offered no later reading");
    }
    yield* page.press("[↓ later]", { onRow: row, rightOf: "[close]" });
    yield* page.until("the recorded drawer's next rows", (next) => next.index > one.index);
    seen.push(...drawerLines(page.screen()));
  }
  for (const line of expected) {
    expect(seen.some((row) => row.includes(line))).toBe(true);
  }
  return { first, seen };
}

describe("REPL original retained schema and generated evidence", () => {
  it("J1: a recorded question reopens its whole schema and answer without work", function* () {
    const dataRoot = yield* useTemporary("xmd-recorded-answer-cold-");
    const kept = yield* scoped(function* () {
      const page = yield* useReplPage({ dataRoot, includes: [REFERENCE_DIRECTORY], size: WIDE });
      yield* referenceAsking(page);
      yield* answerReference(page);
      const generated = (yield* retainedModel(page)).transcript.find(
        (one) => one.kind === "generated",
      );
      if (generated?.kind !== "generated" || generated.source === undefined) {
        throw new Error("the reference retained no generated source");
      }
      yield* selectCatalog(page, "entry-1");
      yield* selectCatalog(page, "generated generated");
      const opening = '<Json value={{"title":"Ship the';
      const closing = 'REPL","steps":2}} />';
      expect(`${opening} ${closing}`).toBe(generated.source);
      yield* page.resize(NARROW);
      for (
        let press = 0;
        press < 60 && !(page.screen().shows(opening) && page.screen().shows(closing));
        press += 1
      ) {
        const index = page.screen().index;
        yield* page.press("[↓ later]");
        yield* page.until("the generated source entering the reading", (one) => one.index > index);
      }
      const begins = page.screen().locate(opening);
      const ends = page.screen().locate(closing);
      expect(ends.row).toBe(begins.row + 1);
      expect(page.screen().locate("<Evaluate").row).toBeLessThan(begins.row);
      if (page.screen().size.columns !== WIDE.columns) {
        yield* page.resize(WIDE);
      }
      yield* selectCatalog(page, "entry-1");
      yield* selectPane(page, "bindings");
      yield* openHistory(page);
      const labels = positionLabels(page.screen());
      expect(labels.length).toBeGreaterThan(4);
      yield* page.press(labels.at(-1) ?? "");
      yield* page.until("the recorded terminal prefix", (one) => one.shows("[live]"));
      yield* closeDrawer(page);
      yield* page.press("answered ");
      yield* page.until(
        "the recorded answer drawer",
        (one) => one.shows("Recorded answer") && one.shows("[close]"),
      );
      const read = yield* retainedAnswerLines(page);
      expect(read.first).not.toEqual(drawerLines(page.screen()));
      const path = yield* executionJournal(page);
      const location = yield* leaveWithLocation(page);
      const parsed = route(location);
      expect(parsed.scopes).toEqual(["entry-1"]);
      expect(parsed.at).toBeDefined();
      expect(parsed.inspect).toBe(true);
      expect(parsed.drawers.map((one) => one.kind)).toEqual(["recorded-elicit"]);
      return { path, location, generated: generated.source, labels };
    });
    const bytes = yield* readTextFile(kept.path);
    const host = yield* useMountedHost({ dataRoot, includes: [REFERENCE_DIRECTORY] });
    yield* noNewExecution();
    const work = yield* performedWork();
    const page = yield* useReplPage({ host, location: kept.location, size: WIDE });
    expect(page.screen().shows("Recorded answer")).toBe(true);
    yield* retainedAnswerLines(page);
    yield* closeDrawer(page);
    expect(trail(page.screen())).toContain("Entry 1");
    expect(page.screen().shows("[live]")).toBe(true);
    yield* catalog(page);
    expect(page.screen().shows("component Checklist")).toBe(true);
    expect(page.screen().shows("generated generated")).toBe(true);
    yield* closeDrawer(page);
    yield* page.press("answered ");
    yield* page.until(
      "the retained question reachable again",
      (one) => one.shows("Recorded answer") && one.shows("[close]"),
    );
    yield* retainedAnswerLines(page);
    yield* closeDrawer(page);
    yield* openHistory(page);
    expect(positionLabels(page.screen())).toEqual(kept.labels);
    const returned = route(yield* leaveWithLocation(page));
    const original = route(kept.location);
    expect([returned.execution, returned.scopes, returned.at, returned.inspect]).toEqual([
      original.execution,
      original.scopes,
      original.at,
      original.inspect,
    ]);
    expect(work.compiles).toBe(0);
    expect(work.asked).toBe(0);
    expect(work.reads).toEqual([]);
    expect(yield* readTextFile(kept.path)).toBe(bytes);
    released(page.repl.terminal);
  });
});

describe("REPL original question arrival on another reading", () => {
  it("UI3: a question on Sessions moves nothing, and is reached by activating it", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* () {
        const host = yield* useMountedHost();
        const entered = withResolvers<void>();
        const release = withResolvers<void>();
        yield* ensure(() => release.resolve());
        yield* Elicitation.around({
          *elicit([request], next) {
            entered.resolve();
            yield* release.operation;
            return yield* next(request);
          },
        });
        const page = yield* useReplPage({ host, size });
        yield* runSource(page, JOURNEY_ONE);
        yield* entered.operation;
        yield* sessions(page);
        for (let press = 0; press < 40 && !page.screen().shows("Enter exits"); press += 1) {
          const index = page.screen().index;
          yield* page.key("Backtab");
          yield* page.until("the preceding control's guidance", (one) => one.index > index);
        }
        expect(page.screen().shows("Enter exits")).toBe(true);
        release.resolve();
        yield* page.until("the newly arrived question", (one) => one.shows("[answer]"));
        expect(page.screen().shows("Enter exits")).toBe(true);
        expect(page.screen().shows("[close]")).toBe(false);
        expect(page.screen().shows("decision: go")).toBe(false);
        if (size.columns === 72) {
          expect(page.screen().shows("All sessions")).toBe(true);
          expect(page.screen().shows("DRAFT")).toBe(false);
        }
        yield* page.press("[answer]");
        yield* page.until("the question's own entry drawer", (one) => one.shows("[submit]"));
        expect(trail(page.screen())).toContain("Entry 1");
        yield* closeDrawer(page);
        expect(page.screen().shows("[answer]")).toBe(true);
        yield* page.key("Enter");
        yield* page.until("the unanswered question reopening", (one) => one.shows("[submit]"));
        expect((yield* journalRecords(page)).filter((line) => line.includes("elicit"))).toEqual([]);
        yield* leaveWithLocation(page);
      });
    }
  });
});

describe("REPL original surface and entry selection marks", () => {
  it("UI1: the active surface and the selected entry are marked in the frame", function* () {
    for (const size of [WIDE, NARROW]) {
      yield* scoped(function* () {
        const page = yield* useReplPage({ size });
        yield* runSource(page, FIRST_COLD);
        yield* entrySettles(page, 1, "ok");
        yield* runSource(
          page,
          "```js eval\nconst carried = `${token}-again`;\n```\n\nTwo: {carried}\n",
        );
        yield* entrySettles(page, 2, "ok");
        expect(trail(page.screen())).toContain("Entry 2");
        const before = page.screen().rows;
        if (size.columns === 72) {
          yield* page.press("Sessions");
          yield* page.until("the selected Sessions outlet", (one) => one.shows("* Sessions"));
        } else {
          yield* intoDraft(page);
          for (let press = 0; press < 4; press += 1) {
            yield* tab(page);
          }
          expect(page.screen().shows("TRANSCRIPT")).toBe(true);
        }
        expect(page.screen().rows).not.toEqual(before);
        yield* catalog(page);
        if (size.columns === 72) {
          expect(page.screen().shows("* Entries")).toBe(true);
        }
        yield* closeDrawer(page);
        let first: readonly string[] = [];
        for (const entry of ["entry-1", "entry-2"]) {
          yield* selectCatalog(page, entry);
          yield* catalog(page);
          for (const label of ["entry-1", "entry-2"]) {
            const row = page.screen().rows.find((one) => one.includes(label)) ?? "";
            expect([size.columns, entry, label, row.includes("*")]).toEqual([
              size.columns,
              entry,
              label,
              entry === label,
            ]);
          }
          yield* closeDrawer(page);
          if (entry === "entry-1") {
            first = page.screen().rows;
          } else {
            expect(page.screen().rows).not.toEqual(first);
          }
        }
        yield* intoDraft(page);
        yield* page.key("Backtab");
        yield* page.until("the way out keeping the entry selected", (one) =>
          one.shows("Enter exits"),
        );
        yield* catalog(page);
        const selected = page.screen().rows.find((one) => one.includes("entry-2")) ?? "";
        expect(selected).toContain("*");
        yield* closeDrawer(page);
        yield* sessions(page);
        expect(page.screen().shows("(none retained)")).toBe(true);
      });
    }
  });
});
