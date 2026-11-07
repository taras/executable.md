import { sleep } from "effection";
import type { Operation } from "effection";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { useReplPage } from "./support/repl-page.ts";
import { intoComposer, sidekickIdle } from "./support/screen-journeys.ts";
import { settledReading } from "./support/mounted-history.ts";
import { awaitedFact } from "./support/mounted-repl.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import type { ReplPage, ScreenReading } from "./support/repl-page.ts";
import { TODO_WAKE } from "../src/repl/todo/wake.ts";

/**
 * Whether the inert last task is the focused one, by its own row and rows.
 *
 * Scoped to that task rather than to any focus marker: the marker has to sit on
 * the row that begins this task, and the row carrying its text has to belong to
 * the same task. At a narrow width the label wraps, so the text arrives on a
 * continuation row — which is why the marker row and the text row may differ
 * while still being one task. No checkbox may appear between them, because a
 * checkbox is where the next task begins: another task's marker therefore
 * cannot stand in for this one.
 *
 * `glyph` is the checkbox this task is expected to be drawn with, because an
 * outside edit may complete it without changing which task it is.
 */
function inertFocused(one: ScreenReading, glyph: "☐" | "☑" = "☐"): boolean {
  const marker = one.rows.findIndex((row) => row.includes(`> ${glyph}`));
  const text = one.rows.findIndex((row) => row.includes("<Sidekick.Tod"));
  if (marker < 0 || text < marker) {
    return false;
  }
  return !one.rows.slice(marker + 1, text + 1).some((row) => /[☐☑]/.test(row));
}

/** Whether this task's own continuation rows still carry its escaped text. */
function inertTextBelowFocus(one: ScreenReading): boolean {
  const marker = one.rows.findIndex((row) => /> [☐☑]/.test(row));
  if (marker < 0) {
    return false;
  }
  const own = one.rows.slice(marker).join("\n");
  const next = one.rows.slice(marker + 1).findIndex((row) => /[☐☑]/.test(row));
  const mine = next < 0 ? own : one.rows.slice(marker, marker + 1 + next).join("\n");
  return mine.includes("<Sidekick.Tod") && mine.includes("{inert}") && mine.includes("\\u{1b}");
}

/**
 * The cell this task's own checkbox is drawn in, and the glyph it holds.
 *
 * Found from the row carrying this task's text rather than from the focus cue,
 * so it is the same answer whether this task holds focus or not: a task's own
 * row is the last one at or above its text that begins a task. Nothing but the
 * two-cell cue and spaces is drawn before the checkbox, so its offset in the
 * row is the column it was drawn in.
 */
function inertCheckbox(
  one: ScreenReading,
): { readonly column: number; readonly row: number; readonly glyph: string } | undefined {
  const text = one.rows.findIndex((row) => row.includes("<Sidekick.Tod"));
  if (text < 0) {
    return undefined;
  }
  for (let row = text; row >= 0; row -= 1) {
    const found = /[☐☑]/.exec(one.rows[row]);
    if (found !== null) {
      return { column: found.index, row, glyph: found[0] };
    }
  }
  return undefined;
}

/**
 * What one reading says about this task's focus, from both sides of the commit.
 *
 * Two facts, and they come from opposite sides of one frame. The `> ` cue is
 * written from `view.focused`, which the frame was *built* from, so on its own
 * it is a frame behind — the loop presents, then reads the committed tree's
 * focus, and only then draws again if it has moved. The decoration is the
 * frame's own answer: `commitReplFrame` draws with `tree.focused()` after the
 * reconcile, so a row whose node holds focus has its runs drawn bold and one
 * that does not has a completed row drawn dim.
 *
 * `"settled"` is both agreeing on this task: the view the frame was built from
 * already named the control the committed tree holds focus on, so that pass had
 * nothing to correct and drew no second frame. `"moved"` is both agreeing the
 * other way — no cue on this task, and its row drawn as a row that does not
 * hold focus — which is an answer rather than an unfinished stage. Anything
 * else is a pass still in flight and is not accepted either way.
 *
 * The decoration is read from the emulator rather than from the reading, which
 * is sound because a page hands a predicate only its latest reading and the
 * emulator holds exactly the cells that write left.
 */
