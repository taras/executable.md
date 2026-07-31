/**
 * Tier FC — Function component tests.
 *
 * Tests .ts files as components alongside .md files.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { Component } from "../src/component-api.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * A fixture project, not a bare directory. A component here is imported by
 * absolute file URL, so Node and Bun resolve it the way they resolve any
 * file: the nearest package.json decides its module type, and bare
 * specifiers resolve through the nearest node_modules. Under the system
 * temp dir there is neither, so the component would load as CommonJS and
 * fail to find `@executablemd/core`. Deno needs neither, because its import
 * map is process-wide.
 *
 * `cleanup` unlinks the node_modules symlink rather than following it.
 */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
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

interface ObservedRun {
  output: string;
  observed: string[];
}

/**
 * One execution with counting `raise` middleware in scope.
 *
 * Content a function component never asks for is never expanded, so nothing in
 * it is ever reported. Output alone cannot show that: a collecting policy
 * renders a diagnostic it observed, but so does an expansion that discarded
 * one. The observation count is what distinguishes "not expanded" from
 * "expanded and swallowed".
 */
function runObserved(dir: string): Operation<ObservedRun> {
  return scoped(function* () {
    const observed: string[] = [];
    yield* Component.around({
      *raise([error], next) {
        observed.push(error.message);
        return yield* next(error);
      },
    });
    const output = yield* collect(
      yield* execute({
        path: path.join(dir, "doc.md"),
        stream: new InMemoryStream(),
        componentDirs: [path.join(dir, "components"), dir],
      }),
    );
    return { output: String(output), observed };
  });
}

