import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { REPL_PALETTE } from "../src/repl/presentation-style.ts";
import { sleep } from "effection";
import type { Operation } from "effection";

import {
  DRAWER_WINDOW,
  focusSettled,
  initialState,
  NO_AGENT,
  reduceRepl,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import type { ReplLive, ReplState } from "../src/repl/application.ts";
import type { ReplKey } from "../src/repl/description.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { usePresenter, windowOf } from "./fixtures/repl/presentation.ts";
import type { Presenter } from "./fixtures/repl/presentation.ts";
import { journalModel } from "./fixtures/repl/journals.ts";
import { REFERENCE_DIRECTORY } from "./fixtures/repl/reference.ts";
import { useReplPage } from "./support/repl-page.ts";
import type { PageKey, ReplPage } from "./support/repl-page.ts";

const WIDE = { columns: 160, rows: 36 };
const MEDIUM = { columns: 120, rows: 30 };
const NARROW = { columns: 72, rows: 20 };

function* key(page: ReplPage, name: PageKey): Operation<void> {
  const before = page.screen().index;
  yield* page.key(name);
  yield* page.until(`a write after ${name}`, (one) => one.index > before);
  // Reveal can publish its window before the follow-up presentation. Keep the
  // keyboard cadence independent of focus cues or a guessed frame count.
  yield* sleep(30);
}

function* typed(page: ReplPage, text: string): Operation<void> {
  yield* page.type(text);
  yield* page.until(`text ${JSON.stringify(text)}`, (one) => one.shows(text));
}

describe("REPL focus regions: the normal screen", () => {
  for (const size of [WIDE, MEDIUM]) {
    it(`R1/R2: fixed region entries deliver Draft and Message input at ${size.columns}x${size.rows}`, function* () {
      const page = yield* useReplPage({ size });
      yield* typed(page, "draft-kept");
      // Draft -> Tabs -> Right reading -> Message, independent of child counts.
      yield* key(page, "Tab");
      yield* key(page, "Tab");
      yield* key(page, "Tab");
      yield* typed(page, "message-kept");
      expect(page.screen().found("message-kept", { after: "message the sidekick" })).toBe(1);
      expect(page.screen().found("draft-kept", { after: " DRAFT" })).toBe(1);
      expect(page.repl.fake.prompts).toHaveLength(0);

      // Message -> History -> Transcript -> Selected work -> Draft.
      for (let step = 0; step < 4; step += 1) {
        yield* key(page, "Tab");
      }
      yield* typed(page, "-returned");
      expect(page.screen().shows("draft-kept-returned")).toBe(true);
      for (const name of [
        "ArrowLeft",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "ArrowRight",
      ] satisfies PageKey[]) {
        yield* page.key(name);
      }
      yield* key(page, "Alt+ArrowDown");
      expect(page.screen().shows("draft-kept-returned")).toBe(true);
      expect(page.screen().shows("No entry yet")).toBe(true);
      yield* key(page, "Tab");
      yield* key(page, "Backtab");
      yield* typed(page, "-fixed");
      expect(page.screen().shows("draft-kept-returned-fixed")).toBe(true);
      expect(page.screen().shows("message-kept")).toBe(true);
    });
  }

  it("R3: tabs and History arrows move without activation; Enter selects", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* key(page, "Tab");
    yield* key(page, "ArrowRight");
    yield* key(page, "ArrowRight");
    yield* page.key("ArrowRight");
    yield* page.key("ArrowDown");
    yield* key(page, "ArrowLeft");
    yield* key(page, "ArrowLeft");
    expect(page.screen().shows("message the sidekick")).toBe(true);
    expect(page.screen().shows("[refresh]")).toBe(false);
    yield* page.key("Enter");
    yield* page.until("Bindings selected", (one) => !one.shows("message the sidekick"));
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* key(page, "ArrowRight");
    expect(page.repl.terminal.ending).toBe(undefined);
    yield* key(page, "ArrowLeft");
    yield* page.key("Enter");
    yield* page.until("History opened", (one) => one.shows("[close]"));
  });

  it("R4: narrowing from Tabs recovers to the bar and widening keeps its destination", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* typed(page, "survives-resize");
    yield* key(page, "Tab");
    yield* page.resize(NARROW);
    // The empty routed outlet has no control: recovery is Sessions on the bar.
    yield* key(page, "Tab");
    yield* typed(page, "-narrow");
    expect(page.screen().shows("survives-resize-narrow")).toBe(true);
    yield* page.resize(WIDE);
    yield* typed(page, "-wide");
    expect(page.screen().shows("survives-resize-narrow-wide")).toBe(true);
  });
});