function inertFocusAnswer(
  page: ReplPage,
  one: ScreenReading,
  glyph: "☐" | "☑",
): "settled" | "moved" | "in-flight" {
  const screen = page.repl.terminal.screen;
  if (screen === undefined) {
    throw new Error("The terminal emulator is absent.");
  }
  const checkbox = inertCheckbox(one);
  if (one.index !== page.screen().index || checkbox === undefined || checkbox.glyph !== glyph) {
    return "in-flight";
  }
  const attrs = screen.styleAt(checkbox.column, checkbox.row).attrs;
  const cued = one.rows[checkbox.row].includes(`> ${glyph}`);
  if (cued && attrs.includes(1)) {
    return "settled";
  }
  // Dim is the decoration a completed row that does not hold focus is drawn
  // with, so this half is only an answer once the task is completed. Before
  // that, an unfocused row is drawn with nothing to tell it apart.
  return !cued && glyph === "☑" && attrs.includes(2) ? "moved" : "in-flight";
}

/** Whether this task's own local controls are drawn on its row. */
function inertActions(one: ScreenReading): boolean {
  const checkbox = inertCheckbox(one);
  if (checkbox === undefined) {
    return false;
  }
  const row = one.rows[checkbox.row];
  return row.includes("↑") && row.includes("↓") && row.includes("x");
}

/**
 * Replace todo.md the way an outside change actually replaces it.
 *
 * Through a sibling and a rename, which is what this product's own Files
 * boundary does and what an editor does. A writer that truncated the file in
 * place and refilled it would leave it momentarily empty or cut off mid-line,
 * and a reader polling it would then see a checklist this file was never
 * supposed to hold — a task that is gone is gone, so the row goes with it and
 * focus goes to its survivor. That is a different stimulus from the one the
 * checklist promises to survive, and asserting against it would be asserting
 * that a task outlives its own removal.
 */
function* replaceOutside(file: string, text: string): Operation<void> {
  const staging = `${file}.outside`;
  yield* writeTextFile(staging, text);
  yield* API.Fs.operations.rename(staging, file);
}

function capture(page: ReplPage, name: string, timings: readonly number[] = []) {
  const screen = page.repl.terminal.screen;
  const size = page.screen().size;
  if (screen === undefined) {
    throw new Error("The terminal emulator is absent.");
  }
  const cells = screen.cells();
  const styles = cells.map((row, y) => row.map((_cell, x) => screen.styleAt(x, y)));
  console.log(
    JSON.stringify({
      capture: name,
      size,
      rows: page.screen().rows,
      cells,
      styles,
      timingsMs: timings,
      timingBoundary: "input to completed terminal write; not physical paint",
    }),
  );
}

