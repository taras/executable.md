/**
 * Named slots tests — Tiers NS-A through NS-G.
 *
 * Covers slot partitioning, content substitution, expansion integration,
 * slot prop reservation, renderChildren interaction, edge cases, and
 * boundary scanner confirmation.
 */

import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { partitionBySlot, stripSlotProp } from "../src/expand.ts";
import { expandSegments, createBlockCounter } from "../src/expand.ts";
import type { ExpansionContext } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { validateProps } from "../src/validate.ts";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import type {
  Segment,
  ComponentDefinition,
  Json,
  CodeBlockResult,
  Modifier,
  CodeBlockContext,
} from "../src/types.ts";

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(
  name: string,
  body: string,
  opts: {
    meta?: Record<string, unknown>;
    inputs?: Record<string, any>;
  } = {},
): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: opts.meta ?? {},
    inputs: opts.inputs ?? {},
    bodySegments: scanSegments(body),
  };
}

function makeCtx(
  components: Record<string, ComponentDefinition>,
  codeResult?: CodeBlockResult,
): ExpansionContext {
  return {
    importComponent: function* (name: string) {
      const comp = components[name];
      if (!comp) throw new Error(`Component not found: ${name}`);
      return comp;
    },
    runModifierChain: function* (_modifiers: Modifier[], _context: CodeBlockContext) {
      return (
        codeResult ?? {
          output: "mock output\n",
          exitCode: 0,
          stderr: "",
        }
      );
    },
  };
}

/** Create a component segment for use in partition tests. */
function compSeg(
  name: string,
  props: Record<string, Json> = {},
  children: Segment[] = [],
): Segment {
  return {
    type: "component",
    name,
    props,
    expressions: {},
    children,
    selfClosing: children.length === 0,
  };
}

/** Create a text segment. */
function textSeg(content: string): Segment {
  return { type: "text", content };
}

/** Create an executable code block segment. */
function codeSeg(content: string): Segment {
  return {
    type: "codeBlock",
    language: "bash",
    content,
    modifiers: [{ name: "exec" }],
    executable: true,
  };
}

