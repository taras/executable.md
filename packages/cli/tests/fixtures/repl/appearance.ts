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
 * produced once and kept, so a profile case replays events rather than running
 * a document again: nothing here is re-executed to find out what colour a row
 * is. Everything it reads is repository data reached from this module's own
 * URL, so the records travel with the tests rather than with a machine.
 */
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import type { Operation } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
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
  readonly authority: Record<string, string>;
  readonly rows: readonly string[];
  readonly styleRuns: readonly { readonly y: number; readonly runs: readonly AppearanceRun[] }[];
  readonly expectedSha256: string;
}

function at(name: string): string {
  return fileURLToPath(new URL(`./appearance/${name}`, import.meta.url));
}

/** The recorded events this appearance is drawn from. */
export function* appearanceEvents(): Operation<readonly DurableEvent[]> {
  const text = yield* readTextFile(at("journal.jsonl"));
  return Object.freeze(
    text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as DurableEvent),
  );
}

/** That recording, through the canonical projection the product reads with. */
export function* appearanceModel(): Operation<ReplModel> {
  const projected = projectRepl(yield* appearanceEvents());
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

/** One stored record, by its profile name. */
export function* appearanceRecord(profile: string): Operation<AppearanceRecord> {
  return JSON.parse(yield* readTextFile(at(`${profile}.json`))) as AppearanceRecord;
}

/** The size one record is of. */
export function sizeOf(record: AppearanceRecord): ReplTerminalSize {
  return Object.freeze({ columns: record.size.columns, rows: record.size.rows });
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
  runs: readonly { readonly y: number; readonly runs: readonly AppearanceRun[] }[],
): readonly string[] {
  const found: string[] = [];
  for (let y = 0; y < record.rows.length; y += 1) {
    const expected = record.rows[y] ?? "";
    const actual = rows[y] ?? "";
    if (expected !== actual) {
      found.push(
        `row ${y} text\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const line of record.styleRuns) {
    const actual = runs.find((one) => one.y === line.y)?.runs ?? [];
    const spell = (one: readonly AppearanceRun[]) =>
      one.map((run) => `${run.x}+${run.width}:${run.fg}/${run.bg}/${run.attrs}`).join(" ");
    if (spell(line.runs) !== spell(actual)) {
      found.push(
        `row ${line.y} style\n  expected: ${spell(line.runs)}\n  actual:   ${spell(actual)}`,
      );
    }
  }
  return found;
}

/** One committed screen, in the two shapes a record is written in. */
export function screenOf(
  grid: TerminalGrid,
  size: ReplTerminalSize,
): {
  readonly rows: readonly string[];
  readonly runs: readonly { readonly y: number; readonly runs: readonly AppearanceRun[] }[];
} {
  const rows: string[] = [];
  const runs: { y: number; runs: AppearanceRun[] }[] = [];
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
