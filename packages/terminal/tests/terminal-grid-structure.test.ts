/**
 * Tier TG — the authored structure of a terminal grid (spec §6.21).
 *
 * The grid is installed syntax: these rows drive it through the same
 * `ExecutionInstallation` an ordinary run installs, so what they prove about
 * the grammar, the layout and the refusal is proved about the form execution
 * selects rather than about a table written beside it.
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

import { Component } from "../../core/src/component-api.ts";
import { expandSegments } from "../../core/src/expand.ts";
import { renderSegments } from "../../core/src/render.ts";
import { scanSegments } from "../../core/src/scanner.ts";
import { installedAuthority } from "../../core/tests/support/installed-structural.ts";
import type { Json, Segment } from "../../core/src/types.ts";
import { terminalGridLayout } from "../mod.ts";
import { TERMINAL_XMD_ORIGIN, terminalGridInstallation } from "../xmd.ts";
import { validateDocument } from "../../core/src/document-validation.ts";
import type { DocumentValidation } from "../../core/src/document-validation.ts";
import { inlineSource, retainedSource } from "../../core/src/root-source.ts";
import { collect } from "../../core/src/collect.ts";
import { executeInstalled } from "../../core/host.ts";
import type { ExecutionInstallation } from "../../core/host.ts";
import { InMemoryStream } from "@executablemd/durable-streams";

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
    const authority = yield* installedAuthority(terminalGridInstallation());
    const segments = yield* expandSegments(
      scanSegments(source),
      {},
      {},
      new Set(),
      undefined,
      undefined,
      "",
      0,
      undefined,
      authority,
    );
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

/** The invocation names one validation reported, in document order. */
function names(result: DocumentValidation): string[] {
  return result.invocations.map((invocation) => invocation.name);
}

function named(result: DocumentValidation, name: string) {
  const found = result.invocations.find((invocation) => invocation.name === name);
  if (found === undefined) {
    throw new Error(`no invocation named ${name} in [${names(result).join(", ")}]`);
  }
  return found;
}

function codes(result: DocumentValidation): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

/** One grid installation whose expander counts the occurrences it is given. */
function countingInstallation(): {
  installation: ExecutionInstallation;
  expansions: () => number;
} {
  const declared = terminalGridInstallation();
  const expand = declared.expand;
  if (expand === undefined) {
    throw new Error("the grid installation supplies no expander");
  }
  let reached = 0;
  return {
    installation: {
      declarations: declared.declarations,
      *expand(request, regions) {
        reached++;
        yield* expand(request, regions);
      },
    },
    expansions: () => reached,
  };
}

/**
 * Validate one document against the installed grid declarations.
 *
 * Validation is handed the declarations and nothing else. `expansions()`
 * answering zero says the expander was not reached — and it is not a vacuous
 * zero, because the row below drives the same counter through a real execution
 * and watches it move.
 */
function validateGrid(
  source: string,
): Operation<{ result: DocumentValidation; expansions: () => number }> {
  return scoped(function* () {
    const { installation, expansions } = countingInstallation();
    const result = yield* validateDocument({
      ...inlineSource(source),
      includes: [],
      declarations: [...(installation.declarations ?? [])],
    });
    return { result, expansions };
  });
}

