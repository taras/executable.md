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
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmd-sc-test-"));
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

/** Stub provider that echoes context.system alongside model and content. */
function stubProviderWithInstructions(componentName: string): string {
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
    "    return '[sampled-by-' + model + ':' + context.content.trim() + '|system:' + (context.system || 'none') + ']';",
    "  },",
    "}, { at: 'min' });",
    "```",
    "",
    "<Content />",
  ].join("\n");
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
    "    return '[sampled-by-' + model + ':' + context.content.trim() + ']';",
    "  },",
    "}, { at: 'min' });",
    "```",
    "",
    "<Content />",
  ].join("\n");
}

describe("Tier SC — Sample component", () => {
  // SC1: Self-closing with prompt — prompt sent to Sample Api
  it("SC1: self-closing with prompt — response in output", function* () {
    const tmpDir = makeTempDir();

    try {
      // Read the real Sample.md component
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
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
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

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
        path.join(process.cwd(), "core/components/Sample.md"),
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
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

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
        path.join(process.cwd(), "core/components/Sample.md"),
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
          "<!-- Target the outer provider explicitly -->",
          '<Sample model="outer" prompt="routed-to-outer" />',
          "",
          "</InnerProv>",
          "",
          "</OuterProv>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

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
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "doc.md": '<Sample prompt="no provider" />',
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      // Should contain error about missing Sample Api provider
      expect(output).toContain("ERROR");
      expect(output).toContain("Sample Api requires provider middleware");
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC5: Replay returns stored response — no re-execution
  it("SC5: replay returns stored response", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
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
      const output1 = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output1).toContain("[sampled-by-test-model:replay-test]");

      // Second run (replay) — same stream
      const output2 = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

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
        path.join(process.cwd(), "core/components/Sample.md"),
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
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output).toContain("[sampled-by-test-model:self-closing-prompt]");
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC7: Nested <Sample> inside <Sample> — children contain components.
  // renderChildren() expands caller-provided children in the parent
  // scope context. Inner <Sample> components create their own child
  // scopes off the parent chain, and ancestor middleware (installed by
  // the provider) is visible through Effection's scope prototype chain.
  it("SC7: nested Sample inside Sample — no deadlock", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProvider("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Sample model="test-model">',
          '<Sample prompt="inner-prompt" model="test-model" />',
          "extra text to combine",
          "</Sample>",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      // The inner Sample should resolve first (via renderChildren),
      // producing [sampled-by-test-model:inner-prompt].
      // Then the outer Sample sends that rendered output + extra text
      // to the provider for sampling.
      expect(output).toContain("[sampled-by-test-model:");
      expect(output).not.toContain("ERROR");
      expect(output).not.toContain("Cycle detected");
    } finally {
      cleanup(tmpDir);
    }
  });

  // SC8: Nested Sample with multiple providers — model routing works
  // Tests that nested Samples inside renderChildren() correctly route
  // to different providers via the middleware chain.
  it("SC8: nested Sample with multi-provider routing", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/OuterProv.md": stubProvider("OuterProv"),
        "components/InnerProv.md": stubProvider("InnerProv"),
        "doc.md": [
          '<OuterProv model="outer">',
          '<InnerProv model="inner">',
          "",
          '<Sample model="inner">',
          '<Sample prompt="routed-to-outer" model="outer" />',
          '<Sample prompt="routed-to-inner" model="inner" />',
          "combine these results",
          "</Sample>",
          "",
          "</InnerProv>",
          "</OuterProv>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      // Inner Samples should route to their respective providers
      // The rendered children output contains both provider responses
      expect(output).toContain("[sampled-by-outer:routed-to-outer]");
      expect(output).toContain("[sampled-by-inner:routed-to-inner]");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("Tier EO — eval output() function", () => {
  // EO1: output() sets eval block output
  it("EO1: output() produces eval block output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": '```js eval\noutput("hello from eval");\n```\n',
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("hello from eval");
  });

  // EO2: output() replayed from journal
  it("EO2: output() replayed from journal", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": '```js eval\noutput("journaled-output");\n```\n',
    });
    yield* useEchoExec();

    // First run
    const output1 = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output1).toContain("journaled-output");

    // Replay
    const output2 = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output2).toContain("journaled-output");
    expect(output1).toEqual(output2);
  });

  // EO3: eval block without output() still returns empty
  it("EO3: eval block without output() produces no output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\nconst x = 42;\n```\nafter-eval",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    // No output from eval block — should see "after-eval" but no "42"
    expect(output).toContain("after-eval");
    expect(output).not.toContain("42");
  });

  // EO4: output() with multiline content
  it("EO4: output() with multiline content", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": '```js eval\noutput("line1\\nline2\\nline3");\n```\n',
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("line1\nline2\nline3");
  });

  // EO5: output() converts non-string to string
  it("EO5: output() converts non-string to string", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\noutput(12345);\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("12345");
  });
});

