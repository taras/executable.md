/**
 * Expression prop evaluation tests — Tier EP + Scanner ES.
 *
 * Covers eval expression resolution against env.values, scanner-level
 * parseExpressionValue changes, and integration with expansion/validation.
 */

import { workspaceJournalCases } from "../../test-support/journal-cases.ts";
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { parseExpressionValue, scanSegments } from "../src/scanner.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useStubFs } from "@executablemd/runtime/test";
import { asText } from "./helpers.ts";
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
    includes: [path.join(tmpDir, "components"), tmpDir],
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

const expressionCase = workspaceJournalCases(
  "packages/core/tests/expression-props.test.ts",
  "doc.md",
  () => useTempDirectory("expr-props-test-"),
);

describe("Tier EP — Expression prop evaluation", () => {
  beforeAll(() => useTempFileCompiler());
  expressionCase("EP1: bare identifier resolves from env", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    // {props.data} will be interpolated — for objects, it uses toString
    expect(output).toContain("received:");
    expect(output).not.toContain("ERROR");
  });

  expressionCase("EP2: member expression resolves", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("length=3");
  });

  expressionCase("EP3: comparison expression resolves", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("active=true");
  });

  expressionCase("EP5: arithmetic expression", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("total=30");
  });

  expressionCase("EP6: JSON literal still resolves at scan time", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("count=42");
  });

  expressionCase("EP11: string attribute unaffected", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("hello world");
  });

  expressionCase("EP13: undefined binding → error", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("Failed to evaluate expression prop");
    expect(output).toContain("nonexistent");
  });

  expressionCase("EP14: non-serializable result → error", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("non-serializable");
  });

  expressionCase("EP15: no binding in env → reference error", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("Failed to evaluate expression prop");
    expect(output).toContain("someVar");
  });

  expressionCase("EP16: syntax error in expression → error", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("Failed to evaluate expression prop");
  });

  expressionCase("EP17: mixed resolved and eval props", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("count=42");
    expect(output).toContain("data=result");
    expect(output).toContain("name=hello");
  });

  expressionCase("EP18: expression prop passes validation", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("count=5");
    expect(output).not.toContain("ERROR");
  });

  expressionCase("EP19: expression prop fails validation", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("must be number");
  });

  expressionCase("EP20: expression prop with slot", function* (stream, tmpDir) {
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
        includes: [path.join(tmpDir, "components"), tmpDir],
      }),
    );
    const output2 = yield* collect(
      yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream,
        includes: [path.join(tmpDir, "components"), tmpDir],
      }),
    );
    expect(output1).toContain("count=7");
    expect(output2).toBe(output1);
  });

  expressionCase("EP22: nested component receives expression prop", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("inner-data=from-outer");
  });

  expressionCase("EP23: children with expression props", function* (stream, tmpDir) {
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
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("child-data=from-parent");
  });
});

/**
 * Tier EU — an expression prop that evaluates to `undefined` (spec §6.5).
 *
 * Absence is a thing an author writes: a prop whose value has not been produced
 * yet is simply not there. It is decided once, in the resolver both component
 * kinds pass through, before validation and before anything durable is written.
 * The function-component call path is CP8; these are the Markdown one, and the
 * boundary the two of them share.
 */