for (const size of [
  { columns: 160, rows: 36 },
  { columns: 120, rows: 30 },
  { columns: 72, rows: 20 },
]) {
  describe(`Shared TODO terminal at ${size.columns}x${size.rows}`, () => {
    it("creates a shared task, wakes honestly without changing the composer, and collapses persistently", function* () {
      const page = yield* useReplPage({ size });
      if (size.columns < 120) {
        yield* page.press("Sidekick");
      } else {
        yield* intoComposer(page);
      }
      yield* page.until("TODO header", (one) => one.shows("TODO"));
      capture(page, "empty");
      page.repl.fake.script({ reply: "<Output>Reviewed task.</Output>" });
      yield* page.press("+", { onRow: "▾ TODO" });
      yield* page.until("task editor", (one) => one.shows("Task:"));
      const start = performance.now();
      yield* page.type("**one** `code` [label](https://example.com)");
      yield* page.key("Enter");
      yield* page.until(
        "committed task and answer",
        (one) => one.shows("one") && one.shows("Reviewed task."),
      );
      yield* page.until("task review joins", sidekickIdle);
      capture(page, "short", [performance.now() - start]);
      expect(page.repl.fake.prompts).toHaveLength(1);
      expect(page.repl.fake.prompts[0]).toContain(TODO_WAKE);
      const reading = yield* settledReading(page.repl);
      const message = reading.chat.find((one) => one.kind === "message");
      expect(message?.kind === "message" && message.origin).toEqual({ kind: "todo" });
      const document = pairedLocation(page.repl.root, reading.execution).directory + "/todo.md";
      expect(yield* readTextFile(document)).toBe(
        "- [ ] **one** `code` [label](https://example.com)\n",
      );
      yield* page.press("▾ TODO");
      yield* page.until("collapsed", (one) => !one.shows("☐ one"));
      capture(page, "collapsed");
      expect(page.screen().shows("Remove task")).toBe(false);
      yield* page.press("+", { onRow: "▸ TODO" });
      yield* page.until(
        "creation expands checklist",
        (one) => one.shows("▾ TODO") && one.shows("Task:"),
      );
      yield* page.key("Escape");
      yield* page.until("creation cancelled", (one) => !one.shows("Task:"));
      expect(yield* readTextFile(document)).toBe(
        "- [ ] **one** `code` [label](https://example.com)\n",
      );
      expect(page.repl.fake.prompts).toHaveLength(1);
      page.repl.terminal.end();
      yield* awaitedFact("joined command cleanup", function* () {
        return page.repl.outcome() !== undefined;
      });
      expect(page.repl.outcome()?.ok).toBe(true);
    });

    it("bounds wrapped rows and preserves keyboard access, collapse and external refresh", function* () {
      const page = yield* useReplPage({ size });
      if (size.columns < 120) {
        yield* page.press("Sidekick");
      } else {
        yield* intoComposer(page);
      }
      yield* page.until("TODO header", (one) => one.shows("TODO"));
      const read = yield* settledReading(page.repl);
      const file = pairedLocation(page.repl.root, read.execution).directory + "/todo.md";
      const source =
        Array.from(
          { length: 12 },
          (_, index) =>
            `- [${index === 0 ? "x" : " "}] task-${index} ${"wrapped label ".repeat(6)}`,
        ).join("\n") + "\n- [ ] <Sidekick.Todo> {inert} \u001b[31m\n";
      yield* replaceOutside(file, source);
      yield* page.until("external task rows", (one) => one.shows("task-0"));
      expect(page.repl.fake.prompts).toHaveLength(0);
      capture(page, "overflow-wrapped");
      const header = page.screen().locate("▾ TODO");
      const composer = page.screen().locate("message the sidekick");
      const actions = page.screen().locate("task-0");
      const bodyRows = page
        .screen()
        .rows.slice(actions.row, composer.row)
        .filter((row) => row.slice(header.column).trim().length > 0);
      expect(bodyRows.length).toBeLessThanOrEqual(
        size.columns >= 160 ? 8 : size.columns >= 120 ? 6 : 3,
      );
      const task = page.screen().locate("task-0");
      expect(page.repl.terminal.screen?.styleAt(task.column, task.row).attrs).toContain(9);
      yield* page.press("task-0");
      yield* page.until("editing preserves source", (one) => one.shows("Task:"));
      yield* page.key("Escape");
      yield* page.until("editor cancelled", (one) => !one.shows("Task:"));
      yield* page.press("▾ TODO");
      yield* page.until("collapsed", (one) => !one.shows("task-0"));
      yield* replaceOutside(file, source.replace("task-0", "background-0"));
      const before = page.screen().index;
      yield* page.until("collapsed refresh", (one) => one.index > before);
      expect(page.screen().shows("background-0")).toBe(false);
      capture(page, "collapsed-background-change");
      yield* page.press("▸ TODO");
      yield* page.until("expanded current tasks", (one) => one.shows("background-0"));
      yield* page.until("expanded header owns focus", (one) => one.shows("> ▾ TODO"));
      const timings: number[] = [];
      let navigationInputs = 0;
      for (let taskIndex = 0; taskIndex < 13; taskIndex++) {
        const expected =
          taskIndex === 0
            ? "> ☑"
            : taskIndex === 12
              ? "> ☐ <Sidekick.Todo>"
              : `> ☐ task-${taskIndex}`;
        const matches =
          taskIndex === 12 ? inertFocused : (one: ScreenReading) => one.shows(expected);
        for (
          let attempt = 0;
          attempt < (taskIndex === 0 ? 10 : 1) && !matches(page.screen());
          attempt++
        ) {
          const previousFocus = page
            .screen()
            .rows.filter((row) => row.includes("> "))
            .join("\n");
          const start = performance.now();
          navigationInputs++;
          yield* page.key("ArrowDown");
          yield* page.until(
            "keyboard focus write",
            (one) =>
              matches(one) ||
              (taskIndex === 0 &&
                one.rows.filter((row) => row.includes("> ")).join("\n") !== previousFocus),
          );
          timings.push(performance.now() - start);
        }
        yield* page.until(`focus on task ${taskIndex}`, (one) => matches(one));
        if (taskIndex === 0) {
          capture(page, "completed-focus");
        }
      }
      const taskText = page
        .screen()
        .rows.slice(
          page.screen().locate("▾ TODO").row + 1,
          page.screen().locate("message the sidekick").row,
        )
        .map((row) =>
          row.slice(Math.max(0, page.screen().locate("message the sidekick").column - 4)).trim(),
        )
        .join("");
      expect(taskText).toContain("{inert}");
      expect(taskText).toContain("\\u{1b}");
      const focusedLast = page.screen().locate("<Sidekick.Tod");
      yield* page.wheel("up", focusedLast);
      yield* page.until("wheel retains focused task", (one) => inertFocused(one));
      const resizeTimings: number[] = [];
      for (const resized of [
        { columns: 160, rows: 36 },
        { columns: 120, rows: 30 },
        { columns: 72, rows: 20 },
        size,
      ]) {
        if (
          resized.columns === page.screen().size.columns &&
          resized.rows === page.screen().size.rows
        ) {
          continue;
        }
        const started = performance.now();
        // A drag rather than one step, because a window being dragged outruns
        // the frame being prepared for it: every read answers with the size
        // that was there and leaves a different one behind. Draining those
        // reads says the drag is over and nothing more — the frame that saw the
        // last of them may still be on its way, and a presentation already
        // carrying the new geometry can be the first half of a pass whose focus
        // has yet to settle. So the drain only says no further size is owed.
        // What is accepted is a committed frame at this geometry whose own
        // answer and whose view agree that this task holds focus, with its
        // local controls drawn and its continuation rows carrying its text.
        page.repl.terminal.churnSize(12, resized);
        page.repl.terminal.resized(resized);
        yield* awaitedFact(`the drag to ${resized.columns}x${resized.rows} draining`, function* () {
          return page.repl.terminal.churning() === 0;
        });
        yield* page.until(
          `the settled pass at ${resized.columns}x${resized.rows} still focuses this task`,
          (one) =>
            one.size.columns === resized.columns &&
            one.size.rows === resized.rows &&
            inertFocusAnswer(page, one, "☐") === "settled" &&
            inertFocused(one) &&
            inertTextBelowFocus(one) &&
            inertActions(one),
        );
        resizeTimings.push(performance.now() - started);
      }
      // The baseline this refresh is measured against, asserted rather than
      // assumed: the last completed pass settled with this task holding focus,
      // its local controls are drawn and its escaped text is on screen.
      expect(inertFocusAnswer(page, page.screen(), "☐")).toBe("settled");
      expect(inertFocused(page.screen())).toBe(true);
      expect(inertTextBelowFocus(page.screen())).toBe(true);
      expect(inertActions(page.screen())).toBe(true);
      // Not yet completed, so the observation below is a state this screen does
      // not already satisfy: waiting for it cannot pass on the baseline.
      expect(inertFocused(page.screen(), "☑")).toBe(false);
      expect(inertFocusAnswer(page, page.screen(), "☑")).toBe("in-flight");
      // The outside edit completes this same task as well as renaming two
      // offscreen ones. Its text and occurrence are unchanged, so its semantic
      // key is unchanged and it must stay the focused task — while the checkbox
      // it is drawn with changes, which is what makes adoption observable at
      // every profile. The renamed tasks are offscreen under these caps, so a
      // further write or rereading the file would say nothing about adoption.
      const changed = source
        .replace("task-0", "background-0")
        .replace("task-1 ", "background-1 ")
        .replace("- [ ] <Sidekick.Todo>", "- [x] <Sidekick.Todo>");
      yield* replaceOutside(file, changed);
      // The first pass that settles after the change has to be one that still
      // focuses this task. A pass settling the other way is an answer too, and
      // it is this observation's failure rather than its deadline: the reading
      // that carries it is reported where it happened, because what a drop
      // needs is the transition it happened on.
      yield* page.until(
        "the first settled pass after the adopted change still focuses this task",
        (one) => {
          if (inertFocusAnswer(page, one, "☑") === "moved") {
            throw new Error(
              `a settled pass adopted the change and moved focus off this task. ${page.describe()}`,
            );
          }
          return (
            inertFocusAnswer(page, one, "☑") === "settled" &&
            inertFocused(one, "☑") &&
            inertTextBelowFocus(one) &&
            inertActions(one)
          );
        },
      );
      console.log(
        JSON.stringify({
          profile: "wrapped-navigation",
          size,
          tasks: 13,
          navigationInputs,
          navigationTimingsMs: timings,
          resizeTimingsMs: resizeTimings,
          backgroundMutation: true,
          timingBoundary: "input to completed terminal write; not physical paint",
        }),
      );
      const visibleRows = (one: ScreenReading) =>
        one.rows
          .slice(
            one.locate("message the sidekick").row -
              (one.size.columns >= 160 ? 8 : one.size.columns >= 120 ? 6 : 3),
            one.locate("message the sidekick").row,
          )
          .map((row) =>
            row
              .replace(/> (?=[☐☑])/, "  ")
              .replace(/ {2,}[↑↓x >]+(?=\s*$)/, "")
              .trimEnd(),
          );
      const beforeSwitch = visibleRows(page.screen());
      yield* page.press("QUEUE");
      yield* page.until("queue hides checklist", (one) => !one.shows("<Sidekick.Tod"));
      yield* page.press("▾ TODO");
      yield* page.until(
        "checklist reading restored",
        (one) => one.shows("<Sidekick.Tod") && one.shows("> ▾ TODO"),
      );
      expect(visibleRows(page.screen())).toEqual(beforeSwitch);
      yield* page.key("Tab");
      yield* page.until("Message fixed entry", (one) => one.shows("> › message the sidekick"));
      yield* page.key("Backtab");
      yield* page.until("TODO reverse fixed entry", (one) => one.shows("> ▾ TODO"));
      capture(page, "keyboard-navigation", timings);
      expect(yield* readTextFile(file)).toBe(changed);
      expect(page.repl.fake.prompts).toHaveLength(0);
      page.repl.terminal.end();
      yield* awaitedFact("overflow command cleanup joined", function* () {
        return page.repl.outcome() !== undefined;
      });
      expect(page.repl.terminal.listeners).toBe(0);
      expect(page.repl.terminal.readers).toBe(0);
    });
  });
}

