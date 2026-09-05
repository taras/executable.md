/**
 * The catalog as Markdown a person reads.
 *
 * One renderer, in core, because two things print it: `xmd syntax`, which
 * describes an environment without running it, and canonical `<Syntax>`, which
 * hands the same text to a document that is running. Rendering here is what
 * makes those two answers the same bytes for the same site — a renderer the CLI
 * owned could only be reached by the CLI, and a component in core would have
 * needed a second one.
 *
 * It takes the catalog as a value. It discovers nothing, reads no filesystem,
 * resolves no name and parses no other projection's output, so what it prints is
 * exactly what construction decided.
 *
 * Markdown is written for a person: where a schema carries more than a table can
 * summarize honestly, the table says so and the schema is printed beside it.
 */

import type {
  CompleteComponentSyntaxEntry,
  OriginOnlyComponentSyntaxEntry,
  StructuralSyntaxEntry,
  SyntaxCatalog,
} from "./inspect.ts";
import { NO_DOCUMENTATION } from "./documentation-index.ts";
import type { ComponentOrigin, Json, PropsSchema } from "./types.ts";

/** The three category kinds, taken from the catalog rather than restated. */
type CategoryKind = SyntaxCatalog["categories"][number]["kind"];

const HEADINGS: Record<CategoryKind, string> = {
  structural: "## Built-in structural syntax",
  "built-in": "## Built-in components",
  "user-provided": "## User-provided components",
};

const EMPTY: Record<CategoryKind, string> = {
  structural: "No structural constructs are reserved.",
  "built-in": "No components are registered in this profile.",
  "user-provided": "No components were found in the configured includes.",
};

export function renderSyntaxMarkdown(catalog: SyntaxCatalog): string {
  const sections = catalog.categories.map((category) => {
    const blocks: string[] = [HEADINGS[category.kind]];
    if (category.entries.length === 0) {
      blocks.push(EMPTY[category.kind]);
      return blocks.join("\n\n");
    }
    for (const entry of category.entries) {
      blocks.push(...renderEntry(entry));
    }
    return blocks.join("\n\n");
  });
  return `${sections.join("\n\n")}\n`;
}

/** One catalog entry, as the named form selects it. */
export interface SelectedEntry {
  readonly entry:
    | StructuralSyntaxEntry
    | CompleteComponentSyntaxEntry
    | OriginOnlyComponentSyntaxEntry;
  /** The long-form documentation this entry has, if it has any. */
  readonly documentation: string | undefined;
  /**
   * Whether the current evaluation can actually run this component.
   *
   * Stated rather than implied, because the named form reads from the enclosing
   * authoring catalog: inside a narrowed evaluation it can explain a component
   * the evaluation may not execute, and a reader shown documentation with no
   * word about availability would reasonably assume they had both.
   */
  readonly available: boolean;
}

/**
 * The selected entries, each with its metadata and its long-form documentation.
 *
 * What `<Syntax names={…}>` and `xmd syntax Elicit` both render — one renderer,
 * so the component and the command cannot describe one component two ways.
 */
export function renderSelectedDocumentation(selected: readonly SelectedEntry[]): string {
  const sections = selected.map((one) => {
    const blocks = renderEntry(one.entry);
    blocks.push(`**Available in this evaluation:** ${one.available ? "yes" : "no"}`);
    blocks.push(one.documentation ?? NO_DOCUMENTATION);
    return blocks.join("\n\n");
  });
  return `${sections.join("\n\n")}\n`;
}

function renderEntry(
  entry: StructuralSyntaxEntry | CompleteComponentSyntaxEntry | OriginOnlyComponentSyntaxEntry,
): string[] {
  if (entry.kind === "structural") {
    return renderStructural(entry);
  }
  if (entry.inspectability === "origin-only") {
    return renderOriginOnly(entry);
  }
  return renderComponent(entry);
}

function heading(name: string): string {
  return `### \`<${name}>\``;
}

function renderStructural(entry: StructuralSyntaxEntry): string[] {
  const blocks = [heading(entry.name), entry.description];
  blocks.push("**Syntax:**", fence("md", entry.syntax.join("\n")));
  blocks.push(...prose(entry));
  return blocks;
}

function renderOriginOnly(entry: OriginOnlyComponentSyntaxEntry): string[] {
  return [
    heading(entry.name),
    "This component is a repository TypeScript module. Its contract lives on the module's " +
      "exports, and reading it would import the module and run its top-level code — which " +
      "describing an environment must not do. The module was not imported, so its props, " +
      "captures, forms and return are unavailable here.",
    `**Origin:** ${describeOrigin(entry.origin)}`,
  ];
}

