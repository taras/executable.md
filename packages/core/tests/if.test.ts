import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import type { SourceOrigin } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import type { ComponentElement, Segment } from "../src/types.ts";

interface IfRun {
  segments: Segment[];
  output: string;
  env: Record<string, unknown> | undefined;
  /** Components the run tried to import, in order. */
  imports: string[];
  /** Source of every code block the run executed, in order. */
  blocks: string[];
}

function runIf(
  source: string,
  opts: { env?: Record<string, unknown>; origin?: SourceOrigin } = {},
): Operation<IfRun> {
  return scoped(function* () {
    const imports: string[] = [];
    const blocks: string[] = [];
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          imports.push(name);
          throw new Error(`Component not found: ${name}`);
        },
        // deno-lint-ignore require-yield
        *applyModifiers([_modifiers, context], _next) {
          blocks.push(context.content);
          return { output: `ran:${context.content.trim()}`, exitCode: 0, stderr: "" };
        },
      },
      { at: "min" },
    );
    const testEnv = { values: { ...(opts.env ?? {}) } };
    yield* Component.around({ env: () => testEnv }, { at: "min" });
    const segments = yield* expandSegments(scanSegments(source, opts.origin), {}, {}, new Set());
    return {
      segments,
      output: renderSegments(segments),
      env: testEnv.values,
      imports,
      blocks,
    };
  });
}

function errorMessages(segments: Segment[]): string[] {
  return segments.filter((s) => s.type === "error").map((s) => s.message);
}