describe("REPL focus regions: Unicode caret editing", () => {
  it("PV3: Draft and Message edit at independent carets across rows, focus and resize", function* () {
    const page = yield* useReplPage({ size: MEDIUM });
    yield* page.type("é界\nsecond");
    yield* page.until("both Draft rows", (one) => one.shows("é界") && one.shows("second"));
    yield* key(page, "Home");
    yield* key(page, "ArrowUp");
    yield* key(page, "ArrowRight");
    yield* typed(page, "中");
    expect(page.screen().shows("é中界")).toBe(true);
    yield* page.resize(NARROW);
    yield* typed(page, "!");
    expect(page.screen().shows("é中!界")).toBe(true);
    yield* key(page, "Alt+ArrowDown");
    yield* key(page, "Tab");
    yield* key(page, "Backtab");
    yield* typed(page, "?");
    expect(page.screen().shows("é中!?界")).toBe(true);
    yield* key(page, "Backspace");
    yield* page.resize(MEDIUM);
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* page.type(" m界\nXYZ");
    yield* page.until("both Message rows", (one) => one.shows(" m界") && one.shows("XYZ"));
    yield* key(page, "Home");
    yield* key(page, "ArrowUp");
    yield* key(page, "ArrowRight");
    yield* page.type("M");
    yield* page.until("Message middle insertion", (one) => one.shows(" Mm界"));
    yield* key(page, "Backspace");
    yield* key(page, "ArrowDown");
    yield* page.type("中");
    yield* page.until("Message second-row insertion", (one) => one.shows("X中YZ"));
    yield* key(page, "Alt+ArrowUp");
    yield* key(page, "Tab");
    yield* key(page, "Backtab");
    yield* page.type("!");
    yield* page.until("Message preserved caret", (one) => one.shows("X中!YZ"));
    expect(page.screen().shows("é中!界")).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(0);
    expect(page.screen().shows("No entry yet")).toBe(true);
  });
});

describe("REPL focus regions: reading and narrow recovery", () => {
  it("PV5: the selected reading reaches both boundaries without activating or editing", function* () {
    const page = yield* useReplPage({ size: MEDIUM });
    yield* page.type(Array.from({ length: 50 }, (_, at) => `Reading row ${at}`).join("\n"));
    yield* page.until("the complete source", (one) => one.shows("Reading row 49"));
    yield* page.key("Enter");
    yield* page.until("the entry settled", (one) => one.shows("Ready for Entry 2"));
    yield* typed(page, "kept-draft");
    yield* key(page, "Backtab");
    yield* key(page, "Alt+ArrowDown");
    yield* key(page, "Alt+ArrowDown");
    yield* key(page, "End");
    yield* page.until("the reading's final row", (one) => one.shows("Reading row 49"));
    yield* key(page, "Home");
    yield* page.until("the reading's first row", (one) => one.shows("Reading row 0"));
    yield* key(page, "PageDown");
    yield* key(page, "ArrowUp");
    yield* key(page, "Enter");
    expect(page.screen().shows("kept-draft")).toBe(true);
    expect(page.screen().shows("Ready for Entry 2")).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(0);
  });

  it("PV6: running work and both texts survive narrow access and minimum-size recovery", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* page.type(
      '<Elicit as="response" schema={{type:"object",properties:{response:{type:"string"}},required:["response"],additionalProperties:false}}>Waiting for your answer.</Elicit>',
    );
    yield* page.until("the source ready", (one) => one.shows("</Elicit>"));
    yield* page.key("Enter");
    yield* page.until("the entry waiting", (one) => one.shows("[answer]"));
    yield* typed(page, "next-draft");
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* typed(page, "next-message");
    yield* page.resize(MEDIUM);
    yield* page.resize(NARROW);
    yield* key(page, "Backtab");
    yield* key(page, "ArrowRight");
    yield* key(page, "ArrowRight");
    yield* page.key("Enter");
    yield* page.until("narrow Sidekick", (one) => one.shows("message the sidekick"));
    yield* page.type("-narrow");
    yield* page.until("the narrow Message", (one) => one.shows("next-message-narrow"));
    yield* page.resize({ columns: 71, rows: 19 });
    yield* page.until("the minimum-size refusal", (one) => one.shows("needs at least 72x20"));
    yield* page.resize(NARROW);
    yield* page.until("the routed reading recovered", (one) => one.shows("message the sidekick"));
    yield* key(page, "Tab");
    yield* page.type("-recovered");
    yield* page.until("the recovered Message", (one) => one.shows("next-message-narrow-recovered"));
    yield* page.resize(WIDE);
    yield* page.type("-wide");
    yield* page.until("no widening focus jump", (one) =>
      one.shows("next-message-narrow-recovered-wide"),
    );
    expect(page.screen().shows("next-draft")).toBe(true);
    expect(page.screen().shows("[answer]")).toBe(true);
    expect(page.screen().shows("[stop]")).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(0);
  });
});