function renderComponent(entry: CompleteComponentSyntaxEntry): string[] {
  const blocks = [heading(entry.name)];
  if (entry.description !== undefined) {
    blocks.push(entry.description);
  }
  blocks.push(`**Forms:** ${entry.forms.map((form) => invocation(entry.name, form)).join(", ")}`);
  blocks.push(...renderProps(entry.props));
  if (entry.captures.length > 0) {
    blocks.push(
      `**Captures:** ${entry.captures.map(code).join(", ")} — evaluated by the component ` +
        "itself, so these props are deliberately absent from the schema above.",
    );
  }
  blocks.push(...prose(entry));
  blocks.push(...renderReturns(entry));
  blocks.push(`**Origin:** ${describeOrigin(entry.origin)}`);
  return blocks;
}

function prose(entry: { as?: string; context?: string }): string[] {
  const blocks: string[] = [];
  if (entry.as !== undefined) {
    blocks.push(`**\`as\`:** ${entry.as}`);
  }
  if (entry.context !== undefined) {
    blocks.push(`**Body context:** ${entry.context}`);
  }
  return blocks;
}

function invocation(name: string, form: "self-closing" | "paired"): string {
  return code(form === "self-closing" ? `<${name} />` : `<${name}>…</${name}>`);
}

function renderReturns(entry: CompleteComponentSyntaxEntry): string[] {
  if (entry.returnMode === "text") {
    return [
      "**Returns:** text — the markdown this component renders.",
      fence("json", stringify(entry.returns)),
    ];
  }
  return [
    "**Returns:** a value — it renders nothing, and `as` binds what it returns.",
    fence("json", stringify(entry.returns)),
  ];
}

/**
 * The props table, and the schema it summarizes.
 *
 * The table is the readable half and the schema is the authoritative one. A
 * table cannot carry `default`, `enum`, a combinator, a reference or a root
 * constraint, so the schema is printed beside it rather than reduced into it,
 * and a property the table cannot name a type for is labelled honestly instead
 * of being given an invented one.
 */
function renderProps(props: PropsSchema): string[] {
  const rows = propertyRows(props);
  const blocks = ["#### Props"];
  if (rows.length === 0) {
    blocks.push("This component declares no individual props.");
  } else {
    blocks.push(
      ["| Prop | Type | Required | Description |", "| --- | --- | --- | --- |", ...rows].join("\n"),
    );
  }
  blocks.push(fence("json", stringify(props)));
  return blocks;
}

function propertyRows(props: PropsSchema): string[] {
  const properties = props.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return [];
  }
  const required = new Set(
    Array.isArray(props.required)
      ? props.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const rows: string[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    // Every cell is escaped on the way in, the prop name included: a schema
    // property may be spelled with anything, and one pipe in a name would
    // shift every column after it.
    rows.push(
      row([
        code(name),
        summarizeType(schema),
        required.has(name) ? "yes" : "no",
        describeProp(schema),
      ]),
    );
  }
  return rows;
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

/**
 * The type column, or an honest refusal to reduce one.
 *
 * A plain `type` — one name or a union of them — summarizes faithfully.
 * Anything else is a schema whose constraints do not fit a word, so the column
 * says JSON Schema and the reader goes to the block below it.
 */
function summarizeType(schema: Json): string {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "JSON Schema";
  }
  const type = schema.type;
  if (typeof type === "string") {
    return code(type);
  }
  if (Array.isArray(type) && type.every((member) => typeof member === "string")) {
    // Unescaped: `row()` escapes every cell once, and escaping here as well
    // would put a backslash in front of the backslash.
    return type.map(code).join(" | ");
  }
  return "JSON Schema";
}

function describeProp(schema: Json): string {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "";
  }
  const description = schema.description;
  return typeof description === "string" ? description : "";
}

function describeOrigin(origin: ComponentOrigin): string {
  if (origin.kind === "repository") {
    return code(origin.path);
  }
  if (origin.kind === "registered") {
    return `${code(origin.origin)} (${origin.reserved ? "reserved registration" : "registered default"})`;
  }
  if (origin.kind === "protected") {
    // Not "reserved registration": a reader deciding whether they can supply
    // this name themselves gets the opposite answer from the two phrases.
    return `${code(origin.origin)} (protected component)`;
  }
  if (origin.kind === "workflow") {
    // The object id as well as the path, so this cannot be read as a file the
    // reader could edit. Abbreviated the way a commit is: enough to compare,
    // short enough to sit in a table cell.
    return `${code(origin.path)} (workflow bundle, ${code(abbreviate(origin.sourceHash))})`;
  }
  if (origin.kind === "declared-markdown") {
    return `${code(origin.origin)} (declared Markdown)`;
  }
  return `structural syntax (${code(origin.construct)})`;
}

/** A blob id, shortened for a table cell but left whole when it is already short. */
function abbreviate(sourceHash: string): string {
  return sourceHash.length > 12 ? sourceHash.slice(0, 12) : sourceHash;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** A table cell: pipes escaped, and line breaks folded so the row stays a row. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function fence(language: string, body: string): string {
  return ["```" + language, body, "```"].join("\n");
}

function stringify(value: Json): string {
  return JSON.stringify(value, null, 2);
}
