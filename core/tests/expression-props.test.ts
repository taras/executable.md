/**
 * Expression prop evaluation tests — Tier EP + Scanner ES.
 *
 * Covers eval expression resolution against env.values, scanner-level
 * parseExpressionValue changes, and integration with expansion/validation.
 */

import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import {
  parseExpressionValue,
  scanSegments,
} from "../src/scanner.ts";
import { expandSegments, createBlockCounter } from "../src/expand.ts";
import type { ExpansionContext } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
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
    contentHash: `sha256:fake-${name}`,
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
    runModifierChain: function* (
      _modifiers: Modifier[],
      _context: CodeBlockContext,
    ) {
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

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "expr-props-test-"));
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
// Tier ES — Scanner-level parseExpressionValue tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier ES — parseExpressionValue", () => {
  // deno-lint-ignore require-yield
  it("ES1: number literal resolves at scan time", function* () {
    const result = parseExpressionValue("42");
    expect(result).toEqual({ kind: "resolved", value: 42 });
  });

  // deno-lint-ignore require-yield
  it("ES2: boolean true resolves at scan time", function* () {
    const result = parseExpressionValue("true");
    expect(result).toEqual({ kind: "resolved", value: true });
  });

  // deno-lint-ignore require-yield
  it("ES3: null resolves at scan time", function* () {
    const result = parseExpressionValue("null");
    expect(result).toEqual({ kind: "resolved", value: null });
  });

  // deno-lint-ignore require-yield
  it("ES4: object literal resolves at scan time", function* () {
    const result = parseExpressionValue('{ "a": 1 }');
    expect(result).toEqual({ kind: "resolved", value: { a: 1 } });
  });

  // deno-lint-ignore require-yield
  it("ES5: array literal resolves at scan time", function* () {
    const result = parseExpressionValue("[1, 2]");
    expect(result).toEqual({ kind: "resolved", value: [1, 2] });
  });

  // deno-lint-ignore require-yield
  it("ES6: bare identifier is eval expression", function* () {
    const result = parseExpressionValue("pr");
    expect(result).toEqual({ kind: "eval", expression: "pr" });
  });

  // deno-lint-ignore require-yield
  it("ES7: member expression is eval expression", function* () {
    const result = parseExpressionValue("items.length");
    expect(result).toEqual({ kind: "eval", expression: "items.length" });
  });

  // deno-lint-ignore require-yield
  it("ES8: comparison is eval expression", function* () {
    const result = parseExpressionValue('status === "ready"');
    expect(result).toEqual({
      kind: "eval",
      expression: 'status === "ready"',
    });
  });

  // deno-lint-ignore require-yield
  it("ES9: template literal is eval expression", function* () {
    const result = parseExpressionValue("`${name}-v2`");
    expect(result).toEqual({ kind: "eval", expression: "`${name}-v2`" });
  });

  // deno-lint-ignore require-yield
  it("ES10: arithmetic is eval expression", function* () {
    const result = parseExpressionValue("a + b");
    expect(result).toEqual({ kind: "eval", expression: "a + b" });
  });

  // deno-lint-ignore require-yield
  it("ES11: scanned component has both props and expressions", function* () {
    const segments = scanSegments('<Comp count={42} data={pr} />');
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg.type).toBe("component");
    if (seg.type === "component") {
      expect(seg.props.count).toBe(42);
      expect(seg.expressions.data).toBe("pr");
      expect("data" in seg.props).toBe(false);
      expect("count" in seg.expressions).toBe(false);
    }
  });

  // deno-lint-ignore require-yield
  it("ES12: self-closing with expressions", function* () {
    const segments = scanSegments('<Comp data={pr} />');
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    if (seg.type === "component") {
      expect(seg.selfClosing).toBe(true);
      expect(seg.expressions.data).toBe("pr");
    }
  });

  // deno-lint-ignore require-yield
  it("ES13: block tag with expressions", function* () {
    const segments = scanSegments("<Comp data={pr}>child</Comp>");
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    if (seg.type === "component") {
      expect(seg.selfClosing).toBe(false);
      expect(seg.expressions.data).toBe("pr");
      expect(seg.children).toHaveLength(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier EP — Expression prop evaluation (integration)
// ═══════════════════════════════════════════════════════════════════════════

describe("Tier EP — Expression prop evaluation", () => {
  it("EP1: bare identifier resolves from env", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Display.md": [
          "---",
          "inputs:",
          "  data:",
          "    type: object",
          "    required: true",
          "---",
          "received:{props.data}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          'const pr = { files: 3 };',
          "```",
          "",
          "<Display data={pr} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      // {props.data} will be interpolated — for objects, it uses toString
      expect(output).toContain("received:");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP2: member expression resolves", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Show.md": [
          "---",
          "inputs:",
          "  len:",
          "    type: number",
          "    required: true",
          "---",
          "length={props.len}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const items = [1, 2, 3];",
          "```",
          "",
          "<Show len={items.length} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("length=3");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP3: comparison expression resolves", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Check.md": [
          "---",
          "inputs:",
          "  active:",
          "    type: boolean",
          "    required: true",
          "---",
          "active={props.active}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          'const status = "ready";',
          "```",
          "",
          '<Check active={status === "ready"} />',
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("active=true");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP5: arithmetic expression", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Sum.md": [
          "---",
          "inputs:",
          "  total:",
          "    type: number",
          "    required: true",
          "---",
          "total={props.total}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const a = 10;",
          "const b = 20;",
          "```",
          "",
          "<Sum total={a + b} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("total=30");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP6: JSON literal still resolves at scan time", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Num.md": [
          "---",
          "inputs:",
          "  count:",
          "    type: number",
          "    required: true",
          "---",
          "count={props.count}",
        ].join("\n"),
        // No eval block — count={42} resolves at scan time
        "doc.md": "<Num count={42} />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("count=42");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP11: string attribute unaffected", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Greet.md": [
          "---",
          "inputs:",
          "  name:",
          "    type: string",
          "    required: true",
          "---",
          "hello {props.name}",
        ].join("\n"),
        "doc.md": '<Greet name="world" />',
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("hello world");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP13: undefined binding → error", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Show.md": [
          "---",
          "inputs:",
          "  data:",
          "    type: any",
          "    required: true",
          "---",
          "data={props.data}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const x = 1;",
          "```",
          "",
          "<Show data={nonexistent} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("Failed to evaluate expression prop");
      expect(output).toContain("nonexistent");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP14: non-serializable result → error", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Show.md": [
          "---",
          "inputs:",
          "  handler:",
          "    type: any",
          "    required: true",
          "---",
          "ok",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const myFn = function() {};",
          "```",
          "",
          "<Show handler={myFn} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("non-serializable");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP15: no binding in env → reference error", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Show.md": [
          "---",
          "inputs:",
          "  data:",
          "    type: any",
          "    required: true",
          "---",
          "ok",
        ].join("\n"),
        // No eval block defines someVar — ReferenceError at expansion time
        "doc.md": "<Show data={someVar} />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("Failed to evaluate expression prop");
      expect(output).toContain("someVar");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP16: syntax error in expression → error", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Show.md": [
          "---",
          "inputs:",
          "  x:",
          "    type: any",
          "    required: true",
          "---",
          "ok",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const a = 1;",
          "```",
          "",
          "<Show x={a +} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("Failed to evaluate expression prop");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP17: mixed resolved and eval props", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Mixed.md": [
          "---",
          "inputs:",
          "  count:",
          "    type: number",
          "    required: true",
          "  data:",
          "    type: string",
          "    required: true",
          "  name:",
          "    type: string",
          "    required: true",
          "---",
          "count={props.count} data={props.data} name={props.name}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          'const pr = "result";',
          "```",
          "",
          '<Mixed count={42} data={pr} name="hello" />',
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("count=42");
      expect(output).toContain("data=result");
      expect(output).toContain("name=hello");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP18: expression prop passes validation", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Typed.md": [
          "---",
          "inputs:",
          "  count:",
          "    type: number",
          "    required: true",
          "---",
          "count={props.count}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const total = 5;",
          "```",
          "",
          "<Typed count={total} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("count=5");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP19: expression prop fails validation", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Typed.md": [
          "---",
          "inputs:",
          "  count:",
          "    type: number",
          "    required: true",
          "---",
          "count={props.count}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          'const name = "hello";',
          "```",
          "",
          "<Typed count={name} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("expected number");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP20: expression prop with slot", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Layout.md": [
          "---",
          "inputs: {}",
          "---",
          "```js eval",
          'const pr = "hello";',
          "```",
          "",
          '<Content slot="main" />',
        ].join("\n"),
        "components/Display.md": [
          "---",
          "inputs:",
          "  data:",
          "    type: string",
          "    required: true",
          "---",
          "data={props.data}",
        ].join("\n"),
        "doc.md": [
          "<Layout>",
          '<Display slot="main" data={pr} />',
          "</Layout>",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("data=hello");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP21: replay produces same props", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Show.md": [
          "---",
          "inputs:",
          "  count:",
          "    type: number",
          "    required: true",
          "---",
          "count={props.count}",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const total = 7;",
          "```",
          "",
          "<Show count={total} />",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output1 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      const output2 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output1).toContain("count=7");
      expect(output2).toBe(output1);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP22: nested component receives expression prop", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Outer.md": [
          "---",
          "inputs: {}",
          "---",
          "```js eval",
          'const computed = "from-outer";',
          "```",
          "",
          '<Inner data={computed} />',
        ].join("\n"),
        "components/Inner.md": [
          "---",
          "inputs:",
          "  data:",
          "    type: string",
          "    required: true",
          "---",
          "inner-data={props.data}",
        ].join("\n"),
        "doc.md": "<Outer />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("inner-data=from-outer");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("EP23: children with expression props", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Parent.md": [
          "---",
          "inputs: {}",
          "---",
          "```js eval",
          'const parentData = "from-parent";',
          "```",
          "",
          "<Content />",
        ].join("\n"),
        "components/Child.md": [
          "---",
          "inputs:",
          "  data:",
          "    type: string",
          "    required: true",
          "---",
          "child-data={props.data}",
        ].join("\n"),
        "doc.md": [
          "<Parent>",
          "<Child data={parentData} />",
          "</Parent>",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));
      expect(output).toContain("child-data=from-parent");
    } finally {
      cleanup(tmpDir);
    }
  });
});
