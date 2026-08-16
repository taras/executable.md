/**
 * Expression prop evaluation tests — Tier EP + Scanner ES.
 *
 * Covers eval expression resolution against env.values, scanner-level
 * parseExpressionValue changes, and integration with expansion/validation.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { parseExpressionValue, scanSegments } from "../src/scanner.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import * as path from "node:path";

function* writeFiles(dir: string, files: Record<string, string>): Operation<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const abs = path.join(dir, filePath);
    yield* ensureDir(path.dirname(abs));
    yield* writeTextFile(abs, content);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier ES — Scanner-level parseExpressionValue tests
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What one run of the fixture said: its rendered text, or the diagnostic it
 * reported. An expression a document got wrong is an uncaught failure, so the
 * refusal is the run's own outcome rather than a comment in the body.
 */
function* said(tmpDir: string, stream: InMemoryStream): Operation<string> {
  const execution = yield* execute({
    path: path.join(tmpDir, "doc.md"),
    stream,
    componentDirs: [path.join(tmpDir, "components"), tmpDir],
  });
  const result = yield* execution;
  return result.ok ? String(result.value) : result.error.message;
}

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
    const segments = scanSegments("<Comp count={42} data={pr} />");
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
    const segments = scanSegments("<Comp data={pr} />");
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
  beforeAll(() => useTempFileCompiler());
  it("EP1: bare identifier resolves from env", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Display.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    data:",
        "      type: object",
        "  required:",
        "    - data",
        "  additionalProperties: false",
        "---",
        "received:{props.data}",
      ].join("\n"),
      "doc.md": ["```js eval", "const pr = { files: 3 };", "```", "", "<Display data={pr} />"].join(
        "\n",
      ),
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    // {props.data} will be interpolated — for objects, it uses toString
    expect(output).toContain("received:");
    expect(output).not.toContain("ERROR");
  });

  it("EP2: member expression resolves", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Show.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    len:",
        "      type: number",
        "  required:",
        "    - len",
        "  additionalProperties: false",
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("length=3");
  });

  it("EP3: comparison expression resolves", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Check.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    active:",
        "      type: boolean",
        "  required:",
        "    - active",
        "  additionalProperties: false",
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("active=true");
  });

  it("EP5: arithmetic expression", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Sum.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    total:",
        "      type: number",
        "  required:",
        "    - total",
        "  additionalProperties: false",
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("total=30");
  });

  it("EP6: JSON literal still resolves at scan time", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Num.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    count:",
        "      type: number",
        "  required:",
        "    - count",
        "  additionalProperties: false",
        "---",
        "count={props.count}",
      ].join("\n"),
      // No eval block — count={42} resolves at scan time
      "doc.md": "<Num count={42} />",
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("count=42");
  });

  it("EP11: string attribute unaffected", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Greet.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    name:",
        "      type: string",
        "  required:",
        "    - name",
        "  additionalProperties: false",
        "---",
        "hello {props.name}",
      ].join("\n"),
      "doc.md": '<Greet name="world" />',
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("hello world");
  });

  it("EP13: undefined binding → error", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Show.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    data: {}",
        "  required:",
        "    - data",
        "  additionalProperties: false",
        "---",
        "data={props.data}",
      ].join("\n"),
      "doc.md": ["```js eval", "const x = 1;", "```", "", "<Show data={nonexistent} />"].join("\n"),
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("Failed to evaluate expression prop");
    expect(output).toContain("nonexistent");
  });

  it("EP14: non-serializable result → error", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Show.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    handler: {}",
        "  required:",
        "    - handler",
        "  additionalProperties: false",
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("non-serializable");
  });

  it("EP15: no binding in env → reference error", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Show.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    data: {}",
        "  required:",
        "    - data",
        "  additionalProperties: false",
        "---",
        "ok",
      ].join("\n"),
      // No eval block defines someVar — ReferenceError at expansion time
      "doc.md": "<Show data={someVar} />",
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("Failed to evaluate expression prop");
    expect(output).toContain("someVar");
  });

  it("EP16: syntax error in expression → error", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Show.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    x: {}",
        "  required:",
        "    - x",
        "  additionalProperties: false",
        "---",
        "ok",
      ].join("\n"),
      "doc.md": ["```js eval", "const a = 1;", "```", "", "<Show x={a +} />"].join("\n"),
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("Failed to evaluate expression prop");
  });

  it("EP17: mixed resolved and eval props", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Mixed.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    count:",
        "      type: number",
        "    data:",
        "      type: string",
        "    name:",
        "      type: string",
        "  required:",
        "    - count",
        "    - data",
        "    - name",
        "  additionalProperties: false",
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("count=42");
    expect(output).toContain("data=result");
    expect(output).toContain("name=hello");
  });

  it("EP18: expression prop passes validation", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Typed.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    count:",
        "      type: number",
        "  required:",
        "    - count",
        "  additionalProperties: false",
        "---",
        "count={props.count}",
      ].join("\n"),
      "doc.md": ["```js eval", "const total = 5;", "```", "", "<Typed count={total} />"].join("\n"),
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("count=5");
    expect(output).not.toContain("ERROR");
  });

  it("EP19: expression prop fails validation", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Typed.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    count:",
        "      type: number",
        "  required:",
        "    - count",
        "  additionalProperties: false",
        "---",
        "count={props.count}",
      ].join("\n"),
      "doc.md": ["```js eval", 'const name = "hello";', "```", "", "<Typed count={name} />"].join(
        "\n",
      ),
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("must be number");
  });

  it("EP20: expression prop with slot", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Layout.md": [
        "---",
        "props:",
        "  type: object",
        "  properties: {}",
        "  additionalProperties: false",
        "---",
        "```js eval",
        'const pr = "hello";',
        "```",
        "",
        '<Content slot="main" />',
      ].join("\n"),
      "components/Display.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    data:",
        "      type: string",
        "  required:",
        "    - data",
        "  additionalProperties: false",
        "---",
        "data={props.data}",
      ].join("\n"),
      "doc.md": ["<Layout>", '<Display slot="main" data={pr} />', "</Layout>"].join("\n"),
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("data=hello");
    expect(output).not.toContain("ERROR");
  });

  it("EP21: replay produces same props", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Show.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    count:",
        "      type: number",
        "  required:",
        "    - count",
        "  additionalProperties: false",
        "---",
        "count={props.count}",
      ].join("\n"),
      "doc.md": ["```js eval", "const total = 7;", "```", "", "<Show count={total} />"].join("\n"),
    });
    const stream = new InMemoryStream();
    const output1 = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
      }),
    );
    const output2 = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
      }),
    );
    expect(output1).toContain("count=7");
    expect(output2).toBe(output1);
  });

  it("EP22: nested component receives expression prop", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Outer.md": [
        "---",
        "props:",
        "  type: object",
        "  properties: {}",
        "  additionalProperties: false",
        "---",
        "```js eval",
        'const computed = "from-outer";',
        "```",
        "",
        "<Inner data={computed} />",
      ].join("\n"),
      "components/Inner.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    data:",
        "      type: string",
        "  required:",
        "    - data",
        "  additionalProperties: false",
        "---",
        "inner-data={props.data}",
      ].join("\n"),
      "doc.md": "<Outer />",
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("inner-data=from-outer");
  });

  it("EP23: children with expression props", function* () {
    const tmpDir = yield* useTempDirectory("expr-props-test-");
    yield* writeFiles(tmpDir, {
      "components/Parent.md": [
        "---",
        "props:",
        "  type: object",
        "  properties: {}",
        "  additionalProperties: false",
        "---",
        "```js eval",
        'const parentData = "from-parent";',
        "```",
        "",
        "<Content />",
      ].join("\n"),
      "components/Child.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    data:",
        "      type: string",
        "  required:",
        "    - data",
        "  additionalProperties: false",
        "---",
        "child-data={props.data}",
      ].join("\n"),
      "doc.md": ["<Parent>", "<Child data={parentData} />", "</Parent>"].join("\n"),
    });
    const stream = new InMemoryStream();
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("child-data=from-parent");
  });
});
