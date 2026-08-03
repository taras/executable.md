import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { registerComponents } from "../src/components/registration.ts";
import { Component } from "../src/component-api.ts";
import { AmbientErrorPolicy, DocumentationError } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import type { SourceOrigin } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { DivergenceError, InMemoryStream, StaleInputError } from "@executablemd/durable-streams";
import type { DurableEvent, Json, Result } from "@executablemd/durable-streams";
import { useEchoExec, useStubFs } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { captureErrors } from "../src/component-failures.ts";
import type { ComponentElement, FunctionComponent, Segment } from "../src/types.ts";
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
// Ordinary components: indexing the definition union would widen these to the
// live shape too, and then captureErrors could not infer a concrete arm.
type Stubs = Record<string, FunctionComponent>;

function runLoop(
  source: string,
  opts: {
    env?: Record<string, unknown>;
    origin?: SourceOrigin;
    components?: Stubs;
  } = {},
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
          return {
            kind: "function",
            name,
            props: OBJECT_SCHEMA,
            // What these assert is how a rendered diagnostic interacts with a
            // loop and its policy, which needs the failure to become one.
            fn: captureErrors(fn),
          };
        },
        // deno-lint-ignore require-yield
        *applyModifiers([_modifiers, context], _next) {
          blocks.push(context.content);
          return {
            output: `ran:${context.content.trim()}`,
            exitCode: 0,
            stderr: "",
          };
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

/** A journal entry's recorded value, as a plain record. */
function recordedValue(event: DurableEvent): Record<string, Json> {
  if (event.type !== "yield" || event.result.status !== "ok") {
    return {};
  }
  const value = event.result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value;
}

interface IterationEntry {
  name: string;
  loop: Json | undefined;
  iteration: Json;
}

function iterationRecords(events: DurableEvent[]): IterationEntry[] {
  return events
    .filter((event) => event.type === "yield" && event.description.type === "loop_iteration")
    .map((event) => ({
      name: event.type === "yield" ? event.description.name : "",
      loop: event.type === "yield" ? event.description.loop : undefined,
      iteration: recordedValue(event).iteration,
    }));
}

interface OutcomeEntry {
  name: string;
  status: string;
  iterations: Json;
  outcome: Json;
}

function closeResults(events: DurableEvent[]): string[] {
  return events.filter((event) => event.type === "close").map((event) => event.result.status);
}

function outcomeRecords(events: DurableEvent[]): OutcomeEntry[] {
  return events
    .filter((event) => event.type === "yield" && event.description.type === "loop")
    .map((event) => ({
      name: event.type === "yield" ? event.description.name : "",
      status: event.type === "yield" ? event.result.status : "",
      iterations: recordedValue(event).iterations,
      outcome: recordedValue(event).outcome,
    }));
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
    const run = yield* runLoop("<Loop max={attempts}>x</Loop>", {
      env: { attempts: 4 },
    });
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
      const run = yield* runLoop("<Loop max={limit}>BODY</Loop>", {
        env: { limit: value },
      });
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

  it("BREAK18: a malformed <Break> performs no control action", function* () {
    const run = yield* runLoop('<Loop max={3}>a<Break when="now" />b</Loop>');
    // Only a well-formed <Break> carries the instruction, so the loop runs to
    // its bound and the rest of each iteration still expands.
    expect(errorMessages(run.segments)).toHaveLength(3);
    // "b" follows the rejected element in every iteration, so neither the
    // iteration nor the loop was cut short.
    expect(run.output.match(/b/g)).toHaveLength(3);
  });

  it("BREAK18b: a malformed <Break> aborts under a throwing policy", function* () {
    let thrown: unknown;
    yield* scoped(function* () {
      yield* AmbientErrorPolicy.set("throw");
      try {
        yield* runLoop("<Loop max={3}>a<Break>why</Break>b</Loop>");
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(DocumentationError);
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

  it("LOOP39: a truncated journal replays one iteration and runs the rest live", function* () {
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
    const goldenEvals = evalNames(stream.snapshot());
    const goldenIterations = iterationRecords(stream.snapshot()).map((entry) => entry.name);
    expect(goldenIterations).toHaveLength(3);

    // Cut immediately after the first iteration's own eval entry, located from
    // the loop's iteration records rather than from the first eval yield — that
    // one belongs to the block that computes the bound, before the loop.
    const events = stream.snapshot();
    const secondIteration = events.findIndex(
      (event) => event.type === "yield" && event.description.name === `${goldenIterations[1]}`,
    );
    expect(secondIteration).toBeGreaterThan(0);
    const partial = new InMemoryStream(events.slice(0, secondIteration));
    expect(partial.snapshot().some((event) => event.type === "close")).toBe(false);
    // Exactly one iteration is on the truncated journal, with its body entry.
    expect(iterationRecords(partial.snapshot())).toHaveLength(1);
    expect(evalNames(partial.snapshot())).toHaveLength(2);
    expect(outcomeRecords(partial.snapshot())).toHaveLength(0);

    const replayed = asText(yield* collect(yield* execute({ path: "test.md", stream: partial })));

    // Iteration 0 replayed; iterations 1 and 2 ran live onto the same
    // identities, and the loop still finished by exhausting its bound.
    expect(replayed).toBe(golden);
    expect(partial.appendCount).toBeGreaterThan(0);
    expect(evalNames(partial.snapshot())).toEqual(goldenEvals);
    expect(iterationRecords(partial.snapshot()).map((entry) => entry.name)).toEqual(
      goldenIterations,
    );
    expect(outcomeRecords(partial.snapshot())).toEqual([
      { name: "loop:1", status: "ok", iterations: 3, outcome: "exhausted" },
    ]);
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

/**
 * The loop writes its own records, so an outcome is read rather than inferred.
 * Every scenario below pairs the iteration entries with the outcome entry: the
 * two together are what separate an exhausted loop from one that broke on its
 * final iteration, and an empty body from an immediate `<Break>`.
 */
describe("Tier LOOP — execution records", () => {
  beforeAll(() => useTempFileCompiler());

  function runDoc(doc: string, files: Record<string, string> = {}) {
    return scoped(function* () {
      const stream = new InMemoryStream();
      yield* useStubFs({ "test.md": doc, ...files });
      yield* useEchoExec();
      let output = "";
      let failure: unknown;
      try {
        output = asText(yield* collect(yield* execute({ path: "test.md", stream })));
      } catch (error) {
        failure = error;
      }
      return { output, failure, events: stream.snapshot() };
    });
  }

  const COUNTING_LOOP = (max: number, breakAt: number) =>
    [
      "```js eval",
      "const seen = [];",
      "```",
      `<Loop max={${max}}>`,
      "",
      "```js eval",
      "seen.push(seen.length);",
      "```",
      "",
      `<If condition={seen.length === ${breakAt}}>`,
      "<Break />",
      "</If>",
      "</Loop>",
    ].join("\n");

  it("LOOP41: an empty body still records every iteration and the exhaustion", function* () {
    const run = yield* runDoc('<Loop name="planning" max={3}></Loop>');

    expect(iterationRecords(run.events)).toEqual([
      { name: "loop:0:iteration:0", loop: "planning", iteration: 0 },
      { name: "loop:0:iteration:1", loop: "planning", iteration: 1 },
      { name: "loop:0:iteration:2", loop: "planning", iteration: 2 },
    ]);
    expect(outcomeRecords(run.events)).toEqual([
      { name: "loop:0", status: "ok", iterations: 3, outcome: "exhausted" },
    ]);
  });

  it("LOOP42: an immediate <Break> is distinguishable from empty exhaustion", function* () {
    const run = yield* runDoc('<Loop name="planning" max={3}><Break /></Loop>');

    expect(iterationRecords(run.events)).toHaveLength(1);
    expect(outcomeRecords(run.events)).toEqual([
      { name: "loop:0", status: "ok", iterations: 1, outcome: "break" },
    ]);
  });

  it("LOOP43: a break on the final iteration is distinguishable from exhaustion", function* () {
    const broke = yield* runDoc(COUNTING_LOOP(3, 3));
    const exhausted = yield* runDoc(COUNTING_LOOP(3, 99));

    // Identical iteration counts — only the outcome entry tells them apart.
    expect(iterationRecords(broke.events)).toHaveLength(3);
    expect(iterationRecords(exhausted.events)).toHaveLength(3);
    expect(outcomeRecords(broke.events)[0]?.outcome).toBe("break");
    expect(outcomeRecords(exhausted.events)[0]?.outcome).toBe("exhausted");
    expect(outcomeRecords(broke.events)[0]?.iterations).toBe(3);
    expect(outcomeRecords(exhausted.events)[0]?.iterations).toBe(3);
  });

  it("LOOP44: a failure records the error outcome at the iteration it reached", function* () {
    const run = yield* runDoc(
      ["<Loop max={3}>", "<Missing />", "</Loop>", "", "<Output>", "done", "</Output>"].join("\n"),
    );

    expect(run.failure).toBeInstanceOf(DocumentationError);
    expect(iterationRecords(run.events)).toHaveLength(1);
    expect(outcomeRecords(run.events)).toEqual([
      { name: "loop:0", status: "ok", iterations: 1, outcome: "error" },
    ]);
    // The execution's own terminal record agrees. A document that decided it
    // failed is a determined outcome (#309), so the close is `ok` and the
    // failure it carries is inside the recorded value.
    const close = run.events.find((event) => event.type === "close");
    expect(close?.result.status).toBe("ok");
    expect(JSON.stringify(close?.result)).toContain('"status":"err"');
  });

  it("LOOP45: a collecting policy is not a loop failure", function* () {
    const run = yield* runDoc(["<Loop max={3}>", "<Missing />", "</Loop>"].join("\n"));

    expect(iterationRecords(run.events)).toHaveLength(3);
    expect(outcomeRecords(run.events)[0]?.outcome).toBe("exhausted");
  });

  it("LOOP46: an interrupted loop has iteration entries and no terminal record", function* () {
    const DOC = [
      "```js eval",
      "const seen = [];",
      "```",
      "<Loop max={5}>",
      "",
      "```js eval",
      "seen.push(seen.length);",
      "if (seen.length === 2) { yield* suspend(); }",
      "```",
      "",
      "</Loop>",
    ].join("\n");

    const events = yield* scoped(function* () {
      const stream = new InMemoryStream();
      const reachedSecond = withResolvers<void>();
      stream.onAppend = (event) => {
        if (event.type === "yield" && event.description.name === "loop:1:iteration:1") {
          reachedSecond.resolve();
        }
      };
      yield* useStubFs({ "test.md": DOC });
      yield* useEchoExec();

      const task = yield* spawn(function* () {
        yield* collect(yield* execute({ path: "test.md", stream }));
      });
      yield* reachedSecond.operation;
      yield* task.halt();
      return stream.snapshot();
    });

    // Both entered iterations are on the record, under their zero-based
    // identities. The second one's body never completed — an iteration entry
    // records entry, not completion.
    expect(iterationRecords(events).map((entry) => entry.iteration)).toEqual([0, 1]);
    expect(evalNames(events)).toHaveLength(2);

    // The loop never finished, so it wrote no terminal record, and the
    // execution never finished, so it wrote no root Close.
    expect(outcomeRecords(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === "close")).toHaveLength(0);

    // Observably different from both kinds of finished execution. What the
    // journal does not say is why this one stopped: a cancellation and a
    // crashed process leave exactly this state.
    const completed = yield* runDoc("<Loop max={2}>x</Loop>");
    const failed = yield* runDoc(
      ["<Loop max={2}>", "<Missing />", "</Loop>", "", "<Output>", "d", "</Output>"].join("\n"),
    );

    expect(outcomeRecords(completed.events)[0]?.outcome).toBe("exhausted");
    expect(closeResults(completed.events)).toEqual(["ok"]);
    expect(outcomeRecords(failed.events)[0]?.outcome).toBe("error");
    // A determined document failure closes `ok` around the failed outcome; only
    // a durability or infrastructure failure closes `err` (#309).
    expect(closeResults(failed.events)).toEqual(["ok"]);
    expect(closeResults(events)).toEqual([]);
  });

  /**
   * Resumption from an interrupted loop, through the supported recovery path:
   * the incomplete journal is read back and handed to a new execution.
   *
   * `stall` arms the interruption on the first run and disarms it on the
   * second, so the cut lands inside a known iteration without the document
   * having to behave differently when it resumes.
   */
  it("LOOP49: an interrupted loop resumes and finishes on the recorded identities", function* () {
    const DOC = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    stall:",
      "      type: boolean",
      "  required: [stall]",
      "  additionalProperties: false",
      "---",
      "",
      "```js eval",
      "const entered = [];",
      "```",
      '<Loop name="repair" max={4}>',
      "",
      "```js eval",
      "entered.push(1);",
      "output('STEP');",
      "if (stall && entered.length === 3) { yield* suspend(); }",
      "```",
      "",
      "</Loop>",
    ].join("\n");

    const interrupted = yield* scoped(function* () {
      const stream = new InMemoryStream();
      const enteredThird = withResolvers<void>();
      stream.onAppend = (event) => {
        if (
          event.type === "yield" &&
          event.description.type === "loop_iteration" &&
          recordedValue(event).iteration === 2
        ) {
          enteredThird.resolve();
        }
      };
      yield* useStubFs({ "test.md": DOC });
      yield* useEchoExec();

      const task = yield* spawn(function* () {
        yield* collect(yield* execute({ path: "test.md", stream, props: { stall: true } }));
      });
      yield* enteredThird.operation;
      yield* task.halt();
      return stream.snapshot();
    });

    const cutIterations = iterationRecords(interrupted);
    expect(cutIterations.map((entry) => entry.iteration)).toEqual([0, 1, 2]);
    expect(cutIterations.every((entry) => entry.loop === "repair")).toBe(true);
    // Iteration 2 was entered but its body never completed, so it journaled
    // nothing: one binding block plus two finished iterations.
    expect(evalNames(interrupted)).toHaveLength(3);
    expect(outcomeRecords(interrupted)).toHaveLength(0);
    expect(closeResults(interrupted)).toEqual([]);

    // The incomplete journal, read back and handed to a new execution.
    const resumed = yield* scoped(function* () {
      const stream = new InMemoryStream(interrupted);
      yield* useStubFs({ "test.md": DOC });
      yield* useEchoExec();
      const execution = yield* execute({
        path: "test.md",
        stream,
        props: { stall: false },
      });
      const output = asText(yield* collect(execution));
      return {
        output,
        events: stream.snapshot(),
        appended: stream.appendCount,
      };
    });

    // The incomplete journal was accepted: a divergence or a stale entry would
    // have failed the execution rather than producing output.
    expect(resumed.output.match(/STEP/g)).toHaveLength(4);
    expect(resumed.appended).toBeGreaterThan(0);

    // Recorded iteration entries replayed in order, and the loop kept the same
    // identity it was interrupted under.
    const finalIterations = iterationRecords(resumed.events);
    expect(finalIterations.map((entry) => entry.name)).toEqual([
      ...cutIterations.map((entry) => entry.name),
      `${cutIterations[0]?.name.replace(":iteration:0", ":iteration:3")}`,
    ]);
    expect(finalIterations.map((entry) => entry.iteration)).toEqual([0, 1, 2, 3]);

    // The interrupted iteration's body reran live, because an interrupted
    // durable operation journals nothing to replay from.
    expect(evalNames(resumed.events)).toHaveLength(5);
    expect(evalNames(resumed.events).slice(0, 3)).toEqual(evalNames(interrupted));

    // Exactly one terminal record, with the correct outcome and count, on the
    // identity the interrupted run established.
    const loopId = cutIterations[0]?.name.replace(":iteration:0", "") ?? "";
    expect(outcomeRecords(resumed.events)).toEqual([
      { name: loopId, status: "ok", iterations: 4, outcome: "exhausted" },
    ]);

    // The resumed execution finished.
    expect(closeResults(resumed.events)).toEqual(["ok"]);
  });

  it("LOOP47: nested loops record distinct identities per entry", function* () {
    const run = yield* runDoc("<Loop max={2}>(<Loop max={2}>i</Loop>)</Loop>");

    const outcomes = outcomeRecords(run.events);
    // One outcome for the outer loop and one for each entry into the inner one.
    expect(outcomes).toHaveLength(3);
    expect(new Set(outcomes.map((entry) => entry.name)).size).toBe(3);
    expect(new Set(iterationRecords(run.events).map((entry) => entry.name)).size).toBe(6);
  });

  it("LOOP48: the iteration identity is internal", function* () {
    const run = yield* runDoc("<Loop max={2}>({iteration})</Loop>");
    expect(run.output).toContain("({iteration})");
    expect(run.output).not.toContain("(0)");
  });
});

/**
 * A terminal record is identified by the loop, not by the outcome, so replay
 * matches it whatever the recovering run derived. Nothing may accept a stored
 * outcome the run disagrees with, and a durability failure is never recorded as
 * the loop's own.
 */
describe("Tier LOOP — replay validates the terminal record", () => {
  beforeAll(() => useTempFileCompiler());

  /** Complete a run, then hand its journal back without the root Close. */
  function completeThenCut(
    doc: string,
    props: Record<string, Json>,
    files: Record<string, string> = {},
  ) {
    return scoped(function* () {
      const stream = new InMemoryStream();
      yield* useStubFs({ "test.md": doc, ...files });
      yield* useEchoExec();
      yield* collect(yield* execute({ path: "test.md", stream, props }));
      const complete = stream.snapshot();
      expect(closeResults(complete)).toEqual(["ok"]);
      return complete.filter((event) => event.type !== "close");
    });
  }

  function resume(
    doc: string,
    journal: DurableEvent[],
    props: Record<string, Json>,
    files: Record<string, string> = {},
  ) {
    return scoped(function* () {
      const stream = new InMemoryStream(journal);
      yield* useStubFs({ "test.md": doc, ...files });
      yield* useEchoExec();
      let failure: unknown;
      let output = "";
      try {
        output = asText(yield* collect(yield* execute({ path: "test.md", stream, props })));
      } catch (error) {
        failure = error;
      }
      return { failure, output, events: stream.snapshot() };
    });
  }

  const SWITCHABLE = [
    "---",
    "props:",
    "  type: object",
    "  properties:",
    "    breakNow:",
    "      type: boolean",
    "  required: [breakNow]",
    "  additionalProperties: false",
    "---",
    "",
    "<Loop max={1}>",
    "step",
    "<If condition={breakNow}>",
    "<Break />",
    "</If>",
    "</Loop>",
  ].join("\n");

  it("LOOP50: a stored exhausted record cannot replay as a derived break", function* () {
    const cut = yield* completeThenCut(SWITCHABLE, { breakNow: false });
    expect(outcomeRecords(cut)).toEqual([
      { name: "loop:0", status: "ok", iterations: 1, outcome: "exhausted" },
    ]);

    // Same iteration count, so the terminal entry is exactly what the recovering
    // run's own terminal operation reaches. Only its value disagrees.
    const replayed = yield* resume(SWITCHABLE, cut, { breakNow: true });

    expect(replayed.failure).toBeInstanceOf(StaleInputError);
    expect(String(replayed.failure)).toContain("finishing as exhausted after 1 iterations");
    expect(String(replayed.failure)).toContain("finished it as break after 1 iterations");
    // The stored record stands; nothing rewrote or reinterpreted it.
    expect(outcomeRecords(replayed.events).map((entry) => entry.outcome)).toEqual(["exhausted"]);
  });

  it("LOOP51: a stored exhausted record cannot replay as a derived error", function* () {
    const FAILING = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    condition: {}",
      "  required: [condition]",
      "  additionalProperties: false",
      "---",
      "",
      "<Loop max={1}>",
      "<If condition={condition}>step</If>",
      "</Loop>",
      "",
      "<Output>",
      "done",
      "</Output>",
    ].join("\n");

    const cut = yield* completeThenCut(FAILING, { condition: true });
    expect(outcomeRecords(cut).map((entry) => entry.outcome)).toEqual(["exhausted"]);

    // A non-boolean condition makes the body fail under the documentation
    // policy, so this run derives `error` where the journal holds `exhausted`.
    const replayed = yield* resume(FAILING, cut, { condition: 1 });

    expect(replayed.failure).toBeInstanceOf(StaleInputError);
    expect(outcomeRecords(replayed.events).map((entry) => entry.outcome)).toEqual(["exhausted"]);
    // The document failure that reached the stale record is kept as its cause.
    const failure = replayed.failure;
    expect(failure instanceof Error && failure.cause).toBeInstanceOf(DocumentationError);
  });

  it("LOOP52: a stale resource replay inside a loop stays a durability failure", function* () {
    const HELD = [
      "<Loop max={2}>",
      "<TempDir>",
      "",
      "```js eval",
      "output('INSIDE');",
      "```",
      "",
      "</TempDir>",
      "</Loop>",
    ].join("\n");

    const cut = yield* scoped(function* () {
      const stream = new InMemoryStream();
      yield* useStubFs({ "test.md": HELD });
      yield* useEchoExec();
      yield* collect(yield* execute({ path: "test.md", stream }));
      const complete = stream.snapshot();
      expect(closeResults(complete)).toEqual(["ok"]);
      expect(outcomeRecords(complete).map((entry) => entry.outcome)).toEqual(["exhausted"]);
      return complete.filter((event) => event.type !== "close");
    });

    // Every run creates a new temporary directory, so the recorded work inside
    // the old one cannot be replayed. <TempDir> refuses it.
    const replayed = yield* resume(HELD, cut, {});

    expect(replayed.failure).toBeInstanceOf(StaleInputError);
    expect(String(replayed.failure)).toContain("<TempDir> cannot replay");
    // The loop did not settle this as its own `error` outcome, so the stored
    // terminal record was neither consumed nor joined by a second one.
    expect(outcomeRecords(replayed.events).map((entry) => entry.outcome)).toEqual(["exhausted"]);
  });

  it("LOOP54: a wrapped durability failure reaches the caller unwrapped", function* () {
    const planted = new StaleInputError("PLANTED_DURABILITY_FAILURE");

    const run = yield* scoped(function* () {
      const stream = new InMemoryStream();
      yield* useStubFs({ "test.md": "<Loop max={3}>a<Wrapped />b</Loop>" });
      yield* useEchoExec();
      // No generic catch sits above the component, so the wrapper reaches the
      // loop intact — which is what makes this observable. Registered rather
      // than stubbed through importComponent: execute() installs its own
      // terminal provider at { at: "min" }, so an outer stub is never asked.
      yield* registerComponents([
        {
          name: "Wrapped",
          origin: "test",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn() {
            throw new AggregateError([planted], "carried by a wrapper");
          },
        },
      ]);
      let failure: unknown;
      try {
        yield* collect(yield* execute({ path: "test.md", stream }));
      } catch (error) {
        failure = error;
      }
      return { failure, events: stream.snapshot() };
    });

    // The exact nested failure, not the AggregateError that carried it.
    expect(run.failure).toBe(planted);
    // The loop entered its first iteration and recorded no outcome for a
    // failure that is not its own.
    expect(iterationRecords(run.events)).toHaveLength(1);
    expect(outcomeRecords(run.events)).toHaveLength(0);
  });

  it("LOOP57: a wrapper carrying both failures still yields the durability one", function* () {
    const planted = new StaleInputError("PLANTED_STALE_ENTRY");

    const run = yield* scoped(function* () {
      const stream = new InMemoryStream();
      yield* useStubFs({ "test.md": "<Loop max={3}>a<Mixed />b</Loop>" });
      yield* useEchoExec();
      // Thrown from a component, so it travels through the generic catch that
      // asks `fatalCause` which failure ends the execution. The document's
      // failure comes first in the wrapper — the order that would otherwise be
      // reported and let the loop record `error` onto a stale journal.
      yield* Component.around({
        *importComponent([name], next) {
          if (name !== "Mixed") {
            return yield* next(name);
          }
          return {
            kind: "function",
            name,
            path: "Mixed.ts",
            props: OBJECT_SCHEMA,
            // deno-lint-ignore require-yield
            fn: captureErrors(function* () {
              throw new AggregateError(
                [
                  new DocumentationError({
                    type: "error",
                    message: "the document is wrong",
                  }),
                  planted,
                ],
                "carried together",
              );
            }),
          };
        },
      });
      let failure: unknown;
      try {
        yield* collect(yield* execute({ path: "test.md", stream }));
      } catch (error) {
        failure = error;
      }
      return { failure, events: stream.snapshot() };
    });

    expect(run.failure).toBe(planted);
    expect(iterationRecords(run.events)).toHaveLength(1);
    expect(outcomeRecords(run.events)).toHaveLength(0);
  });

  it("LOOP55: a body divergence is reported where it happened", function* () {
    const DIVERGING = [
      "<Loop max={2}>",
      "",
      "```js eval",
      "output('BODY');",
      "```",
      "",
      "</Loop>",
    ].join("\n");

    const complete = yield* scoped(function* () {
      const stream = new InMemoryStream();
      yield* useStubFs({ "test.md": DIVERGING });
      yield* useEchoExec();
      yield* collect(yield* execute({ path: "test.md", stream }));
      return stream.snapshot();
    });

    // Rename the first iteration's body entry, so replaying the loop reaches a
    // description the journal does not hold. Everything else is untouched.
    const bodyEntry = complete.findIndex(isEvalYield);
    expect(bodyEntry).toBeGreaterThan(0);
    const bodyName =
      complete[bodyEntry].type === "yield" ? complete[bodyEntry].description.name : "";
    const tampered = complete
      .filter((event) => event.type !== "close")
      .map((event, index) =>
        index === bodyEntry && event.type === "yield"
          ? {
              ...event,
              description: { ...event.description, name: `${bodyName}:moved` },
            }
          : event,
      );

    const replayed = yield* resume(DIVERGING, tampered, {});

    // The original mismatch, at the body operation that hit it.
    expect(replayed.failure).toBeInstanceOf(DivergenceError);
    const failure = replayed.failure;
    if (!(failure instanceof DivergenceError)) {
      throw new Error("expected a DivergenceError");
    }
    expect(failure.expected.name).toBe(`${bodyName}:moved`);
    expect(failure.actual.name).toBe(bodyName);
    expect(failure.actual.type).toBe("eval");
    // Not the loop's terminal operation, which is where a divergence that had
    // been collected as a diagnostic would have surfaced instead.
    expect(failure.actual.type).not.toBe("loop");
    expect(failure.expected.type).not.toBe("loop");

    // The loop recorded no outcome of its own: the terminal record the earlier
    // run wrote is the only one, and it was neither rewritten nor reinterpreted
    // as an `error`.
    expect(outcomeRecords(replayed.events)).toEqual([
      { name: "loop:0", status: "ok", iterations: 2, outcome: "exhausted" },
    ]);
    // Nor was it rendered: a collectable diagnostic is exactly what would have
    // let expansion carry on to a second, misleading mismatch.
    expect(replayed.output).not.toContain("Divergence");
    expect(replayed.output).not.toContain("ERROR");
  });

  it("LOOP56: a malformed terminal record is described, never quoted", function* () {
    const cut = yield* completeThenCut(SWITCHABLE, { breakNow: false });

    const PLANTED = "ghp_PLANTEDSECRET <script>alert(1)</script>";
    const malformed: Result = { status: "ok", value: { note: PLANTED } };
    const tampered = cut.map((event) =>
      event.type === "yield" && event.description.type === "loop"
        ? { ...event, result: malformed }
        : event,
    );

    const replayed = yield* resume(SWITCHABLE, tampered, { breakNow: false });

    expect(replayed.failure).toBeInstanceOf(StaleInputError);
    const message = String(replayed.failure);
    expect(message).toContain("loop:0");
    expect(message).toContain("an invalid terminal record");
    expect(message).toContain("exhausted after 1 iterations");
    // None of the journal's content is reproduced.
    expect(message).not.toContain("ghp_PLANTEDSECRET");
    expect(message).not.toContain("<script>");
    expect(message).not.toContain("note");
  });

  it("LOOP53: a partial journal whose outcome still agrees replays cleanly", function* () {
    const cut = yield* completeThenCut(SWITCHABLE, { breakNow: false });

    const replayed = yield* resume(SWITCHABLE, cut, { breakNow: false });

    expect(replayed.failure).toBeUndefined();
    expect(replayed.output).toContain("step");
    expect(outcomeRecords(replayed.events)).toEqual([
      { name: "loop:0", status: "ok", iterations: 1, outcome: "exhausted" },
    ]);
    expect(closeResults(replayed.events)).toEqual(["ok"]);
  });
});

/**
 * A component's own body is isolated from the caller's loop; the content the
 * caller projects through it is not. Both sides are observed here, because
 * either one alone would be satisfied by a rule that gets the other backwards.
 */
describe("Tier BREAK — the projection boundary", () => {
  beforeAll(() => useTempFileCompiler());

  function runDoc(doc: string, files: Record<string, string>) {
    return scoped(function* () {
      yield* useStubFs({ "test.md": doc, ...files });
      yield* useEchoExec();
      return asText(
        yield* collect(yield* execute({ path: "test.md", stream: new InMemoryStream() })),
      );
    });
  }

  it("BREAK20: a <Break> the caller projects through <Content /> exits the caller's loop", function* () {
    const output = yield* runDoc("<Loop max={3}>HEAD<Wrap><Break /></Wrap>TAIL</Loop>", {
      "components/Wrap.md": "<section><Content /></section>\n",
    });

    // The component finishes rendering — the loop has no authority over its
    // body — and the break lands when the invocation returns, so TAIL and the
    // remaining iterations never expand.
    expect(output).toContain("<section></section>");
    expect(output).not.toContain("TAIL");
    expect(output.match(/HEAD/g)).toHaveLength(1);
    expect(output).not.toContain("ERROR");
  });

  it("BREAK21: a <Break> a component writes in its own body is stray", function* () {
    const output = yield* runDoc("<Loop max={2}>HEAD<Owner />TAIL</Loop>", {
      "components/Owner.md": "<em><Break /></em>\n",
    });

    expect(output).toContain("must be written inside a <Loop>");
    // Both iterations ran and both kept their trailing content.
    expect(output.match(/TAIL/g)).toHaveLength(2);
  });

  it("BREAK22: a projected <Break> reaches a loop through content() too", function* () {
    const output = yield* runDoc("<Loop max={3}>HEAD<TempDir><Break /></TempDir>TAIL</Loop>", {});

    expect(output).not.toContain("TAIL");
    expect(output.match(/HEAD/g)).toHaveLength(1);
    expect(output).not.toContain("ERROR");
  });
});