describe("REPL focus regions: the catalog drawer at the narrow size", () => {
  it("R5: nested arrows reveal hidden entries, fixed Content entry and modal close restore", function* () {
    const page = yield* useReplPage({ size: NARROW, includes: [REFERENCE_DIRECTORY] });
    for (let order = 1; order <= 6; order += 1) {
      yield* typed(page, `<Checklist title="Plan ${order}" steps={1} />`);
      yield* page.key("Enter");
      yield* page.until(`entry ${order} settled`, (one) => one.shows(`${order} ✓`));
      yield* page.until(`ready for entry ${order + 1}`, (one) =>
        one.shows(`Ready for Entry ${order + 1}`),
      );
    }
    // Draft -> History -> Surface bar, then Entries. Arrows do not open it.
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* key(page, "ArrowRight");
    expect(page.screen().shows("[close]")).toBe(false);
    yield* page.key("Enter");
    yield* page.until("catalog open", (one) => one.shows("[close]"));
    expect(page.screen().shows("1. [")).toBe(true);
    expect(page.screen().shows("6. [")).toBe(false);

    yield* key(page, "ArrowDown");
    yield* key(page, "ArrowRight");
    yield* page.key("ArrowDown");
    yield* key(page, "ArrowLeft");
    yield* key(page, "Alt+ArrowDown");
    yield* key(page, "Alt+ArrowUp");
    for (let order = 3; order <= 6; order += 1) {
      yield* key(page, "ArrowDown");
    }
    expect(page.screen().shows("6. [")).toBe(true);
    expect(page.screen().shows("1. [")).toBe(false);
    // Activate the reached row: the selected entry's source is the oracle.
    yield* page.key("Enter");
    yield* page.until("entry 6 selected", (one) => one.shows("Plan 6") && !one.shows("[close]"));
    expect(page.screen().shows("Ready for Entry 7")).toBe(true);

    // Closing selection restores Entries. Reopen, then use all three regions.
    yield* page.key("Enter");
    yield* page.until("catalog reopened", (one) => one.shows("[close]"));
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* key(page, "Tab");
    yield* page.key("Enter");
    yield* page.until("fixed first admitted Content row selected", (one) => !one.shows("[close]"));
    // Reopen at the restored opener; Actions is Close, never the Draft behind it.
    yield* page.key("Enter");
    yield* page.until("catalog reopened for Close", (one) => one.shows("[close]"));
    yield* key(page, "Backtab");
    yield* key(page, "Backtab");
    yield* page.key("Enter");
    yield* page.until("catalog closed by Actions", (one) => !one.shows("[close]"));
    yield* key(page, "Tab");
    yield* key(page, "Backtab");
    yield* page.key("Enter");
    yield* page.until("fixed Sessions entry routes without reopening catalog", (one) =>
      one.shows("All sessions"),
    );
    expect(page.screen().shows("[close]")).toBe(false);
  });
});

const IDLE: ReplLive = {
  output: "",
  question: undefined,
  expansion: "playing",
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
  sidekick: {
    chat: [],
    busy: false,
    agent: "scribe",
    refusal: undefined,
    question: undefined,
    requested: undefined,
    verified: undefined,
    conversation: "owned",
    reading: "owned",
    current: true,
    turns: [],
    availability: { chats: ["owned"], sessions: [], refusal: undefined },
  },
};

function focused(presenter: Presenter): string | undefined {
  const node = presenter.tree.focused();
  return node === undefined ? undefined : presenter.tree.keyOf(node);
}

