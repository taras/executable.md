import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import type { StatResult } from "@executablemd/runtime";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { readTextFile } from "@effectionx/fs";

import { collect } from "../src/collect.ts";
import { Component } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { DocumentationError, ErrorMode } from "../src/errors.ts";
import { execute } from "../src/execute.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { Sample } from "../src/sample-api.ts";
import { scanSegments } from "../src/scanner.ts";
import type { SourceOrigin } from "../src/scanner.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import type { ComponentElement, FunctionComponentDefinition, Segment } from "../src/types.ts";
import { asText } from "./helpers.ts";

interface SwitchRun {
  segments: Segment[];
  output: string;
  env: Record<string, unknown> | undefined;
  /** Components the run tried to import, in order. */
  imports: string[];
  /** Source of every code block the run executed, in order. */
  blocks: string[];
}

function runSwitch(
  source: string,
  opts: { env?: Record<string, unknown>; origin?: SourceOrigin } = {},
): Operation<SwitchRun> {
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

/**
 * A run whose operands announce themselves.
 *
 * Rendered output says which branch expanded; it cannot say how many matchers
 * were compared to get there. Every operand in these documents is a call into
 * the recorder, so the order and the count are read directly.
 */
interface TracedRun extends SwitchRun {
  calls: string[];
}

function runTraced(source: string, values: Record<string, unknown> = {}): Operation<TracedRun> {
  return scoped(function* () {
    const calls: string[] = [];
    const run = yield* runSwitch(source, {
      env: {
        ...values,
        seen: (label: string, value: unknown) => {
          calls.push(label);
          return value;
        },
        boom: (label: string) => {
          calls.push(label);
          throw new Error(`${label} was evaluated`);
        },
      },
    });
    return { ...run, calls };
  });
}

describe("Tier SWITCH / CASE — selection", () => {
  it("SW1: the first case whose matcher is === the selector expands", function* () {
    const run = yield* runSwitch(
      [
        "<Switch value={status}>",
        '<Case value="newer">NEWER</Case>',
        '<Case value="current">CURRENT</Case>',
        '<Case value="older">OLDER</Case>',
        "</Switch>",
      ].join(""),
      { env: { status: "current" } },
    );
    expect(run.output).toBe("CURRENT");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("SW2: the selector is evaluated once and matchers only up to the match", function* () {
    const run = yield* runTraced(
      [
        '<Switch value={seen("selector", "b")}>',
        '<Case value={seen("a", "a")}>A</Case>',
        '<Case value={seen("b", "b")}>B</Case>',
        '<Case value={boom("c")}>C</Case>',
        "</Switch>",
      ].join(""),
    );
    expect(run.output).toBe("B");
    expect(run.calls).toEqual(["selector", "a", "b"]);
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("SW3: two cases carrying the same matcher select the first", function* () {
    const run = yield* runSwitch(
      [
        '<Switch value="same">',
        '<Case value="same">FIRST</Case>',
        '<Case value="same">SECOND</Case>',
        "</Switch>",
      ].join(""),
    );
    expect(run.output).toBe("FIRST");
  });

  it("SW4: comparison is the === operator, so NaN matches nothing", function* () {
    const run = yield* runSwitch(
      [
        "<Switch value={NaN}>",
        "<Case value={NaN}>NAN</Case>",
        "<Case default>DEFAULT</Case>",
        "</Switch>",
      ].join(""),
    );
    expect(run.output).toBe("DEFAULT");
  });

  it("SW5: === makes 0 and -0 the same value", function* () {
    const run = yield* runSwitch(
      ["<Switch value={0}>", "<Case value={-0}>ZERO</Case>", "</Switch>"].join(""),
    );
    expect(run.output).toBe("ZERO");
  });

  it("SW6: === compares objects by reference", function* () {
    const token = { name: "token" };
    const run = yield* runSwitch(
      [
        "<Switch value={token}>",
        "<Case value={twin}>TWIN</Case>",
        "<Case value={token}>TOKEN</Case>",
        "</Switch>",
      ].join(""),
      { env: { token, twin: { name: "token" } } },
    );
    expect(run.output).toBe("TOKEN");
  });

  it("SW7: an operand is the value its own expression produced, not a JSON reading of it", function* () {
    // The scanner resolves `{undefined}` to `null` when it reads a structural
    // operand as JSON. Selecting `null` here would mean the comparison ran on
    // that reading rather than on what the author wrote.
    const undefinedSelector = yield* runSwitch(
      [
        "<Switch value={undefined}>",
        "<Case value={null}>NULL</Case>",
        "<Case default>DEFAULT</Case>",
        "</Switch>",
      ].join(""),
    );
    expect(undefinedSelector.output).toBe("DEFAULT");

    const undefinedMatcher = yield* runSwitch(
      [
        "<Switch value={missing}>",
        "<Case value={undefined}>UNDEFINED</Case>",
        "<Case default>DEFAULT</Case>",
        "</Switch>",
      ].join(""),
      { env: { missing: undefined } },
    );
    expect(undefinedMatcher.output).toBe("UNDEFINED");
  });

  it("SW8: a quoted matcher is the string it spells, never coerced", function* () {
    const run = yield* runSwitch(
      [
        "<Switch value={1}>",
        '<Case value="1">STRING</Case>',
        "<Case value={true}>BOOLEAN</Case>",
        "<Case value={1}>NUMBER</Case>",
        "</Switch>",
      ].join(""),
    );
    expect(run.output).toBe("NUMBER");
  });

  it("SW9: the final default expands only after every matcher missed", function* () {
    const run = yield* runTraced(
      [
        '<Switch value={seen("selector", "z")}>',
        '<Case value={seen("a", "a")}>A</Case>',
        '<Case value={seen("b", "b")}>B</Case>',
        "<Case default>DEFAULT</Case>",
        "</Switch>",
      ].join(""),
    );
    expect(run.output).toBe("DEFAULT");
    expect(run.calls).toEqual(["selector", "a", "b"]);
  });

  it("SW10: no match without a default renders nothing and reports no error", function* () {
    const run = yield* runSwitch(
      [
        '<Switch value="z">',
        '<Case value="a"><Let as="picked">A</Let></Case>',
        '<Case value="b">B</Case>',
        "</Switch>",
        "[{picked}]",
      ].join(""),
    );
    expect(run.output).toBe("[{picked}]");
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.env?.picked).toBeUndefined();
  });

  it("SW11: an empty selected branch renders nothing and is not an error", function* () {
    const run = yield* runSwitch(
      ['<Switch value="a">', '<Case value="a"></Case>', "</Switch>", "after"].join(""),
    );
    expect(run.output).toBe("after");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });
});

describe("Tier SWITCH / CASE — complete structure precedes every evaluation", () => {
  const MALFORMED: Array<[string, string, string]> = [
    ["SW12", '<Switch><Case value="a">BODY</Case></Switch>', 'requires a "value" prop'],
    [
      "SW13",
      '<Switch value="a" on="x"><Case value="a">BODY</Case></Switch>',
      'only accepts a "value" prop',
    ],
    ["SW14", '<Switch value="a" />', "is written paired"],
    ["SW15", '<Switch value="a"></Switch>', "requires at least one <Case> branch"],
    [
      "SW16",
      '<Switch value="a">stray text<Case value="a">BODY</Case></Switch>',
      'Found text "stray text" directly inside it',
    ],
    [
      "SW17",
      '<Switch value="a"><Tripwire /><Case value="a">BODY</Case></Switch>',
      "Found <Tripwire> directly inside it",
    ],
    [
      "SW18",
      [
        '<Switch value="a">',
        "",
        "```bash exec",
        "echo TRIPWIRE",
        "```",
        "",
        '<Case value="a">BODY</Case>',
        "</Switch>",
      ].join("\n"),
      "Found a `bash` code block directly inside it",
    ],
    ["SW19", '<Switch value="a"><Case>BODY</Case></Switch>', 'requires a "value" prop'],
    [
      "SW20",
      '<Switch value="a"><Case value="a" default>BODY</Case></Switch>',
      'either matches a "value" or is the "default" branch, not both',
    ],
    [
      "SW21",
      '<Switch value="a"><Case value="a" on="x">BODY</Case></Switch>',
      'only accepts "value" and "default" props',
    ],
    ["SW22", '<Switch value="a"><Case value="a" /></Switch>', "is written paired"],
    [
      "SW23",
      '<Switch value="a"><Case default={true}>BODY</Case></Switch>',
      "default is the bare word",
    ],
    [
      "SW24",
      '<Switch value="a"><Case default="yes">BODY</Case></Switch>',
      "default is the bare word",
    ],
    [
      "SW25",
      '<Switch value="a"><Case default>BODY</Case><Case default>BODY</Case></Switch>',
      "at most one <Case default> branch",
    ],
    [
      "SW26",
      '<Switch value="a"><Case default>BODY</Case><Case value="a">BODY</Case></Switch>',
      "must be the final branch of its <Switch>",
    ],
    [
      "SW27",
      '<Switch value="a"><Case value="a"><Case value="b">INNER</Case></Case></Switch>',
      "must be a direct child of <Switch>",
    ],
  ];

  for (const [id, source, expected] of MALFORMED) {
    it(`${id}: ${expected}`, function* () {
      const run = yield* runSwitch(source);
      expect(errorMessages(run.segments).join("\n")).toContain(expected);
      expect(run.output).not.toContain("BODY");
      expect(run.output).not.toContain("INNER");
      expect(run.imports).toHaveLength(0);
      expect(run.blocks).toHaveLength(0);
    });
  }

  it("SW28: a <Case> outside every <Switch> is reserved rather than resolved", function* () {
    const run = yield* runSwitch('<Case value="a">orphan</Case>');
    expect(errorMessages(run.segments)[0]).toContain("must be a direct child of <Switch>");
    expect(errorMessages(run.segments)[0]).toContain("never resolves a component");
    expect(run.output).not.toContain("orphan");
    expect(run.imports).toHaveLength(0);
  });

  it("SW29: a malformed case the comparison would never reach still stops the switch", function* () {
    const run = yield* runTraced(
      [
        '<Switch value={seen("selector", "a")}>',
        '<Case value={seen("a", "a")}>SELECTED</Case>',
        '<Case value="b" default>MALFORMED</Case>',
        "</Switch>",
      ].join(""),
    );
    expect(run.calls).toEqual([]);
    expect(run.output).not.toContain("SELECTED");
    expect(errorMessages(run.segments).join("\n")).toContain("not both");
  });

  it("SW30: whitespace between branches is formatting, not a substantive child", function* () {
    const run = yield* runSwitch(
      [
        '<Switch value="b">',
        '<Case value="a">A</Case>',
        '<Case value="b">B</Case>',
        "</Switch>",
      ].join("\n"),
    );
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.output.trim()).toBe("B");
  });

  it("SW31: a nested <Switch> owns the cases beneath it", function* () {
    const run = yield* runSwitch(
      [
        '<Switch value="outer">',
        '<Case value="outer">',
        '<Switch value="inner">',
        '<Case value="inner">NESTED</Case>',
        "<Case default>NESTED_DEFAULT</Case>",
        "</Switch>",
        "</Case>",
        "</Switch>",
      ].join(""),
    );
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.output).toBe("NESTED");
  });
});

describe("Tier SWITCH / CASE — operand failures", () => {
  it("SW32: a selector that fails to evaluate reports one error and compares nothing", function* () {
    const run = yield* runTraced(
      [
        '<Switch value={boom("selector")}>',
        '<Case value={seen("a", "a")}>A</Case>',
        "<Case default>DEFAULT</Case>",
        "</Switch>",
      ].join(""),
    );
    expect(run.calls).toEqual(["selector"]);
    expect(errorMessages(run.segments)).toHaveLength(1);
    expect(errorMessages(run.segments)[0]).toContain("selector was evaluated");
    expect(run.output).not.toContain("DEFAULT");
  });

  it("SW33: a matcher that fails reports one error at that case and stops", function* () {
    const run = yield* runTraced(
      [
        '<Switch value={seen("selector", "z")}>',
        '<Case value={seen("a", "a")}>A</Case>',
        '<Case value={boom("b")}>B</Case>',
        '<Case value={boom("c")}>C</Case>',
        "<Case default>DEFAULT</Case>",
        "</Switch>",
      ].join(""),
    );
    expect(run.calls).toEqual(["selector", "a", "b"]);
    expect(errorMessages(run.segments)).toHaveLength(1);
    expect(errorMessages(run.segments)[0]).toContain("b was evaluated");
    expect(run.output).not.toContain("DEFAULT");
  });

  it("SW34: an undeclared identifier in an operand is reported, not treated as a miss", function* () {
    const run = yield* runSwitch(
      ["<Switch value={absent}>", '<Case value="a">A</Case>', "</Switch>"].join(""),
    );
    expect(errorMessages(run.segments)[0]).toContain("value={absent}");
    expect(run.output).not.toContain("A");
  });
});

describe("Tier SWITCH / CASE — printed errors carry source positions", () => {
  it("SW35: a structural error anchors at the responsible element", function* () {
    const run = yield* runSwitch('line one\n<Switch>\n<Case value="a">A</Case>\n</Switch>\n');
    expect(errorMessages(run.segments)[0]).toContain("(2:1)");
  });

  it("SW36: a case's own structural error anchors at that case", function* () {
    const run = yield* runSwitch(
      ['<Switch value="a">', '<Case value="a" default>A</Case>', "</Switch>"].join("\n"),
    );
    expect(errorMessages(run.segments)[0]).toContain("(2:1)");
  });

  it("SW37: an origin adds the file path to a selector failure", function* () {
    const run = yield* runSwitch(
      ["<Switch value={absent}>", '<Case value="a">A</Case>', "</Switch>"].join("\n"),
      { origin: { path: "Doc.md", baseOffset: 40, baseLine: 5 } },
    );
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:5:1)");
  });

  it("SW38: a matcher failure names the <Case> it belongs to", function* () {
    const run = yield* runTraced(
      ['<Switch value={"z"}>', '<Case value={boom("b")}>B</Case>', "</Switch>"].join("\n"),
    );
    const failure = run.segments.find((segment) => segment.type === "error");
    expect(failure?.type === "error" ? failure.source : undefined).toBe("Case");
    expect(errorMessages(run.segments)[0]).toContain("(2:1)");
  });

  it("SW39: an element with no position diagnoses without one", function* () {
    const element: ComponentElement = {
      type: "component",
      name: "Switch",
      props: {},
      expressions: {},
      children: [],
      selfClosing: false,
    };
    const segments = yield* scoped(function* () {
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments([element], {}, {}, new Set());
    });
    expect(errorMessages(segments)).toContain('<Switch> requires a "value" prop.');
  });

  it("SW40: a stray <Case> reports its own position", function* () {
    const run = yield* runSwitch('intro\n<Case value="a">orphan</Case>', {
      origin: { path: "Doc.md", baseOffset: 0, baseLine: 1 },
    });
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:2:1)");
  });
});

