/**
 * Tier TG — the authored structure of a terminal grid (spec §6.21).
 *
 * What an author may write, and where each pane lands, decided before anything
 * opens. These rows drive the real expansion path: a grid the grammar accepts
 * runs until the point a terminal provider would be asked for one, and this
 * build installs none, so it refuses there and carries the layout it derived
 * beside the refusal.
 *
 * Provider non-observation is asserted rather than assumed. Every run traps the
 * two boundaries a pane's body would cross — resolving a component and running
 * a code block — and a row is evidence only when both stayed empty. That the
 * machine running these tests has no tmux is not evidence of anything: nothing
 * here would look for one.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { terminalGridLayout } from "../src/terminal-grid.ts";
import type { Json, Segment } from "../src/types.ts";

interface GridRun {
  segments: Segment[];
  output: string;
  /** Every component the run tried to resolve, in order. */
  imports: string[];
  /** The source of every code block the run ran, in order. */
  blocks: string[];
  /** Every expression the document evaluated, by label, in order. */
  calls: string[];
}

/**
 * Expand one document with every effect a pane could have trapped.
 *
 * A component this run resolves, a code block it runs, or an expression it
 * evaluates is recorded rather than performed, so "nothing beneath the grid
 * happened" is something the row reads back instead of assuming.
 */
function runGrid(source: string, values: Record<string, unknown> = {}): Operation<GridRun> {
  return scoped(function* () {
    const imports: string[] = [];
    const blocks: string[] = [];
    const calls: string[] = [];
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          imports.push(name);
          throw new Error(`Component not found: ${name}`);
        },
        // deno-lint-ignore require-yield
        *applyModifiers([_modifiers, context], _next) {
          blocks.push(context.content);
          return { output: "", exitCode: 0, stderr: "" };
        },
      },
      { at: "min" },
    );
    const testEnv = {
      values: {
        ...values,
        seen: (label: string, value: unknown) => {
          calls.push(label);
          return value;
        },
      },
    };
    yield* Component.around({ env: () => testEnv }, { at: "min" });
    const segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
    return { segments, output: renderSegments(segments), imports, blocks, calls };
  });
}

function errorMessages(segments: Segment[]): string[] {
  return segments.filter((segment) => segment.type === "error").map((segment) => segment.message);
}