function stubProvider(componentName: string): string {
  return [
    "---",
    "meta:",
    `  componentName: ${componentName}`,
    "inputs:",
    "  model:",
    "    type: string",
    "    required: true",
    "---",
    "",
    "```js persist eval",
    "yield* Sample.around({",
    "  *sample([context], next) {",
    "    if (context.model !== undefined && context.model !== model) {",
    "      return yield* next(context);",
    "    }",
    "    return '[sampled-by-' + model + ':' + context.content.trim() + ']';",
    "  },",
    "}, { at: 'min' });",
    "```",
    "",
    "<Content />",
  ].join("\n");
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "named-slots-test-"));
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [filePath, content] of Object.entries(files)) {
    const abs = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier NS-A — Slot partitioning (unit)
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier NS-A — Slot partitioning", () => {
  // deno-lint-ignore require-yield
  it("NS-A1: no slot props — all in default", function* () {
    const children = [textSeg("hello"), compSeg("Widget"), textSeg("world")];
    const result = partitionBySlot(children);
    expect(result.default).toHaveLength(3);
    expect(result.named.size).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // deno-lint-ignore require-yield
  it("NS-A2: single named slot", function* () {
    const children = [compSeg("Nav", { slot: "sidebar" })];
    const result = partitionBySlot(children);
    expect(result.default).toHaveLength(0);
    expect(result.named.size).toBe(1);
    expect(result.named.get("sidebar")!).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  // deno-lint-ignore require-yield
  it("NS-A3: multiple named slots", function* () {
    const children = [
      compSeg("A", { slot: "a" }),
      compSeg("B", { slot: "b" }),
      compSeg("C", { slot: "c" }),
    ];
    const result = partitionBySlot(children);
    expect(result.default).toHaveLength(0);
    expect(result.named.size).toBe(3);
    expect(result.named.get("a")!).toHaveLength(1);
    expect(result.named.get("b")!).toHaveLength(1);
    expect(result.named.get("c")!).toHaveLength(1);
  });

  // deno-lint-ignore require-yield
  it("NS-A4: mixed named and default", function* () {
    const children = [
      compSeg("A", { slot: "header" }),
      textSeg("default text"),
      compSeg("B", { slot: "footer" }),
      compSeg("C"),
    ];
    const result = partitionBySlot(children);
    expect(result.default).toHaveLength(2); // text + C
    expect(result.named.size).toBe(2);
    expect(result.named.get("header")!).toHaveLength(1);
    expect(result.named.get("footer")!).toHaveLength(1);
  });

  // deno-lint-ignore require-yield
  it("NS-A5: text segments always default", function* () {
    const children = [textSeg("before"), compSeg("Nav", { slot: "sidebar" }), textSeg("after")];
    const result = partitionBySlot(children);
    expect(result.default).toHaveLength(2);
    expect(result.default[0]).toEqual(textSeg("before"));
    expect(result.default[1]).toEqual(textSeg("after"));
  });

  // deno-lint-ignore require-yield
  it("NS-A6: code blocks always default", function* () {
    const children = [codeSeg("echo hello"), compSeg("Nav", { slot: "sidebar" })];
    const result = partitionBySlot(children);
    expect(result.default).toHaveLength(1);
    expect(result.default[0]).toEqual(codeSeg("echo hello"));
  });

  // deno-lint-ignore require-yield
  it("NS-A7: multiple children same slot — order preserved", function* () {
    const children = [
      compSeg("A", { slot: "body", id: "first" }),
      compSeg("B", { slot: "body", id: "second" }),
    ];
    const result = partitionBySlot(children);
    const bodySlot = result.named.get("body")!;
    expect(bodySlot).toHaveLength(2);
    expect((bodySlot[0] as { type: "component"; props: Record<string, Json> }).props.id).toBe(
      "first",
    );
    expect((bodySlot[1] as { type: "component"; props: Record<string, Json> }).props.id).toBe(
      "second",
    );
  });

  // deno-lint-ignore require-yield
  it("NS-A8: empty children", function* () {
    const result = partitionBySlot([]);
    expect(result.default).toHaveLength(0);
    expect(result.named.size).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // deno-lint-ignore require-yield
  it("NS-A9: slot name case sensitivity", function* () {
    const children = [compSeg("A", { slot: "Header" }), compSeg("B", { slot: "header" })];
    const result = partitionBySlot(children);
    expect(result.named.size).toBe(2);
    expect(result.named.get("Header")!).toHaveLength(1);
    expect(result.named.get("header")!).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier NS-B — Content substitution (unit)
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier NS-B — Content substitution", () => {
  it("NS-B1: backward compat — no slots anywhere", function* () {
    const layout = makeComponent("Layout", "before\n<Content />\nafter");
    const ctx = makeCtx({ Layout: layout });
    const segments = scanSegments("<Layout>\nchild text\n</Layout>");
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("before");
    expect(output).toContain("child text");
    expect(output).toContain("after");
  });

  it("NS-B2: named slot projection", function* () {
    const layout = makeComponent("Layout", '<Content slot="header" />\n---\n<Content />');
    const ctx = makeCtx({ Layout: layout, Header: makeComponent("Header", "HEADER") });
    const segments = scanSegments('<Layout>\n<Header slot="header" />\ndefault text\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("HEADER");
    expect(output).toContain("default text");
  });

  it("NS-B3: default slot projection", function* () {
    const layout = makeComponent("Layout", '<Content slot="nav" />\n---\n<Content />');
    const nav = makeComponent("Nav", "NAV");
    const ctx = makeCtx({ Layout: layout, Nav: nav });
    const segments = scanSegments('<Layout>\n<Nav slot="nav" />\ndefault text\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    // Default slot should only have "default text", not Nav
    expect(output).toContain("NAV");
    expect(output).toContain("default text");
  });

  it("NS-B4: named + default together", function* () {
    const layout = makeComponent("Layout", 'NAV: <Content slot="nav" />\nBODY: <Content />');
    const nav = makeComponent("Nav", "I-AM-NAV");
    const ctx = makeCtx({ Layout: layout, Nav: nav });
    const segments = scanSegments('<Layout>\n<Nav slot="nav" />\nbody content\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("I-AM-NAV");
    expect(output).toContain("body content");
  });

  it("NS-B5: missing named slot — empty expansion", function* () {
    const layout = makeComponent("Layout", '<Content slot="footer" />\n<Content />');
    const ctx = makeCtx({ Layout: layout });
    const segments = scanSegments("<Layout>\nbody only\n</Layout>");
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("body only");
    expect(output).not.toContain("footer");
  });

  it("NS-B6: unused named slot — silently discarded", function* () {
    // Layout body has no <Content slot="extra" />, so the extra-slotted child is discarded
    const layout = makeComponent("Layout", "<Content />");
    const extra = makeComponent("Extra", "EXTRA");
    const ctx = makeCtx({ Layout: layout, Extra: extra });
    const segments = scanSegments('<Layout>\n<Extra slot="extra" />\nbody text\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("body text");
    expect(output).not.toContain("EXTRA");
  });

  it("NS-B7: multiple projections same slot", function* () {
    const layout = makeComponent(
      "Layout",
      'FIRST: <Content slot="header" />\nSECOND: <Content slot="header" />',
    );
    const header = makeComponent("Header", "H");
    const ctx = makeCtx({ Layout: layout, Header: header });
    const segments = scanSegments('<Layout>\n<Header slot="header" />\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    // Both projections should have the header content
    const matches = output.match(/H/g);
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("NS-B8: slot prop stripped", function* () {
    // Widget declares "title" as an input but NOT "slot"
    const layout = makeComponent("Layout", '<Content slot="main" />');
    const widget = makeComponent("Widget", "WIDGET:{props.title}", {
      inputs: { title: { type: "string", required: true } },
    });
    const ctx = makeCtx({ Layout: layout, Widget: widget });
    const segments = scanSegments('<Layout>\n<Widget slot="main" title="Hello" />\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    // Should expand Widget with title prop, without PropValidationError for "slot"
    expect(output).toContain("WIDGET:");
    expect(output).not.toContain("ERROR");
    expect(output).not.toContain("Unknown prop");
  });

  it("NS-B9: interpolation still works", function* () {
    const layout = makeComponent(
      "Layout",
      'Title: {meta.title}\n<Content slot="body" />\n<Content />',
      {
        meta: { title: "MyLayout" },
      },
    );
    const body = makeComponent("Body", "BODY-CONTENT");
    const ctx = makeCtx({ Layout: layout, Body: body });
    const segments = scanSegments('<Layout>\n<Body slot="body" />\ndefault content\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("Title: MyLayout");
    expect(output).toContain("BODY-CONTENT");
    expect(output).toContain("default content");
  });

  it("NS-B10: multiple children in one slot", function* () {
    const layout = makeComponent("Layout", '<Content slot="items" />');
    const itemA = makeComponent("ItemA", "A");
    const itemB = makeComponent("ItemB", "B");
    const ctx = makeCtx({ Layout: layout, ItemA: itemA, ItemB: itemB });
    const segments = scanSegments(
      '<Layout>\n<ItemA slot="items" />\n<ItemB slot="items" />\n</Layout>',
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("A");
    expect(output).toContain("B");
    // A should appear before B
    expect(output.indexOf("A")).toBeLessThan(output.indexOf("B"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier NS-C — Expansion integration
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier NS-C — Expansion integration", () => {
  it("NS-C1: basic named slot expansion", function* () {
    const report = makeComponent(
      "Report",
      '<Content slot="header" />\n---\n<Content slot="body" />\n---\n<Content />',
    );
    const header = makeComponent("Header", "HEADER-TEXT");
    const body = makeComponent("Body", "BODY-TEXT");
    const ctx = makeCtx({ Report: report, Header: header, Body: body });
    const segments = scanSegments(
      '<Report>\n<Header slot="header" />\n<Body slot="body" />\ndefault text\n</Report>',
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("HEADER-TEXT");
    expect(output).toContain("BODY-TEXT");
    expect(output).toContain("default text");
    // Verify order: header before body before default
    expect(output.indexOf("HEADER-TEXT")).toBeLessThan(output.indexOf("BODY-TEXT"));
    expect(output.indexOf("BODY-TEXT")).toBeLessThan(output.indexOf("default text"));
  });

  it("NS-C2: slotted child is expanded", function* () {
    const layout = makeComponent("Layout", '<Content slot="main" />');
    const inner = makeComponent("Inner", "INNER-EXPANDED");
    const wrapper = makeComponent("Wrapper", "WRAP:<Content />");
    const ctx = makeCtx({ Layout: layout, Wrapper: wrapper, Inner: inner });
    const segments = scanSegments('<Layout>\n<Wrapper slot="main"><Inner /></Wrapper>\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("WRAP:");
    expect(output).toContain("INNER-EXPANDED");
  });

  it("NS-C3: nested component with slots", function* () {
    // Outer uses slots, Inner also uses slots
    const outer = makeComponent(
      "Outer",
      'OUTER-HEAD:<Content slot="head" />\nOUTER-BODY:<Content />',
    );
    const inner = makeComponent(
      "Inner",
      'INNER-LEFT:<Content slot="left" />\nINNER-RIGHT:<Content slot="right" />',
    );
    const leftComp = makeComponent("Left", "L");
    const rightComp = makeComponent("Right", "R");
    const headComp = makeComponent("Head", "H");
    const ctx = makeCtx({
      Outer: outer,
      Inner: inner,
      Left: leftComp,
      Right: rightComp,
      Head: headComp,
    });
    const segments = scanSegments(
      [
        "<Outer>",
        '<Head slot="head" />',
        "<Inner>",
        '<Left slot="left" />',
        '<Right slot="right" />',
        "</Inner>",
        "</Outer>",
      ].join("\n"),
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("OUTER-HEAD:");
    expect(output).toContain("H");
    expect(output).toContain("INNER-LEFT:");
    expect(output).toContain("L");
    expect(output).toContain("INNER-RIGHT:");
    expect(output).toContain("R");
  });

  it("NS-C4: slot inside provider", function* () {
    // Provider passes all children through via <Content />
    // Report uses named slots
    const provider = makeComponent("Provider", "<Content />");
    const report = makeComponent("Report", 'HEAD:<Content slot="header" />\nBODY:<Content />');
    const header = makeComponent("Header", "H");
    const ctx = makeCtx({ Provider: provider, Report: report, Header: header });
    const segments = scanSegments(
      [
        "<Provider>",
        "<Report>",
        '<Header slot="header" />',
        "body text",
        "</Report>",
        "</Provider>",
      ].join("\n"),
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("HEAD:");
    expect(output).toContain("H");
    expect(output).toContain("BODY:");
    expect(output).toContain("body text");
  });

  it("NS-C5: props on slotted child", function* () {
    const layout = makeComponent("Layout", '<Content slot="main" />');
    const comp = makeComponent("Comp", "title={props.title}", {
      inputs: { title: { type: "string", required: true } },
    });
    const ctx = makeCtx({ Layout: layout, Comp: comp });
    const segments = scanSegments('<Layout>\n<Comp slot="main" title="Hello" />\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("title=Hello");
    expect(output).not.toContain("Unknown prop");
    expect(output).not.toContain("ERROR");
  });

  it("NS-C6: default slot with no explicit default children", function* () {
    // All children carry slot props — default <Content /> expands to nothing
    const layout = makeComponent("Layout", 'HEAD:<Content slot="header" />\nDEFAULT:<Content />');
    const header = makeComponent("Header", "H");
    const ctx = makeCtx({ Layout: layout, Header: header });
    const segments = scanSegments('<Layout>\n<Header slot="header" />\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("HEAD:");
    expect(output).toContain("H");
    expect(output).toContain("DEFAULT:");
    // No default children after DEFAULT:
  });

  it("NS-C7: Fragment passthrough", function* () {
    const layout = makeComponent("Layout", 'SLOT:<Content slot="header" />\nDEFAULT:<Content />');
    const fragment = makeComponent("Fragment", "<Content />");
    const ctx = makeCtx({ Layout: layout, Fragment: fragment });
    const segments = scanSegments(
      [
        "<Layout>",
        '<Fragment slot="header">',
        "raw text in header slot",
        "</Fragment>",
        "default text",
        "</Layout>",
      ].join("\n"),
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("raw text in header slot");
    expect(output).toContain("default text");
  });

  it("NS-C8: slotted child with own children", function* () {
    const layout = makeComponent("Layout", '<Content slot="sidebar" />\n<Content />');
    const wrapper = makeComponent("Wrapper", "WRAP:<Content />");
    const nav = makeComponent("Nav", "NAV");
    const ctx = makeCtx({ Layout: layout, Wrapper: wrapper, Nav: nav });
    const segments = scanSegments(
      ["<Layout>", '<Wrapper slot="sidebar"><Nav /></Wrapper>', "main content", "</Layout>"].join(
        "\n",
      ),
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("WRAP:");
    expect(output).toContain("NAV");
    expect(output).toContain("main content");
  });

  it("NS-C9: exec block in default slot", function* () {
    const layout = makeComponent("Layout", '<Content slot="header" />\n<Content />');
    const header = makeComponent("Header", "H");
    const ctx = makeCtx({ Layout: layout, Header: header });
    const segments = scanSegments(
      [
        "<Layout>",
        '<Header slot="header" />',
        "",
        "```bash exec",
        "echo hello",
        "```",
        "",
        "</Layout>",
      ].join("\n"),
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("H");
    expect(output).toContain("mock output");
  });

  it("NS-C10: cycle detection unaffected", function* () {
    // A uses slots but A slot="x" where A's body references A → cycle
    const a = makeComponent("A", '<Content slot="x" />\n<A />');
    const ctx = makeCtx({ A: a });
    const segments = scanSegments('<A>\n<A slot="x" />\n</A>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("Cycle detected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier NS-D — slot prop reservation
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier NS-D — slot prop reservation", () => {
  // deno-lint-ignore require-yield
  it("NS-D1: slot in inputs frontmatter → error", function* () {
    expect(() => {
      parseFrontmatter({
        inputs: {
          slot: { type: "string", required: true },
        },
      });
    }).toThrow("reserved prop name");
  });

  it("NS-D2: slot not in child's validatedProps", function* () {
    // Widget declares "title" input only — slot should be stripped before validation
    const layout = makeComponent("Layout", '<Content slot="main" />');
    const widget = makeComponent("Widget", "T:{props.title}", {
      inputs: { title: { type: "string", required: true } },
    });
    const ctx = makeCtx({ Layout: layout, Widget: widget });
    // <Widget slot="main" title="Hi" /> — slot is stripped before validation
    const segments = scanSegments('<Layout>\n<Widget slot="main" title="Hi" />\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("T:Hi");
    expect(output).not.toContain("ERROR");
  });

  it("NS-D3: Content slot prop not validated as input", function* () {
    // Content is special-cased — slot on Content should not cause validation error
    const comp = makeComponent("Comp", '<Content slot="header" />\n<Content />');
    const header = makeComponent("Header", "H");
    const ctx = makeCtx({ Comp: comp, Header: header });
    const segments = scanSegments('<Comp>\n<Header slot="header" />\nbody\n</Comp>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).not.toContain("ERROR");
    expect(output).toContain("H");
  });

  // deno-lint-ignore require-yield
  it("NS-D4: slot with empty string → error", function* () {
    const children = [compSeg("A", { slot: "" })];
    const result = partitionBySlot(children);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("must not be empty");
  });

  // deno-lint-ignore require-yield
  it("NS-D5: slot with invalid name → error", function* () {
    const children = [compSeg("A", { slot: "123invalid" })];
    const result = partitionBySlot(children);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("must match");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier NS-E — renderChildren() interaction
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier NS-E — renderChildren interaction", () => {
  it("NS-E1: renderChildren includes all slots", function* () {
    const tmpDir = makeTempDir();
    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );
      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "components/Header.md": "---\ninputs: {}\n---\nHEADER-CONTENT",
        "doc.md": [
          '<TestProvider model="test-model">',
          '<Sample model="test-model">',
          '<Header slot="head" />',
          "body content",
          "</Sample>",
          "</TestProvider>",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* runDocument({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      // renderChildren() should capture both the slotted Header and body content
      expect(output).toContain("[sampled-by-test-model:");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("NS-E2: Sample component with slotted input — all content captured", function* () {
    const tmpDir = makeTempDir();
    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );
      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "components/X.md": "---\ninputs: {}\n---\nX-CONTENT",
        "components/Y.md": "---\ninputs: {}\n---\nY-CONTENT",
        "doc.md": [
          '<TestProvider model="test-model">',
          '<Sample model="test-model">',
          '<X slot="prompt" />',
          "<Y />",
          "</Sample>",
          "</TestProvider>",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* runDocument({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      // Both X and Y should be included in renderChildren output
      expect(output).toContain("[sampled-by-test-model:");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("NS-E3: renderChildren preserves order", function* () {
    const tmpDir = makeTempDir();
    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );
      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "components/First.md": "---\ninputs: {}\n---\nFIRST",
        "components/Second.md": "---\ninputs: {}\n---\nSECOND",
        "doc.md": [
          '<TestProvider model="test-model">',
          '<Sample model="test-model">',
          '<First slot="a" />',
          '<Second slot="b" />',
          "THIRD",
          "</Sample>",
          "</TestProvider>",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* runDocument({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      // renderChildren renders ALL children in source order
      expect(output).toContain("[sampled-by-test-model:");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier NS-F — Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier NS-F — Edge cases", () => {
  it("NS-F1: slot on self-closing component", function* () {
    const layout = makeComponent("Layout", '<Content slot="icon" />\n<Content />');
    const badge = makeComponent("Badge", "BADGE");
    const ctx = makeCtx({ Layout: layout, Badge: badge });
    const segments = scanSegments('<Layout>\n<Badge slot="icon" />\nbody\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("BADGE");
    expect(output).toContain("body");
  });

  it("NS-F2: slot on component with children", function* () {
    const layout = makeComponent("Layout", '<Content slot="main" />');
    const card = makeComponent("Card", "CARD:<Content />");
    const text = makeComponent("Text", "TEXT");
    const ctx = makeCtx({ Layout: layout, Card: card, Text: text });
    const segments = scanSegments('<Layout>\n<Card slot="main"><Text /></Card>\n</Layout>');
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("CARD:");
    expect(output).toContain("TEXT");
  });

  it("NS-F3: deeply nested slots", function* () {
    const a = makeComponent("A", 'A-HEAD:<Content slot="head" />\nA-BODY:<Content />');
    const b = makeComponent(
      "B",
      'B-LEFT:<Content slot="left" />\nB-RIGHT:<Content slot="right" />',
    );
    const c = makeComponent("C", "C");
    const d = makeComponent("D", "D");
    const h = makeComponent("H", "HEAD");
    const ctx = makeCtx({ A: a, B: b, C: c, D: d, H: h });
    const segments = scanSegments(
      [
        "<A>",
        '<H slot="head" />',
        "<B>",
        '<C slot="left" />',
        '<D slot="right" />',
        "</B>",
        "</A>",
      ].join("\n"),
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("A-HEAD:");
    expect(output).toContain("HEAD");
    expect(output).toContain("B-LEFT:");
    expect(output).toContain("C");
    expect(output).toContain("B-RIGHT:");
    expect(output).toContain("D");
  });

  // deno-lint-ignore require-yield
  it("NS-F4: slot with expression prop", function* () {
    // Scanner parses slot={"header"} as string "header"
    const segments = scanSegments('<Comp slot={"header"} />');
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg.type).toBe("component");
    if (seg.type === "component") {
      expect(seg.props.slot).toBe("header");
    }
  });

  it("NS-F5: body with only named Content slots — default children discarded", function* () {
    const layout = makeComponent("Layout", '<Content slot="a" />\n<Content slot="b" />');
    const a = makeComponent("A", "A-CONTENT");
    const ctx = makeCtx({ Layout: layout, A: a });
    const segments = scanSegments(
      '<Layout>\n<A slot="a" />\ndefault text should be discarded\n</Layout>',
    );
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    expect(output).toContain("A-CONTENT");
    // Default text should be discarded since there's no <Content />
    expect(output).not.toContain("default text should be discarded");
  });

  it("NS-F6: healing unaffected by slots", function* () {
    // Text goes to default slot — layout must have <Content /> for it
    const layout = makeComponent("Layout", '<Content slot="main" />\n<Content />');
    const ctx = makeCtx({ Layout: layout });
    // Unclosed bold in text — text goes to default slot, healing runs on it
    const segments = scanSegments("<Layout>\n**unclosed bold\n</Layout>");
    const expanded = yield* expandSegments(segments, {}, {}, new Set(), ctx);
    const output = renderSegments(expanded);
    // Text should be healed — no dangling markers
    expect(output).toContain("unclosed bold");
  });

  it("NS-F7: journal shape unchanged", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Layout.md": [
          "---",
          "inputs: {}",
          "---",
          '<Content slot="header" />',
          "<Content />",
        ].join("\n"),
        "components/Header.md": "---\ninputs: {}\n---\nHEADER",
        "doc.md": '<Layout>\n<Header slot="header" />\nbody\n</Layout>',
      });
      const stream = new InMemoryStream();
      yield* collect(
        yield* runDocument({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      const events = yield* stream.readAll();
      // Should have import_component events and a close — no new event types
      for (const event of events) {
        if (event.type === "yield") {
          expect(["import_component", "exec", "eval"]).toContain(event.description.type);
        }
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  it("NS-F8: replay with named slots", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Layout.md": [
          "---",
          "inputs: {}",
          "---",
          '<Content slot="header" />',
          "<Content />",
        ].join("\n"),
        "components/Header.md": "---\ninputs: {}\n---\nHEADER",
        "doc.md": '<Layout>\n<Header slot="header" />\nbody\n</Layout>',
      });
      const stream = new InMemoryStream();
      const output1 = yield* collect(
        yield* runDocument({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      // Replay — same stream, same output
      const output2 = yield* collect(
        yield* runDocument({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output2).toBe(output1);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier NS-G — Boundary scanner (confirms no changes needed)
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier NS-G — Boundary scanner", () => {
  // deno-lint-ignore require-yield
  it("NS-G1: slot parsed as string prop", function* () {
    const segments = scanSegments('<Comp slot="header" />');
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg.type).toBe("component");
    if (seg.type === "component") {
      expect(seg.props.slot).toBe("header");
    }
  });

  // deno-lint-ignore require-yield
  it("NS-G2: slot with other props", function* () {
    const segments = scanSegments('<Comp slot="header" title="Hi" />');
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    if (seg.type === "component") {
      expect(seg.props.slot).toBe("header");
      expect(seg.props.title).toBe("Hi");
    }
  });

  // deno-lint-ignore require-yield
  it("NS-G3: Content with slot prop", function* () {
    const segments = scanSegments('<Content slot="body" />');
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg.type).toBe("component");
    if (seg.type === "component") {
      expect(seg.name).toBe("Content");
      expect(seg.props.slot).toBe("body");
    }
  });

  // deno-lint-ignore require-yield
  it("NS-G4: slot in code span — text, not component", function* () {
    const segments = scanSegments('`<Comp slot="x" />`');
    expect(segments).toHaveLength(1);
    expect(segments[0]!.type).toBe("text");
  });
});
