/**
 * The three reviewed appearance records, and the one input they describe.
 *
 * This is an oracle for what the screen *looks like*: complete rows of text and
 * the style runs underneath them, at the three accepted profiles. It holds no
 * route, no ancestry, no box id and no target list — those are the behaviour
 * tests' business, and a screen that drew the right words in the right inks
 * while mounting the wrong tree is a different failure from this one.
 *
 * The input is recorded. `journal.jsonl` is the fixture's own execution,
 * produced once with the compiler installed and kept, so a profile case
 * replays a journal rather than running a document again: nothing here is
 * re-executed to find out what colour a row is. Every line of it goes through
 * the same `parseDurableEvent` the product reads a journal with, and every
 * record says which journal it was written against — a record whose input
 * changed underneath it fails on the digest rather than on a row.
 *
 * Everything it reads is repository data reached from this module's own URL,
 * so the records travel with the tests rather than with a machine.
 */
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Operation } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { ReplModel } from "../../../src/repl/model.ts";
import { projectRepl } from "../../../src/repl/model.ts";
import type { ReplTerminalSize } from "../../../src/repl/terminal.ts";
import type { TerminalGrid } from "./presentation.ts";

/** One run of cells drawn in one style. */
export interface AppearanceRun {
  readonly x: number;
  readonly width: number;
  readonly fg: string;
  readonly bg: string;
  readonly attrs: string;
}

/** One row's runs, as a record stores them. */
export interface AppearanceLine {
  readonly y: number;
  readonly runs: readonly AppearanceRun[];
}

/** What one profile is expected to look like. */
export interface AppearanceRecord {
  readonly profile: string;
  readonly size: { readonly columns: number; readonly rows: number };
  readonly input: {
    readonly journal: string;
    readonly journalSha256: string;
    readonly workspace: string;
    readonly initialFocus: string;
    readonly focused: string | undefined;
  };
  readonly authority: Readonly<Record<string, string>>;
  readonly rows: readonly string[];
  readonly styleRuns: readonly AppearanceLine[];
  readonly expectedSha256: string;
}

function at(name: string): string {
  return fileURLToPath(new URL(`./appearance/${name}`, import.meta.url));
}

/** The recorded journal's own text, and what it hashes to. */
export function* appearanceJournal(): Operation<{
  readonly text: string;
  readonly sha256: string;
  readonly events: readonly DurableEvent[];
}> {
  const text = yield* readTextFile(at("journal.jsonl"));
  const events: DurableEvent[] = [];
  for (const [at, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    // The product's own parser, not JSON.parse with a type written over it: a
    // line this rejects is not an event, and a fixture that cast it would be
    // describing a screen drawn from something else.
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      throw new Error(`appearance journal line ${at + 1} is not a durable event`, {
        cause: parsed.error,
      });
    }
    events.push(parsed.value);
  }
  return {
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    events: Object.freeze(events),
  };
}