describe("TODO human semantic actions", () => {
  it("adds, renames, completes, reopens, reorders and removes through mounted controls", function* () {
    const page = yield* useReplPage();
    let inputCount = 0;
    yield* intoComposer(page);
    page.repl.fake.script({ reply: "<Output>review complete</Output>", held: true });
    inputCount++;
    yield* page.press("+", { onRow: "▾ TODO" });
    yield* page.until("new task editor", (one) => one.shows("Task:"));
    inputCount++;
    yield* page.type("**rich** `code` [label](https://example.com)");
    inputCount++;
    yield* page.key("Enter");
    yield* sleep(30);
    yield* page.repl.fake.startedTurns(1);
    yield* page.until("rich task", (one) => one.shows("☐ rich code label"));
    const read = yield* settledReading(page.repl);
    const file = pairedLocation(page.repl.root, read.execution).directory + "/todo.md";
    const timings: number[] = [];
    const inputs = ["duplicate", "duplicate"];
    for (const text of inputs) {
      const start = performance.now();
      inputCount++;
      yield* page.press("+", { onRow: "▾ TODO" });
      yield* page.until("append editor", (one) => one.shows("Task:"));
      inputCount++;
      yield* page.type(text);
      inputCount++;
      yield* page.key("Enter");
      yield* sleep(30);
      yield* page.until("append committed", (one) => !one.shows("Task:"));
      timings.push(performance.now() - start);
    }
    expect(yield* readTextFile(file)).toBe(
      "- [ ] **rich** `code` [label](https://example.com)\n- [ ] duplicate\n- [ ] duplicate\n",
    );
    inputCount++;
    yield* page.press("rich code label");
    yield* page.until("rename editor", (one) => one.shows("Task:"));
    inputCount++;
    yield* page.key("Home");
    yield* sleep(30);
    inputCount++;
    yield* page.key("ArrowUp");
    yield* sleep(30);
    inputCount++;
    yield* page.key("Home");
    yield* sleep(30);
    inputCount++;
    yield* page.type("renamed ");
    yield* page.resize({ columns: 120, rows: 30 });
    inputCount++;
    yield* page.press("[configure scribe]");
    yield* page.until("Configure covers task editor", (one) => one.shows("Agent:"));
    inputCount++;
    yield* page.press("[close]");
    yield* page.until("task editor returns", (one) => one.shows("Task:") && !one.shows("Agent:"));
    inputCount++;
    yield* page.key("Tab");
    yield* sleep(30);
    yield* sleep(30);
    inputCount++;
    yield* page.key("Tab");
    yield* sleep(30);
    yield* page.until("TODO after modal", (one) => one.shows("> ▾ TODO"));
    for (let at = 0; at < 10 && !page.screen().shows("> Task:"); at++) {
      const before = page.screen().index;
      inputCount++;
      yield* page.key("ArrowDown");
      yield* sleep(30);
      yield* page.until("editor navigation write", (one) => one.index > before);
      yield* sleep(30);
    }
    yield* page.until("task editor focus returns", (one) => one.shows("> Task:"));
    inputCount++;
    yield* page.type("X");
    inputCount++;
    yield* page.key("Backspace");
    yield* sleep(30);
    yield* page.resize({ columns: 160, rows: 36 });
    inputCount++;
    yield* page.key("Enter");
    yield* sleep(30);
    yield* page.until("renamed task", (one) => one.shows("☐ renamed rich code label"));
    inputCount++;
    yield* page.press("▾ TODO");
    yield* page.until("collapsed before task navigation", (one) => one.shows("▸ TODO"));
    inputCount++;
    yield* page.press("▸ TODO");
    yield* page.until("expanded for keyboard", (one) => one.shows("☐ renamed rich code label"));
    for (
      let attempt = 0;
      attempt < 10 && !page.screen().shows("> ☐ renamed rich code label");
      attempt++
    ) {
      const before = page.screen().index;
      inputCount++;
      yield* page.key("ArrowDown");
      yield* sleep(30);
      yield* page.until("task focus write", (one) => one.index > before);
    }
    yield* page.until("task focused", (one) => one.shows("> ☐ renamed rich code label"));
    const extent = page.screen().locate("renamed rich code label");
    inputCount++;
    yield* page.type(" ");
    yield* page.until("completed task", (one) => one.shows("> ☑ renamed rich code label"));
    expect(page.screen().locate("renamed rich code label")).toEqual(extent);
    inputCount++;
    yield* page.type(" ");
    yield* page.until("reopened task", (one) => one.shows("> ☐ renamed rich code label"));
    inputCount++;
    yield* page.press("↓", { onRow: "renamed rich code label" });
    yield* page.until(
      "move committed",
      (one) =>
        one.shows("> ☐ renamed rich code label") &&
        one.rows.findIndex((row) => row.includes("☐ duplicate")) <
          one.rows.findIndex((row) => row.includes("> ☐ renamed rich code label")),
    );
    yield* awaitedFact("physical move", function* () {
      return (yield* readTextFile(file)).startsWith("- [ ] duplicate\n");
    });
    inputCount++;
    yield* page.press("x", { onRow: "renamed rich code label" });
    yield* page.until(
      "removed selected moved task",
      (one) => !one.shows("renamed rich code label"),
    );
    expect(yield* readTextFile(file)).toBe("- [ ] duplicate\n- [ ] duplicate\n");
    expect(page.repl.fake.prompts).toHaveLength(1);
    inputCount++;
    yield* page.press("▾ TODO");
    yield* page.until("collapse after remove", (one) => one.shows("▸ TODO"));
    inputCount++;
    yield* page.press("▸ TODO");
    yield* page.until("expand after remove", (one) => one.shows("☐ duplicate"));
    for (let at = 0; at < 10 && !page.screen().shows("Task:"); at++) {
      const before = page.screen().index;
      inputCount++;
      yield* page.key("ArrowDown");
      yield* sleep(30);
      yield* page.until("Down-from-last write", (one) => one.index > before);
      yield* sleep(30);
    }
    yield* page.until("Down-from-last creates editor", (one) => one.shows("Task:"));
    inputCount++;
    yield* page.key("Escape");
    yield* sleep(30);
    yield* page.until("creation cancelled", (one) => !one.shows("Task:"));
    expect(yield* readTextFile(file)).toBe("- [ ] duplicate\n- [ ] duplicate\n");
    capture(page, "human-editing", timings);
    console.log(
      JSON.stringify({
        profile: "human-editing",
        size: page.screen().size,
        startingTasks: 0,
        finalTasks: 2,
        duplicateLabels: true,
        inputCount,
        appendGestureTimingsMs: timings,
        timingBoundary: "append gesture through completed terminal write; not physical paint",
      }),
    );
    page.repl.fake.releaseTurn();
    yield* page.until("held review complete", (one) => one.shows("review complete"));
    expect(page.repl.fake.prompts).toHaveLength(1);
    page.repl.terminal.end();
    yield* awaitedFact("editing cleanup joined", function* () {
      return page.repl.outcome() !== undefined;
    });
  });
});