describe("Tier SWITCH / CASE — the selected case is transparent", () => {
  it("SW41: the selected branch renders inline, in place", function* () {
    const run = yield* runSwitch(
      ['before|<Switch value="a">', '<Case value="a">mid</Case>', "</Switch>|after"].join(""),
    );
    expect(run.output).toBe("before|mid|after");
  });

  it("SW42: a binding from the selected case stays available afterward", function* () {
    const run = yield* runSwitch(
      [
        '<Switch value="a">',
        '<Case value="a"><Let as="picked">chosen</Let></Case>',
        '<Case value="b"><Let as="skipped">other</Let></Case>',
        "</Switch>",
        "[{picked}][{skipped}]",
      ].join(""),
    );
    expect(run.output).toBe("[chosen][{skipped}]");
    expect(run.env?.picked).toBe("chosen");
    expect(run.env?.skipped).toBeUndefined();
  });

  it("SW43: a <Break> in the selected case exits the authored enclosing loop", function* () {
    const run = yield* runSwitch(
      [
        "<Loop max={3}>",
        "x",
        '<Switch value="stop">',
        '<Case value="stop"><Break /></Case>',
        "</Switch>",
        "</Loop>",
      ].join(""),
    );
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.output).toBe("x");
  });

  it("SW44: a <Break> in an unselected case does not exit the loop", function* () {
    const run = yield* runSwitch(
      [
        "<Loop max={3}>",
        "x",
        '<Switch value="go">',
        '<Case value="stop"><Break /></Case>',
        "</Switch>",
        "</Loop>",
      ].join(""),
    );
    expect(errorMessages(run.segments)).toHaveLength(0);
    expect(run.output).toBe("xxx");
  });
});