/** The one message a run that refused for a single reason reports. */
function soleError(run: GridRun): string {
  const messages = errorMessages(run.segments);
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

/**
 * The grid a run derived, read from the refusal that carries it.
 *
 * A run that refused for a grammar or placement reason never derived one, so
 * asking for it is also how a row states that the grid was complete.
 */
function derivedLayout(run: GridRun): Json {
  const refusal = run.segments.find(
    (segment) => segment.type === "error" && segment.source === "Terminal.Grid",
  );
  if (refusal === undefined || refusal.type !== "error" || refusal.cause === undefined) {
    throw new Error(`no terminal-grid refusal carrying a layout: ${errorMessages(run.segments)}`);
  }
  return refusal.cause;
}

/** Every boundary a pane's body would have crossed, and none of them did. */
function reachedNothing(run: GridRun): void {
  expect(run.imports).toEqual([]);
  expect(run.blocks).toEqual([]);
  expect(run.calls).toEqual([]);
}

/**
 * Work a pane's body would do, so a body that expanded would be recorded.
 *
 * One of each boundary `reachedNothing()` reads: a component to resolve, an
 * expression to evaluate, and a command to run.
 */
const PANE_BODY = [
  "<Boom />",
  "",
  '<If condition={seen("pane-condition", true)}>reached</If>',
  "",
  "```bash exec",
  "echo ran",
  "```",
].join("\n");

describe("Tier TG — the grid grammar", () => {
  it("TG1: accepts a paired grid with positive integer columns and both pane forms", function* () {
    const run = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Agent">Instructions.</Terminal>',
        '<Terminal title="Shell" />',
        "</Terminal.Grid>",
      ].join("\n"),
    );

    // The grammar accepted it, so the run reached the one thing this build
    // cannot do — and stopped there.
    expect(soleError(run)).toContain("no terminal provider opened this grid");
    expect(derivedLayout(run)).toEqual({
      layout: {
        columns: 2,
        rows: 1,
        cells: [
          { ordinal: 0, row: 0, column: 0, title: "Agent", form: "paired" },
          { ordinal: 1, row: 0, column: 1, title: "Shell", form: "self-closing" },
        ],
      },
    });
  });

  it("TG1: refuses an unknown prop and `as` on the grid", function* () {
    const unknown = yield* runGrid(
      '<Terminal.Grid columns={2} layout="tiled"><Terminal title="A" /></Terminal.Grid>',
    );
    expect(soleError(unknown)).toContain(
      '<Terminal.Grid> only accepts a "columns" prop. Got: "layout".',
    );

    const captured = yield* runGrid(
      '<Terminal.Grid columns={2} as="grid"><Terminal title="A" /></Terminal.Grid>',
    );
    expect(soleError(captured)).toContain(
      '<Terminal.Grid> only accepts a "columns" prop. Got: "as".',
    );
    reachedNothing(unknown);
    reachedNothing(captured);
  });

  it("TG1: refuses an unknown prop and `as` on a pane", function* () {
    const unknown = yield* runGrid(
      '<Terminal.Grid columns={2}><Terminal title="A" shell="zsh" /></Terminal.Grid>',
    );
    expect(soleError(unknown)).toContain('<Terminal> only accepts a "title" prop. Got: "shell".');

    const captured = yield* runGrid(
      '<Terminal.Grid columns={2}><Terminal title="A" as="pane" /></Terminal.Grid>',
    );
    expect(soleError(captured)).toContain('<Terminal> only accepts a "title" prop. Got: "as".');
    reachedNothing(unknown);
    reachedNothing(captured);
  });

  it("TG1: requires columns to be a positive integer, however it was written", function* () {
    const missing = yield* runGrid('<Terminal.Grid><Terminal title="A" /></Terminal.Grid>');
    expect(soleError(missing)).toContain(
      '<Terminal.Grid> requires a "columns" prop (a positive integer).',
    );

    for (const literal of ["{0}", "{-1}", "{2.5}", '"2"', "{null}"]) {
      const run = yield* runGrid(
        `<Terminal.Grid columns=${literal}><Terminal title="A" /></Terminal.Grid>`,
      );
      expect(soleError(run)).toContain('Prop "columns" on <Terminal.Grid> must be a positive');
      reachedNothing(run);
    }

    // The same rule reaches a value the document computes, which the source
    // could not have decided about.
    const computed = yield* runGrid(
      '<Terminal.Grid columns={size}><Terminal title="A" /></Terminal.Grid>',
      { size: 0 },
    );
    expect(soleError(computed)).toContain(
      'Prop "columns" on <Terminal.Grid> must be a positive integer. Got: 0.',
    );
    reachedNothing(computed);
  });

  it("TG1: requires a non-empty title on every pane, however it was written", function* () {
    const missing = yield* runGrid("<Terminal.Grid columns={2}><Terminal /></Terminal.Grid>");
    expect(soleError(missing)).toContain(
      '<Terminal> requires a "title" prop (the label the pane displays).',
    );

    for (const literal of ['""', "{3}", "{null}"]) {
      const run = yield* runGrid(
        `<Terminal.Grid columns={2}><Terminal title=${literal} /></Terminal.Grid>`,
      );
      expect(soleError(run)).toContain('Prop "title" on <Terminal> must be a non-empty string');
      reachedNothing(run);
    }

    const computed = yield* runGrid(
      "<Terminal.Grid columns={2}><Terminal title={label} /></Terminal.Grid>",
      { label: "" },
    );
    expect(soleError(computed)).toContain(
      'Prop "title" on <Terminal> must be a non-empty string. Got: "".',
    );
    reachedNothing(computed);
  });

  it("TG1: refuses a self-closing grid", function* () {
    const run = yield* runGrid("<Terminal.Grid columns={2} />");
    expect(soleError(run)).toContain("<Terminal.Grid> holds the panes it lays out");
    reachedNothing(run);
  });
});