/** That recording, through the canonical projection the product reads with. */
export function* appearanceModel(): Operation<ReplModel> {
  const projected = projectRepl((yield* appearanceJournal()).events);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

function runOf(value: unknown, where: string): AppearanceRun {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${where} is not a style run`);
  }
  const { x, width, fg, bg, attrs } = value as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof width !== "number" ||
    typeof fg !== "string" ||
    typeof bg !== "string" ||
    typeof attrs !== "string"
  ) {
    throw new Error(`${where} is not a style run`);
  }
  return Object.freeze({ x, width, fg, bg, attrs });
}

/**
 * One stored record, read as the structure it is supposed to be.
 *
 * Checked field by field rather than asserted into shape: a record that lost
 * its rows, its runs or the digest binding it to an input says so here, where
 * the message is about the record, instead of failing later as a row that did
 * not match.
 */
export function* appearanceRecord(profile: string): Operation<AppearanceRecord> {
  const text = yield* readTextFile(at(`${profile}.json`));
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error(`the ${profile} record is not an object`);
  }
  const record = value as Record<string, unknown>;
  const size = record.size as Record<string, unknown> | undefined;
  const input = record.input as Record<string, unknown> | undefined;
  if (
    record.profile !== profile ||
    size === undefined ||
    typeof size.columns !== "number" ||
    typeof size.rows !== "number"
  ) {
    throw new Error(`the ${profile} record does not say which profile and size it is`);
  }
  if (
    input === undefined ||
    typeof input.journal !== "string" ||
    typeof input.journalSha256 !== "string" ||
    typeof input.workspace !== "string" ||
    typeof input.initialFocus !== "string"
  ) {
    throw new Error(`the ${profile} record does not name the input it describes`);
  }
  if (!Array.isArray(record.rows) || !record.rows.every((row) => typeof row === "string")) {
    throw new Error(`the ${profile} record has no rows of text`);
  }
  if (record.rows.length !== size.rows) {
    throw new Error(`the ${profile} record holds ${record.rows.length} rows for ${size.rows}`);
  }
  if (!Array.isArray(record.styleRuns)) {
    throw new Error(`the ${profile} record has no style runs`);
  }
  const styleRuns = record.styleRuns.map((line, order) => {
    const held = line as Record<string, unknown>;
    if (typeof held.y !== "number" || !Array.isArray(held.runs)) {
      throw new Error(`the ${profile} record's style line ${order} has no rows or runs`);
    }
    return Object.freeze({
      y: held.y,
      runs: Object.freeze(
        held.runs.map((run, index) => runOf(run, `${profile} line ${held.y} run ${index}`)),
      ),
    });
  });
  if (typeof record.expectedSha256 !== "string" || typeof record.authority !== "object") {
    throw new Error(`the ${profile} record carries no digest or authority`);
  }
  return Object.freeze({
    profile,
    size: Object.freeze({ columns: size.columns, rows: size.rows }),
    input: Object.freeze({
      journal: input.journal,
      journalSha256: input.journalSha256,
      workspace: input.workspace,
      initialFocus: input.initialFocus,
      focused: typeof input.focused === "string" ? input.focused : undefined,
    }),
    authority: Object.freeze({ ...(record.authority as Record<string, string>) }),
    rows: Object.freeze([...record.rows]),
    styleRuns: Object.freeze(styleRuns),
    expectedSha256: record.expectedSha256,
  });
}

/** The size one record is of. */
export function sizeOf(record: AppearanceRecord): ReplTerminalSize {
  return Object.freeze({ columns: record.size.columns, rows: record.size.rows });
}

/** One committed screen, in the two shapes a record is written in. */
export function screenOf(
  grid: TerminalGrid,
  size: ReplTerminalSize,
): { readonly rows: readonly string[]; readonly runs: readonly AppearanceLine[] } {
  const rows: string[] = [];
  const runs: AppearanceLine[] = [];
  for (let y = 0; y < size.rows; y += 1) {
    let row = "";
    const line: AppearanceRun[] = [];
    let start = 0;
    const spell = (x: number) => {
      const style = grid.styleAt(x, y);
      const colour = (value: number | undefined) =>
        value === undefined ? "-" : value.toString(16).padStart(6, "0");
      return `${colour(style.foreground)}|${colour(style.background)}|${style.attrs.join(",")}`;
    };
    for (let x = 0; x < size.columns; x += 1) {
      row += grid.at(x, y);
      if (x + 1 === size.columns || spell(x + 1) !== spell(start)) {
        const [fg, bg, attrs] = spell(start).split("|");
        line.push({ x: start, width: x + 1 - start, fg, bg, attrs });
        start = x + 1;
      }
    }
    rows.push(row);
    runs.push({ y, runs: line });
  }
  return { rows, runs };
}

/**
 * What a candidate screen differs from a record by, in rows a person can read.
 *
 * Text first and style second, because a row whose words changed explains its
 * own style runs; and bounded, because a record that drifted everywhere is a
 * thing to look at rather than a thing to scroll.
 */
export function differences(
  record: AppearanceRecord,
  rows: readonly string[],
  runs: readonly AppearanceLine[],
): readonly string[] {
  const found: string[] = [];
  for (let y = 0; y < record.rows.length; y += 1) {
    const expected = record.rows[y] ?? "";
    const actual = rows[y] ?? "";
    if (expected !== actual) {
      found.push(
        `row ${y} text\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(
          actual,
        )}`,
      );
    }
  }
  const spell = (one: readonly AppearanceRun[]) =>
    one.map((run) => `${run.x}+${run.width}:${run.fg}/${run.bg}/${run.attrs}`).join(" ");
  for (const line of record.styleRuns) {
    const actual = runs.find((one) => one.y === line.y)?.runs ?? [];
    if (spell(line.runs) !== spell(actual)) {
      found.push(
        `row ${line.y} style\n  expected: ${spell(line.runs)}\n  actual:   ${spell(actual)}`,
      );
    }
  }
  return found;
}