describe("TODO background task focus", () => {
  it("keeps the surviving target and its local actions after an external prepend", function* () {
    const page = yield* useReplPage();
    yield* intoComposer(page);
    const read = yield* settledReading(page.repl);
    const file = pairedLocation(page.repl.root, read.execution).directory + "/todo.md";
    const source = "- [ ] first\n- [ ] target\n- [ ] last\n";
    yield* replaceOutside(file, source);
    yield* page.until("initial tasks", (one) => one.shows("☐ target"));
    yield* page.key("Backtab");
    yield* page.until("TODO header focus", (one) => one.shows("> ▾ TODO"));
    for (let attempt = 0; attempt < 10 && !page.screen().shows("> ☐ target"); attempt++) {
      const before = page
        .screen()
        .rows.filter((row) => row.includes("> "))
        .join("\n");
      yield* page.key("ArrowDown");
      yield* page.until(
        "task focus advances",
        (one) => one.rows.filter((row) => row.includes("> ")).join("\n") !== before,
      );
    }
    yield* page.until("target focused", (one) => one.shows("> ☐ target"));
    for (const icon of ["↑", "↓", "x"]) {
      yield* page.key("ArrowRight");
      yield* page.until("target local action focused", (one) =>
        one.rows.some((row) => row.includes("☐ target") && row.includes(`> ${icon}`)),
      );
    }
    console.log(JSON.stringify({ correctionCapture: "before-prepend", rows: page.screen().rows }));
    yield* replaceOutside(file, "- [ ] inserted-before\n" + source);
    yield* page.until("real outside refresh", (one) => one.shows("☐ inserted-before"));
    expect(page.screen().rows.some((row) => row.includes("☐ target") && row.includes("> x"))).toBe(
      true,
    );
    expect(page.repl.fake.prompts).toHaveLength(0);
    console.log(JSON.stringify({ correctionCapture: "after-prepend", rows: page.screen().rows }));
    for (const size of [
      { columns: 120, rows: 30 },
      { columns: 72, rows: 20 },
      { columns: 160, rows: 36 },
    ]) {
      yield* page.resize(size);
      yield* page.until("task action survives resize", (one) =>
        one.rows.some((row) => row.includes("☐ target") && row.includes("> x")),
      );
    }
    page.repl.fake.script({ reply: "<Output>reviewed removal</Output>" });
    yield* page.key("Enter");
    yield* awaitedFact("local action removes target", function* () {
      return (yield* readTextFile(file)) === "- [ ] inserted-before\n- [ ] first\n- [ ] last\n";
    });
    yield* page.until("human removal wake joined", (one) => one.shows("reviewed removal"));
    page.repl.terminal.end();
    yield* awaitedFact("background focus command joined", function* () {
      return page.repl.outcome() !== undefined;
    });
    expect(page.repl.outcome()?.ok).toBe(true);
  });
});