describe("Tier FC — Function components", () => {
  it("FC1: basic function component returns string", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Hello.ts": [
          "export default function*() {",
          '  return "Hello from TypeScript!";',
          "}",
        ].join("\n"),
        "doc.md": "<Hello />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("Hello from TypeScript!");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC-async: rejects an async props schema at the function-component load boundary", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Bad.ts": [
          "export const props = {",
          "  $async: true,",
          '  type: "object",',
          "  properties: {},",
          "  additionalProperties: false,",
          "};",
          'export default function*() { return "x"; }',
        ].join("\n"),
        "doc.md": "<Bad />",
      });
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream: new InMemoryStream(),
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("async");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC-reserved: rejects a reserved slot property at the function-component load boundary", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Bad.ts": [
          "export const props = {",
          '  type: "object",',
          '  properties: { slot: { type: "string" } },',
          "  additionalProperties: false,",
          "};",
          'export default function*() { return "x"; }',
        ].join("\n"),
        "doc.md": "<Bad />",
      });
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream: new InMemoryStream(),
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("reserved");
    } finally {
      cleanup(tmpDir);
    }
  });

  // A function component declares its schema through `props`; an `inputs`
  // export is ignored, leaving the default closed empty-object schema.
  it("FC-alias: an `inputs` export declares no props and rejects one", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Legacy.ts": [
          "export const inputs = {",
          '  type: "object",',
          '  properties: { name: { type: "string" } },',
          "  additionalProperties: false,",
          "};",
          "export default function*(props) { return `name=${props.name}`; }",
        ].join("\n"),
        "doc.md": '<Legacy name="world" />',
      });
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream: new InMemoryStream(),
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("name");
      expect(output).not.toContain("name=world");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC-alias: the same component declared with `props` validates normally", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Modern.ts": [
          "export const props = {",
          '  type: "object",',
          '  properties: { name: { type: "string" } },',
          "  additionalProperties: false,",
          "};",
          "export default function*(props) { return `name=${props.name}`; }",
        ].join("\n"),
        "doc.md": '<Modern name="world" />',
      });
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream: new InMemoryStream(),
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("name=world");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC2: function component with props", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Greet.ts": [
          "export const props = {",
          '  type: "object",',
          '  properties: { name: { type: "string" } },',
          '  required: ["name"],',
          "  additionalProperties: false,",
          "};",
          "",
          "export default function*(props) {",
          "  return `Hello, ${props.name}!`;",
          "}",
        ].join("\n"),
        "doc.md": '<Greet name="world" />',
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("Hello, world!");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC3: function component renders its content with content()", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Wrapper.ts": [
          'import { content } from "@executablemd/core";',
          "",
          "export default function*() {",
          "  const rendered = yield* content();",
          "  return `BEFORE\\n${rendered}\\nAFTER`;",
          "}",
        ].join("\n"),
        "doc.md": ["<Wrapper>", "child content here", "</Wrapper>"].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("BEFORE");
      expect(output).toContain("child content here");
      expect(output).toContain("AFTER");
    } finally {
      cleanup(tmpDir);
    }
  });

  // `content()` is the canonical operation; a component written against the
  // `useContent()` alias keeps working, including for a named slot.
  it("FC3-compat: a component written with useContent() still renders its content", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Legacy.ts": [
          'import { useContent } from "@executablemd/core";',
          "",
          "export default function*() {",
          "  const childContent = yield* useContent();",
          '  const heading = yield* useContent("header");',
          "  return `HEAD[${heading.trim()}]\\n${childContent}`;",
          "}",
        ].join("\n"),
        "doc.md": [
          "<Legacy>",
          '<Note slot="header" />',
          "",
          "child content here",
          "</Legacy>",
        ].join("\n"),
        "components/Note.md": [
          "---",
          "props:",
          "  type: object",
          "  properties: {}",
          "  additionalProperties: false",
          "---",
          "HEADING",
        ].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("HEAD[HEADING]");
      expect(output).toContain("child content here");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC4: .md wins over .ts when both exist", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Dual.md": [
          "---",
          "props:",
          "  type: object",
          "  properties: {}",
          "  additionalProperties: false",
          "---",
          "FROM-MARKDOWN",
        ].join("\n"),
        "components/Dual.ts": [
          "export default function*() {",
          '  return "FROM-TYPESCRIPT";',
          "}",
        ].join("\n"),
        "doc.md": "<Dual />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("FROM-MARKDOWN");
      expect(output).not.toContain("FROM-TYPESCRIPT");
    } finally {
      cleanup(tmpDir);
    }
  });

  // The default: a component that fails fails the operation it is part of, so
  // the document stops rather than rendering a note and carrying on.
  it("FC5: an unmarked component's failure fails the execution", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Broken.ts": [
          "export default function*() {",
          '  throw new Error("component error");',
          "}",
        ].join("\n"),
        "doc.md": "<Broken />\n\nAFTER\n",
      });
      const execution = yield* execute({
        path: path.join(tmpDir, "doc.md"),
        stream: new InMemoryStream(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
      });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      const result = yield* execution;

      // A failed operation, not a completed one holding a diagnostic.
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.message).toContain("component error");
      // Nothing after it ran, and nothing was rendered in its place.
      expect(next.value).not.toContain("AFTER");
      expect(next.value).not.toContain("<!-- ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // The explicit choice: `collectFailures` says this component reports rather
  // than stops, so the failure becomes one diagnostic and the document goes on.
  it("FC5b: a component marked with collectFailures reports and continues", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Broken.ts": [
          'import { collectFailures } from "@executablemd/core";',
          "export default collectFailures(function*() {",
          '  throw new Error("component error");',
          "});",
        ].join("\n"),
        "doc.md": "<Broken />\n\nAFTER\n",
      });
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream: new InMemoryStream(),
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(String(output)).toContain("component error");
      expect(String(output)).toContain("AFTER");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC6: function component prop validation", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Typed.ts": [
          "export const props = {",
          '  type: "object",',
          '  properties: { count: { type: "number" } },',
          '  required: ["count"],',
          "  additionalProperties: false,",
          "};",
          "",
          "export default function*(props) {",
          "  return `count=${props.count}`;",
          "}",
        ].join("\n"),
        "doc.md": "<Typed count={42} />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("count=42");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC7: function component missing required prop → error", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Req.ts": [
          "export const props = {",
          '  type: "object",',
          '  properties: { name: { type: "string" } },',
          '  required: ["name"],',
          "  additionalProperties: false,",
          "};",
          "",
          "export default function*(props) {",
          "  return `name=${props.name}`;",
          "}",
        ].join("\n"),
        "doc.md": "<Req />",
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("must have required property");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC8: function component alongside markdown components", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/MdComp.md": [
          "---",
          "props:",
          "  type: object",
          "  properties: {}",
          "  additionalProperties: false",
          "---",
          "FROM-MD",
        ].join("\n"),
        "components/TsComp.ts": ["export default function*() {", '  return "FROM-TS";', "}"].join(
          "\n",
        ),
        "doc.md": ["<MdComp />", "", "<TsComp />"].join("\n"),
      });
      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );
      expect(output).toContain("FROM-MD");
      expect(output).toContain("FROM-TS");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC9: replay with function component", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Static.ts": [
          "export default function*() {",
          '  return "STATIC-OUTPUT";',
          "}",
        ].join("\n"),
        "doc.md": "<Static />",
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
      expect(output1).toContain("STATIC-OUTPUT");
      expect(output2).toBe(output1);
    } finally {
      cleanup(tmpDir);
    }
  });

  // FC10: only the requested slot is expanded, so a slot the component never
  // asks for cannot fail the invocation — nothing in it runs.
  it("FC10: an error in an unrequested slot is never expanded or observed", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Body.ts": [
          'import { content } from "@executablemd/core";',
          "",
          "export default function*() {",
          "  const rendered = yield* content();",
          "  return `BODY[${rendered.trim()}]`;",
          "}",
        ].join("\n"),
        "doc.md": ["<Body>", '<Missing slot="header" />', "", "body text", "</Body>"].join("\n"),
      });

      const run = yield* runObserved(tmpDir);

      expect(run.output).toContain("BODY[body text]");
      expect(run.output).not.toContain("ERROR");
      expect(run.observed).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  // FC11: content is expanded because the component asks for it. One that never
  // calls content() leaves it unexpanded, however broken it is.
  it("FC11: a component that never calls content() does not expand it", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Ignores.ts": [
          "export default function*() {",
          '  return "IGNORED-CONTENT";',
          "}",
        ].join("\n"),
        "doc.md": ["<Ignores>", "<Missing />", "</Ignores>"].join("\n"),
      });

      const run = yield* runObserved(tmpDir);

      expect(run.output).toContain("IGNORED-CONTENT");
      expect(run.output).not.toContain("ERROR");
      expect(run.observed).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  // FC12: recovery is written the way an author writes it — a real .ts file
  // compiled by the engine, importing `ContentError` from the package. The
  // `instanceof` check is the assertion: it only matches if the class the
  // component imported is the class the engine threw.
  it("FC12: a compiled component catches ContentError and returns its own fallback", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Preview.ts": [
          'import { content, ContentError } from "@executablemd/core";',
          "",
          "export default function* Preview() {",
          "  try {",
          "    return yield* content();",
          "  } catch (error) {",
          "    if (error instanceof ContentError) {",
          '      return `recovered:${error.errors[0]?.message ?? "?"}`;',
          "    }",
          "    throw error;",
          "  }",
          "}",
        ].join("\n"),
        "doc.md": ["<Preview>", "<Missing />", "</Preview>"].join("\n"),
      });

      const run = yield* runObserved(tmpDir);

      // The child error was reported exactly once, where it was created;
      // recovery neither suppressed that observation nor added another.
      expect(run.observed).toHaveLength(1);
      expect(run.observed[0]).toContain("Cannot resolve component: Missing");
      // The fallback quotes the message of that same segment, so the component
      // inspected the original error rather than a rendered summary of it — and
      // the document shows the recovery instead of a diagnostic.
      expect(run.output).toContain(`recovered:${run.observed[0]}`);
      expect(run.output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });
});

