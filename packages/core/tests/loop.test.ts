import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { AmbientErrorPolicy, DocumentationError } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import type { SourceOrigin } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import type { ComponentElement, FunctionComponentDefinition, Segment } from "../src/types.ts";
import { asText } from "./helpers.ts";

interface LoopRun {
  segments: Segment[];
  output: string;
  env: Record<string, unknown> | undefined;
  /** Components the run tried to import, in order. */
  imports: string[];
  /** Source of every code block the run executed, in order. */
  blocks: string[];
}

/** Every stub takes no props; the engine still requires a declared object schema. */
const OBJECT_SCHEMA = { type: "object", properties: {} };

/** Function components the harness serves instead of the filesystem. */
type Stubs = Record<string, FunctionComponentDefinition["fn"]>;

function runLoop(
  source: string,
  opts: { env?: Record<string, unknown>; origin?: SourceOrigin; components?: Stubs } = {},
): Operation<LoopRun> {
  return scoped(function* () {
    const imports: string[] = [];
    const blocks: string[] = [];
    const components = opts.components ?? {};
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          imports.push(name);
          const fn = components[name];
          if (!fn) {
            throw new Error(`Component not found: ${name}`);
          }
          return { kind: "function", name, path: `${name}.ts`, props: OBJECT_SCHEMA, fn };
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

function evalNames(events: DurableEvent[]): string[] {
  return events
    .filter(isEvalYield)
    .map((event) => (event.type === "yield" ? event.description.name : ""));
}

describe("Tier LOOP — bounded repetition", () => {
  it("LOOP1: the body expands exactly max times", function* () {
    const run = yield* runLoop("<Loop max={3}>x</Loop>");
    expect(run.output).toBe("xxx");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("LOOP2: max={1} expands the body once", function* () {
    const run = yield* runLoop("<Loop max={1}>x</Loop>");
    expect(run.output).toBe("x");
  });

  it("LOOP3: reaching max completes normally", function* () {
    const run = yield* runLoop("before|<Loop max={2}>x</Loop>|after");
    expect(run.output).toBe("before|xx|after");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("LOOP4: an empty body renders nothing", function* () {
    const run = yield* runLoop("<Loop max={3}></Loop>after");
    expect(run.output).toBe("after");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("LOOP5: a self-closing loop renders nothing", function* () {
    const run = yield* runLoop("<Loop max={3} />after");
    expect(run.output).toBe("after");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("LOOP6: max resolves from an expression", function* () {
    const run = yield* runLoop("<Loop max={attempts}>x</Loop>", { env: { attempts: 4 } });
    expect(run.output).toBe("xxxx");
  });

  it("LOOP7: each iteration runs the body's code block again", function* () {
    const run = yield* runLoop(
      ["<Loop max={3}>", "", "```bash exec", "echo hi", "```", "", "</Loop>"].join("\n"),
    );
    expect(run.blocks).toEqual(["echo hi\n", "echo hi\n", "echo hi\n"]);
  });

  it("LOOP8: each iteration invokes the body's component again", function* () {
    const run = yield* runLoop("<Loop max={3}><Probe /></Loop>", {
      // deno-lint-ignore require-yield
      components: {
        Probe: function* () {
          return "p";
        },
      },
    });
    expect(run.output).toBe("ppp");
    expect(run.imports).toEqual(["Probe", "Probe", "Probe"]);
  });

  it("LOOP9: loops nest, and the inner loop reruns per outer iteration", function* () {
    const run = yield* runLoop("<Loop max={2}>(<Loop max={3}>i</Loop>)</Loop>");
    expect(run.output).toBe("(iii)(iii)");
  });
});

describe("Tier LOOP — bindings", () => {
  it("LOOP10: an iteration reads what an earlier one bound", function* () {
    const run = yield* runLoop('<Loop max={3}><Capture as="tally">{tally}.</Capture></Loop>', {
      env: { tally: "." },
    });
    expect(run.env?.tally).toBe("....");
  });

  it("LOOP11: the final binding stays readable after the loop", function* () {
    const run = yield* runLoop(
      '<Loop max={2}><Capture as="tally">{tally}.</Capture></Loop>({tally})',
      { env: { tally: "." } },
    );
    expect(run.output).toBe("(...)");
  });

  it("LOOP12: a binding made in the last iteration survives the loop", function* () {
    const run = yield* runLoop(
      '<Loop max={2}><Capture as="picked">chosen</Capture></Loop>({picked})',
    );
    expect(run.output).toBe("(chosen)");
    expect(run.env?.picked).toBe("chosen");
  });

  it("LOOP13: <If> inside the body reads a binding an earlier iteration made", function* () {
    const run = yield* runLoop(
      '<Loop max={2}><If condition={seen}>again<Else>first</Else></If><Capture as="seen">x</Capture></Loop>',
      { env: { seen: false } },
    );
    // The capture rebinds `seen` to a non-boolean, so the second iteration's
    // condition is rejected rather than coerced — bindings really do carry.
    expect(run.output).toContain("first");
    expect(errorMessages(run.segments)[0]).toContain("must be a boolean, not a string");
  });
});

describe("Tier LOOP — bound validation", () => {
  it("LOOP14: a missing max is rejected", function* () {
    const run = yield* runLoop("<Loop>body</Loop>");
    expect(errorMessages(run.segments)[0]).toContain('requires a "max" prop');
    expect(run.output).not.toContain("body");
  });

  it("LOOP15: zero, negative and fractional bounds are rejected", function* () {
    for (const source of [
      "<Loop max={0}>BODY</Loop>",
      "<Loop max={-1}>BODY</Loop>",
      "<Loop max={1.5}>BODY</Loop>",
    ]) {
      const run = yield* runLoop(source);
      expect(errorMessages(run.segments)[0]).toContain("must be a positive integer");
      expect(run.output).not.toContain("BODY");
    }
  });

  it("LOOP16: a non-numeric max is rejected without coercion", function* () {
    const cases: Array<[string, string]> = [
      ['<Loop max="3">BODY</Loop>', "a string"],
      ["<Loop max={true}>BODY</Loop>", "a boolean"],
      ["<Loop max={null}>BODY</Loop>", "null"],
      ["<Loop max={[3]}>BODY</Loop>", "an array"],
      ["<Loop max={{n: 3}}>BODY</Loop>", "an object"],
    ];
    for (const [source, kind] of cases) {
      const run = yield* runLoop(source);
      const message = errorMessages(run.segments)[0] ?? "";
      expect(message).toContain("must be a positive integer");
      expect(message).toContain(kind);
      expect(run.output).not.toContain("BODY");
    }
  });

  it("LOOP17: a non-finite bound is rejected", function* () {
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const run = yield* runLoop("<Loop max={limit}>BODY</Loop>", { env: { limit: value } });
      expect(errorMessages(run.segments)[0]).toContain("must be a positive integer");
      expect(run.output).not.toContain("BODY");
    }
  });

  it("LOOP18: an unresolvable max expression is rejected", function* () {
    const run = yield* runLoop("<Loop max={missing}>BODY</Loop>");
    expect(errorMessages(run.segments)[0]).toContain("max={missing}");
    expect(run.output).not.toContain("BODY");
  });

  it("LOOP19: an invalid bound runs nothing in the body", function* () {
    const run = yield* runLoop("<Loop max={0}><Probe /></Loop>", {
      // deno-lint-ignore require-yield
      components: {
        Probe: function* () {
          return "p";
        },
      },
    });
    expect(run.imports).toHaveLength(0);
  });

  it("LOOP20: unknown props are rejected", function* () {
    const literal = yield* runLoop('<Loop max={2} until="done">x</Loop>');
    expect(errorMessages(literal.segments)[0]).toContain('only accepts "max" and "name" props');

    const expression = yield* runLoop("<Loop max={2} while={flag}>x</Loop>", {
      env: { flag: true },
    });
    expect(errorMessages(expression.segments)[0]).toContain('only accepts "max" and "name" props');
  });
});

describe("Tier LOOP — the optional name", () => {
  it("LOOP21: a name does not change what the loop renders", function* () {
    const run = yield* runLoop('<Loop name="planning" max={2}>x</Loop>');
    expect(run.output).toBe("xx");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("LOOP22: a name is not published as a binding", function* () {
    const run = yield* runLoop('<Loop name="planning" max={1}>({name})({planning})</Loop>');
    expect(run.output).toBe("({name})({planning})");
  });

  it("LOOP23: a name appears in the loop's own diagnostics", function* () {
    const run = yield* runLoop('<Loop name="planning">x</Loop>');
    expect(errorMessages(run.segments)[0]).toContain('<Loop name="planning">');
  });

  it("LOOP24: an expression name is rejected", function* () {
    const run = yield* runLoop("<Loop name={label} max={2}>x</Loop>", {
      env: { label: "planning" },
    });
    expect(errorMessages(run.segments)[0]).toContain("must be a string literal");
  });

  it("LOOP25: an empty or non-string name is rejected", function* () {
    const empty = yield* runLoop('<Loop name="" max={2}>x</Loop>');
    expect(errorMessages(empty.segments)[0]).toContain("must be a non-empty string");

    const numeric = yield* runLoop("<Loop name={2} max={2}>x</Loop>");
    expect(errorMessages(numeric.segments)[0]).toContain("must be a non-empty string");
  });
});

describe("Tier BREAK — exiting the loop", () => {
  it("BREAK1: an immediate <Break> runs the body once", function* () {
    const run = yield* runLoop("<Loop max={5}>a<Break /></Loop>");
    expect(run.output).toBe("a");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("BREAK2: a <Break> before anything else produces no output", function* () {
    const run = yield* runLoop("<Loop max={5}><Break />a</Loop>after");
    expect(run.output).toBe("after");
  });

  it("BREAK3: <Break> inside <If> exits the loop", function* () {
    const run = yield* runLoop("<Loop max={5}>a<If condition={true}><Break /></If>b</Loop>");
    expect(run.output).toBe("a");
  });

  it("BREAK4: an unselected <Break> leaves the loop running", function* () {
    const run = yield* runLoop("<Loop max={3}>a<If condition={false}><Break /></If></Loop>");
    expect(run.output).toBe("aaa");
  });

  it("BREAK5: bindings made before the <Break> remain available", function* () {
    const run = yield* runLoop(
      '<Loop max={5}><Capture as="picked">chosen</Capture><Break /></Loop>({picked})',
    );
    expect(run.output).toBe("(chosen)");
    expect(run.env?.picked).toBe("chosen");
  });

  it("BREAK6: a <Break> exits only the nearest loop", function* () {
    const run = yield* runLoop("<Loop max={2}>(<Loop max={3}>i<Break /></Loop>)</Loop>");
    expect(run.output).toBe("(i)(i)");
  });

  it("BREAK7: an outer <Break> after an inner loop exits the outer loop", function* () {
    const run = yield* runLoop("<Loop max={3}>(<Loop max={2}>i</Loop>)<Break /></Loop>");
    expect(run.output).toBe("(ii)");
  });

  it("BREAK8: <Break> inside <Each> exits the enclosing loop and stops the items", function* () {
    const run = yield* runLoop(
      '<Loop max={3}><Each in={[1, 2, 3]} let="n">{n}<Break /></Each></Loop>',
    );
    expect(run.output).toBe("1");
  });
});

describe("Tier BREAK — content after the break does not run", () => {
  it("BREAK9: text after <Break> does not render", function* () {
    const run = yield* runLoop("<Loop max={2}>before<Break />AFTER</Loop>");
    expect(run.output).toBe("before");
  });

  it("BREAK10: a component after <Break> is never imported", function* () {
    const run = yield* runLoop("<Loop max={2}>before<Break /><Probe /></Loop>", {
      // deno-lint-ignore require-yield
      components: {
        Probe: function* () {
          return "p";
        },
      },
    });
    expect(run.output).toBe("before");
    expect(run.imports).toHaveLength(0);
  });

  it("BREAK11: a code block after <Break> never runs", function* () {
    const run = yield* runLoop(
      [
        "<Loop max={2}>",
        "before",
        "<Break />",
        "",
        "```bash exec",
        "echo after",
        "```",
        "",
        "</Loop>",
      ].join("\n"),
    );
    expect(run.blocks).toHaveLength(0);
  });

  it("BREAK12: a <Capture> after <Break> creates no binding", function* () {
    const run = yield* runLoop(
      '<Loop max={2}>before<Break /><Capture as="skipped">never</Capture></Loop>({skipped})',
    );
    expect(run.output).toBe("before({skipped})");
    expect(run.env?.skipped).toBeUndefined();
  });

  it("BREAK13: content after the loop still runs", function* () {
    const run = yield* runLoop("<Loop max={2}>a<Break /></Loop>after");
    expect(run.output).toBe("aafter");
  });
});

describe("Tier BREAK — validation", () => {
  it("BREAK14: <Break> outside any <Loop> is rejected", function* () {
    const run = yield* runLoop("<Break />");
    expect(errorMessages(run.segments)[0]).toContain("must be written inside a <Loop>");
    expect(run.imports).toHaveLength(0);
  });

  it("BREAK15: a stray <Break> resolves no component", function* () {
    const run = yield* runLoop("<Break />after");
    expect(run.imports).toHaveLength(0);
    expect(run.output).toContain("after");
  });

  it("BREAK16: props on <Break> are rejected", function* () {
    const literal = yield* runLoop('<Loop max={2}>a<Break when="now" /></Loop>');
    expect(errorMessages(literal.segments)[0]).toContain("accepts no props");

    const expression = yield* runLoop("<Loop max={2}>a<Break if={flag} /></Loop>", {
      env: { flag: true },
    });
    expect(errorMessages(expression.segments)[0]).toContain("accepts no props");
  });

  it("BREAK17: content on <Break> is rejected", function* () {
    const run = yield* runLoop("<Loop max={2}>a<Break>why</Break></Loop>");
    expect(errorMessages(run.segments)[0]).toContain("takes no content");
  });

  it("BREAK18: a malformed <Break> still exits the loop, so it reports once", function* () {
    const run = yield* runLoop('<Loop max={5}>a<Break when="now" />b</Loop>');
    expect(errorMessages(run.segments)).toHaveLength(1);
    expect(run.output).toContain("a");
    expect(run.output).not.toContain("b");
  });

  it("BREAK19: <Break> in a component body cannot break the caller's loop", function* () {
    const run = yield* runLoop("<Loop max={3}><Wrap />|</Loop>", {
      components: {
        Wrap: function* () {
          const inner = yield* expandSegments(scanSegments("<Break />"), {}, {}, new Set());
          return renderSegments(inner);
        },
      },
    });
    expect(run.output).toContain("must be written inside a <Loop>");
    // Three iterations still ran: the component never reached the caller's loop.
    expect(run.imports).toEqual(["Wrap", "Wrap", "Wrap"]);
  });
});

describe("Tier LOOP — errors and cancellation stop further iterations", () => {
  it("LOOP26: a throwing policy aborts at the first failing iteration", function* () {
    let thrown: unknown;
    const started: string[] = [];
    yield* scoped(function* () {
      yield* AmbientErrorPolicy.set("throw");
      try {
        yield* runLoop("<Loop max={5}><Boom /></Loop>", {
          // deno-lint-ignore require-yield
          components: {
            Boom: function* () {
              started.push("ran");
              throw new Error("boom");
            },
          },
        });
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(DocumentationError);
    expect(started).toEqual(["ran"]);
  });

  it("LOOP27: a collecting policy renders the diagnostic and keeps iterating", function* () {
    const run = yield* runLoop("<Loop max={3}><Boom /></Loop>", {
      // deno-lint-ignore require-yield
      components: {
        Boom: function* () {
          throw new Error("boom");
        },
      },
    });
    expect(errorMessages(run.segments)).toHaveLength(3);
  });

  it("LOOP28: cancellation stops the loop where it stands", function* () {
    const started: string[] = [];
    const reachedSecond = withResolvers<void>();

    yield* scoped(function* () {
      const task = yield* spawn(() =>
        runLoop("<Loop max={5}><Blocker /></Loop>", {
          components: {
            Blocker: function* () {
              started.push(`iteration:${started.length}`);
              if (started.length === 2) {
                reachedSecond.resolve();
                yield* suspend();
              }
              return "ok";
            },
          },
        }),
      );
      yield* reachedSecond.operation;
      yield* task.halt();
    });

    expect(started).toEqual(["iteration:0", "iteration:1"]);
  });
});

describe("Tier LOOP — resource teardown", () => {
  it("LOOP29: each iteration releases its resources before the next begins", function* () {
    const order: string[] = [];
    const run = yield* runLoop("<Loop max={3}><Held /></Loop>", {
      components: {
        Held: function* () {
          const n = order.filter((entry) => entry.startsWith("acquire")).length;
          order.push(`acquire:${n}`);
          yield* ensure(() => {
            order.push(`release:${n}`);
          });
          return "h";
        },
      },
    });
    expect(run.output).toBe("hhh");
    expect(order).toEqual([
      "acquire:0",
      "release:0",
      "acquire:1",
      "release:1",
      "acquire:2",
      "release:2",
    ]);
  });

  it("LOOP30: a <Break> releases the iteration's resources before the loop exits", function* () {
    const order: string[] = [];
    yield* runLoop("<Loop max={3}><Held /><Break /></Loop>", {
      components: {
        Held: function* () {
          order.push("acquire");
          yield* ensure(() => {
            order.push("release");
          });
          return "h";
        },
      },
    });
    expect(order).toEqual(["acquire", "release"]);
  });
});

describe("Tier LOOP — diagnostics carry source positions", () => {
  it("LOOP31: a local position anchors the loop diagnostic", function* () {
    const run = yield* runLoop("line one\n<Loop>body</Loop>\n");
    expect(errorMessages(run.segments)[0]).toContain("(2:1)");
  });

  it("LOOP32: an origin adds the file path", function* () {
    const run = yield* runLoop("\n<Loop max={0}>body</Loop>", {
      origin: { path: "Doc.md", baseOffset: 40, baseLine: 5 },
    });
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:6:1)");
  });

  it("LOOP33: a stray <Break> reports its own position", function* () {
    const run = yield* runLoop("intro\n<Break />", {
      origin: { path: "Doc.md", baseOffset: 0, baseLine: 1 },
    });
    expect(errorMessages(run.segments)[0]).toContain("(Doc.md:2:1)");
  });

  it("LOOP34: an element with no position diagnoses without one", function* () {
    const element: ComponentElement = {
      type: "component",
      name: "Loop",
      props: {},
      expressions: {},
      children: [{ type: "text", content: "body" }],
      selfClosing: false,
    };
    const segments = yield* scoped(function* () {
      yield* Component.around({ env: () => ({ values: {} }) }, { at: "min" });
      return yield* expandSegments([element], {}, {}, new Set());
    });
    expect(errorMessages(segments)[0]).toBe(
      '<Loop> requires a "max" prop (a positive integer). Repetition is always bounded — ' +
        "there is no unbounded loop.",
    );
  });
});

describe("Tier LOOP — document execution", () => {
  beforeAll(() => useTempFileCompiler());

  it("LOOP35: every iteration journals its own eval entry", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": ["<Loop max={3}>", "", "```js eval", "output('RAN');", "```", "", "</Loop>"].join(
        "\n",
      ),
    });
    yield* useEchoExec();

    const output = asText(yield* collect(yield* execute({ path: "test.md", stream })));

    expect(output.match(/RAN/g)).toHaveLength(3);
    const names = evalNames(stream.snapshot());
    expect(names).toHaveLength(3);
    // Deterministic, distinct identities: the block counter advances across
    // iterations, so replay matches each iteration to its own entry.
    expect(new Set(names).size).toBe(3);
  });

  it("LOOP36: content skipped by <Break> writes no journal entry", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "<Loop max={3}>",
        "",
        "```js eval",
        "output('ITERATION_RAN');",
        "```",
        "",
        "<Break />",
        "",
        "```js eval",
        "output('AFTER_BREAK_RAN');",
        "```",
        "",
        "</Loop>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = asText(yield* collect(yield* execute({ path: "test.md", stream })));

    expect(output).toContain("ITERATION_RAN");
    expect(output).not.toContain("AFTER_BREAK_RAN");
    expect(output).not.toContain("ERROR");

    const evaluated = JSON.stringify(stream.snapshot().filter(isEvalYield));
    expect(evaluated).toContain("ITERATION_RAN");
    expect(evaluated).not.toContain("AFTER_BREAK_RAN");
    expect(evalNames(stream.snapshot())).toHaveLength(1);
  });

  it("LOOP37: a binding accumulates across iterations", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const marks = [];",
        "```",
        "<Loop max={4}>",
        "",
        "```js eval",
        "marks.push(marks.length);",
        "```",
        "",
        "</Loop>",
        "",
        "tally={marks.length}",
        "",
        "```js eval",
        "output(`TALLY:${marks.join(',')}`);",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = asText(yield* collect(yield* execute({ path: "test.md", stream })));
    expect(output).toContain("TALLY:0,1,2,3");
  });

  it("LOOP38: a component in the loop body is imported once per iteration", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Step.md": "step\n",
      "test.md": "<Loop max={3}><Step /></Loop>",
    });
    yield* useEchoExec();

    const output = asText(yield* collect(yield* execute({ path: "test.md", stream })));
    expect(output.match(/step/g)).toHaveLength(3);
    expect(output).not.toContain("ERROR");
  });

  it("LOOP39: a truncated journal replays to the same iterations and identities", function* () {
    const DOC = [
      "```js eval",
      "const attempts = 3;",
      "```",
      "<Loop max={attempts}>",
      "",
      "```js eval",
      "output('STEP');",
      "```",
      "",
      "</Loop>",
    ].join("\n");

    const stream = new InMemoryStream();
    yield* useStubFs({ "test.md": DOC });
    yield* useEchoExec();

    const golden = asText(yield* collect(yield* execute({ path: "test.md", stream })));
    expect(golden.match(/STEP/g)).toHaveLength(3);
    const goldenNames = evalNames(stream.snapshot());

    // Cut the journal to the bound plus the first iteration. Replaying a stream
    // that still carried the root Close would return the stored result without
    // running the loop at all, which would prove nothing about repetition.
    const events = stream.snapshot();
    const firstIteration = events.findIndex(isEvalYield);
    expect(firstIteration).toBeGreaterThanOrEqual(0);
    const partial = new InMemoryStream(events.slice(0, firstIteration + 2));
    expect(partial.snapshot().some((event) => event.type === "close")).toBe(false);

    const replayed = asText(yield* collect(yield* execute({ path: "test.md", stream: partial })));

    // The remaining iterations ran live and landed on the same identities, so
    // the loop is replayable rather than merely repeatable.
    expect(replayed).toBe(golden);
    expect(partial.appendCount).toBeGreaterThan(0);
    expect(evalNames(partial.snapshot())).toEqual(goldenNames);
  });

  it("LOOP40: a <Break> chosen from a binding stops the document's loop", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const seen = [];",
        "```",
        "<Loop max={5}>",
        "",
        "```js eval",
        "seen.push('iteration');",
        "```",
        "",
        "<If condition={seen.length === 2}>",
        "<Break />",
        "</If>",
        "</Loop>",
        "",
        "```js eval",
        "output(`ITERATIONS:${seen.length}`);",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = asText(yield* collect(yield* execute({ path: "test.md", stream })));
    expect(output).toContain("ITERATIONS:2");
    expect(output).not.toContain("ERROR");
  });
});
