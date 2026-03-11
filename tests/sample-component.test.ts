/**
 * Tier SC — Sample component tests.
 *
 * Tests the Sample component (components/Sample.md), the output() eval
 * function, and the renderChildren/render closures injected into
 * component environments.
 *
 * The Sample component:
 * - With children: expands children → captures rendered output → sends to Sample Api → outputs response
 * - Self-closing with prompt: sends prompt text to Sample Api → outputs response
 *
 * Uses stub providers (Sample.around middleware) to intercept Sample Api
 * calls and return canned responses for testing.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@effectionx/durable-streams";
import { stubRuntime } from "@effectionx/durable-effects";
import type { DurableRuntime, StatResult } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";
import { runDocument } from "../src/run-document.ts";
import { Sample } from "../src/sample-api.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ema-sc-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    const fileDir = path.dirname(fullPath);
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

/** Stub provider that returns canned responses with the model name. */
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
    "    return '[sampled-by-' + model + ':' + context.stdout.trim() + ']';",
    "  },",
    "}, { at: 'min' });",
    "```",
    "",
    "<Content />",
  ].join("\n");
}

/** In-memory runtime that stubs readTextFile, stat, and exec. */
function makeRuntime(files: Record<string, string>): DurableRuntime {
  return stubRuntime({
    *readTextFile(filePath: string) {
      const content = files[filePath];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${filePath}`);
      }
      return content;
    },
    *stat(filePath: string): Generator<never, StatResult, unknown> {
      const exists = filePath in files;
      return { exists, isFile: exists, isDirectory: false };
    },
    *exec(options: { command: string[]; timeout?: number }) {
      const cmd = options.command.join(" ");
      if (cmd.includes("bash -c")) {
        const script = (options.command[2] ?? "").trim();
        if (script.startsWith("echo ")) {
          return { exitCode: 0, stdout: script.slice(5) + "\n", stderr: "" };
        }
        return { exitCode: 0, stdout: script + "\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

// ---------------------------------------------------------------------------
// Tier SC — Sample component tests
// ---------------------------------------------------------------------------

describe("Tier SC — Sample component", () => {
  // SC1: Self-closing with prompt — prompt sent to Sample Api
  it("SC1: self-closing with prompt — response in output", function* () {
    const tmpDir = makeTempDir();

    try {
      // Read the real Sample.md component
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Sample model="test-model" prompt="hello world" />',
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // The stub provider echoes back the model and the prompt
      expect(output).toContain("[sampled-by-test-model:hello world]");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC2: With children containing exec block — children output sent to Sample Api
  it("SC2: with children — children output captured and sampled", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Sample model="test-model">',
          "",
          "```bash exec",
          "echo children-output-here",
          "```",
          "",
          "</Sample>",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // The children exec block produces "children-output-here\n"
      // The stub provider echoes it back with the model name
      expect(output).toContain("[sampled-by-test-model:children-output-here");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC3: Model routing — <Sample model="X"> routes to matching provider
  it("SC3: model routing — targets specific provider", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/OuterProv.md": stubProvider("OuterProv"),
        "components/InnerProv.md": stubProvider("InnerProv"),
        "doc.md": [
          '<OuterProv model="outer">',
          "",
          '<InnerProv model="inner">',
          "",
          '<!-- Target the outer provider explicitly -->',
          '<Sample model="outer" prompt="routed-to-outer" />',
          "",
          "</InnerProv>",
          "",
          "</OuterProv>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // The outer provider should handle the call
      expect(output).toContain("[sampled-by-outer:routed-to-outer]");
      expect(output).not.toContain("[sampled-by-inner");
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC4: No provider → descriptive error
  it("SC4: no provider — descriptive error", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "doc.md": '<Sample prompt="no provider" />',
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // Should contain error about missing Sample Api middleware
      expect(output).toContain("ERROR");
      expect(output).toContain("Sample Api middleware");
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC5: Replay returns stored response — no re-execution
  it("SC5: replay returns stored response", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Sample model="test-model" prompt="replay-test" />',
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      // First run
      const stream = new InMemoryStream();
      const output1 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      expect(output1).toContain("[sampled-by-test-model:replay-test]");

      // Second run (replay) — same stream
      const output2 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      expect(output2).toContain("[sampled-by-test-model:replay-test]");
      expect(output1).toEqual(output2);
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC6: renderChildren returns empty for self-closing component
  it("SC6: self-closing — renderChildren returns empty, prompt used", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Sample model="test-model" prompt="self-closing-prompt" />',
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      expect(output).toContain("[sampled-by-test-model:self-closing-prompt]");
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier EO — eval output() function tests
// ---------------------------------------------------------------------------

describe("Tier EO — eval output() function", () => {
  // EO1: output() sets eval block output
  it("EO1: output() produces eval block output", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\noutput("hello from eval");\n```\n',
    });

    const output = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output).toContain("hello from eval");
  });

  // EO2: output() replayed from journal
  it("EO2: output() replayed from journal", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\noutput("journaled-output");\n```\n',
    });

    // First run
    const output1 = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output1).toContain("journaled-output");

    // Replay
    const output2 = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output2).toContain("journaled-output");
    expect(output1).toEqual(output2);
  });

  // EO3: eval block without output() still returns empty
  it("EO3: eval block without output() produces no output", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js eval\nconst x = 42;\n```\nafter-eval",
    });

    const output = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    // No output from eval block — should see "after-eval" but no "42"
    expect(output).toContain("after-eval");
    expect(output).not.toContain("42");
  });

  // EO4: output() with multiline content
  it("EO4: output() with multiline content", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\noutput("line1\\nline2\\nline3");\n```\n',
    });

    const output = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output).toContain("line1\nline2\nline3");
  });

  // EO5: output() converts non-string to string
  it("EO5: output() converts non-string to string", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js eval\noutput(12345);\n```\n",
    });

    const output = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output).toContain("12345");
  });
});

// ---------------------------------------------------------------------------
// Tier RC — renderChildren / render closure tests
// ---------------------------------------------------------------------------

describe("Tier RC — renderChildren and render closures", () => {
  // RC1: renderChildren() returns empty string for self-closing component
  it("RC1: renderChildren returns empty for self-closing component", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "components/TestComp.md": [
        "---",
        "meta:",
        "  componentName: TestComp",
        "---",
        "",
        "```js eval",
        "const result = yield* renderChildren();",
        "output('children:[' + result + ']');",
        "```",
      ].join("\n"),
      "test.md": "<TestComp />",
    });

    const output = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output).toContain("children:[]");
  });

  // RC2: renderChildren() captures children text content
  it("RC2: renderChildren captures children text", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "components/TestComp.md": [
        "---",
        "meta:",
        "  componentName: TestComp",
        "---",
        "",
        "```js eval",
        "const result = yield* renderChildren();",
        "output('children:[' + result.trim() + ']');",
        "```",
      ].join("\n"),
      "test.md": [
        "<TestComp>",
        "",
        "hello from children",
        "",
        "</TestComp>",
      ].join("\n"),
    });

    const output = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output).toContain("children:[hello from children]");
  });

  // RC3: render() expands arbitrary markdown
  it("RC3: render() expands arbitrary markdown string", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "components/TestComp.md": [
        "---",
        "meta:",
        "  componentName: TestComp",
        "---",
        "",
        "```js eval",
        "const result = yield* render('arbitrary **markdown** content');",
        "output('rendered:[' + result.trim() + ']');",
        "```",
      ].join("\n"),
      "test.md": "<TestComp />",
    });

    const output = yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    });

    expect(output).toContain("rendered:[arbitrary **markdown** content]");
  });
});
