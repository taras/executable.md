import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { journalBeforeEach } from "@executablemd/test-support/failure-journal";
import { expect } from "@executablemd/test-support/expect";
import { sleep, scoped } from "effection";
import { useReplPage } from "./support/repl-page.ts";
import { generateTypingHistory } from "./support/typing-history.ts";
import { intoDraft } from "./support/screen-journeys.ts";

import { awaited } from "./support/mounted-repl.ts";
import { decodeLocation } from "../src/repl/route.ts";

const OWNER = "packages/cli/tests/repl-history-rounds.test.ts";
describe("History round controls", () => {
  beforeEach(journalBeforeEach(OWNER));
  for (const size of [
    { columns: 160, rows: 36 },
    { columns: 72, rows: 20 },
  ]) {
    it(`selects both retained positions by pointer and keyboard at ${size.columns}`, function* () {
      const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
      yield* generateTypingHistory(page, 3, 1);
      if (size.columns === 72) {
        yield* page.resize(size);
      }
      for (const method of ["pointer", "keyboard"]) {
        for (const destination of ["Input", "Output"]) {
          yield* page.press("[History]");
          yield* page.until(
            "round controls",
            (one) => one.shows("Round 3:") && one.shows("[Output]"),
          );
          const input = page.screen().locate("[Input]", { onRow: "Round 3:" });
          const output = page.screen().locate("[Output]", { onRow: "Round 3:" });
          expect(input.row).toBe(output.row);
          if (size.columns === 160) {
            expect(input.row).toBeLessThan(page.screen().locate("Round 2:").row);
          }
          if (method === "pointer") {
            yield* page.press(`[${destination}]`, { onRow: "Round 3:" });
          } else {
            yield* page.until("Input focus", (one) =>
              one.rows.some((row) => row.includes("Round 3:") && row.includes("> [Input]")),
            );
            if (destination === "Output") {
              yield* page.key("ArrowRight");
              yield* page.until("Output focus", (one) => one.shows("> [Output]"));
            }
            yield* page.key("Enter");
          }
          yield* page.until(
            "selected retained position",
            (one) =>
              one.shows("[live]") &&
              one.shows(destination === "Input" ? "UNFINISHED" : "COMPLETED"),
          );
          yield* page.key("Escape");
          yield* page.until("launcher restored", (one) => one.shows("> [History]"));
          yield* page.press("[live]");
          yield* page.until("live restored", (one) => !one.shows("[live]"));
          yield* sleep(30);
        }
      }
    });
  }
  it("reaches an offscreen round and both positions by keyboard at narrow width", function* () {
    const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
    yield* generateTypingHistory(page, 20, 1);
    yield* page.resize({ columns: 72, rows: 20 });
    for (const destination of ["Input", "Output"]) {
      yield* page.press("[History]");
      yield* page.until("round drawer ready", (one) => one.shows("[Positions]"));
      yield* page.key("Home");
      yield* page.until("newest round focused", (one) =>
        one.rows.some((row) => row.includes("Round 20:") && row.includes("> [Input]")),
      );
      expect(page.screen().shows("Round 1:")).toBe(false);
      yield* page.key("End");
      yield* page.until("oldest round focused", (one) =>
        one.rows.some((row) => row.includes("Round 1:") && row.includes("> [Input]")),
      );
      if (destination === "Output") {
        yield* page.key("ArrowRight");
        yield* page.until("oldest Output focused", (one) =>
          one.rows.some((row) => row.includes("Round 1:") && row.includes("> [Output]")),
        );
      }
      yield* page.key("Enter");
      yield* page.until(
        "oldest position selected",
        (one) =>
          one.shows("[live]") && one.shows(destination === "Input" ? "UNFINISHED" : "COMPLETED"),
      );
      yield* page.key("Escape");
      yield* page.until("oldest drawer dismissed", (one) => one.shows("> [History]"));
      yield* page.press("[live]");
      yield* page.until("oldest selection returned live", (one) => !one.shows("[live]"));
    }
  });
  it("keeps the retained admission and outcome marker identities", function* () {
    for (const destination of ["Input", "Output"]) {
      yield* scoped(function* () {
        const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
        const retained = yield* generateTypingHistory(page, 2, 1);
        const markers = retained.model.checkpoints.map((one) => one.marker);
        const expected = destination === "Input" ? markers.at(-2) : markers.at(-1);
        yield* page.press("[History]");
        yield* page.until("identity round row", (one) => one.shows("Round 2:"));
        if (destination === "Input") {
          yield* page.press("[Input]", { onRow: "Round 2:" });
        } else {
          yield* page.until("identity Input focus", (one) =>
            one.rows.some((row) => row.includes("Round 2:") && row.includes("> [Input]")),
          );
          yield* page.key("ArrowRight");
          yield* page.until("identity Output focus", (one) => one.shows("> [Output]"));
          yield* page.key("Enter");
        }
        yield* page.until("identity selected", (one) => one.shows("[live]"));
        page.repl.terminal.end();
        yield* awaited("identity command ends", () => page.repl.outcome() !== undefined);
        const result = page.repl.outcome();
        if (result === undefined || !result.ok) {
          throw new Error("identity command failed");
        }
        const route = decodeLocation(result.value.location);
        if (!route.ok) {
          throw route.error;
        }
        expect(route.value.at).toBe(expected);
        expect(retained.model.checkpoints.map((one) => one.marker)).toEqual(markers);
      });
    }
  });
  it("omits Output while the latest admitted round waits for an answer", function* () {
    const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
    yield* generateTypingHistory(page, 2, 1);
    yield* intoDraft(page);
    yield* page.type(
      '```js eval\nconst retained = 1;\n```\n<Elicit as="answer" schema={{ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }}>Pending round</Elicit>',
    );
    yield* page.until("pending source", (one) => one.shows("</Elicit>"));
    yield* page.press("Send", { onRow: "✎ draft" });
    yield* page.until("round waits", (one) => one.shows("[answer]"));
    yield* page.press("[History]");
    yield* page.until("pending round row", (one) => one.shows("Round 3:"));
    expect(page.screen().found("[Output]", { onRow: "Round 3:" })).toBe(0);
    expect(page.screen().found("[Output]", { onRow: "Round 2:" })).toBe(1);
    yield* page.press("[Positions]");
    yield* page.until(
      "intermediate positions",
      (one) => one.shows("Bindings recorded") && one.shows("[Rounds]"),
    );
    yield* page.press("[Rounds]");
    yield* page.until("round list restored", (one) => one.shows("Round 3:"));
    yield* page.press("[Input]", { onRow: "Round 3:" });
    yield* page.until(
      "pending input selected",
      (one) => one.shows("[live]") && one.shows("UNFINISHED"),
    );
    yield* page.key("Escape");
    yield* page.until("pending input drawer closed", (one) => one.shows("> [History]"));
    yield* page.press("[live]");
    yield* page.until("pending answer preserved", (one) => one.shows("[answer]"));
  });
});