describe("Tier TG — structural placement", () => {
  it("TG2: refuses a grid with no pane", function* () {
    const run = yield* runGrid("<Terminal.Grid columns={2}></Terminal.Grid>");
    expect(soleError(run)).toContain("<Terminal.Grid> requires at least one <Terminal> pane.");
    reachedNothing(run);
  });

  it("TG2: refuses ordinary text written directly in a grid", function* () {
    const run = yield* runGrid(
      '<Terminal.Grid columns={2}>a note<Terminal title="A" /></Terminal.Grid>',
    );
    expect(soleError(run)).toContain(
      '<Terminal.Grid> holds only <Terminal> panes. Found text "a note" directly inside it.',
    );
    reachedNothing(run);
  });

  it("TG2: refuses a direct element that is not a pane", function* () {
    const run = yield* runGrid(
      '<Terminal.Grid columns={2}><Boom /><Terminal title="A" /></Terminal.Grid>',
    );
    expect(soleError(run)).toContain(
      "<Terminal.Grid> holds only <Terminal> panes. Found <Boom> directly inside it.",
    );
    // The element was refused as authored structure, so it was never resolved.
    reachedNothing(run);
  });

  it("TG2: refuses a control structure that would produce the panes", function* () {
    const run = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        '<If condition={seen("condition", true)}>',
        '<Terminal title="A" />',
        "</If>",
        "</Terminal.Grid>",
      ].join("\n"),
    );

    const messages = errorMessages(run.segments);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(
      "<Terminal.Grid> holds only <Terminal> panes. Found <If> directly inside it.",
    );
    expect(messages[0]).toContain("Write control flow inside a pane instead.");
    expect(messages[1]).toContain("<Terminal> must be a direct child of <Terminal.Grid>.");
    // The condition decides which panes would exist, and the grid must know
    // that from the source, so it is never evaluated.
    reachedNothing(run);
  });

  it("TG2: refuses a grid nested inside a pane", function* () {
    const run = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Outer">',
        '<Terminal.Grid columns={1}><Terminal title="Inner" /></Terminal.Grid>',
        "</Terminal>",
        "</Terminal.Grid>",
      ].join("\n"),
    );
    expect(soleError(run)).toContain(
      "<Terminal.Grid> cannot be written inside another <Terminal.Grid>.",
    );
    reachedNothing(run);
  });

  it("TG2: refuses a pane written outside every grid", function* () {
    const alone = yield* runGrid('<Terminal title="A">Instructions.</Terminal>');
    expect(soleError(alone)).toContain("<Terminal> must be a direct child of <Terminal.Grid>.");

    // Below a grid but not one of its panes is the same mistake, reported where
    // the pane was written.
    const buried = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Outer">',
        '<Terminal title="Inner" />',
        "</Terminal>",
        "</Terminal.Grid>",
      ].join("\n"),
    );
    expect(soleError(buried)).toContain("<Terminal> must be a direct child of <Terminal.Grid>.");
    reachedNothing(alone);
    reachedNothing(buried);
  });

  it("TG2: treats whitespace between panes as nothing at all", function* () {
    const run = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        "",
        '  <Terminal title="A" />',
        "",
        '  <Terminal title="B" />',
        "",
        "</Terminal.Grid>",
      ].join("\n"),
    );

    expect(soleError(run)).toContain("no terminal provider opened this grid");
    expect(derivedLayout(run)).toEqual({
      layout: {
        columns: 2,
        rows: 1,
        cells: [
          { ordinal: 0, row: 0, column: 0, title: "A", form: "self-closing" },
          { ordinal: 1, row: 0, column: 1, title: "B", form: "self-closing" },
        ],
      },
    });
  });

  it("TG2: a complete grid refuses before any pane body or default shell", function* () {
    const run = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Work">',
        "",
        PANE_BODY,
        "</Terminal>",
        '<Terminal title="Shell" />',
        "</Terminal.Grid>",
      ].join("\n"),
    );

    expect(soleError(run)).toContain("no pane expanded its content and no default shell started.");
    // The pane held a component and a command; neither was reached, and the
    // grid rendered nothing of its own.
    reachedNothing(run);
    expect(run.output).toContain("no terminal provider opened this grid");
  });
});