describe("Tier If — structural conditional directive", () => {
  it("I1: a true condition renders its children", function* () {
    const run = yield* runIf("<If condition={true}>rendered</If>");
    expect(run.output).toBe("rendered");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("I2: a false condition without <Else> renders nothing", function* () {
    const run = yield* runIf("<If condition={false}>hidden</If>");
    expect(run.output).toBe("");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("I3: a false condition renders the <Else> branch", function* () {
    const run = yield* runIf("<If condition={false}>then<Else>otherwise</Else></If>");
    expect(run.output).toBe("otherwise");
  });

  it("I4: a true condition renders only the children before <Else>", function* () {
    const run = yield* runIf("<If condition={true}>then<Else>otherwise</Else></If>");
    expect(run.output).toBe("then");
  });

  it("I5: the condition resolves from an eval binding expression", function* () {
    const passing = yield* runIf("<If condition={ok}>yes<Else>no</Else></If>", {
      env: { ok: true },
    });
    expect(passing.output).toBe("yes");

    const failing = yield* runIf("<If condition={ok}>yes<Else>no</Else></If>", {
      env: { ok: false },
    });
    expect(failing.output).toBe("no");
  });

  it("I6: expressions may compute the boolean from bindings", function* () {
    const run = yield* runIf("<If condition={findings.length === 0}>clean<Else>dirty</Else></If>", {
      env: { findings: [] },
    });
    expect(run.output).toBe("clean");

    const negated = yield* runIf("<If condition={!passed}>failed<Else>passed</Else></If>", {
      env: { passed: true },
    });
    expect(negated.output).toBe("passed");
  });

  it("I7: content around the directive keeps its order", function* () {
    const run = yield* runIf("before|<If condition={true}>mid<Else>alt</Else></If>|after");
    expect(run.output).toBe("before|mid|after");
  });

  it("I8: a capture from the selected branch stays available afterward", function* () {
    const run = yield* runIf(
      '<If condition={true}><Capture as="picked">chosen</Capture></If>[{picked}]',
    );
    expect(run.output).toBe("[chosen]");
    expect(run.env?.picked).toBe("chosen");
  });

  it("I9: the unselected branch creates no binding", function* () {
    const run = yield* runIf(
      '<If condition={false}><Capture as="skipped">never</Capture><Else>alt</Else></If>[{skipped}]',
    );
    expect(run.output).toBe("alt[{skipped}]");
    expect(run.env?.skipped).toBeUndefined();
  });

  it("I10: nested conditionals select independently", function* () {
    const run = yield* runIf(
      "<If condition={true}>outer:<If condition={false}>inner<Else>alt</Else></If>:end<Else>skipped</Else></If>",
    );
    expect(run.output).toBe("outer:alt:end");
  });

  it("I11: a nested <If> in the unselected branch never runs", function* () {
    const run = yield* runIf(
      "<If condition={false}><If condition={true}>inner</If><Else>alt</Else></If>",
    );
    expect(run.output).toBe("alt");
  });

  it("I12: a self-closing <If> renders nothing", function* () {
    const run = yield* runIf("<If condition={true} />after");
    expect(run.output).toBe("after");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });
});

describe("Tier If — condition validation", () => {
  it("I13: a missing condition is rejected", function* () {
    const run = yield* runIf("<If>body</If>");
    expect(errorMessages(run.segments)[0]).toContain('requires a "condition" prop');
    expect(run.output).not.toContain("body");
  });

  it("I14: a non-boolean condition is rejected without coercion", function* () {
    const cases: Array<[string, string]> = [
      ['<If condition="yes">x</If>', "a string"],
      ["<If condition={1}>x</If>", "a number"],
      ["<If condition={0}>x</If>", "a number"],
      ["<If condition={null}>x</If>", "null"],
      ["<If condition={[1]}>x</If>", "an array"],
      ["<If condition={{a: 1}}>x</If>", "an object"],
    ];
    for (const [source, kind] of cases) {
      const run = yield* runIf(source);
      const message = errorMessages(run.segments)[0] ?? "";
      expect(message).toContain("must be a boolean");
      expect(message).toContain(kind);
      expect(run.output).not.toContain("x");
    }
  });

  it("I15: a non-boolean expression result is rejected", function* () {
    const run = yield* runIf("<If condition={count}>x</If>", { env: { count: 3 } });
    expect(errorMessages(run.segments)[0]).toContain("must be a boolean, not a number");
  });

  it("I16: an unresolvable condition expression is rejected", function* () {
    const run = yield* runIf("<If condition={missing}>x</If>");
    expect(errorMessages(run.segments)[0]).toContain("condition={missing}");
  });

  it("I17: unknown props are rejected", function* () {
    const literal = yield* runIf('<If condition={true} when="x">body</If>');
    expect(errorMessages(literal.segments)[0]).toContain('only accepts a "condition" prop');

    const expression = yield* runIf("<If condition={true} fallback={alt}>body</If>", {
      env: { alt: "x" },
    });
    expect(errorMessages(expression.segments)[0]).toContain('only accepts a "condition" prop');
  });
});

describe("Tier If — <Else> structure", () => {
  it("I18: <Else> outside <If> is rejected", function* () {
    const run = yield* runIf("<Else>orphan</Else>");
    expect(errorMessages(run.segments)[0]).toContain("must be a direct child of <If>");
    expect(run.imports).toHaveLength(0);
  });

  it("I19: a second <Else> is rejected", function* () {
    const run = yield* runIf("<If condition={true}>a<Else>b</Else><Else>c</Else></If>");
    expect(errorMessages(run.segments)[0]).toContain("at most one <Else>");
  });

  it("I20: an <Else> below the direct children is rejected", function* () {
    const run = yield* runIf("<If condition={true}><Wrapper><Else>nested</Else></Wrapper></If>");
    expect(errorMessages(run.segments)[0]).toContain("must be a direct child of <If>");
    expect(run.imports).toHaveLength(0);
  });

  it("I21: an <Else> inside <Else> is rejected", function* () {
    const run = yield* runIf("<If condition={true}>a<Else>b<Else>c</Else></Else></If>");
    expect(errorMessages(run.segments)[0]).toContain("must be a direct child of <If>");
  });

  it("I22: a self-closing <Else> is rejected", function* () {
    const run = yield* runIf("<If condition={false}>a<Else /></If>");
    expect(errorMessages(run.segments)[0]).toContain("must have content");
  });

  it("I23: a prop-bearing <Else> is rejected", function* () {
    const literal = yield* runIf('<If condition={false}>a<Else when="x">b</Else></If>');
    expect(errorMessages(literal.segments)[0]).toContain("accepts no props");

    const expression = yield* runIf("<If condition={false}>a<Else on={flag}>b</Else></If>", {
      env: { flag: true },
    });
    expect(errorMessages(expression.segments)[0]).toContain("accepts no props");
  });

  it("I24: a malformed <Else> in the unselected branch is still diagnosed", function* () {
    const run = yield* runIf('<If condition={true}>SELECTED<Else when="x">OTHER</Else></If>');
    expect(errorMessages(run.segments)[0]).toContain("accepts no props");
    expect(run.output).not.toContain("SELECTED");
  });

  it("I25: a nested <If> owns the <Else> beneath it", function* () {
    const run = yield* runIf(
      "<If condition={true}><If condition={false}>x<Else>y</Else></If><Else>z</Else></If>",
    );
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.output).toBe("y");
  });
});

describe("Tier If — the unselected branch performs no work", () => {
  it("I26: it imports no component", function* () {
    const run = yield* runIf("<If condition={false}><Missing /><Else>alt</Else></If>");
    expect(run.output).toBe("alt");
    expect(run.imports).toHaveLength(0);
  });

  it("I27: it runs no code block", function* () {
    const source = [
      "<If condition={false}>",
      "",
      "```bash exec",
      "echo skipped",
      "```",
      "",
      "<Else>alt</Else>",
      "</If>",
    ].join("\n");
    const run = yield* runIf(source);
    expect(run.output).toContain("alt");
    expect(run.blocks).toHaveLength(0);
  });

  it("I28: the selected branch does run its code block", function* () {
    const source = [
      "<If condition={true}>",
      "",
      "```bash exec",
      "echo selected",
      "```",
      "",
      "<Else>alt</Else>",
      "</If>",
    ].join("\n");
    const run = yield* runIf(source);
    expect(run.blocks).toEqual(["echo selected\n"]);
    expect(run.output).toContain("ran:echo selected");
  });

  it("I29: a component in the unselected <Else> is never imported", function* () {
    const run = yield* runIf("<If condition={true}>then<Else><Missing /></Else></If>");
    expect(run.output).toBe("then");
    expect(run.imports).toHaveLength(0);
  });
});

describe("Tier If — diagnostics carry source positions", () => {
  it("I30: a local position anchors the diagnostic", function* () {
    const run = yield* runIf("line one\n<If>body</If>\n");
    expect(errorMessages(run.segments)[0]).toContain("(2:1)");
  });

  it("I31: an origin adds the file path", function* () {
    const run = yield* runIf("\n<If condition={1}>body</If>", {
      origin: { path: "Doc.md", baseOffset: 40, baseLine: 5 },
    });
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:6:1)");
  });

  it("I32: a stray <Else> reports its own position", function* () {
    const run = yield* runIf("intro\n<Else>orphan</Else>", {
      origin: { path: "Doc.md", baseOffset: 0, baseLine: 1 },
    });
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:2:1)");
  });

  it("I33: an element with no position diagnoses without one", function* () {
    const element: ComponentElement = {
      type: "component",
      name: "If",
      props: {},
      expressions: {},
      children: [{ type: "text", content: "body" }],
      selfClosing: false,
    };
    const segments = yield* scoped(function* () {
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments([element], {}, {}, new Set());
    });
    const message = errorMessages(segments)[0] ?? "";
    expect(message).toBe('<If> requires a "condition" prop (a boolean).');
  });
});

describe("Tier If — document execution", () => {
  beforeAll(() => useTempFileCompiler());

  it("I34: only the selected branch reaches the journal", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const ok = false;",
        "```",
        "<If condition={ok}>",
        "```js eval",
        "output('UNSELECTED_RAN');",
        "```",
        "<Else>",
        "```js eval",
        "output('SELECTED_RAN');",
        "```",
        "</Else>",
        "</If>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("SELECTED_RAN");
    expect(output).not.toContain("UNSELECTED_RAN");
    expect(output).not.toContain("ERROR");

    // The root import entry carries the whole document source, both branches
    // included, so only the eval entries show what actually ran.
    const evaluated = JSON.stringify(
      stream.snapshot().filter((event) => JSON.stringify(event).includes('"type":"eval"')),
    );
    expect(evaluated).toContain("SELECTED_RAN");
    expect(evaluated).not.toContain("UNSELECTED_RAN");
  });

  it("I35: an effect in the unselected branch never happens", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "<If condition={false}>",
        "```js eval",
        "throw new Error('UNSELECTED_EFFECT');",
        "```",
        "<Else>selected</Else>",
        "</If>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("selected");
    expect(output).not.toContain("UNSELECTED_EFFECT");
    expect(output).not.toContain("ERROR");
  });

  it("I36: a component in the unselected branch is never imported", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Boom.md": "```js eval\noutput('BOOM_RAN');\n```\n",
      "test.md": "<If condition={false}><Boom /><Else>alt</Else></If>",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("alt");
    expect(output).not.toContain("BOOM_RAN");
    expect(output).not.toContain("ERROR");
  });

  it("I37: the selected branch replays deterministically", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const findings = ['stale doc'];",
        "```",
        "<If condition={findings.length === 0}>",
        "clean",
        "<Else>",
        "needs work: {findings.length}",
        "</Else>",
        "</If>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const golden = yield* collect(yield* execute({ path: "test.md", stream }));
    const replayed = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(golden).toContain("needs work: 1");
    expect(golden).not.toContain("clean");
    expect(replayed).toBe(golden);
  });

  it("I38: an <If> projected through <Content /> resolves the caller's binding", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": "<Content />",
      "test.md": [
        "```js eval",
        "const ready = false;",
        "```",
        "<Wrap>",
        "<If condition={ready}>READY<Else>WAITING</Else></If>",
        "</Wrap>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("WAITING");
    expect(output).not.toContain("READY");
    expect(output).not.toContain("ERROR");
  });
});
