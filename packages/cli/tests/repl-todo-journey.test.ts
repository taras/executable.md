import { sleep } from "effection";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { useReplPage } from "./support/repl-page.ts";
import { intoComposer } from "./support/screen-journeys.ts";
import { settledReading } from "./support/mounted-history.ts";
import { awaitedFact } from "./support/mounted-repl.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import type { ReplPage } from "./support/repl-page.ts";
import { TODO_WAKE } from "../src/repl/todo/wake.ts";

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
      yield* page.until("collapsed", (one) => !one.shows("[ ] one"));
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
      yield* writeTextFile(file, source);
      yield* page.until("external task rows", (one) => one.shows("task-0"));
      expect(page.repl.fake.prompts).toHaveLength(0);
      capture(page, "overflow-wrapped");
      const header = page.screen().locate("▾ TODO");
      const composer = page.screen().locate("message the sidekick");
      const actions = page.screen().locate("Remove task");
      const bodyRows = page
        .screen()
        .rows.slice(actions.row + 1, composer.row)
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
      yield* writeTextFile(file, source.replace("task-0", "background-0"));
      const before = page.screen().index;
      yield* page.until("collapsed refresh", (one) => one.index > before);
      expect(page.screen().shows("background-0")).toBe(false);
      capture(page, "collapsed-background-change");
      yield* page.press("▸ TODO");
      yield* page.until("expanded current tasks", (one) => one.shows("background-0"));
      const timings: number[] = [];
      let navigationInputs = 0;
      for (let taskIndex = 0; taskIndex < 13; taskIndex++) {
        const expected =
          taskIndex === 12
            ? "> [ ] <Sidekick.Todo>"
            : `> [${taskIndex === 0 ? "x" : " "}] ${taskIndex === 0 ? "background-0" : `task-${taskIndex}`}`;
        for (
          let attempt = 0;
          attempt < (taskIndex === 0 ? 10 : 1) && !page.screen().shows(expected);
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
              one.shows(expected) ||
              (taskIndex === 0 &&
                one.rows.filter((row) => row.includes("> ")).join("\n") !== previousFocus),
          );
          timings.push(performance.now() - start);
        }
        yield* page.until(`focus on task ${taskIndex}`, (one) => one.shows(expected));
        if (taskIndex === 0) {
          capture(page, "completed-focus");
        }
      }
      const taskText = page
        .screen()
        .rows.slice(
          page.screen().locate("Remove task").row + 1,
          page.screen().locate("message the sidekick").row,
        )
        .map((row) =>
          row.slice(Math.max(0, page.screen().locate("message the sidekick").column - 4)).trim(),
        )
        .join("");
      expect(taskText).toContain("{inert}");
      expect(taskText).toContain("\\u{1b}");
      const focusedLast = page.screen().locate("<Sidekick.Todo>");
      yield* page.wheel("up", focusedLast);
      yield* page.until("wheel retains focused task", (one) => one.shows("> [ ] <Sidekick.Todo>"));
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
        yield* page.resize(resized);
        yield* page.until("focused task survives resize", (one) =>
          one.shows("> [ ] <Sidekick.Todo>"),
        );
        resizeTimings.push(performance.now() - started);
      }
      const changed = source.replace("task-0", "background-0").replace("task-1 ", "background-1 ");
      const beforeRefresh = page.screen().index;
      yield* writeTextFile(file, changed);
      yield* page.until(
        "background refresh leaves focus",
        (one) => one.index > beforeRefresh && one.shows("> [ ] <Sidekick.Todo>"),
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
    yield* page.until("rich task", (one) => one.shows("[ ] rich code label"));
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
    yield* page.until("renamed task", (one) => one.shows("[ ] renamed rich code label"));
    inputCount++;
    yield* page.press("▾ TODO");
    yield* page.until("collapsed before task navigation", (one) => one.shows("▸ TODO"));
    inputCount++;
    yield* page.press("▸ TODO");
    yield* page.until("expanded for keyboard", (one) => one.shows("[ ] renamed rich code label"));
    for (
      let attempt = 0;
      attempt < 10 && !page.screen().shows("> [ ] renamed rich code label");
      attempt++
    ) {
      const before = page.screen().index;
      inputCount++;
      yield* page.key("ArrowDown");
      yield* sleep(30);
      yield* page.until("task focus write", (one) => one.index > before);
    }
    yield* page.until("task focused", (one) => one.shows("> [ ] renamed rich code label"));
    const extent = page.screen().locate("renamed rich code label");
    inputCount++;
    yield* page.type(" ");
    yield* page.until("completed task", (one) => one.shows("> [x] renamed rich code label"));
    expect(page.screen().locate("renamed rich code label")).toEqual(extent);
    inputCount++;
    yield* page.type(" ");
    yield* page.until("reopened task", (one) => one.shows("> [ ] renamed rich code label"));
    inputCount++;
    yield* page.press("Move down");
    yield* page.until(
      "move committed",
      (one) => one.shows("[ ] duplicate") && !one.shows("> [ ] renamed"),
    );
    yield* awaitedFact("physical move", function* () {
      return (yield* readTextFile(file)).startsWith("- [ ] duplicate\n");
    });
    inputCount++;
    yield* page.press("Remove task");
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
    yield* page.until("expand after remove", (one) => one.shows("[ ] duplicate"));
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