describe("Tier TG — row-major layout", () => {
  const positions = (columns: number, panes: number) =>
    terminalGridLayout(
      columns,
      Array.from({ length: panes }, (_unused, index) => ({
        title: `pane ${index}`,
        form: "self-closing" as const,
      })),
    ).cells.map((cell) => [cell.row, cell.column]);

  it("TG4: places one through five panes row-major across two columns", function* () {
    expect(positions(2, 1)).toEqual([[0, 0]]);
    expect(positions(2, 2)).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(positions(2, 3)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(positions(2, 4)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(positions(2, 5)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
    // The last row is left short rather than balanced or padded.
    expect([1, 2, 3, 4, 5].map((panes) => terminalGridLayout(2, filler(panes)).rows)).toEqual([
      1, 1, 2, 2, 3,
    ]);
  });

  it("TG4: places one through five panes row-major across three columns", function* () {
    expect(positions(3, 1)).toEqual([[0, 0]]);
    expect(positions(3, 2)).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(positions(3, 3)).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
    expect(positions(3, 4)).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
    ]);
    expect(positions(3, 5)).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
    ]);
    expect([1, 2, 3, 4, 5].map((panes) => terminalGridLayout(3, filler(panes)).rows)).toEqual([
      1, 1, 1, 2, 2,
    ]);
  });

  it("TG4: an executed grid derives those same positions", function* () {
    const run = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="One" />',
        '<Terminal title="Two" />',
        '<Terminal title="Three" />',
        '<Terminal title="Four" />',
        '<Terminal title="Five" />',
        "</Terminal.Grid>",
      ].join("\n"),
    );

    expect(derivedLayout(run)).toEqual({
      layout: {
        columns: 2,
        rows: 3,
        cells: [
          { ordinal: 0, row: 0, column: 0, title: "One", form: "self-closing" },
          { ordinal: 1, row: 0, column: 1, title: "Two", form: "self-closing" },
          { ordinal: 2, row: 1, column: 0, title: "Three", form: "self-closing" },
          { ordinal: 3, row: 1, column: 1, title: "Four", form: "self-closing" },
          { ordinal: 4, row: 2, column: 0, title: "Five", form: "self-closing" },
        ],
      },
    });
  });

  it("TG4: duplicate titles stay valid, and identity is the ordinal", function* () {
    const run = yield* runGrid(
      [
        "<Terminal.Grid columns={2}>",
        '<Terminal title="Agent">first</Terminal>',
        '<Terminal title="Agent" />',
        '<Terminal title="Agent">third</Terminal>',
        "</Terminal.Grid>",
      ].join("\n"),
    );

    // Three panes sharing one label are three panes: the ordinal separates
    // them, and the form each one was written in travels with it.
    expect(derivedLayout(run)).toEqual({
      layout: {
        columns: 2,
        rows: 2,
        cells: [
          { ordinal: 0, row: 0, column: 0, title: "Agent", form: "paired" },
          { ordinal: 1, row: 0, column: 1, title: "Agent", form: "self-closing" },
          { ordinal: 2, row: 1, column: 0, title: "Agent", form: "paired" },
        ],
      },
    });
  });
});

/** Panes that differ only in count, for a row about rows. */
function filler(panes: number): { title: string; form: "self-closing" }[] {
  return Array.from({ length: panes }, (_unused, index) => ({
    title: `pane ${index}`,
    form: "self-closing" as const,
  }));
}