/**
 * Tier FC-WF — the invocation shape a component like `<WebForm>` needs.
 *
 * An object-valued schema resolved from the document reaches the function
 * through validated props; the content it renders is validated before the
 * effects that follow it; and its declared return only becomes an `as` binding
 * when that content succeeded. The engine owns every one of those steps, so the
 * component needs neither the raw element nor an expression resolver.
 */
describe("Tier FC-WF — props, returns, and as around content()", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * `record` is an operation the component genuinely yields to, and the log
   * file is the only witness that it ran. Reading non-execution out of the
   * rendered output would prove nothing: a failed invocation renders no output
   * either way.
   */
  function analyze(dir: string): string {
    return [
      'import { content } from "@executablemd/core";',
      'import { appendFileSync } from "node:fs";',
      "",
      `const LOG = ${JSON.stringify(path.join(dir, "effects.log"))};`,
      "",
      "function* record(event) {",
      "  appendFileSync(LOG, event + '\\n');",
      "}",
      "",
      "export const props = {",
      '  type: "object",',
      '  properties: { schema: { type: "object" } },',
      '  required: ["schema"],',
      "  additionalProperties: false,",
      "};",
      "",
      "export const returns = {",
      '  type: "object",',
      "  properties: {",
      '    body: { type: "string" },',
      '    schemaType: { type: "string" },',
      '    fields: { type: "array", items: { type: "string" } },',
      "  },",
      '  required: ["body", "schemaType", "fields"],',
      "  additionalProperties: false,",
      "};",
      "",
      "export default function*(props) {",
      "  yield* record(`props:${props.schema.type}:${Object.keys(props.schema.properties)}`);",
      "  const rendered = yield* content();",
      "  yield* record('post-content');",
      "  return {",
      "    body: rendered.trim(),",
      "    schemaType: props.schema.type,",
      "    fields: Object.keys(props.schema.properties),",
      "  };",
      "}",
    ].join("\n");
  }

  function invocation(...children: string[]): string {
    return [
      "```js eval",
      "const responseSchema = {",
      '  type: "object",',
      '  properties: { question: { type: "string" }, answer: { type: "string" } },',
      "};",
      "```",
      "",
      '<Analyze schema={responseSchema} as="result">',
      ...children,
      "</Analyze>",
      "",
      "```js eval",
      // `typeof` on a name the invocation never bound is safe; reading it
      // directly would be a ReferenceError and hide what is being asserted.
      "const shown = typeof result === 'undefined' ? 'unbound' : JSON.stringify(result);",
      "```",
      "",
      "captured: {shown}",
      "",
    ].join("\n");
  }

  /** Every event the component's `record` operation appended, in order. */
  function events(dir: string): string[] {
    const log = path.join(dir, "effects.log");
    if (!fs.existsSync(log)) {
      return [];
    }
    return fs.readFileSync(log, "utf8").trim().split("\n");
  }

  it("FC-WF1: an object-valued schema prop reaches the function and its return binds", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Analyze.ts": analyze(tmpDir),
        "doc.md": invocation("analysis body"),
      });

      const run = yield* runObserved(tmpDir);

      expect(run.observed).toEqual([]);
      expect(run.output).not.toContain("ERROR");
      // The declared return validated and reached the invocation site.
      expect(run.output).toContain(
        `captured: ${JSON.stringify({
          body: "analysis body",
          schemaType: "object",
          fields: ["question", "answer"],
        })}`,
      );
      // The function saw the resolved, validated schema object, not an
      // expression or a string, and resumed past its content.
      expect(events(tmpDir)).toEqual(["props:object:question,answer", "post-content"]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("FC-WF2: failed content skips the return, the binding, and post-content work", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Analyze.ts": analyze(tmpDir),
        "doc.md": invocation("PARTIAL-BEFORE", "<Missing />", "PARTIAL-AFTER"),
      });

      const run = yield* runObserved(tmpDir);

      // The original diagnostic replaces the whole invocation, once.
      expect(run.observed).toHaveLength(1);
      expect(run.observed[0]).toContain("Cannot resolve component: Missing");
      expect(run.output.match(/Cannot resolve component: Missing/g)).toHaveLength(1);
      // No wrapper, and no partial content from around the failure.
      expect(run.output).not.toContain("PARTIAL-BEFORE");
      expect(run.output).not.toContain("PARTIAL-AFTER");
      // Nothing validated the return, so `as` left the binding unmade — and the
      // sibling that reads it still runs under the collecting policy.
      expect(run.output).toContain("captured: unbound");
      // The function ran and received its validated props; it stopped at
      // content() and never reached the effect after it.
      expect(events(tmpDir)).toEqual(["props:object:question,answer"]);
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("Tier O — Eval scope hierarchy", () => {
  // O22: the widened component contract keeps durability compositional — a
  // component can journal a durable effect and hold an ordinary resource in the
  // same body, and each keeps its own semantics across a partial replay.
  it("O22: a component combines a durable effect with a directly acquired resource", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Mixed.ts": [
          'import { durableCall } from "@executablemd/durable-streams";',
          'import { ensure, resource } from "effection";',
          'import { appendFileSync, readFileSync } from "node:fs";',
          "",
          `const DIR = ${JSON.stringify(tmpDir)};`,
          "",
          "function mark(kind, event) {",
          "  const file = `${DIR}/${kind}.log`;",
          "  appendFileSync(file, event + '\\n');",
          "  return readFileSync(file, 'utf8').trim().split('\\n').length;",
          "}",
          "",
          "export default function*() {",
          "  yield* resource(function*(provide) {",
          "    mark('resource', 'acquire');",
          "    yield* ensure(function*() { mark('resource', 'release'); });",
          "    yield* provide();",
          "  });",
          "  const stamp = yield* durableCall('component-stamp', () =>",
          "    Promise.resolve(mark('executor', 'ran')));",
          "  return `stamp=${stamp}`;",
          "}",
        ].join("\n"),
        "doc.md": "<Mixed />",
      });

      const stream = new InMemoryStream();
      const first = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      // durableRun short-circuits on the root Close, so a stream without it is
      // what forces a replay that then continues live.
      const events = yield* stream.readAll();
      const partial = events.filter(
        (event) => !(event.type === "close" && event.coroutineId === "root"),
      );
      const second = yield* collect(
        yield* execute({
          path: path.join(tmpDir, "doc.md"),
          stream: new InMemoryStream(partial),
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      const lines = (kind: string) =>
        fs
          .readFileSync(path.join(tmpDir, `${kind}.log`), "utf8")
          .trim()
          .split("\n");

      // The durable executor ran once and was replayed the second time.
      expect(lines("executor")).toEqual(["ran"]);
      expect(second).toBe(first);
      expect(first).toContain("stamp=1");
      // The ordinary resource is re-established per execution and owned by the
      // invocation, so it is acquired and released once on each run.
      expect(lines("resource")).toEqual(["acquire", "release", "acquire", "release"]);
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("Tier RT — Retained resources under durability", () => {
  beforeAll(() => useTempFileCompiler());

  /**
   * One bounded execution. A resource retained at the root belongs to the
   * document eval scope, which `execute()` acquires on its caller's frame —
   * so the scope has to close before the run's effects can be read.
   */
  function runDocument(dir: string, stream: InMemoryStream): Operation<Json> {
    return scoped(function* () {
      return yield* collect(
        yield* execute({
          path: path.join(dir, "doc.md"),
          stream,
          componentDirs: [path.join(dir, "components"), dir],
        }),
      );
    });
  }

  // RT15: retention is a property of component execution, so it composes with
  // durability the way an ordinary resource does (O22). The import and the
  // durable effect replay; the retained resource is re-established on each
  // execution that actually runs, and released with its site scope each time.
  it("RT15: a retained resource is re-established on every execution", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "components/Held.ts": [
          'import { durableCall } from "@executablemd/durable-streams";',
          'import { retain } from "@executablemd/core";',
          'import { ensure } from "effection";',
          'import { appendFileSync, readFileSync } from "node:fs";',
          "",
          `const DIR = ${JSON.stringify(tmpDir)};`,
          "",
          "function mark(kind, event) {",
          "  const file = `${DIR}/${kind}.log`;",
          "  appendFileSync(file, event + '\\n');",
          "  return readFileSync(file, 'utf8').trim().split('\\n').length;",
          "}",
          "",
          "export default function*() {",
          "  const token = yield* retain(function*() {",
          "    mark('retained', 'acquire');",
          "    yield* ensure(function*() { mark('retained', 'release'); });",
          "    return 'token';",
          "  });",
          "  const stamp = yield* durableCall('held-stamp', () =>",
          "    Promise.resolve(mark('executor', 'ran')));",
          "  return `${token}=${stamp}`;",
          "}",
        ].join("\n"),
        "doc.md": "<Held />",
      });

      const stream = new InMemoryStream();
      const first = yield* runDocument(tmpDir, stream);

      // Without the root Close the second run replays what is journaled and
      // then continues live — the same partial-replay shape O22 uses.
      const events = yield* stream.readAll();
      const partial = events.filter(
        (event) => !(event.type === "close" && event.coroutineId === "root"),
      );
      const second = yield* runDocument(tmpDir, new InMemoryStream(partial));

      const lines = (kind: string) =>
        fs
          .readFileSync(path.join(tmpDir, `${kind}.log`), "utf8")
          .trim()
          .split("\n");

      expect(first).toContain("token=1");
      expect(second).toBe(first);
      // The durable executor ran once and replayed the second time.
      expect(lines("executor")).toEqual(["ran"]);
      // The retained resource did not: it is re-established per execution and
      // released with that execution's site scope — the document scope here.
      expect(lines("retained")).toEqual(["acquire", "release", "acquire", "release"]);
    } finally {
      cleanup(tmpDir);
    }
  });

  // RT16: the same request from an eval block is refused. Eval is durable, so a
  // replay would restore the block's values without re-establishing anything.
  it("RT16: an eval block cannot retain at the invocation site", function* () {
    const tmpDir = makeTempDir();
    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          'import { retain } from "@executablemd/core";',
          "const held = yield* retain(function*() { return 'nope'; });",
          "output(held);",
          "```",
        ].join("\n"),
      });

      const output = yield* runDocument(tmpDir, new InMemoryStream());

      expect(output).toContain("cannot retain a resource at the invocation site");
      expect(output).not.toContain("nope");
    } finally {
      cleanup(tmpDir);
    }
  });
});