describe("Tier EU — a prop that evaluates to undefined", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * A component that reports what it was given. Its body reads `props` from an
   * eval block rather than through `{props.value}`, because interpolation
   * renders an absent prop and a `null` one the same way and these cases are
   * about telling them apart.
   */
  function probe(declaration: string[], report = 'own=${Object.hasOwn(props, "value")}'): string {
    return [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      ...declaration,
      "  additionalProperties: false",
      "---",
      "```js eval",
      "return `" + report + "`;",
      "```",
    ].join("\n");
  }

  expressionCase(
    "EU1: a member that is not there is a prop that is not there",
    function* (stream, tmpDir) {
      yield* writeFiles(tmpDir, {
        "components/Probe.md": probe(["    value: {}"]),
        "doc.md": [
          "```js eval",
          "const record = { present: 1 };",
          "```",
          "",
          "<Probe value={record.missing} />",
        ].join("\n"),
      });
      const output = yield* said(tmpDir, stream);
      expect(output).toContain("own=false");
    },
  );

  expressionCase("EU2: a literal `undefined` takes that same path", function* (stream, tmpDir) {
    yield* writeFiles(tmpDir, {
      "components/Probe.md": probe(["    value: {}"]),
      "doc.md": "<Probe value={undefined} />",
    });
    const output = yield* said(tmpDir, stream);
    expect(output).toContain("own=false");
  });

  expressionCase("EU3: a declared default answers the absence", function* (stream, tmpDir) {
    yield* writeFiles(tmpDir, {
      "components/Probe.md": probe(
        ["    value:", "      type: string", '      default: "fallback"'],
        'own=${Object.hasOwn(props, "value")} value=${props.value}',
      ),
      "doc.md": [
        "```js eval",
        "const record = {};",
        "```",
        "",
        "<Probe value={record.missing} />",
      ].join("\n"),
    });
    const output = yield* said(tmpDir, stream);
    // Omission happens before validation, which is the only reason the schema
    // gets to supply its default.
    expect(output).toContain("own=true value=fallback");
  });

  expressionCase(
    "EU4: a required prop is missing, and the body does not run",
    function* (stream, tmpDir) {
      yield* writeFiles(tmpDir, {
        "components/Probe.md": [
          "---",
          "props:",
          "  type: object",
          "  properties:",
          "    value: {}",
          "  required:",
          "    - value",
          "  additionalProperties: false",
          "---",
          "THE BODY RAN",
        ].join("\n"),
        "doc.md": [
          "```js eval",
          "const record = {};",
          "```",
          "",
          "<Probe value={record.missing} />",
        ].join("\n"),
      });
      const output = yield* said(tmpDir, stream);
      expect(output).toContain("value");
      expect(output).toContain("required");
      expect(output).not.toContain("THE BODY RAN");
    },
  );

  expressionCase(
    "EU5: `null` is a value the author wrote, not an absence",
    function* (stream, tmpDir) {
      yield* writeFiles(tmpDir, {
        "components/Probe.md": probe(
          ["    value:", '      type: ["string", "null"]'],
          'own=${Object.hasOwn(props, "value")} value=${String(props.value)};',
        ),
        "doc.md": [
          "```js eval",
          "const record = {};",
          "```",
          "",
          "<Probe value={null} />",
          "",
          "<Probe value={record.missing} />",
        ].join("\n"),
      });
      const output = yield* said(tmpDir, stream);
      expect(output).toContain("own=true value=null;");
      expect(output).toContain("own=false value=undefined;");
    },
  );

  expressionCase(
    "EU6: an expression that throws is still the failure it was",
    function* (stream, tmpDir) {
      yield* writeFiles(tmpDir, {
        "components/Probe.md": probe(["    value: {}"]),
        "doc.md": [
          "```js eval",
          "const record = { boom() { throw new Error('no value here'); } };",
          "```",
          "",
          "<Probe value={record.boom()} />",
        ].join("\n"),
      });
      const output = yield* said(tmpDir, stream);
      expect(output).toContain("Failed to evaluate expression prop");
      expect(output).toContain("no value here");
    },
  );

  expressionCase(
    "EU7: a nested `undefined` keeps its native JSON reading",
    function* (stream, tmpDir) {
      yield* writeFiles(tmpDir, {
        "components/Probe.md": probe(
          ["    value:", "      type: object"],
          "json=${JSON.stringify(props.value)}",
        ),
        "doc.md": [
          "```js eval",
          "const record = {};",
          "```",
          "",
          "<Probe value={{ a: record.missing, b: [record.missing, 1], c: 2 }} />",
        ].join("\n"),
      });
      const output = yield* said(tmpDir, stream);
      // One `JSON.stringify` decides everything below the root, as it always
      // has: an object member goes, an array entry becomes `null`.
      expect(output).toContain('json={"b":[null,1],"c":2}');
    },
  );

  it("EU8: nothing durable holds it, and replay reconstructs the same props", function* () {
    const document = [
      "```ts eval",
      "const record = {};",
      "```",
      "",
      "<Probe value={record.missing} />",
      "",
      "```ts eval",
      'return "and after";',
      "```",
    ].join("\n");

    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": document,
      "components/Probe.md": probe(
        ["    value:", "      type: string", '      default: "fallback"'],
        'own=${Object.hasOwn(props, "value")} value=${props.value}',
      ),
    });

    const golden = asText(yield* collect(yield* execute({ path: "README.md", stream })));
    expect(golden).toContain("own=true value=fallback");
    expect(golden).toContain("and after");

    const full = stream.snapshot();
    // Resolving the prop wrote nothing of its own: the record is the imports
    // and the evals it always was.
    expect(full.map(kind)).toEqual([
      "import_component",
      "eval",
      "import_component",
      "eval",
      "eval",
      "close",
    ]);
    expect(holdsUndefined(full)).toBe(false);

    // A crash before the last eval: the run resumes into the live suffix and
    // expands the invocation again, so the absent prop is reconstructed rather
    // than restored.
    const prefix = full.slice(0, full.length - 2);
    const resumedStream = new InMemoryStream(prefix);
    const resumed = asText(
      yield* collect(yield* execute({ path: "README.md", stream: resumedStream })),
    );
    expect(resumed).toBe(golden);
    expect(holdsUndefined(resumedStream.snapshot())).toBe(false);

    // A completed run is answered from its own terminal outcome: nothing is
    // imported a second time, so no body runs.
    const replayed = asText(yield* collect(yield* execute({ path: "README.md", stream })));
    expect(replayed).toBe(golden);
    expect(stream.snapshot().map(kind)).toEqual(full.map(kind));
  });
});

/** What one journal event is, for an assertion about a run's whole record. */
// deno-lint-ignore no-explicit-any
function kind(event: any): string {
  return event.type === "yield" ? String(event.description.type) : String(event.type);
}

/** Whether anything reachable from a durable record holds `undefined`. */
function holdsUndefined(node: unknown): boolean {
  if (node === undefined) {
    return true;
  }
  if (node === null || typeof node !== "object") {
    return false;
  }
  return Reflect.ownKeys(node).some((key) =>
    holdsUndefined((node as Record<PropertyKey, unknown>)[key]),
  );
}
