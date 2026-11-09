/**
 * The terminal engine measures every distinct text as itself (#1216).
 *
 * The published `@bomb.sh/tty` 0.9.0 engine kept one text-measurement cache
 * entry per hash, so two different texts that hashed alike were given one
 * width. `SHORT` and `LONG` are such a pair: before the prepared runtime, the
 * second text measured in a batch or a later call came back with the first
 * one's width, and a reading cut for that width refused or lost its tail.
 *
 * These go through the prepared runtime the CLI imports — the renderer, the
 * reading cutter and a full frame — and through the engine itself where key
 * storage, rather than a REPL reading, is what is being held.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, until } from "effection";
import type { Operation } from "effection";

import { close, createTerm, fit, open, text } from "../generated/tty/mod.js";
import type { Op, Term } from "../generated/tty/mod.js";
import {
  initialState,
  NO_AGENT,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import { runText } from "../src/repl/description.ts";
import { prepareReading, readingRuns } from "../src/repl/fitting.ts";
import type { ReplPreparedReading } from "../src/repl/fitting.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplLifecycleReading } from "../src/repl/lifecycle.ts";
import type { ReplEntry, ReplScope } from "../src/repl/model.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
import { entryReading } from "../src/repl/source-reading.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { journalModel } from "./fixtures/repl/journals.ts";
import { usePresenter } from "./fixtures/repl/presentation.ts";

const SHORT = "synthetic sample synthetic sample synthetic sample 022aa2";
const LONG =
  "synthetic sample synthetic sample synthetic sample synthetic sample synthetic sample 01fda4";
const SIZE: ReplTerminalSize = { columns: 186, rows: 40 };
const NATURAL = { layout: { width: fit(), height: fit() } };

function column(values: readonly string[], prefix: string): Op[] {
  return [
    open("probe", { layout: { width: fit(), height: fit(), direction: "ttb" } }),
    ...values.flatMap((value, at) => [open(`${prefix}-${at}`, NATURAL), text(value), close()]),
    close(),
  ];
}

describe("the prepared terminal engine measures each distinct text as itself", () => {
  it("keeps both widths of a colliding pair measured in one batch", function* () {
    const renderer = yield* useReplRenderer(SIZE);
    const result = yield* renderer.measure(column([SHORT, LONG], "row"), SIZE);
    if (!result.ok) {
      throw result.error;
    }
    expect([result.value.boundsOf("row-0")?.width, result.value.boundsOf("row-1")?.width]).toEqual([
      57, 91,
    ]);
  });

  it("keeps both widths when the pair is measured in separate calls", function* () {
    const renderer = yield* useReplRenderer(SIZE);
    const widths: (number | undefined)[] = [];
    for (const value of [SHORT, LONG, SHORT, LONG]) {
      const result = yield* renderer.measure(column([value], "row"), SIZE);
      if (!result.ok) {
        throw result.error;
      }
      widths.push(result.value.boundsOf("row-0")?.width);
    }
    expect(widths).toEqual([57, 91, 57, 91]);
  });

  it("draws the longer text's tail in a full frame", function* () {
    const source = `${SHORT}\n${LONG}\n`;
    const model = yield* journalModel([source]);
    const live = {
      output: "",
      question: undefined,
      expansion: "playing",
      pausable: false,
      running: false,
      agent: NO_AGENT,
      lifecycle: NO_LIFECYCLE,
    } as const;
    const view = viewFor(
      initialState("synthetic"),
      model,
      live,
      SIZE,
      undefined,
      navigationOf(model.checkpoints, "settled"),
    );
    if (!view.ok) {
      throw view.error;
    }
    const presenter = yield* usePresenter(SIZE);
    yield* presenter.commit(withWorkspace(view.value, workspaceOf(model)));
    expect(presenter.grid.rows().some((row) => row.includes("01fda4"))).toBe(true);
    expect(presenter.grid.rows().some((row) => row.includes("022aa2"))).toBe(true);
    expect(model.entries[0].source).toBe(source);
  });
});

describe("the engine owns the text its cache compares", () => {
  /** Widths of each text, measured by one engine in one render. */
  function measure(term: Term, values: readonly string[]): (number | undefined)[] {
    const result = term.render(column(values, "row"));
    expect(result.errors).toEqual([]);
    return values.map((_, at) => result.info.get(`row-${at}`)?.bounds.width);
  }

  it("keeps earlier keys exact after the key storage is reset", function* () {
    const term = yield* until(createTerm({ width: SIZE.columns, height: SIZE.rows }));
    expect(measure(term, [SHORT])).toEqual([57]);
    expect(measure(term, [LONG])).toEqual([91]);
    expect(measure(term, [SHORT, LONG])).toEqual([57, 91]);
    // Two layouts near the wire budget: the second cannot fit beside the
    // first's retained keys, so the engine resets its cache before it lays out.
    for (const pass of [0, 1]) {
      measure(
        term,
        Array.from(
          { length: 390 },
          (_, at) => `${pass}-${at.toString().padStart(3, "0")}-${"x".repeat(4994)}`,
        ),
      );
    }
    expect(measure(term, [SHORT, LONG])).toEqual([57, 91]);
  });

  it("measures a layout larger than the key storage after a resize", function* () {
    // Built large and resized down, so the wire buffer it already allocated
    // admits more text than one layout's retained keys could hold.
    const term = yield* until(createTerm({ width: 400, height: 100 }));
    term.update({ width: SIZE.columns, height: SIZE.rows });
    const values = [
      SHORT,
      LONG,
      ...Array.from({ length: 430 }, (_, at) => `${at}-${"x".repeat(5000)}`),
    ];
    expect(measure(term, values).slice(0, 2)).toEqual([57, 91]);
    expect(measure(term, [SHORT, LONG])).toEqual([57, 91]);
  });
});