/**
 * `<Switch>` must not add an observation boundary (spec §6.9). Every
 * ErrorSegment passes through `Component.raise` exactly once, where it is
 * created, so an error inside a selected case settles once — exactly as the
 * same error would inline — and an error the construct creates itself settles
 * once too.
 */
describe("Tier SWITCH / CASE — error observation", () => {
  const BROKEN: FunctionComponentDefinition = {
    kind: "function",
    name: "Broken",
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    fn: printErrors(function* () {
      throw new Error("broken thing");
    }),
  };

  const BROKE = "Function component Broken error: broken thing";

  function runRaiseProbe(source: string): Operation<{ observed: string[]; output: string }> {
    return scoped(function* () {
      const observed: string[] = [];
      yield* Component.around({
        *raise([error], next) {
          observed.push(error.message);
          return yield* next(error);
        },
      });
      yield* Component.around(
        {
          env: () => ({ values: {} }),
          // deno-lint-ignore require-yield
          *importComponent([name], _next) {
            if (name !== "Broken") {
              throw new Error(`Component not found: ${name}`);
            }
            return BROKEN;
          },
        },
        { at: "min" },
      );
      const segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
      return { observed, output: renderSegments(segments) };
    });
  }

  it("SW45: an error in the selected case is observed once", function* () {
    const probe = yield* runRaiseProbe(
      '<Switch value="a"><Case value="a"><Broken /></Case></Switch>',
    );
    expect(probe.observed).toEqual([BROKE]);
    expect(probe.output).toContain(BROKE);
  });

  it("SW46: an error in an unselected case is observed zero times", function* () {
    const probe = yield* runRaiseProbe(
      [
        '<Switch value="b">',
        '<Case value="a"><Broken /></Case>',
        '<Case value="b">alt</Case>',
        "</Switch>",
      ].join(""),
    );
    expect(probe.observed).toEqual([]);
    expect(probe.output).toBe("alt");
  });

  it("SW47: a <Switch>-owned structural error is observed once", function* () {
    const structure = yield* runRaiseProbe('<Switch><Case value="a">A</Case></Switch>');
    expect(structure.observed).toHaveLength(1);
    expect(structure.observed[0]).toContain('requires a "value" prop');

    const stray = yield* runRaiseProbe('<Case value="a">orphan</Case>');
    expect(stray.observed).toHaveLength(1);
    expect(stray.observed[0]).toContain("must be a direct child of <Switch>");
  });

  it("SW48: a throwing error mode still aborts on a selected-case error", function* () {
    let thrown: unknown;
    yield* scoped(function* () {
      yield* ErrorMode.set("throw");
      try {
        yield* runRaiseProbe('<Switch value="a"><Case value="a"><Broken /></Case></Switch>');
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(DocumentationError);
  });
});

/**
 * Direct probes at each mechanism an unselected case could reach. Rendered
 * output alone cannot distinguish "never ran" from "ran and rendered nothing",
 * so every probe counts calls at the Api itself and pairs the unselected case
 * with a selected control that proves the counter would have moved.
 */
describe("Tier SWITCH / CASE — only the selected body works", () => {
  beforeAll(() => useTempFileCompiler());

  const PROBE_DOC = (selector: string) =>
    [
      `<Switch value="${selector}">`,
      '<Case value="work">',
      "<Probe />",
      "",
      "```bash exec",
      "echo CASE_RAN",
      "```",
      "",
      "```js eval",
      'const caseBinding = "worked";',
      "```",
      "</Case>",
      "<Case default>",
      "alternative",
      "</Case>",
      "</Switch>",
      "[{caseBinding}]",
    ].join("\n");

  interface ProbeRun {
    output: string;
    /** Every path the document caused the Fs Api to stat or read. */
    reads: string[];
    /** Every command handed to the process runtime. */
    commands: string[];
    events: DurableEvent[];
  }

  /**
   * Each run gets its own scope: `useStubFs` installs a terminal Fs handler, so
   * two runs in one scope would leave the first document answering for both.
   */
  function runProbe(selector: string): Operation<ProbeRun> {
    return scoped(function* () {
      const reads: string[] = [];
      const commands: string[] = [];
      const stream = new InMemoryStream();
      const files: Record<string, string> = {
        "components/Probe.md": "PROBE_BODY",
        "test.md": PROBE_DOC(selector),
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
      const output = asText(yield* collect(yield* execute({ path: "test.md", stream })));
      return { output, reads, commands, events: stream.snapshot() };
    });
  }

  it("SW49: no component in an unselected case expands", function* () {
    const skipped = yield* runProbe("other");
    expect(skipped.output).not.toContain("PROBE_BODY");
    expect(skipped.output).toContain("alternative");

    const selected = yield* runProbe("work");
    expect(selected.output).toContain("PROBE_BODY");
  });

  it("SW50: no component file is looked up or read for an unselected case", function* () {
    const skipped = yield* runProbe("other");
    expect(skipped.reads).toEqual(["test.md"]);

    const selected = yield* runProbe("work");
    expect(selected.reads).toContain("stat:components/Probe.md");
    expect(selected.reads).toContain("components/Probe.md");
  });

  it("SW51: the process runtime is never invoked for an unselected exec block", function* () {
    const skipped = yield* runProbe("other");
    expect(skipped.commands).toHaveLength(0);

    const selected = yield* runProbe("work");
    expect(selected.commands.some((command) => command.includes("CASE_RAN"))).toBe(true);
  });

  it("SW52: an unselected case writes no exec or eval durable event", function* () {
    const skipped = yield* runProbe("other");
    expect(skipped.events.filter(isExecYield)).toHaveLength(0);
    expect(skipped.events.filter(isEvalYield)).toHaveLength(0);

    const selected = yield* runProbe("work");
    expect(selected.events.filter(isExecYield).length).toBeGreaterThan(0);
    expect(selected.events.filter(isEvalYield).length).toBeGreaterThan(0);
  });

  it("SW53: an unselected case creates no binding for later content", function* () {
    const skipped = yield* runProbe("other");
    expect(skipped.output).toContain("[{caseBinding}]");

    const selected = yield* runProbe("work");
    expect(selected.output).toContain("[worked]");
  });
});

/**
 * The provider boundary specifically. An unselected case that never imports a
 * component and never runs a block cannot reach a provider either, but that is
 * an inference from two other mechanisms, so this counts calls at the Sample
 * Api itself.
 */
describe("Tier SWITCH / CASE — provider boundary", () => {
  beforeAll(() => useTempFileCompiler());

  function runSampleProbe(selector: string): Operation<{ calls: string[]; output: string }> {
    return scoped(function* () {
      const calls: string[] = [];
      // Read the real component before the stub filesystem replaces it.
      const sampleMd = yield* readTextFile("packages/core/components/Sample.md");

      yield* useStubFs({
        "components/Sample.md": sampleMd,
        "test.md": [
          `<Switch value="${selector}">`,
          '<Case value="ask">',
          '<Sample prompt="CASE_PROMPT" />',
          "</Case>",
          "<Case default>alternative</Case>",
          "</Switch>",
        ].join("\n"),
      });
      yield* useEchoExec();
      yield* Sample.around({
        // deno-lint-ignore require-yield
        *sample([context], _next) {
          calls.push(context.content);
          return "[sampled]";
        },
      });

      const output = asText(
        yield* collect(yield* execute({ path: "test.md", stream: new InMemoryStream() })),
      );
      return { calls, output };
    });
  }

  it("SW54: an unselected case makes zero provider calls", function* () {
    const skipped = yield* runSampleProbe("other");
    expect(skipped.calls).toEqual([]);
    expect(skipped.output).toContain("alternative");
    expect(skipped.output).not.toContain("[sampled]");

    // The same probe records a call when the case is selected, so the empty
    // result above is non-execution rather than a probe that stopped working.
    const selected = yield* runSampleProbe("ask");
    expect(selected.calls).toEqual(["CASE_PROMPT"]);
    expect(selected.output).toContain("[sampled]");
  });
});

describe("Tier SWITCH / CASE — document execution", () => {
  beforeAll(() => useTempFileCompiler());

  it("SW55: a <Return> in the selected case satisfies the value body that owns it", function* () {
    yield* useStubFs({
      "Verdict.md": [
        "---",
        "returns:",
        "  type: string",
        "---",
        "",
        '<Switch value="ship">',
        '<Case value="hold"><Return value="held" /></Case>',
        '<Case value="ship"><Return value="picked" /></Case>',
        "</Switch>",
        "",
      ].join("\n"),
      "test.md": '<Verdict as="v" />\n\nGot {v}\n',
    });
    yield* useEchoExec();

    const output = asText(
      yield* collect(yield* execute({ path: "test.md", stream: new InMemoryStream() })),
    );
    expect(output).toContain("Got picked");
    expect(output).not.toContain("held");
  });

  it("SW56: a <Switch> projected through <Content /> reads the caller's bindings", function* () {
    yield* useStubFs({
      "components/Wrap.md": "<Content />",
      "test.md": [
        "```js eval",
        "const state = 'waiting';",
        "```",
        "<Wrap>",
        "<Switch value={state}>",
        "<Case value={'ready'}>READY</Case>",
        "<Case value={'waiting'}>WAITING</Case>",
        "</Switch>",
        "</Wrap>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = asText(
      yield* collect(yield* execute({ path: "test.md", stream: new InMemoryStream() })),
    );
    expect(output).toContain("WAITING");
    expect(output).not.toContain("READY");
    expect(output).not.toContain("ERROR");
  });

  it("SW57: only the selected case reaches the journal", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const state = 'second';",
        "```",
        "<Switch value={state}>",
        "<Case value={'first'}>",
        "```js eval",
        "output('FIRST_RAN');",
        "```",
        "</Case>",
        "<Case value={'second'}>",
        "```js eval",
        "output('SECOND_RAN');",
        "```",
        "</Case>",
        "</Switch>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("SECOND_RAN");
    expect(output).not.toContain("FIRST_RAN");
    expect(output).not.toContain("ERROR");

    // The root import entry carries the whole document source, both branches
    // included, so only the eval entries show what actually ran.
    const evaluated = JSON.stringify(stream.snapshot().filter(isEvalYield));
    expect(evaluated).toContain("SECOND_RAN");
    expect(evaluated).not.toContain("FIRST_RAN");
  });
});

describe("Tier SWITCH / CASE — replay", () => {
  beforeAll(() => useTempFileCompiler());

  const REPLAY_DOC = [
    "```js eval",
    "const state = 'second';",
    "```",
    "<Switch value={state}>",
    "<Case value={'first'}>",
    "```js eval",
    "output('FIRST_RAN');",
    "```",
    "</Case>",
    "<Case value={'second'}>",
    "```js eval",
    "output('SELECTED_EFFECT');",
    "```",
    "</Case>",
    "</Switch>",
    "",
    "```js eval",
    "output('AFTER_SWITCH');",
    "```",
  ].join("\n");

  it("SW58: a truncated journal restores the selected effect and continues live", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "test.md": REPLAY_DOC });
    yield* useEchoExec();

    const golden = yield* collect(yield* execute({ path: "test.md", stream }));
    expect(golden).toContain("SELECTED_EFFECT");
    expect(golden).toContain("AFTER_SWITCH");
    expect(golden).not.toContain("FIRST_RAN");

    // Cut the journal to the root import, the binding eval and the selected
    // case's own eval. A stream still carrying the root Close would return the
    // stored result without expanding the document, which would prove nothing
    // about selection.
    const events = stream.snapshot();
    const evals = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => isEvalYield(event));
    expect(evals.length).toBeGreaterThanOrEqual(3);
    const partial = new InMemoryStream(events.slice(0, evals[1].index + 1));
    expect(partial.snapshot().some((event) => event.type === "close")).toBe(false);

    const replayed = yield* collect(yield* execute({ path: "test.md", stream: partial }));

    expect(replayed).toBe(golden);
    // The switch appended no event of its own: selection was rebuilt by
    // ordinary expansion, and only the work after the restored effect is new.
    expect(partial.appendCount).toBeGreaterThan(0);
    const evaluated = JSON.stringify(partial.snapshot().filter(isEvalYield));
    expect(evaluated).toContain("SELECTED_EFFECT");
    expect(evaluated).toContain("AFTER_SWITCH");
    expect(evaluated).not.toContain("FIRST_RAN");
  });

  it("SW59: completed replay performs no selector, matcher, import or block", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "test.md": REPLAY_DOC });
    yield* useEchoExec();
    const golden = yield* collect(yield* execute({ path: "test.md", stream }));

    const completed = new InMemoryStream(stream.snapshot());
    expect(completed.snapshot().some((event) => event.type === "close")).toBe(true);

    const reads: string[] = [];
    const replayed = yield* scoped(function* () {
      yield* API.Fs.around({
        // deno-lint-ignore require-yield
        *readTextFile([path], _next): Operation<string> {
          reads.push(path);
          throw new Error(`ENOENT: no such file: ${path}`);
        },
        // deno-lint-ignore require-yield
        *stat([path], _next): Operation<StatResult> {
          reads.push(`stat:${path}`);
          return { exists: false, isFile: false, isDirectory: false };
        },
        // deno-lint-ignore require-yield
        *glob(_args, _next) {
          throw new Error("glob not stubbed");
        },
      });
      return yield* collect(yield* execute({ path: "test.md", stream: completed }));
    });

    expect(replayed).toBe(golden);
    expect(reads).toHaveLength(0);
    expect(completed.appendCount).toBe(0);
  });
});
