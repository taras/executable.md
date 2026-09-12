/**
 * The executable-Markdown syntax that arranges a terminal grid.
 *
 * One `ExecutionInstallation` declares both forms and implements them, so a
 * profile that installs this gets the syntax, its validation, its inspection
 * entry and its expansion together — and a profile that does not install it has
 * none of them. Canonical core contains no name, rule or branch of its own for
 * either form.
 *
 * What the expansion does here is derive the arrangement and refuse: a grid is
 * opened by a terminal provider, and this integration installs none. The
 * refusal is closed — no pane expanded its content and no shell started — and
 * it carries the grid the author asked for as its cause, so an assertion is
 * about the layout that was derived rather than about the wording.
 */

import type { ExecutionInstallation, StructuralDeclaration } from "@executablemd/core/host";
import type { ExpansionRegion, ExpansionRequest } from "@executablemd/core";
import type { Operation } from "effection";

import { terminalGridLayout } from "./layout.ts";
import type { PlacedPane, TerminalPaneForm } from "./layout.ts";

/** The package this syntax reports itself as coming from. */
export const TERMINAL_XMD_ORIGIN = "@executablemd/terminal/xmd";

export const TERMINAL_GRID = "Terminal.Grid";
export const TERMINAL_PANE = "Terminal";

const STRAY_PANE =
  "<Terminal> must be a direct child of <Terminal.Grid>. <Terminal> is reserved: it never " +
  "resolves a component, and only the grid it belongs to can place it.";

const gridDeclaration: StructuralDeclaration = {
  kind: "structural",
  name: TERMINAL_GRID,
  origin: TERMINAL_XMD_ORIGIN,
  forms: ["paired"],
  props: {
    type: "object",
    properties: {
      // A positive integer, spelled as a number with a whole-number constraint
      // rather than as `integer`: the two report a fractional count under
      // different keywords, and the sentence a reader gets is decided by which.
      columns: { type: "number", multipleOf: 1, minimum: 1 },
    },
    required: ["columns"],
    additionalProperties: false,
  },
  syntax: ["<Terminal.Grid columns={2}>…</Terminal.Grid>"],
  description:
    "Open several terminals in one view. " +
    '`<Terminal.Grid columns={2}><Terminal title="Agent">…</Terminal></Terminal.Grid>`',
  context: "The `<Terminal>` panes the grid lays out.",
  placement: { kind: "parent", minimumChildren: 1, nested: "forbidden" },
  diagnostics: {
    selfClosingParent:
      "<Terminal.Grid> holds the panes it lays out, so it is written paired: " +
      '<Terminal.Grid columns={2}><Terminal title="One" /></Terminal.Grid>.',
    minimumChildren: "<Terminal.Grid> requires at least one <Terminal> pane.",
    unknownProp: '<Terminal.Grid> only accepts a "columns" prop. Got: "{found}".',
    unexpectedChild:
      "<Terminal.Grid> holds only <Terminal> panes. Found {found} " +
      "directly inside it. Write control flow inside a pane instead.",
    nestedParent:
      "<Terminal.Grid> cannot be written inside another <Terminal.Grid>. A grid " +
      "lays out the panes it is written with, so one pane cannot become a grid of its own.",
    misplacedChild: STRAY_PANE,
    props: {
      columns: {
        missing: '<Terminal.Grid> requires a "columns" prop (a positive integer).',
        invalidType: 'Prop "columns" on <Terminal.Grid> must be a positive integer, not {kind}.',
        invalidValue: 'Prop "columns" on <Terminal.Grid> must be a positive integer. Got: {value}.',
      },
    },
  },
};

const paneDeclaration: StructuralDeclaration = {
  kind: "structural",
  name: TERMINAL_PANE,
  origin: TERMINAL_XMD_ORIGIN,
  forms: ["self-closing", "paired"],
  props: {
    type: "object",
    properties: { title: { type: "string", minLength: 1 } },
    required: ["title"],
    additionalProperties: false,
  },
  syntax: ['<Terminal title="Agent">…</Terminal>', '<Terminal title="Shell" />'],
  description:
    "Expand Markdown or open a shell in a pane. " +
    '`<Terminal title="Agent">…</Terminal>` runs content; ' +
    '`<Terminal title="Shell" />` opens a shell.',
  context: "Markdown the pane runs, in the paired form.",
  placement: { kind: "child", parent: TERMINAL_GRID },
  diagnostics: {
    unknownProp: '<Terminal> only accepts a "title" prop. Got: "{found}".',
    misplacedChild: STRAY_PANE,
    props: {
      title: {
        missing: '<Terminal> requires a "title" prop (the label the pane displays).',
        invalidType: 'Prop "title" on <Terminal> must be a non-empty string, not {kind}.',
        invalidValue: 'Prop "title" on <Terminal> must be a non-empty string. Got: {value}.',
      },
    },
  },
};

/** What a complete grid says on a host where nothing can open one. */
export function noTerminalProviderMessage(): string {
  return (
    "no terminal provider opened this grid. A host installs the terminal-grid capability " +
    "explicitly, and this one installs none, so no pane expanded its content and no default " +
    "shell started."
  );
}

/** A grid nothing opened, carrying the arrangement the author asked for. */
export class NoTerminalProviderError extends Error {
  override name = "NoTerminalProviderError";
}

function paneTitle(region: ExpansionRegion): string {
  const title = region.props["title"];
  return typeof title === "string" ? title : "";
}

function paneForm(region: ExpansionRegion): TerminalPaneForm {
  return region.form === "self-closing" ? "self-closing" : "paired";
}

/**
 * Arrange the grid the author wrote, then refuse for want of a provider.
 *
 * The props arrived evaluated and checked against the declarations above, and
 * the regions are the accepted panes in source order — so the whole layout is
 * known here. No region is expanded, which is what makes the refusal a closed
 * one rather than a partial grid left behind.
 */
// deno-lint-ignore require-yield
function* expandTerminalGrid(
  request: ExpansionRequest,
  regions: readonly ExpansionRegion[],
): Operation<void> {
  const columns = request.props["columns"];
  if (typeof columns !== "number") {
    throw new Error('<Terminal.Grid> requires a "columns" prop (a positive integer).');
  }
  const placed: PlacedPane[] = regions.map((region) => ({
    title: paneTitle(region),
    form: paneForm(region),
  }));
  const layout = terminalGridLayout(columns, placed);
  throw new NoTerminalProviderError(noTerminalProviderMessage(), {
    cause: {
      layout: {
        columns: layout.columns,
        rows: layout.rows,
        cells: layout.cells.map((cell) => ({ ...cell })),
      },
    },
  });
}

/**
 * The one installation that adds terminal-grid syntax to an execution.
 *
 * A fresh record each call, so one run's installation is never the object
 * another run resolves through.
 */
export function terminalGridInstallation(): ExecutionInstallation {
  return {
    declarations: [gridDeclaration, paneDeclaration],
    expand: expandTerminalGrid,
  };
}
