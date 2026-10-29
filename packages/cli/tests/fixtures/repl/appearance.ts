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
import { z } from "zod";
import type { Operation } from "effection";
import type { DurableEvent } from "@executablemd/durable-streams";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { ReplModel } from "../../../src/repl/model.ts";
import { projectRepl } from "../../../src/repl/model.ts";
import type { ReplTerminalSize } from "../../../src/repl/terminal.ts";
import type { TerminalGrid } from "./presentation.ts";

/**
 * What a stored record has to be, as a schema the record is parsed through.
 *
 * Parsed rather than asserted: a record whose size lost a number, whose
 * authority holds something other than a string, or whose runs are missing a
 * width fails here, naming the member, instead of being handed on as a shape
 * the type said it had.
 */
const RUN = z
  .object({
    x: z.number(),
    width: z.number(),
    fg: z.string(),
    bg: z.string(),
    attrs: z.string(),
  })
  .strict();

const RECORD = z
  .object({
    profile: z.string().min(1),
    size: z.object({ columns: z.number(), rows: z.number() }).strict(),
    input: z
      .object({
        journal: z.string().min(1),
        journalSha256: z.string().min(1),
        workspace: z.string().min(1),
        initialFocus: z.string().min(1),
        focused: z.string().optional(),
      })
      .strict(),
    authority: z.record(z.string(), z.string()),
    rows: z.array(z.string()),
    styleRuns: z.array(z.object({ y: z.number(), runs: z.array(RUN) }).strict()),
    expectedSha256: z.string().min(1),
  })
  .strict();

/** One run of cells drawn in one style. */
export type AppearanceRun = z.infer<typeof RUN>;

/** One row's runs, as a record stores them. */
export type AppearanceLine = z.infer<typeof RECORD>["styleRuns"][number];

/** What one profile is expected to look like. */
export type AppearanceRecord = z.infer<typeof RECORD>;

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
  for (const [order, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    // The product's own parser, not JSON.parse with a type written over it: a
    // line this rejects is not an event, and a fixture that cast it would be
    // describing a screen drawn from something else.
    const parsed = parseDurableEvent(line);
    if (!parsed.ok) {
      throw new Error(`appearance journal line ${order + 1} is not a durable event`, {
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

/** One stored record, parsed into the structure it is supposed to be. */
export function readAppearanceRecord(profile: string, text: string): AppearanceRecord {
  const parsed = RECORD.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`the ${profile} appearance record is not one: ${parsed.error.message}`);
  }
  const record = parsed.data;
  if (record.profile !== profile) {
    throw new Error(`the ${profile} record says it is ${record.profile}`);
  }
  if (record.rows.length !== record.size.rows) {
    throw new Error(
      `the ${profile} record holds ${record.rows.length} rows for a screen of ${record.size.rows}`,
    );
  }
  return record;
}

/** That record, read from the repository data beside this module. */
export function* appearanceRecord(profile: string): Operation<AppearanceRecord> {
  return readAppearanceRecord(profile, yield* readTextFile(at(`${profile}.json`)));
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