function scope(source: string): ReplScope {
  return Object.freeze({
    key: "entry-1",
    kind: "entry",
    name: "entry",
    path: "repl://entry-1",
    source,
    position: undefined,
    marker: "m1",
    bindings: Object.freeze([]),
    elicitations: Object.freeze([]),
    generated: Object.freeze([]),
    scopes: Object.freeze([]),
  });
}

function entryOf(source: string): ReplEntry {
  return Object.freeze({
    key: "entry-1",
    order: 1,
    source,
    path: "repl://entry-1",
    scope: scope(source),
    transcript: Object.freeze([]),
    checkpoints: Object.freeze([]),
    terminal: undefined,
    settled: false,
    bindings: Object.freeze([]),
    turns: Object.freeze([]),
    records: Object.freeze([]),
  });
}

/** Two observed calls, so the reading carries badges whose column is compared. */
function observing(source: string): ReplLifecycleReading {
  return Object.freeze({
    entry: "entry-1",
    occurrences: Object.freeze(
      [
        { offset: 0, phase: "active" as const },
        { offset: source.indexOf("<Step"), phase: "settled" as const },
      ].map((one, index) =>
        Object.freeze({
          key: `entry-1#${index + 1}`,
          expansion: "x",
          name: index === 0 ? "Section" : "Step",
          parent: undefined,
          position: Object.freeze({
            path: "repl://entry-1",
            generatedSource: undefined,
            offset: one.offset,
            line: 1,
            column: 1,
          }),
          phase: one.phase,
          waiting: Object.freeze([]),
        }),
      ),
    ),
  });
}

/** Six enclosures deep: the colliding pair, wide and combining text, whitespace and blank lines. */
const NESTED = [
  "<Section>",
  "<Part>",
  "<Group>",
  "<Block>",
  "<Item>",
  "<Step>",
  SHORT,
  LONG,
  "",
  "界é🙂 and é combining, then a long run of prose that has to wrap at every profile here",
  "   leading   and   inner   whitespace   kept   exactly   as   it   was   written   ",
  "",
  "</Step>",
  "</Item>",
  "</Block>",
  "</Group>",
  "</Part>",
  "</Section>",
  "",
].join("\n");

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeBoundaries(value: string): Set<number> {
  const boundaries = new Set([value.length]);
  for (const piece of SEGMENTER.segment(value)) {
    boundaries.add(piece.index);
  }
  return boundaries;
}

function* prepared(size: ReplTerminalSize): Operation<{
  lines: ReturnType<typeof entryReading>["source"]["lines"];
  reading: ReplPreparedReading;
}> {
  return yield* scoped(function* () {
    const renderer = yield* useReplRenderer(size);
    const lines = entryReading({
      entry: entryOf(NESTED),
      lifecycle: observing(NESTED),
      live: "",
      inspected: false,
    }).source.lines;
    const result = yield* prepareReading(renderer, size, lines, size.columns - 4);
    if (!result.ok) {
      throw result.error;
    }
    return { lines, reading: result.value };
  });
}

describe("a nested reading with a colliding pair fits every profile exactly", () => {
  for (const size of [SIZE, { columns: 160, rows: 36 }, { columns: 72, rows: 20 }]) {
    it(`recovers, cuts and aligns it at ${size.columns}x${size.rows}`, function* () {
      const { lines, reading } = yield* prepared(size);
      const deepest = lines.filter((one) => one.text === SHORT || one.text === LONG);
      expect(deepest.map((one) => one.depth)).toEqual([6, 6]);

      for (const line of lines) {
        const rows = reading.rows.filter((one) => one.line === line.key);
        // Concatenating the rows recovers the source line, byte for byte.
        expect(rows.map((one) => one.text).join("")).toBe(line.text);
        // Every cut falls on a grapheme boundary of the line it came from.
        const boundaries = graphemeBoundaries(line.text);
        let offset = 0;
        for (const row of rows) {
          expect(boundaries.has(offset)).toBe(true);
          offset += row.text.length;
          expect(runText(row.runs)).toBe(row.text);
          // Measured, and within the region it was cut for at its own indent.
          const indent = Math.min(row.depth * 2 + row.indent, reading.reservation.content - 1);
          expect(row.width).toBeLessThanOrEqual(reading.reservation.content - indent);
        }
        expect(offset).toBe(line.text.length);
        // A continuation is set in to its line's written column, never further left.
        for (const row of rows.slice(1)) {
          expect(row.indent).toBe(line.text.length - line.text.trimStart().length);
        }
      }

      // Every badge ends at the same measured column, whatever its width.
      const badged = reading.rows.filter((one) => one.badge !== undefined);
      expect(badged.length).toBe(2);
      for (const row of badged) {
        expect(runText(readingRuns(reading, row)).endsWith(runText(row.badge ?? []))).toBe(true);
      }
      expect(new Set(badged.map((row) => runText(readingRuns(reading, row)).length)).size).toBe(1);
    });
  }
});
