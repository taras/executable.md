/**
 * `xmd syntax` — everything a document may write here, described without
 * running any of it.
 *
 * Two jobs, kept apart. The first is assembling the `run` host profile as
 * *declarations*: the same arrays the runtime installers register, with none of
 * the middleware, providers, launchers or activation those installers also
 * arrange. The second is rendering, and both renderers take the catalog as a
 * value — neither performs discovery, and neither parses the other's output.
 *
 * JSON is the canonical, lossless projection. Markdown is written for a person
 * and says so when a schema is richer than a table can summarize honestly.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import {
  AGENT_REGISTRATIONS,
  agentIdentityComponents,
  inspectSyntax,
  registerComponents,
} from "@executablemd/core";
import type {
  CompleteComponentSyntaxEntry,
  ComponentOrigin,
  Json,
  OriginOnlyComponentSyntaxEntry,
  PropsSchema,
  StructuralSyntaxEntry,
  SyntaxCatalog,
} from "@executablemd/core";
import { TESTING_REGISTRATIONS } from "@executablemd/testing";
import { WEB_REGISTRATIONS } from "@executablemd/web";

/**
 * The catalog for the production `run` profile, in the contextual working
 * directory.
 *
 * The registrations are the ones `installTestingComponents()`,
 * `installWebComponents()` and `installAgentComponents()` register, read as
 * values so this cannot drift from what a run installs. What those installers
 * *also* do — testing activation and its execution middleware, the elicitation
 * provider, the agent provider, the permission mode, the foreground launcher —
 * is operational and belongs to a run, so none of it happens here.
 *
 * `<Session>` travels as a declaration for the same reason: its factory takes
 * an execution's claimant, and describing an environment mints no execution.
 *
 * The scope is bounded, and everything installed in it is declarative registry
 * state. Leaving it removes the layer, and there is no process, agent, service,
 * journal, file or authority left to clean up.
 */
export function* syntaxCatalog(includes: readonly string[]): Operation<SyntaxCatalog> {
  return yield* scoped(function* () {
    yield* useRunProfileRegistry();
    return yield* inspectSyntax({ includes, components: agentIdentityComponents() });
  });
}

/**
 * The registrations the `run` profile installs, as registry state and nothing
 * else.
 *
 * Shared with `xmd plan`, which both describes this vocabulary to a generator
 * and validates what comes back. Registering only here would make the catalog
 * advertise `<Agent>` while validation reported it unresolved — a document told
 * to use a component nobody would accept.
 */
export function* useRunProfileRegistry(): Operation<void> {
  yield* registerComponents([
    ...AGENT_REGISTRATIONS,
    ...TESTING_REGISTRATIONS,
    ...WEB_REGISTRATIONS,
  ]);
}

/**
 * The catalog as JSON: two-space indent, one trailing newline.
 *
 * Catalog construction owns member insertion order, category order and entry
 * order, so the bytes are the same for the same environment.
 */
export function renderSyntaxJson(catalog: SyntaxCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

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
  return `structural syntax (${code(origin.construct)})`;
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
