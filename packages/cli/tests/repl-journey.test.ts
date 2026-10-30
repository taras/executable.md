/** The mounted REPL journey, driven by terminal input and visible outcomes. */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend } from "effection";
import type { Operation } from "effection";
import { Elicitation } from "@executablemd/core";
import { API } from "@executablemd/runtime";
import { readTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { decodeLocation } from "../src/repl/route.ts";
import { REFERENCE_DIRECTORY } from "./fixtures/repl/reference.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { ReplPage, ScreenReading } from "./support/repl-page.ts";
import { awaited } from "./support/mounted-repl.ts";
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