function* dispatched(presenter: Presenter, name: ReplKey) {
  const result = yield* presenter.tree.dispatch({ kind: "key", key: name });
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

describe("REPL focus regions: owned composition invariants", () => {
  for (const size of [WIDE, MEDIUM]) {
    it(`R1: the seven entries in both directions at ${size.columns}x${size.rows}`, function* () {
      const model = yield* journalModel([]);
      const view = viewFor(initialState("owned"), model, IDLE, size);
      if (!view.ok) {
        throw view.error;
      }
      const presenter = yield* usePresenter(size);
      yield* presenter.commit(withWorkspace(view.value, workspaceOf(model)));
      expect(focused(presenter)).toBe("footer:input");
      const entries = [
        "tab:bindings",
        "sidekick:anchor",
        "sidekick:message",
        "footer:history",
        "transcript:selector",
        "entries:heading",
        "footer:input",
      ];
      const walked: (string | undefined)[] = [];
      for (const _entry of entries) {
        yield* dispatched(presenter, "Tab");
        walked.push(focused(presenter));
      }
      expect(walked).toEqual(entries);
      const back: (string | undefined)[] = [];
      for (const _entry of entries) {
        yield* dispatched(presenter, "Backtab");
        back.push(focused(presenter));
      }
      expect(back).toEqual([
        "entries:heading",
        "transcript:selector",
        "footer:history",
        "sidekick:message",
        "sidekick:anchor",
        "tab:bindings",
        "footer:input",
      ]);
    });
  }

  it("PV3: the rendered Draft keeps its caret visible in the value window", function* () {
    const model = yield* journalModel([]);
    const presenter = yield* usePresenter(MEDIUM);
    let state: ReplState = {
      ...initialState("caret"),
      draft: "first\nsecond\nthird\nfourth\nfifth",
    };
    function* commit() {
      const resolved = viewFor(state, model, IDLE, MEDIUM, focused(presenter));
      if (!resolved.ok) {
        throw resolved.error;
      }
      return yield* presenter.commit(withWorkspace(resolved.value, workspaceOf(model)));
    }
    yield* commit();
    const moved = yield* dispatched(presenter, "Home");
    if (moved.outcome !== "action") {
      throw new Error("the Draft did not claim Home");
    }
    state = reduceRepl(state, moved.action, model, IDLE).state;
    for (let row = 0; row < 4; row += 1) {
      yield* commit();
      const up = yield* dispatched(presenter, "ArrowUp");
      if (up.outcome !== "action") {
        throw new Error("the Draft did not claim Up");
      }
      state = reduceRepl(state, up.action, model, IDLE).state;
    }
    const shown = yield* commit();
    expect(presenter.grid.rows().some((row) => row.includes("first"))).toBe(true);
    const value = shown.boundsOf("draft:value:0");
    if (value === undefined) {
      throw new Error("the Draft value has no drawn bounds");
    }
    expect(presenter.grid.styleAt(value.x, value.y).background).toBe(REPL_PALETTE.focus);
    expect(focused(presenter)).toBe("footer:input");
    expect(state.draft).toBe("first\nsecond\nthird\nfourth\nfifth");
  });

  it("R5: catalog Content re-entry uses the first admitted row rather than the last focus", function* () {
    const model = yield* journalModel(
      Array.from({ length: 8 }, (_, index) => `# Reading ${index + 1}`),
    );
    let state: ReplState = initialState("owned");
    const presenter = yield* usePresenter(NARROW);
    function* commit() {
      const resolved = viewFor(state, model, IDLE, NARROW, focused(presenter));
      if (!resolved.ok) {
        throw resolved.error;
      }
      const view = withWorkspace(resolved.value, workspaceOf(model));
      const shown = yield* presenter.commit(view);
      state = focusSettled(view, focused(presenter), shown.committed.admission);
      return shown;
    }
    function* send(name: ReplKey): Operation<void> {
      const next = yield* dispatched(presenter, name);
      if (next.outcome === "action") {
        state = reduceRepl(state, next.action, model, IDLE).state;
      }
      yield* commit();
    }
    yield* commit();
    yield* send("Tab");
    yield* send("Tab");
    yield* send("ArrowRight");
    yield* send("Enter");
    expect(focused(presenter)).toBe("entry:entry-1");
    for (let row = 2; row <= 8; row += 1) {
      yield* send("ArrowDown");
      expect(focused(presenter)).toBe(`entry:entry-${row}`);
    }
    const shown = yield* commit();
    const window = windowOf(shown.committed.admission, DRAWER_WINDOW);
    expect(window.from).toBeGreaterThan(0);
    const first = shown.keys.find((one) => one.startsWith("entry:"));
    expect(first).not.toBe("entry:entry-8");
    yield* send("Tab");
    expect(focused(presenter)).toBe("drawer:close");
    yield* send("Tab");
    expect(focused(presenter)).toBe("footer:history");
    yield* send("Tab");
    expect(focused(presenter)).toBe(first);
    yield* send("Backtab");
    yield* send("Backtab");
    yield* send("Enter");
    expect(focused(presenter)).toBe("entries:heading");
  });
});
