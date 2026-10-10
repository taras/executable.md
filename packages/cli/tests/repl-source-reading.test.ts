/**
 * The reading an entry is shown as (#881 PR 2, rows S1–S4).
 *
 * One real layout engine answers every width here. Nothing in this file works
 * out where a character lands: a test that counted code units would agree with
 * itself while the terminal drew something else, and the two cases this tier
 * exists to catch — a wide character and a combining mark — are exactly the
 * ones a count gets wrong.
 *
 * What is under test:
 *
 *   - **S1** generated source *replaces* its producer inside the enclosure the
 *     author wrote, at the recorded position, in the owner that recorded it —
 *     and a missing or ambiguous ownership keeps the producer rather than
 *     guessing;
 *   - **S2** every logical line is recoverable from the rows it was cut into,
 *     with its roles, across a long schema, an unbroken token, wide and
 *     combining text and explicit blank lines;
 *   - **S3** the output half says what actually happened, read from the record
 *     rather than from any word in the prose;
 *   - **S4** a phase-only change reuses the same cuts and the same status
 *     column, and static syntax acquires no phase.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import { entryReading, NO_READING, READING_STATUSES } from "../src/repl/source-reading.ts";
import type { ReplReadingLine } from "../src/repl/source-reading.ts";
import { prepareReading, readingRuns, reserveFor } from "../src/repl/fitting.ts";
import type { ReplPreparedReading } from "../src/repl/fitting.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
import type { ReplRenderer } from "../src/repl/renderer.ts";
import { runText } from "../src/repl/description.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplLifecycleReading, ReplOccurrence } from "../src/repl/lifecycle.ts";
import type { ReplEntry, ReplScope, ReplTerminal } from "../src/repl/model.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { LIFECYCLE, RAIL } from "./fixtures/repl/reference-style.ts";
import { REPL_PALETTE, runStyleOf } from "../src/repl/presentation-style.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };

function withRenderer<T>(body: (renderer: ReplRenderer) => Operation<T>): Operation<T> {
  return scoped(function* () {
    return yield* body(yield* useReplRenderer(WIDE));
  });
}

function scope(over: Partial<ReplScope> = {}): ReplScope {
  return Object.freeze({
    key: "entry-1",
    kind: "entry",
    name: "entry",
    path: "repl://entry-1",
    source: "",
    position: undefined,
    marker: "m1",
    bindings: Object.freeze([]),
    elicitations: Object.freeze([]),
    generated: Object.freeze([]),
    scopes: Object.freeze([]),
    ...over,
  });
}

function entryOf(source: string, over: Partial<ReplEntry> = {}): ReplEntry {
  return Object.freeze({
    key: "entry-1",
    order: 1,
    source,
    path: "repl://entry-1",
    scope: scope({ source }),
    transcript: Object.freeze([]),
    checkpoints: Object.freeze([]),
    terminal: undefined,
    settled: false,
    bindings: Object.freeze([]),
    turns: Object.freeze([]),
    ...over,
  });
}

function settled(status: "ok" | "err" | "cancelled", output: string): ReplTerminal {
  return Object.freeze({ status, output, message: undefined, location: undefined });
}

function observing(occurrences: readonly Partial<ReplOccurrence>[]): ReplLifecycleReading {
  return Object.freeze({
    entry: "entry-1",
    occurrences: Object.freeze(
      occurrences.map((one, index) =>
        Object.freeze({
          key: `entry-1#${index + 1}`,
          expansion: "x",
          name: "Elicit",
          parent: undefined,
          position: undefined,
          phase: "active" as const,
          waiting: Object.freeze([]),
          ...one,
        }),
      ),
    ),
  });
}

function at(offset: number) {
  return Object.freeze({
    path: "repl://entry-1",
    generatedSource: undefined,
    offset,
    line: 1,
    column: 1,
  });
}

/** Every logical line's text, recovered from the rows it was cut into. */
function recovered(prepared: ReplPreparedReading): Map<string, string> {
  const joined = new Map<string, string>();
  for (const row of prepared.rows) {
    joined.set(row.line, (joined.get(row.line) ?? "") + row.text);
  }
  return joined;
}