describe("Tier DV — validating a grid without running one", () => {
  const GRID_DOC = [
    "<Terminal.Grid columns={2}>",
    '<Terminal title="Agent">',
    "The briefing this pane runs.",
    "</Terminal>",
    '<Terminal title="Shell" />',
    "</Terminal.Grid>",
    "",
  ].join("\n");

  it("TG3: a well-formed grid is valid, and nothing beneath it runs", function* () {
    const { result, expansions } = yield* validateGrid(GRID_DOC);

    expect(result.outcome).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(names(result)).toEqual(["Terminal.Grid", "Terminal", "Terminal"]);
    expect(named(result, "Terminal.Grid").origin).toEqual({
      kind: "declared-structural",
      origin: TERMINAL_XMD_ORIGIN,
    });
    expect(named(result, "Terminal").origin).toEqual({
      kind: "declared-structural",
      origin: TERMINAL_XMD_ORIGIN,
    });
    // Validation reads the declarations and never the implementation: no
    // occurrence reached the expander, so nothing derived a layout and nothing
    // refused for want of a provider.
    expect(expansions()).toBe(0);
  });

  it("TG3: reports each invalid authored form, with no execution", function* () {
    const invalid: [string, string, string][] = [
      [
        "an unknown prop on the grid",
        '<Terminal.Grid columns={2} layout="tiled"><Terminal title="A" /></Terminal.Grid>\n',
        '<Terminal.Grid> only accepts a "columns" prop. Got: "layout".',
      ],
      [
        "a capture on the grid",
        '<Terminal.Grid columns={2} as="grid"><Terminal title="A" /></Terminal.Grid>\n',
        '<Terminal.Grid> only accepts a "columns" prop. Got: "as".',
      ],
      [
        "no column count",
        '<Terminal.Grid><Terminal title="A" /></Terminal.Grid>\n',
        '<Terminal.Grid> requires a "columns" prop (a positive integer).',
      ],
      [
        "a column count that is not a positive integer",
        '<Terminal.Grid columns={0}><Terminal title="A" /></Terminal.Grid>\n',
        'Prop "columns" on <Terminal.Grid> must be a positive integer. Got: 0.',
      ],
      [
        "an unknown prop on a pane",
        '<Terminal.Grid columns={2}><Terminal title="A" shell="zsh" /></Terminal.Grid>\n',
        '<Terminal> only accepts a "title" prop. Got: "shell".',
      ],
      [
        "no title on a pane",
        "<Terminal.Grid columns={2}><Terminal /></Terminal.Grid>\n",
        '<Terminal> requires a "title" prop (the label the pane displays).',
      ],
      [
        "an empty title",
        '<Terminal.Grid columns={2}><Terminal title="" /></Terminal.Grid>\n',
        'Prop "title" on <Terminal> must be a non-empty string. Got: "".',
      ],
      [
        "a self-closing grid",
        "<Terminal.Grid columns={2} />\n",
        "<Terminal.Grid> holds the panes it lays out",
      ],
      [
        "a grid with no pane",
        "<Terminal.Grid columns={2}></Terminal.Grid>\n",
        "<Terminal.Grid> requires at least one <Terminal> pane.",
      ],
      [
        "text written directly in a grid",
        '<Terminal.Grid columns={2}>a note<Terminal title="A" /></Terminal.Grid>\n',
        '<Terminal.Grid> holds only <Terminal> panes. Found text "a note" directly inside it.',
      ],
      [
        "a direct element that is not a pane",
        '<Terminal.Grid columns={2}><Note title="x" /><Terminal title="A" /></Terminal.Grid>\n',
        "<Terminal.Grid> holds only <Terminal> panes. Found <Note> directly inside it.",
      ],
      [
        "a pane produced by control flow",
        '<Terminal.Grid columns={2}><If condition={true}><Terminal title="A" /></If></Terminal.Grid>\n',
        "<Terminal.Grid> holds only <Terminal> panes. Found <If> directly inside it.",
      ],
      [
        "a nested grid",
        '<Terminal.Grid columns={2}><Terminal title="A"><Terminal.Grid columns={1}>' +
          '<Terminal title="B" /></Terminal.Grid></Terminal></Terminal.Grid>\n',
        "<Terminal.Grid> cannot be written inside another <Terminal.Grid>.",
      ],
      [
        "a pane outside every grid",
        '<Terminal title="A">alone</Terminal>\n',
        "<Terminal> must be a direct child of <Terminal.Grid>.",
      ],
      [
        "a pane below a grid that is not one of its panes",
        '<Terminal.Grid columns={2}><Terminal title="A"><Terminal title="B" /></Terminal>' +
          "</Terminal.Grid>\n",
        "<Terminal> must be a direct child of <Terminal.Grid>.",
      ],
    ];

    for (const [form, source, message] of invalid) {
      const { result, expansions } = yield* validateGrid(source);

      expect(`${form}: ${result.outcome}`).toBe(`${form}: invalid`);
      expect(`${form}: ${codes(result).includes("structural-usage-invalid")}`).toBe(
        `${form}: true`,
      );
      const said = result.diagnostics.some((diagnostic) => diagnostic.message.includes(message));
      expect(`${form}: ${said}`).toBe(`${form}: true`);
      expect(`${form}: ${expansions()}`).toBe(`${form}: 0`);
    }
  });

  it("TG3: answers the same way twice", function* () {
    const first = yield* validateGrid("<Terminal.Grid columns={2}><Terminal /></Terminal.Grid>\n");
    const second = yield* validateGrid("<Terminal.Grid columns={2}><Terminal /></Terminal.Grid>\n");

    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
  });

  it("TG3: a dynamic column count and title are decided by expansion, not here", function* () {
    const { result, expansions } = yield* validateGrid(
      ["<Terminal.Grid columns={size}>", "<Terminal title={label} />", "</Terminal.Grid>", ""].join(
        "\n",
      ),
    );

    // Whether those expressions produce a positive integer and a non-empty
    // string is a value the document computes, and evaluating one is
    // expansion's alone.
    expect(result.outcome).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(expansions()).toBe(0);
  });
});

describe("Tier DV — validation reaches no expander, execution does", () => {
  it("TG3: the same counter stays at zero for validation and moves for a run", function* () {
    const source = '<Terminal.Grid columns={1}><Terminal title="A" /></Terminal.Grid>\n';
    const { installation, expansions } = countingInstallation();

    yield* scoped(function* () {
      yield* validateDocument({
        ...inlineSource(source),
        includes: [],
        declarations: [...(installation.declarations ?? [])],
      });
    });
    expect(expansions()).toBe(0);

    yield* scoped(function* () {
      try {
        yield* collect(
          yield* executeInstalled(
            { ...retainedSource("root.md", source), stream: new InMemoryStream(), includes: [] },
            [installation],
          ),
        );
      } catch {
        // The grid refuses for want of a provider, which is the point: the
        // expander ran.
      }
    });
    expect(expansions()).toBe(1);
  });
});
