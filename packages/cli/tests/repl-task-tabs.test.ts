import { sleep } from "effection";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { writeTextFile } from "@effectionx/fs";
import { useReplPage } from "./support/repl-page.ts";
import type { ReplPage } from "./support/repl-page.ts";
import { composerHolds, draftText, intoComposer } from "./support/screen-journeys.ts";
import { settledReading } from "./support/mounted-history.ts";
import { awaitedFact } from "./support/mounted-repl.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import { REPL_PALETTE } from "../src/repl/presentation-style.ts";

function capture(page: ReplPage, name: string): void {
  const screen = page.repl.terminal.screen;
  if (screen === undefined) {
    throw new Error("The mounted terminal screen is absent.");
  }
  const cells = screen.cells();
  console.log(
    JSON.stringify({
      capture: name,
      size: page.screen().size,
      rows: page.screen().rows,
      cells,
      styles: cells.map((row, y) => row.map((_cell, x) => screen.styleAt(x, y))),
    }),
  );
}

for (const size of [
  { columns: 160, rows: 36 },
  { columns: 120, rows: 30 },
  { columns: 72, rows: 20 },
]) {
  describe(`TODO/QUEUE tabs at ${size.columns}x${size.rows}`, () => {
    it("switches only on human selection and retains drafts, item controls and held queue work", function* () {
      const page = yield* useReplPage({ size });
      yield* draftText(page, "kept entry");
      if (size.columns < 120) {
        yield* page.press("Sidekick", { onRow: "Sessions" });
      } else {
        yield* intoComposer(page);
      }
      const reading = yield* settledReading(page.repl);
      const file = pairedLocation(page.repl.root, reading.execution).directory + "/todo.md";
      const source = "- [x] done `code`\n- [ ] wrapped " + "label ".repeat(30) + "\n- [ ] last\n";
      yield* writeTextFile(file, source);
      yield* page.until("current tasks", (one) => one.shows("☑ done code"));
      const first = page.screen().locate("done code");
      expect(page.screen().rows[first.row]).not.toContain("↑");
      expect(page.screen().rows[first.row]).not.toContain("↓");
      expect(page.screen().locate("▾ TODO").row).toBe(page.screen().locate("QUEUE 0/16").row);
      expect(page.repl.terminal.screen?.styleAt(first.column, first.row).attrs).toContain(9);
      expect(page.repl.terminal.screen?.styleAt(first.column, first.row).background).toBe(
        REPL_PALETTE.composerSurface,
      );
      capture(page, "composer-no-task-icons");
      yield* page.key("Backtab");
      yield* page.until("task tabs focused", (one) => one.shows("> ▾ TODO"));
      yield* page.key("ArrowDown");
      yield* page.until("completed task focused", (one) => one.shows("> ☑ done code"));
      const focused = page.screen().locate("done code");
      const taskStyle = page.repl.terminal.screen?.styleAt(focused.column, focused.row);
      expect(taskStyle?.background).toBe(REPL_PALETTE.focusSurface);
      expect(taskStyle?.attrs).toContain(4);
      for (const icon of ["↑", "↓", "x"]) {
        const at = page.screen().locate(icon, { onRow: "done code" });
        expect(at.row).toBe(focused.row);
        const iconStyle = page.repl.terminal.screen?.styleAt(at.column, at.row);
        expect(iconStyle?.background).toBe(REPL_PALETTE.composerSurface);
        expect(iconStyle?.attrs).not.toContain(4);
      }
      capture(page, "completed-task-focused");
      yield* page.key("ArrowRight");
      yield* page.until("task action focused", (one) =>
        one.rows.some((row) => row.includes("☑ done code") && row.includes("> ↑")),
      );
      const action = page.screen().locate("↑", { onRow: "done code" });
      const label = page.screen().locate("done code");
      const actionStyle = page.repl.terminal.screen?.styleAt(action.column, action.row);
      expect(actionStyle?.background).toBe(REPL_PALETTE.focusSurface);
      expect(actionStyle?.attrs).toContain(4);
      const labelStyle = page.repl.terminal.screen?.styleAt(label.column, label.row);
      expect(labelStyle?.background).toBe(REPL_PALETTE.composerSurface);
      expect(labelStyle?.attrs).not.toContain(4);
      for (const icon of ["↓", "x"]) {
        const at = page.screen().locate(icon, { onRow: "done code" });
        expect(page.repl.terminal.screen?.styleAt(at.column, at.row).background).toBe(
          REPL_PALETTE.composerSurface,
        );
      }
      capture(page, "task-action-focused");
      yield* page.key("ArrowLeft");
      yield* page.until("task body focused again", (one) => one.shows("> ☑ done code"));
      yield* page.key("ArrowDown");
      yield* page.until("incomplete wrapped task focused", (one) => one.shows("> ☐ wrapped"));
      expect(
        page
          .screen()
          .rows.filter((row) => row.includes("done code"))
          .every((row) => !row.includes("↑")),
      ).toBe(true);
      capture(page, "incomplete-wrapped-focused");
      yield* page.key("ArrowUp");
      yield* page.until("completed task reading restored", (one) => one.shows("> ☑ done code"));
      yield* page.key("Tab");
      yield* page.until(
        "Message focus hides task actions",
        (one) =>
          one.shows("> › message the sidekick") &&
          !one.rows[one.locate("done code").row].includes("↑") &&
          !one.rows[one.locate("wrapped").row].includes("↑"),
      );
      capture(page, "composer-after-task-focus");

      page.repl.fake.script({ reply: "<Output>held answer</Output>", held: true });
      yield* page.type("active request");
      yield* page.press("[send]", { rightOf: "message the sidekick" });
      yield* page.repl.fake.startedTurns(1);
      for (const text of ["waiting-one", "waiting-two"]) {
        yield* page.until(
          "cleared accepted text",
          (one) => !composerHolds(one, "request") && !composerHolds(one, "waiting-"),
        );
        yield* page.type(text);
        yield* page.press("[send]", { rightOf: "message the sidekick" });
        yield* page.until("waiting count", (one) =>
          one.shows(text === "waiting-one" ? "QUEUE 1/16" : "QUEUE 2/16"),
        );
      }
      yield* page.until(
        "second accepted text cleared",
        (one) => !composerHolds(one, "waiting-two"),
      );
      yield* page.type("kept message");
      yield* page.until("newer Message painted", (one) => composerHolds(one, "kept message"));
      yield* page.key("Home");
      yield* sleep(30);
      yield* page.key("ArrowRight");
      yield* sleep(30);
      yield* page.type("X");
      yield* page.until("middle caret established", (one) => composerHolds(one, "kXept message"));
      yield* page.key("Backspace");
      yield* page.until("message retained", (one) => composerHolds(one, "kept message"));
      expect(page.screen().shows("☑ done code")).toBe(true);
      capture(page, "todo-queue-arrival");

      yield* page.press("QUEUE 2/16");
      yield* page.until(
        "queue selected",
        (one) => one.shows("waiting-one") && !one.shows("done code"),
      );
      capture(page, "queue-waiting");
      yield* page.key("ArrowDown");
      yield* page.until("pending action focused", (one) =>
        one.rows.some((row) => row.includes("waiting-one") && row.includes("> X")),
      );
      yield* writeTextFile(file, "- [ ] inserted\n" + source);
      yield* sleep(300);
      expect(page.screen().shows("inserted")).toBe(false);
      expect(
        page.screen().rows.some((row) => row.includes("waiting-one") && row.includes("> X")),
      ).toBe(true);
      expect(composerHolds(page.screen(), "kept message")).toBe(true);
      capture(page, "queue-background-task-change");
      yield* page.press("[history]");
      yield* page.until("History over held queue", (one) => one.shows("[close]"));
      yield* page.key("Escape");
      yield* page.until(
        "queue action returns from History",
        (one) =>
          !one.shows("[close]") &&
          one.rows.some((row) => row.includes("waiting-one") && row.includes("> X")),
      );
      expect(composerHolds(page.screen(), "kept message")).toBe(true);
      expect(page.repl.fake.prompts).toHaveLength(1);
      capture(page, "queue-after-history");

      yield* page.press("▾ TODO");
      yield* page.until(
        "TODO selected with refreshed source",
        (one) => one.shows("inserted") && !one.shows("waiting-one") && one.shows("> ▾ TODO"),
      );
      capture(page, "todo-after-switch");
      yield* page.key("ArrowRight");
      yield* page.until("QUEUE tab focused", (one) => one.shows("> QUEUE 2/16"));
      yield* page.key("Enter");
      yield* page.until(
        "keyboard selects queue",
        (one) => one.shows("waiting-one") && !one.shows("inserted"),
      );
      yield* page.press("[stop]", { rightOf: "message the sidekick" });
      yield* page.until("held queue", (one) => one.shows("[Resume queue]") && !one.shows("[stop]"));
      capture(page, "queue-stopped");
      yield* page.press("X", { onRow: "waiting-one" });
      yield* page.until(
        "exact queued withdrawal",
        (one) => one.shows("QUEUE 1/16") && !one.shows("waiting-one"),
      );
      page.repl.fake.script({ reply: "<Output>remaining answer</Output>" });
      yield* page.press("[Resume queue]");
      yield* page.until(
        "remaining work completes",
        (one) => one.shows("remaining answer") && one.shows("QUEUE 0/16"),
      );
      expect(page.repl.fake.prompts).toHaveLength(2);
      expect(page.repl.fake.prompts[1]).toContain("waiting-two");
      expect(page.repl.fake.prompts[1]).not.toContain("waiting-one");
      expect(composerHolds(page.screen(), "kept message")).toBe(true);
      yield* page.press("QUEUE 0/16");
      yield* page.until("empty QUEUE tab focus", (one) => one.shows("> QUEUE 0/16"));
      yield* page.key("Tab");
      yield* page.until("Message fixed entry after queue", (one) =>
        one.shows("> › message the sidekick"),
      );
      yield* page.type("X");
      yield* page.until("Message caret retained", (one) => composerHolds(one, "kXept message"));
      yield* page.key("Backspace");
      yield* page.until("Message caret edit undone", (one) => composerHolds(one, "kept message"));
      if (size.columns < 120) {
        yield* page.press("Entries");
        yield* page.until("draft survives", (one) => one.shows("kept entry"));
      } else {
        expect(page.screen().shows("kept entry")).toBe(true);
      }
      page.repl.terminal.end();
      yield* awaitedFact("tab journey joins", function* () {
        return page.repl.outcome() !== undefined;
      });
      expect(page.repl.outcome()?.ok).toBe(true);
      expect(page.repl.terminal.listeners).toBe(0);
    });
  });
}