describe("Tier RC — renderChildren and render closures", () => {
  // RC1: renderChildren() returns empty string for self-closing component
  it("RC1: renderChildren returns empty for self-closing component", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
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
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("children:[]");
  });

  // RC2: renderChildren() captures children text content
  it("RC2: renderChildren captures children text", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
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
      "test.md": ["<TestComp>", "", "hello from children", "", "</TestComp>"].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("children:[hello from children]");
  });

  // RC3: render() expands arbitrary markdown string
  it("RC3: render() expands arbitrary markdown string", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
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
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("rendered:[arbitrary **markdown** content]");
  });
});

describe("Tier IN — Instruction component", () => {
  // IN1: Instruction enriches Sample context with instructions
  it("IN1: Instruction enriches Sample context", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );
      const instructionMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Instruction.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/Instruction.md": instructionMd,
        "components/TestProvider.md": stubProviderWithInstructions("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Instruction system="You are a pirate. Respond in pirate speak.">',
          '<Sample prompt="hello" model="test-model" />',
          "</Instruction>",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output).toContain("system:You are a pirate. Respond in pirate speak.");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // IN2: No Instruction — backward compatible, instructions is none
  it("IN2: no Instruction — instructions is none", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProviderWithInstructions("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Sample prompt="hello" model="test-model" />',
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output).toContain("system:none");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // IN3: Instruction passes non-Sample children through via Content
  it("IN3: Instruction passes text children through", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );
      const instructionMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Instruction.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/Instruction.md": instructionMd,
        "components/TestProvider.md": stubProviderWithInstructions("TestProvider"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          '<Instruction system="Be a pirate.">',
          "",
          "Some visible text before the sample.",
          "",
          '<Sample prompt="hello" model="test-model" />',
          "</Instruction>",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output).toContain("Some visible text before the sample.");
      expect(output).toContain("system:Be a pirate.");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // IN4: Instruction with no Sample children — no error
  it("IN4: Instruction with no Sample — no error", function* () {
    const tmpDir = makeTempDir();

    try {
      const instructionMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Instruction.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Instruction.md": instructionMd,
        "doc.md": [
          '<Instruction system="Be concise.">',
          "",
          "Just some text, no Sample here.",
          "</Instruction>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output).toContain("Just some text");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("Tier AG — Agent component pattern", () => {
  // AG1: Agent component installs instruction middleware + Content
  it("AG1: agent component with instruction middleware", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProviderWithInstructions("TestProvider"),
        "components/CodeReviewer.md": [
          "---",
          "meta:",
          "  componentName: CodeReviewer",
          "---",
          "",
          "```js persist eval",
          "yield* Sample.around({",
          "  *sample([context], next) {",
          "    const existing = context.system || '';",
          "    const instruction = 'You are a code reviewer. Be concise.';",
          "    return yield* next({",
          "      ...context,",
          "      system: existing ? existing + '\\n' + instruction : instruction,",
          "    });",
          "  },",
          "}, { at: 'min' });",
          "```",
          "",
          "<Content />",
        ].join("\n"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          "<CodeReviewer>",
          '<Sample prompt="def add(a, b): return a - b" model="test-model" />',
          "</CodeReviewer>",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output).toContain("system:You are a code reviewer. Be concise.");
      expect(output).toContain("def add(a, b): return a - b");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // AG2: Nested agents compose instructions
  it("AG2: nested agents compose instructions", function* () {
    const tmpDir = makeTempDir();

    try {
      const sampleMd = fs.readFileSync(
        path.join(process.cwd(), "core/components/Sample.md"),
        "utf-8",
      );

      writeFiles(tmpDir, {
        "components/Sample.md": sampleMd,
        "components/TestProvider.md": stubProviderWithInstructions("TestProvider"),
        "components/CodeReviewer.md": [
          "---",
          "meta:",
          "  componentName: CodeReviewer",
          "---",
          "",
          "```js persist eval",
          "yield* Sample.around({",
          "  *sample([context], next) {",
          "    const existing = context.system || '';",
          "    const instruction = 'You are a code reviewer.';",
          "    return yield* next({",
          "      ...context,",
          "      system: existing ? existing + '\\n' + instruction : instruction,",
          "    });",
          "  },",
          "}, { at: 'min' });",
          "```",
          "",
          "<Content />",
        ].join("\n"),
        "components/SecurityAuditor.md": [
          "---",
          "meta:",
          "  componentName: SecurityAuditor",
          "---",
          "",
          "```js persist eval",
          "yield* Sample.around({",
          "  *sample([context], next) {",
          "    const existing = context.system || '';",
          "    const instruction = 'Focus on security vulnerabilities.';",
          "    return yield* next({",
          "      ...context,",
          "      system: existing ? existing + '\\n' + instruction : instruction,",
          "    });",
          "  },",
          "}, { at: 'min' });",
          "```",
          "",
          "<Content />",
        ].join("\n"),
        "doc.md": [
          '<TestProvider model="test-model">',
          "",
          "<CodeReviewer>",
          "<SecurityAuditor>",
          '<Sample prompt="check this" model="test-model" />',
          "</SecurityAuditor>",
          "</CodeReviewer>",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(
        yield* execute({
          docPath: path.join(tmpDir, "doc.md"),
          stream,
          componentDirs: [path.join(tmpDir, "components"), tmpDir],
        }),
      );

      expect(output).toContain("You are a code reviewer.");
      expect(output).toContain("Focus on security vulnerabilities.");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });
});
