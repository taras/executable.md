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
import type { DurableEvent } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import type { StatResult } from "@executablemd/runtime";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import type { ComponentElement, Segment } from "../src/types.ts";
import { asText } from "./helpers.ts";

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

function isEvalYield(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === "eval";
}

function isExecYield(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === "exec";
}

describe("Tier IF — structural conditional directive", () => {
  it("IF1: a true condition renders its children", function* () {
    const run = yield* runIf("<If condition={true}>rendered</If>");
    expect(run.output).toBe("rendered");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("IF2: a false condition without <Else> renders nothing", function* () {
    const run = yield* runIf("<If condition={false}>hidden</If>");
    expect(run.output).toBe("");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("IF3: a false condition renders the <Else> branch", function* () {
    const run = yield* runIf("<If condition={false}>then<Else>otherwise</Else></If>");
    expect(run.output).toBe("otherwise");
  });

  it("IF4: a true condition renders only the children before <Else>", function* () {
    const run = yield* runIf("<If condition={true}>then<Else>otherwise</Else></If>");
    expect(run.output).toBe("then");
  });

  it("IF5: the condition resolves from an eval binding expression", function* () {
    const passing = yield* runIf("<If condition={ok}>yes<Else>no</Else></If>", {
      env: { ok: true },
    });
    expect(passing.output).toBe("yes");

    const failing = yield* runIf("<If condition={ok}>yes<Else>no</Else></If>", {
      env: { ok: false },
    });
    expect(failing.output).toBe("no");
  });

  it("IF6: expressions may compute the boolean from bindings", function* () {
    const run = yield* runIf("<If condition={findings.length === 0}>clean<Else>dirty</Else></If>", {
      env: { findings: [] },
    });
    expect(run.output).toBe("clean");

    const negated = yield* runIf("<If condition={!passed}>failed<Else>passed</Else></If>", {
      env: { passed: true },
    });
    expect(negated.output).toBe("passed");
  });

  it("IF7: content around the directive keeps its order", function* () {
    const run = yield* runIf("before|<If condition={true}>mid<Else>alt</Else></If>|after");
    expect(run.output).toBe("before|mid|after");
  });

  it("IF8: a capture from the selected branch stays available afterward", function* () {
    const run = yield* runIf(
      '<If condition={true}><Capture as="picked">chosen</Capture></If>[{picked}]',
    );
    expect(run.output).toBe("[chosen]");
    expect(run.env?.picked).toBe("chosen");
  });

  it("IF9: the unselected branch creates no binding", function* () {
    const run = yield* runIf(
      '<If condition={false}><Capture as="skipped">never</Capture><Else>alt</Else></If>[{skipped}]',
    );
    expect(run.output).toBe("alt[{skipped}]");
    expect(run.env?.skipped).toBeUndefined();
  });

  it("IF10: nested conditionals select independently", function* () {
    const run = yield* runIf(
      "<If condition={true}>outer:<If condition={false}>inner<Else>alt</Else></If>:end<Else>skipped</Else></If>",
    );
    expect(run.output).toBe("outer:alt:end");
  });

  it("IF11: a nested <If> in the unselected branch never runs", function* () {
    const run = yield* runIf(
      "<If condition={false}><If condition={true}>inner</If><Else>alt</Else></If>",
    );
    expect(run.output).toBe("alt");
  });

  it("IF12: a self-closing <If> renders nothing", function* () {
    const run = yield* runIf("<If condition={true} />after");
    expect(run.output).toBe("after");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });
});

describe("Tier IF — condition validation", () => {
  it("IF13: a missing condition is rejected", function* () {
    const run = yield* runIf("<If>body</If>");
    expect(errorMessages(run.segments)[0]).toContain('requires a "condition" prop');
    expect(run.output).not.toContain("body");
  });

  it("IF14: a non-boolean condition is rejected without coercion", function* () {
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

  it("IF15: a non-boolean expression result is rejected", function* () {
    const run = yield* runIf("<If condition={count}>x</If>", { env: { count: 3 } });
    expect(errorMessages(run.segments)[0]).toContain("must be a boolean, not a number");
  });

  it("IF16: an unresolvable condition expression is rejected", function* () {
    const run = yield* runIf("<If condition={missing}>x</If>");
    expect(errorMessages(run.segments)[0]).toContain("condition={missing}");
  });

  it("IF17: unknown props are rejected", function* () {
    const literal = yield* runIf('<If condition={true} when="x">body</If>');
    expect(errorMessages(literal.segments)[0]).toContain('only accepts a "condition" prop');

    const expression = yield* runIf("<If condition={true} fallback={alt}>body</If>", {
      env: { alt: "x" },
    });
    expect(errorMessages(expression.segments)[0]).toContain('only accepts a "condition" prop');
  });
});

describe("Tier IF — <Else> structure", () => {
  it("IF18: <Else> outside <If> is rejected", function* () {
    const run = yield* runIf("<Else>orphan</Else>");
    expect(errorMessages(run.segments)[0]).toContain("must be a direct child of <If>");
    expect(run.imports).toHaveLength(0);
  });

  it("IF19: a second <Else> is rejected", function* () {
    const run = yield* runIf("<If condition={true}>a<Else>b</Else><Else>c</Else></If>");
    expect(errorMessages(run.segments)[0]).toContain("at most one <Else>");
  });

  it("IF20: an <Else> below the direct children is rejected", function* () {
    const run = yield* runIf("<If condition={true}><Wrapper><Else>nested</Else></Wrapper></If>");
    expect(errorMessages(run.segments)[0]).toContain("must be a direct child of <If>");
    expect(run.imports).toHaveLength(0);
  });

  it("IF21: an <Else> inside <Else> is rejected", function* () {
    const run = yield* runIf("<If condition={true}>a<Else>b<Else>c</Else></Else></If>");
    expect(errorMessages(run.segments)[0]).toContain("must be a direct child of <If>");
  });

  it("IF22: a self-closing <Else> is rejected", function* () {
    const run = yield* runIf("<If condition={false}>a<Else /></If>");
    expect(errorMessages(run.segments)[0]).toContain("must have content");
  });

  it("IF23: a prop-bearing <Else> is rejected", function* () {
    const literal = yield* runIf('<If condition={false}>a<Else when="x">b</Else></If>');
    expect(errorMessages(literal.segments)[0]).toContain("accepts no props");

    const expression = yield* runIf("<If condition={false}>a<Else on={flag}>b</Else></If>", {
      env: { flag: true },
    });
    expect(errorMessages(expression.segments)[0]).toContain("accepts no props");
  });

  it("IF24: a malformed <Else> in the unselected branch is still diagnosed", function* () {
    const run = yield* runIf('<If condition={true}>SELECTED<Else when="x">OTHER</Else></If>');
    expect(errorMessages(run.segments)[0]).toContain("accepts no props");
    expect(run.output).not.toContain("SELECTED");
  });

  it("IF25: a nested <If> owns the <Else> beneath it", function* () {
    const run = yield* runIf(
      "<If condition={true}><If condition={false}>x<Else>y</Else></If><Else>z</Else></If>",
    );
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.output).toBe("y");
  });

  it("IF26: whitespace after </Else> is formatting, not a third branch", function* () {
    const run = yield* runIf(
      ["<If condition={true}>", "SELECTED", "<Else>", "alternative", "</Else>", "</If>"].join("\n"),
    );
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.output.trim()).toBe("SELECTED");
  });

  it("IF27: substantive text after </Else> is rejected", function* () {
    const run = yield* runIf(
      [
        "<If condition={true}>",
        "before",
        "<Else>",
        "alternative",
        "</Else>",
        "after",
        "</If>",
      ].join("\n"),
    );
    const message = errorMessages(run.segments)[0] ?? "";
    expect(message).toContain("must be the final substantive child of <If>");
    expect(message).toContain('text "after"');
    expect(run.output).not.toContain("before");
  });

  it("IF28: a component after </Else> is rejected and never imported", function* () {
    const run = yield* runIf(
      "<If condition={true}>before<Else>alternative</Else><Trailing /></If>",
    );
    expect(errorMessages(run.segments)[0]).toContain("Found <Trailing> after </Else>");
    expect(run.imports).toHaveLength(0);
    expect(run.output).not.toContain("before");
  });

  it("IF29: an executable block after </Else> is rejected and never runs", function* () {
    const run = yield* runIf(
      [
        "<If condition={true}>",
        "before",
        "<Else>alternative</Else>",
        "",
        "```bash exec",
        "echo trailing",
        "```",
        "",
        "</If>",
      ].join("\n"),
    );
    expect(errorMessages(run.segments)[0]).toContain("code block after </Else>");
    expect(run.blocks).toHaveLength(0);
  });

  it("IF30: trailing content is rejected even when <Else> is the selected branch", function* () {
    const run = yield* runIf(
      ["<If condition={false}>", "before", "<Else>", "SELECTED", "</Else>", "after", "</If>"].join(
        "\n",
      ),
    );
    expect(errorMessages(run.segments)[0]).toContain("must be the final substantive child of <If>");
    expect(run.output).not.toContain("SELECTED");
  });
});

describe("Tier IF — the unselected branch performs no work", () => {
  it("IF31: it imports no component", function* () {
    const run = yield* runIf("<If condition={false}><Missing /><Else>alt</Else></If>");
    expect(run.output).toBe("alt");
    expect(run.imports).toHaveLength(0);
  });

  it("IF32: it runs no code block", function* () {
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

  it("IF33: the selected branch does run its code block", function* () {
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

  it("IF34: a component in the unselected <Else> is never imported", function* () {
    const run = yield* runIf("<If condition={true}>then<Else><Missing /></Else></If>");
    expect(run.output).toBe("then");
    expect(run.imports).toHaveLength(0);
  });
});

describe("Tier IF — diagnostics carry source positions", () => {
  it("IF35: a local position anchors the diagnostic", function* () {
    const run = yield* runIf("line one\n<If>body</If>\n");
    expect(errorMessages(run.segments)[0]).toContain("(2:1)");
  });

  it("IF36: an origin adds the file path", function* () {
    const run = yield* runIf("\n<If condition={1}>body</If>", {
      origin: { path: "Doc.md", baseOffset: 40, baseLine: 5 },
    });
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:6:1)");
  });

  it("IF37: a stray <Else> reports its own position", function* () {
    const run = yield* runIf("intro\n<Else>orphan</Else>", {
      origin: { path: "Doc.md", baseOffset: 0, baseLine: 1 },
    });
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:2:1)");
  });

  it("IF38: an element with no position diagnoses without one", function* () {
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

describe("Tier IF — document execution", () => {
  beforeAll(() => useTempFileCompiler());

  it("IF39: only the selected branch reaches the journal", function* () {
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

  it("IF40: an effect in the unselected branch never happens", function* () {
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

  it("IF41: a component in the unselected branch is never imported", function* () {
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

  it("IF42: <If> selects the same branch from a restored binding on partial replay", function* () {
    const REPLAY_DOC = [
      "```js eval",
      "const findings = ['stale doc'];",
      "```",
      "<If condition={findings.length === 0}>",
      "```js eval",
      "output('CLEAN_RAN');",
      "```",
      "<Else>",
      "```js eval",
      "output('NEEDS_WORK_RAN');",
      "```",
      "</Else>",
      "</If>",
    ].join("\n");

    const stream = new InMemoryStream();
    yield* useStubFs({ "test.md": REPLAY_DOC });
    yield* useEchoExec();

    const golden = yield* collect(yield* execute({ path: "test.md", stream }));
    expect(golden).toContain("NEEDS_WORK_RAN");
    expect(golden).not.toContain("CLEAN_RAN");

    // Cut the journal to the root import plus the eval that binds `findings`.
    // Replaying a stream that still carries the root Close would return the
    // stored result without running the document at all, which would prove
    // nothing about branch selection.
    const events = stream.snapshot();
    const bindingEval = events.findIndex(isEvalYield);
    expect(bindingEval).toBeGreaterThanOrEqual(0);
    const partial = new InMemoryStream(events.slice(0, bindingEval + 1));
    expect(partial.snapshot().some((event) => event.type === "close")).toBe(false);

    const replayed = yield* collect(yield* execute({ path: "test.md", stream: partial }));

    // The branch was reached live: it appended its own eval entry rather than
    // replaying one, and the restored boolean still selected <Else>.
    expect(replayed).toBe(golden);
    expect(partial.appendCount).toBeGreaterThan(0);

    const evaluated = JSON.stringify(partial.snapshot().filter(isEvalYield));
    expect(evaluated).toContain("NEEDS_WORK_RAN");
    expect(evaluated).not.toContain("CLEAN_RAN");
  });

  it("IF43: an <If> projected through <Content /> resolves the caller's binding", function* () {
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

/**
 * Direct probes at each mechanism an unselected branch could reach. Rendered
 * output alone cannot distinguish "never ran" from "ran and rendered nothing",
 * so every probe counts calls at the API itself and pairs the unselected case
 * with a selected control that proves the counter would have moved.
 */
describe("Tier IF — the unselected branch reaches no external mechanism", () => {
  beforeAll(() => useTempFileCompiler());

  const PROBE_DOC = (condition: boolean) =>
    [
      `<If condition={${condition}}>`,
      "<Probe />",
      "",
      "```bash exec",
      "echo THEN_RAN",
      "```",
      "",
      "```js eval",
      'const thenBinding = "then";',
      "```",
      "<Else>",
      "alternative",
      "</Else>",
      "</If>",
      "[{thenBinding}]",
    ].join("\n");

  interface ProbeRun {
    output: string;
    /** Element names offered to the `Component.expand` extension hook. */
    expanded: string[];
    /** Every path the document caused the Fs Api to stat or read. */
    reads: string[];
    /** Every command handed to the process runtime. */
    commands: string[];
    events: DurableEvent[];
  }

  /**
   * Each run gets its own scope: `useStubFs` installs a terminal Fs handler, so
   * two runs in one scope would leave the first document answering for both.
   * The stub records rather than wrapping for the same reason — a recorder
   * layered around a terminal handler never sees the call.
   */
  function runProbe(condition: boolean): Operation<ProbeRun> {
    return scoped(function* () {
      const expanded: string[] = [];
      const reads: string[] = [];
      const commands: string[] = [];
      const stream = new InMemoryStream();
      const files: Record<string, string> = {
        "components/Probe.md": "PROBE_BODY",
        "test.md": PROBE_DOC(condition),
      };

      yield* API.Fs.around({
        // deno-lint-ignore require-yield
        *readTextFile([path], _next) {
          reads.push(path);
          const content = files[path];
          if (content === undefined) {
            throw new Error(`ENOENT: no such file: ${path}`);
          }
          return content;
        },
        // deno-lint-ignore require-yield
        *stat([path], _next): Operation<StatResult> {
          reads.push(`stat:${path}`);
          const exists = path in files;
          return { exists, isFile: exists, isDirectory: false };
        },
        // deno-lint-ignore require-yield
        *glob(_args, _next) {
          throw new Error("glob not stubbed");
        },
      });
      yield* API.Process.around({
        // deno-lint-ignore require-yield
        *exec([options], _next) {
          commands.push(options.command.join(" "));
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      yield* Component.around({
        *expand([element], next) {
          expanded.push(element.name);
          return yield* next(element);
        },
      });

      const output = asText(yield* collect(yield* execute({ path: "test.md", stream })));
      return { output, expanded, reads, commands, events: stream.snapshot() };
    });
  }

  it("IF44: no component element in the unselected branch is offered to expand", function* () {
    const skipped = yield* runProbe(false);
    expect(skipped.expanded).not.toContain("Probe");

    const selected = yield* runProbe(true);
    expect(selected.expanded).toContain("Probe");
  });

  it("IF45: no component file is looked up or read for the unselected branch", function* () {
    const skipped = yield* runProbe(false);
    expect(skipped.reads).toEqual(["test.md"]);

    const selected = yield* runProbe(true);
    expect(selected.reads).toContain("stat:components/Probe.md");
    expect(selected.reads).toContain("components/Probe.md");
  });

  it("IF46: the process runtime is never invoked for an unselected exec block", function* () {
    const skipped = yield* runProbe(false);
    expect(skipped.commands).toHaveLength(0);

    const selected = yield* runProbe(true);
    expect(selected.commands.some((command) => command.includes("THEN_RAN"))).toBe(true);
  });

  it("IF47: an unselected branch writes no exec or eval durable event", function* () {
    const skipped = yield* runProbe(false);
    expect(skipped.events.filter(isExecYield)).toHaveLength(0);
    expect(skipped.events.filter(isEvalYield)).toHaveLength(0);

    const selected = yield* runProbe(true);
    expect(selected.events.filter(isExecYield).length).toBeGreaterThan(0);
    expect(selected.events.filter(isEvalYield).length).toBeGreaterThan(0);
  });

  it("IF48: an unselected branch creates no binding for later content", function* () {
    const skipped = yield* runProbe(false);
    expect(skipped.output).toContain("[{thenBinding}]");

    const selected = yield* runProbe(true);
    expect(selected.output).toContain("[then]");
  });
});