/**
 * Whether every badge of a reading ends where the reading ends.
 *
 * The accepted presentation aligns these at the pane's right inner edge, so
 * what has to agree across rows is where a badge *finishes*, not where it
 * starts: `\u25b6 ENTER` and `\u2713 SETTLED` are different widths and would start in
 * different columns if they were right-aligned correctly.
 */
function rightAligned(prepared: ReplPreparedReading): readonly boolean[] {
  const ends: boolean[] = [];
  for (const row of prepared.rows) {
    if (row.badge === undefined) {
      continue;
    }
    ends.push(runText(readingRuns(prepared, row)).endsWith(runText(row.badge)));
  }
  return ends;
}

describe("the reading one entry is shown as", () => {
  describe("S1 generated source replaces its producer where it was written", () => {
    // `<Evaluate>` is written at offset 0 and the fragment it admitted is
    // recorded against that offset in this owner.
    const SOURCE = '<Evaluate lang="ts">\nconst x = 1;\n</Evaluate>\n';
    const FRAGMENT = '# generated\n\n<Elicit as="q" />\n';

    function owning(decision: "admitted" | "refused", offset: number): ReplEntry {
      const child = scope({
        key: "entry-1/generated-1",
        kind: "generated",
        name: "generated",
        marker: "g1",
        source: FRAGMENT,
        position: Object.freeze({
          path: "repl://entry-1",
          generatedSource: undefined,
          offset,
          line: 1,
          column: 1,
        }),
      });
      return entryOf(SOURCE, {
        scope: scope({
          source: SOURCE,
          generated: Object.freeze([
            Object.freeze({
              marker: "g1",
              source: decision === "admitted" ? FRAGMENT : undefined,
              decision,
              construct: undefined,
            }),
          ]),
          scopes: Object.freeze([child]),
        }),
      });
    }

    it("shows the fragment inside the author's own enclosure bytes", function* () {
      const reading = entryReading({
        entry: owning("admitted", 0),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      const text = reading.source.lines.map((one) => one.text);
      // The enclosure the author wrote, exactly as they wrote it.
      expect(text).toContain('<Evaluate lang="ts">');
      expect(text).toContain("</Evaluate>");
      // What it produced, where its producer was.
      expect(text).toContain("# generated");
      expect(text).toContain('<Elicit as="q" />');
      // And not the producer itself.
      expect(text).not.toContain("const x = 1;");
      // Replaced, never appended: the fragment is between the two delimiters.
      const open = text.indexOf('<Evaluate lang="ts">');
      const close = text.indexOf("</Evaluate>");
      expect(open).toBeLessThan(text.indexOf("# generated"));
      expect(text.indexOf("# generated")).toBeLessThan(close);
    });

    it("keeps the fragment's own offsets, so its elements are its own", function* () {
      const reading = entryReading({
        entry: owning("admitted", 0),
        // The `<Elicit>` is at offset 14 of the *fragment*, which is nowhere
        // near offset 14 of the entry's own source.
        lifecycle: observing([
          {
            name: "Elicit",
            position: Object.freeze({
              path: undefined,
              generatedSource: "g1",
              offset: FRAGMENT.indexOf("<Elicit"),
              line: 3,
              column: 1,
            }),
            phase: "active",
          },
        ]),
        live: "",
        inspected: false,
      });
      const elicit = reading.source.lines.find((one) => one.text.includes("<Elicit"));
      expect(elicit).toBeDefined();
      expect(runText(elicit?.badge ?? [])).toBe(
        `${LIFECYCLE.active.glyph} ${LIFECYCLE.active.word}`,
      );
      // It is nested one deeper than the enclosure that produced it.
      expect(elicit?.depth).toBe(1);
    });

    it("keeps the producer when the admission refused", function* () {
      const reading = entryReading({
        entry: owning("refused", 0),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      const text = reading.source.lines.map((one) => one.text);
      expect(text).toContain("const x = 1;");
      expect(text).not.toContain("# generated");
    });

    it("keeps the producer when the recorded position is not this opening", function* () {
      const reading = entryReading({
        entry: owning("admitted", 99),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      expect(reading.source.lines.map((one) => one.text)).toContain("const x = 1;");
    });

    it("keeps the producer when two admissions claim the same opening", function* () {
      const base = owning("admitted", 0);
      const twice = entryOf(SOURCE, {
        scope: scope({
          source: SOURCE,
          generated: Object.freeze([
            ...base.scope.generated,
            Object.freeze({
              marker: "g2",
              source: "# other\n",
              decision: "admitted" as const,
              construct: undefined,
            }),
          ]),
          scopes: Object.freeze([
            ...base.scope.scopes,
            scope({
              key: "entry-1/generated-2",
              kind: "generated",
              marker: "g2",
              source: "# other\n",
              position: Object.freeze({
                path: "repl://entry-1",
                generatedSource: undefined,
                offset: 0,
                line: 1,
                column: 1,
              }),
            }),
          ]),
        }),
      });
      const reading = entryReading({
        entry: twice,
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      const text = reading.source.lines.map((one) => one.text);
      expect(text).toContain("const x = 1;");
      expect(text).not.toContain("# generated");
      expect(text).not.toContain("# other");
    });

    it("gives a self-closing Evaluate a connected child region underneath", function* () {
      const source = '<Evaluate lang="ts" src="./read.ts" />\n';
      const fragment = "read\n";
      const reading = entryReading({
        entry: entryOf(source, {
          scope: scope({
            source,
            generated: Object.freeze([
              Object.freeze({
                marker: "g1",
                source: fragment,
                decision: "admitted" as const,
                construct: undefined,
              }),
            ]),
            scopes: Object.freeze([
              scope({
                key: "entry-1/generated-1",
                kind: "generated",
                marker: "g1",
                source: fragment,
                position: Object.freeze({
                  path: "repl://entry-1",
                  generatedSource: undefined,
                  offset: 0,
                  line: 1,
                  column: 1,
                }),
              }),
            ]),
          }),
        }),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      const text = reading.source.lines.map((one) => one.text);
      // Its own row is kept, and the region is under it.
      expect(text[0]).toBe('<Evaluate lang="ts" src="./read.ts" />');
      expect(text).toContain("read");
      expect(reading.source.lines.find((one) => one.text === "read")?.depth).toBe(1);
    });
  });

  describe("S2 every logical line is recoverable from the rows it was cut into", () => {
    const PROFILES = [48, 72, 100];

    // A long schema line, an unbroken token no boundary can break, wide and
    // combining text, and explicit blank lines.
    const SOURCE = [
      '<Elicit as="project" schema={{ name: "string", owner: "string", budget: "number" }}>',
      "  Enter the project details, including the owner and the budget it is held against.",
      "</Elicit>",
      "",
      `x${"x".repeat(159)}`,
      "",
      "界é🙂 and é combining",
      "",
    ].join("\n");

    for (const room of PROFILES) {
      it(`recovers every line and its roles at ${room} columns`, () =>
        withRenderer(function* (renderer) {
          const reading = entryReading({
            entry: entryOf(SOURCE),
            lifecycle: NO_LIFECYCLE,
            live: "",
            inspected: false,
          });
          const prepared = yield* prepareReading(renderer, WIDE, reading.source.lines, room);
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            return;
          }
          const joined = recovered(prepared.value);
          for (const line of reading.source.lines) {
            // Nothing dropped, nothing trimmed, nothing shortened.
            expect(joined.get(line.key)).toBe(line.text);
          }
          // Every row's runs still concatenate to exactly its text, so no
          // character lost its role on the way through the cut.
          for (const row of prepared.value.rows) {
            expect(runText(row.runs)).toBe(row.text);
          }
          // The unbroken token did get broken — into rows, not into nothing.
          const unbroken = reading.source.lines.find((one) => one.text.startsWith("xxx"));
          expect(unbroken).toBeDefined();
          const pieces = prepared.value.rows.filter((one) => one.line === unbroken?.key);
          expect(pieces.length).toBeGreaterThan(1);
          // One owner, and no second badge on any continuation.
          expect(pieces.filter((one) => one.continuation).length).toBe(pieces.length - 1);
          expect(pieces.filter((one) => one.badge !== undefined).length).toBeLessThanOrEqual(1);
          // A blank logical line is one row.
          for (const line of reading.source.lines.filter((one) => one.text === "")) {
            expect(prepared.value.rows.filter((one) => one.line === line.key).length).toBe(1);
          }
        }));
    }

    it("sets a continuation in to the column its own line was written at", () =>
      withRenderer(function* (renderer) {
        // An indented line, long enough to wrap. Its continuations have to
        // start where it started: a continuation further left than the row it
        // continues reads as a new, shallower line, which is a claim about
        // structure the source does not make.
        const indented =
          "      " +
          "an indented line of prose, written long enough that it cannot be held on one row";
        const reading = entryReading({
          entry: entryOf(indented + "\n"),
          lifecycle: NO_LIFECYCLE,
          live: "",
          inspected: false,
        });
        const prepared = yield* prepareReading(renderer, WIDE, reading.source.lines, 56);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          return;
        }
        const rows = prepared.value.rows;
        expect(rows.length).toBeGreaterThan(1);
        // The first row carries the source's own whitespace in its text; each
        // continuation carries the same amount as a display indent instead.
        expect(rows[0].indent).toBe(0);
        for (const row of rows.slice(1)) {
          expect(row.indent).toBe(6);
        }
        // Each composed row therefore begins its text at the same column.
        const columns = rows.map((one) => {
          const whole = runText(readingRuns(prepared.value, one));
          return whole.length - whole.trimStart().length;
        });
        expect(new Set(columns).size).toBe(1);
        // And the line is still recoverable exactly: the indent is display,
        // and no source byte moved.
        expect(recovered(prepared.value).get(reading.source.lines[0].key)).toBe(indented);
      }));

    it("never measures a row wider than the region it was cut for", () =>
      withRenderer(function* (renderer) {
        const reading = entryReading({
          entry: entryOf(SOURCE),
          lifecycle: NO_LIFECYCLE,
          live: "",
          inspected: false,
        });
        const prepared = yield* prepareReading(renderer, WIDE, reading.source.lines, 48);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          return;
        }
        for (const row of prepared.value.rows) {
          expect(row.width).toBeLessThanOrEqual(prepared.value.reservation.content);
        }
      }));

    it("cuts wide and combining text at graphemes the engine agrees on", () =>
      withRenderer(function* (renderer) {
        // Four code units, five cells, and two of the three graphemes are not
        // one unit wide.
        const line: ReplReadingLine = Object.freeze({
          key: "one",
          text: "界é🙂",
          runs: Object.freeze([Object.freeze({ text: "界é🙂", token: "source" as const })]),
          rail: "rail-pending" as const,
          depth: 0,
          badge: undefined,
          style: Object.freeze({ role: "source" as const, selected: false, inspected: false }),
        });
        const reservation = yield* reserveFor(renderer, WIDE, 80);
        expect(reservation.ok).toBe(true);
        if (!reservation.ok) {
          return;
        }
        // A region with room for three cells holds `界` and `é` and not the
        // emoji — which a code-unit count would get wrong in both directions.
        const room =
          reservation.value.rail + reservation.value.separator * 2 + reservation.value.status + 3;
        const prepared = yield* prepareReading(renderer, WIDE, [line], room);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          return;
        }
        expect(prepared.value.rows.map((one) => one.text)).toEqual(["界é", "🙂"]);
      }));

    it("refuses rather than clipping when not one grapheme fits", () =>
      withRenderer(function* (renderer) {
        const line: ReplReadingLine = Object.freeze({
          key: "one",
          text: "界界界",
          runs: Object.freeze([Object.freeze({ text: "界界界", token: "source" as const })]),
          rail: "rail-pending" as const,
          depth: 0,
          badge: undefined,
          style: Object.freeze({ role: "source" as const, selected: false, inspected: false }),
        });
        const reservation = yield* reserveFor(renderer, WIDE, 80);
        expect(reservation.ok).toBe(true);
        if (!reservation.ok) {
          return;
        }
        // One column of content, and the narrowest grapheme is two cells wide.
        const room =
          reservation.value.rail + reservation.value.separator * 2 + reservation.value.status + 1;
        const prepared = yield* prepareReading(renderer, WIDE, [line], room);
        expect(prepared.ok).toBe(false);
        if (prepared.ok) {
          return;
        }
        expect(prepared.error.name).toBe("ReplFitRefusal");
      }));
  });

  describe("S3 the output half says what actually happened", () => {
    it("labels text still arriving as live", function* () {
      const reading = entryReading({
        entry: entryOf("hello\n"),
        lifecycle: NO_LIFECYCLE,
        live: "partial outp",
        inspected: false,
      });
      expect(reading.output.caption).toBe("Output · live");
      expect(reading.output.lines.map((one) => one.text)).toEqual(["partial outp"]);
    });

    it("replaces it with the retained result, once, unlabelled", function* () {
      const reading = entryReading({
        entry: entryOf("hello\n", { terminal: settled("ok", "hello"), settled: true }),
        lifecycle: NO_LIFECYCLE,
        // Live text from the run that just finished must not be shown beside
        // the result that replaced it.
        live: "partial outp",
        inspected: false,
      });
      expect(reading.output.caption).toBe("Output");
      expect(reading.output.lines.map((one) => one.text)).toEqual(["hello"]);
    });

    it("says the outcome when nothing was rendered", function* () {
      const reading = entryReading({
        entry: entryOf("<Evaluate />", { terminal: settled("ok", ""), settled: true }),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      expect(reading.output.caption).toBe("No rendered output.");
      expect(reading.output.lines.map((one) => one.text)).toEqual(["closed ok"]);
      expect(reading.output.lines[0].style.role).toBe("successful-outcome");
    });

    it("reads the outcome from the record, not from the prose", function* () {
      // Output containing the word `failed` from a root that closed `ok`.
      const reading = entryReading({
        entry: entryOf("doc", {
          terminal: settled("ok", "the retry failed and the fallback succeeded"),
          settled: true,
        }),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      expect(reading.output.caption).toBe("Output");
      expect(reading.output.lines[0].style.role).toBe("output");
    });

    it("says a prefix recorded no entry output rather than borrowing later text", function* () {
      const reading = entryReading({
        entry: entryOf("doc"),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: true,
      });
      expect(reading.output.caption).toBe("No entry output recorded at this checkpoint.");
      expect(reading.output.lines).toEqual([]);
    });

    it("shows a bound value that emitted nothing as no output", function* () {
      const reading = entryReading({
        entry: entryOf('<Evaluate as="total">1 + 1</Evaluate>', {
          terminal: settled("ok", ""),
          settled: true,
        }),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      expect(reading.output.caption).toBe("No rendered output.");
      // No synthesized receipt, and no rendered value invented for it.
      expect(reading.output.lines.map((one) => one.text)).toEqual(["closed ok"]);
    });

    it("puts output before source", function* () {
      const reading = entryReading({
        entry: entryOf('<Elicit as="q" />\n', { terminal: settled("ok", "done"), settled: true }),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      // One reading, two captioned sections, and the result is the first.
      expect(Object.keys(reading)).toEqual(["output", "source"]);
      expect(reading.output.caption).toBe("Output");
      expect(reading.source.caption).toBe("Source");
    });

    it("reads nothing for a prefix that admitted no entry", function* () {
      expect(NO_READING.output.caption).toBe("No entry output recorded at this checkpoint.");
      expect(NO_READING.source.lines).toEqual([]);
    });
  });

  describe("S4 phases are observed, never inferred from syntax", () => {
    const SOURCE = '<Elicit as="project" schema={schema}>\n  Details.\n</Elicit>\n';

    it("gives static source the rail that means nothing was observed", function* () {
      const reading = entryReading({
        entry: entryOf(SOURCE),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: true,
      });
      for (const line of reading.source.lines) {
        expect(line.rail).toBe("rail-pending");
        expect(line.badge).toBeUndefined();
      }
      expect(REPL_PALETTE.railPending).toBe(RAIL.pend);
    });

    it("gives an observed element its own phase, in the archive's literals", function* () {
      const cases = [
        { phase: "enter" as const, rail: RAIL.active, badge: LIFECYCLE.enter },
        { phase: "active" as const, rail: RAIL.active, badge: LIFECYCLE.active },
        { phase: "settled" as const, rail: RAIL.settled, badge: LIFECYCLE.settled },
        { phase: "failed" as const, rail: RAIL.settled, badge: LIFECYCLE.fail },
      ];
      for (const one of cases) {
        const reading = entryReading({
          entry: entryOf(SOURCE),
          lifecycle: observing([{ position: at(0), phase: one.phase }]),
          live: "",
          inspected: false,
        });
        const badged = reading.source.lines.filter((line) => line.badge !== undefined);
        expect(badged.length).toBe(1);
        expect(runText(badged[0].badge ?? [])).toBe(`${one.badge.glyph} ${one.badge.word}`);
        // The rail is the archive's value for that phase, read through the
        // product's own role rather than compared to the product's palette.
        const rail = reading.source.lines[0].rail;
        expect(runStyleOf(rail, reading.source.lines[0].style, false).colour).toBe(one.rail);
        // And the badge is the archive's colour.
        const ink = runStyleOf((badged[0].badge ?? [])[0].token, badged[0].style, false);
        expect(ink.colour).toBe(one.badge.colour);
      }
    });

    it("says WAITING on the element that is waiting, with the waiting rail", function* () {
      const reading = entryReading({
        entry: entryOf(SOURCE),
        lifecycle: observing([
          { position: at(0), phase: "active", waiting: Object.freeze(["question" as const]) },
        ]),
        live: "",
        inspected: false,
      });
      const badged = reading.source.lines.filter((line) => line.badge !== undefined);
      expect(runText(badged[0].badge ?? [])).toBe(`${LIFECYCLE.hold.glyph} ${LIFECYCLE.hold.word}`);
      expect(runStyleOf(reading.source.lines[0].rail, badged[0].style, false).colour).toBe(
        RAIL.hold,
      );
    });

    it("keeps EXIT's rail during a cleanup wait, and says both readings", function* () {
      const reading = entryReading({
        entry: entryOf(SOURCE),
        lifecycle: observing([
          { position: at(0), phase: "exit", waiting: Object.freeze(["expansion" as const]) },
        ]),
        live: "",
        inspected: false,
      });
      expect(
        runStyleOf(reading.source.lines[0].rail, reading.source.lines[0].style, false).colour,
      ).toBe(RAIL.exit);
      const badged = reading.source.lines.filter((line) => line.badge !== undefined);
      // On the closing delimiter, which is where the exit is happening.
      expect(badged.length).toBe(1);
      expect(badged[0].text).toBe("</Elicit>");
      expect(runText(badged[0].badge ?? [])).toBe(
        `${LIFECYCLE.exit.glyph} ${LIFECYCLE.exit.word} · ` +
          `${LIFECYCLE.hold.glyph} ${LIFECYCLE.hold.word}`,
      );
      // Two readings, two accents, neither of them the separator's.
      const inks = (badged[0].badge ?? []).map(
        (run) => runStyleOf(run.token, badged[0].style, false).colour,
      );
      expect(inks).toContain(LIFECYCLE.exit.colour);
      expect(inks).toContain(LIFECYCLE.hold.colour);
      expect(new Set(inks).size).toBe(3);
    });

    it("keeps this terminal's word for a reading that stopped", function* () {
      const reading = entryReading({
        entry: entryOf(SOURCE),
        lifecycle: observing([{ position: at(0), phase: "cancelled" }]),
        live: "",
        inspected: false,
      });
      const badged = reading.source.lines.filter((line) => line.badge !== undefined);
      expect(runText(badged[0].badge ?? [])).toBe("cancelled");
    });

    it("reuses the same cuts and the same status column when only a phase changed", () =>
      withRenderer(function* (renderer) {
        const long =
          '<Elicit as="project" schema={{ name: "string", owner: "string" }}>\n' +
          "  Enter the project details, including its owner and the budget it is held against.\n" +
          "</Elicit>\n";
        const of = (phase: "enter" | "settled") =>
          entryReading({
            entry: entryOf(long),
            lifecycle: observing([{ position: at(0), phase }]),
            live: "",
            inspected: false,
          });
        const first = yield* prepareReading(renderer, WIDE, of("enter").source.lines, 56);
        const second = yield* prepareReading(renderer, WIDE, of("settled").source.lines, 56);
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) {
          return;
        }
        // The same source, cut the same way.
        expect(second.value.rows.map((one) => one.text)).toEqual(
          first.value.rows.map((one) => one.text),
        );
        // The same reservation, so the column does not move.
        expect(second.value.reservation.status).toBe(first.value.reservation.status);
        expect(rightAligned(first.value)).toEqual([true]);
        expect(rightAligned(second.value)).toEqual([true]);
      }));

    it("reserves for every reading a badge can hold, measured not counted", () =>
      withRenderer(function* (renderer) {
        const reservation = yield* reserveFor(renderer, WIDE, 80);
        expect(reservation.ok).toBe(true);
        if (!reservation.ok) {
          return;
        }
        // Every phase, the cleanup wait that says two things, and the word this
        // terminal keeps for a cancellation.
        for (const one of READING_STATUSES) {
          expect(reservation.value.statusWidths.get(one)).toBeDefined();
          expect(reservation.value.statusWidths.get(one) ?? 0).toBeLessThanOrEqual(
            reservation.value.status,
          );
        }
        expect(READING_STATUSES).toContain("cancelled");
        expect(READING_STATUSES).toContain(
          `${LIFECYCLE.exit.glyph} ${LIFECYCLE.exit.word} · ` +
            `${LIFECYCLE.hold.glyph} ${LIFECYCLE.hold.word}`,
        );
        // The widest is the cleanup wait, which is the point of reserving for
        // it: the column cannot grow when an element starts releasing.
        expect(reservation.value.status).toBe(
          reservation.value.statusWidths.get(
            `${LIFECYCLE.exit.glyph} ${LIFECYCLE.exit.word} · ` +
              `${LIFECYCLE.hold.glyph} ${LIFECYCLE.hold.word}`,
          ),
        );
      }));

    it("attributes nothing to an entry whose observations belong to another", function* () {
      const reading = entryReading({
        entry: entryOf(SOURCE),
        lifecycle: Object.freeze({
          entry: "entry-2",
          occurrences: observing([{ position: at(0), phase: "active" }]).occurrences,
        }),
        live: "",
        inspected: false,
      });
      for (const line of reading.source.lines) {
        expect(line.badge).toBeUndefined();
        expect(line.rail).toBe("rail-pending");
      }
    });

    it("gives each call of one element its own reading, in its own source group", function* () {
      // Two calls of one authored element — what a `<Loop>` produces. Showing
      // only the last would say the first never happened, and one badge for both
      // would say two calls were one.
      const source = '<Step as="each" />\n';
      const reading = entryReading({
        entry: entryOf(source),
        lifecycle: observing([
          { key: "entry-1#1", name: "Step", position: at(0), phase: "settled" },
          { key: "entry-1#2", name: "Step", position: at(0), phase: "active" },
        ]),
        live: "",
        inspected: false,
      });
      const rows = reading.source.lines.filter((one) => one.text.includes("<Step"));
      expect(rows.length).toBe(2);
      // Each reads as the call it is, in the order they were observed.
      expect(rows.map((one) => runText(one.badge ?? []))).toEqual([
        `${LIFECYCLE.settled.glyph} ${LIFECYCLE.settled.word}`,
        `${LIFECYCLE.active.glyph} ${LIFECYCLE.active.word}`,
      ]);
      // And each is its own group: two rows, two keys, two rails.
      expect(new Set(rows.map((one) => one.key)).size).toBe(2);
      expect(rows.map((one) => one.rail)).toEqual(["rail-settled", "rail-active"]);
    });

    it("reads an element nothing was observed of exactly once", function* () {
      const source = '<Step as="each" />\n';
      const reading = entryReading({
        entry: entryOf(source),
        lifecycle: NO_LIFECYCLE,
        live: "",
        inspected: false,
      });
      expect(reading.source.lines.filter((one) => one.text.includes("<Step")).length).toBe(1);
    });

    it("draws a rail on every row, in the colour of the region it is in", () =>
      withRenderer(function* (renderer) {
        // The gap K1 found. Every other case here reads `line.rail`, which is
        // the model's answer; none of them asked whether a rail reaches the
        // row. Removing it from the composed runs broke nothing, so a reading
        // could have lost its rails entirely and every test would have passed.
        const source = '<Elicit as="q">\n  Ask.\n</Elicit>\n';
        const reading = entryReading({
          entry: entryOf(source),
          lifecycle: observing([{ position: at(0), phase: "active" }]),
          live: "",
          inspected: false,
        });
        const prepared = yield* prepareReading(renderer, WIDE, reading.source.lines, 72);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          return;
        }
        expect(prepared.value.rows.length).toBeGreaterThan(0);
        for (const row of prepared.value.rows) {
          const runs = readingRuns(prepared.value, row);
          // It is the first thing in the row, it is the rail glyph, and it is
          // drawn under the rail role that says which region the row is in.
          expect([row.key, runs[0].text]).toEqual([row.key, "\u2502"]);
          expect([row.key, runs[0].token]).toEqual([row.key, row.rail]);
          expect([row.key, runText(runs).startsWith("\u2502")]).toEqual([row.key, true]);
        }
        // And the observed region's rail really is the observed one, so this is
        // not satisfied by painting every row the same.
        const observed = prepared.value.rows.filter((one) => one.rail === "rail-active");
        expect(observed.length).toBeGreaterThan(0);
      }));

    it("aligns every badge at the same measured column", () =>
      withRenderer(function* (renderer) {
        const source = '<Elicit as="a" />\n<Elicit as="b" />\n';
        const reading = entryReading({
          entry: entryOf(source),
          lifecycle: observing([
            { position: at(0), phase: "active" },
            { position: at(source.indexOf('<Elicit as="b"')), phase: "settled" },
          ]),
          live: "",
          inspected: false,
        });
        const prepared = yield* prepareReading(renderer, WIDE, reading.source.lines, 72);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          return;
        }
        const ends = rightAligned(prepared.value);
        expect(ends.length).toBe(2);
        expect(ends).toEqual([true, true]);
        // And both composed rows are exactly as wide as each other, which is
        // what "the same right inner edge" means once the badges differ in
        // width.
        const composed = prepared.value.rows
          .filter((one) => one.badge !== undefined)
          .map((one) => runText(readingRuns(prepared.value, one)).length);
        expect(new Set(composed).size).toBe(1);
      }));
  });
});
