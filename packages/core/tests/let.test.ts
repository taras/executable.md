/**
 * Tier LET — the two sources of `<Let>` (spec §6.5).
 *
 * The rendered source is the behavior `<Capture>` had, and its regressions stay
 * where they were. What is new here is the direct source: which source a
 * construct has is decided from what the author wrote, before either one runs,
 * and a direct value reaches the binding by reference rather than through the
 * JSON boundary ordinary component props cross.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { execute, executeInstalled } from "../src/execute.ts";
import type { HostExecution } from "../src/execute.ts";
import { inlineSource } from "../src/root-source.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { asText } from "./helpers.ts";
import type { ComponentDefinition, EvalEnv, JsonObject, Segment } from "../src/types.ts";
import type { ExecutionInstallation } from "../src/execute.ts";

function markdownComponent(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: {},
    props: { type: "object", properties: {}, additionalProperties: false },
    bodySegments: scanSegments(body),
  };
}

/**
 * What one expansion did, and what it did on the way.
 *
 * `imports` counts the components the run actually asked for, because a
 * refusal that still imported a child is exactly the defect these cases are
 * about — and rendered text cannot show it: a refused construct renders no
 * child either way.
 */
interface LetRun {
  output: string;
  values: Record<string, unknown>;
  imports: string[];
}

function run(
  source: string,
  seed: Record<string, unknown> = {},
  components: Record<string, ComponentDefinition> = {},
): Operation<LetRun> {
  return scoped(function* () {
    const imports: string[] = [];
    const values: Record<string, unknown> = { ...seed };
    const testEnv: EvalEnv = { values };
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          imports.push(name);
          const definition = components[name];
          if (!definition) {
            throw new Error(`Component not found: ${name}`);
          }
          return definition;
        },
        env: () => testEnv,
      },
      { at: "min" },
    );
    const segments: Segment[] = scanSegments(source);
    const expanded = yield* expandSegments(segments, {}, {}, new Set());
    return { output: renderSegments(expanded), values, imports };
  });
}

/** What one journal event is, for an assertion about a run's whole record. */
// deno-lint-ignore no-explicit-any
function kindOf(event: any): string {
  return event.type === "yield" ? String(event.description.type) : String(event.type);
}

/** A counter an expression can increment, so "never evaluated" is observable. */
function counter(): { calls: number; bump: () => number } {
  const state = { calls: 0, bump: () => ++state.calls };
  return state;
}

describe("Tier LET — the direct-value source", () => {
  it("LET1: value={42} binds the number, and both direct forms emit nothing", function* () {
    const selfClosing = yield* run('<Let as="answer" value={42} />');
    expect(selfClosing.values.answer).toBe(42);
    expect(selfClosing.output).toBe("");

    const paired = yield* run('<Let as="answer" value={42}></Let>');
    expect(paired.values.answer).toBe(42);
    expect(paired.output).toBe("");
  });

  it("LET2: an object, an array and a cyclic value bind by reference", function* () {
    const source = { name: "release", steps: [1, 2] };
    const list = [source, "tail"];
    const cycle: { name: string; self?: unknown } = { name: "loop" };
    cycle.self = cycle;

    const result = yield* run(
      [
        '<Let as="aliasObject" value={source} />',
        '<Let as="aliasList" value={list} />',
        '<Let as="aliasCycle" value={cycle} />',
      ].join("\n\n"),
      { source, list, cycle },
    );

    expect(result.values.aliasObject).toBe(source);
    expect(result.values.aliasList).toBe(list);
    // A JSON round-trip cannot produce this value at all, so identity here is
    // the proof that no projection stands between the expression and the binding.
    expect(result.values.aliasCycle).toBe(cycle);
  });

  it("LET2b: a function and a class instance bind unchanged", function* () {
    class Release {
      constructor(public bump: string) {}
    }
    const instance = new Release("minor");
    const fn = () => "called";

    const result = yield* run(
      ['<Let as="aliasFn" value={fn} />', '<Let as="aliasInstance" value={instance} />'].join(
        "\n\n",
      ),
      { fn, instance },
    );

    expect(result.values.aliasFn).toBe(fn);
    expect(result.values.aliasInstance).toBe(instance);
    expect(result.values.aliasInstance instanceof Release).toBeTruthy();
  });

  it("LET3: value={undefined} binds an own name holding exactly undefined", function* () {
    const result = yield* run(
      ['<Let as="absent" value={undefined} />', '<Let as="nulled" value={null} />'].join("\n\n"),
    );

    // Only the blank line between the two elements survives; neither bound.
    expect(result.output.trim()).toBe("");

    // Three states a reader can tell apart: bound to `undefined`, bound to
    // `null`, and never bound at all. Presence alone conflates the first two.
    expect("absent" in result.values).toBeTruthy();
    expect(result.values.absent).toBe(undefined);
    expect(result.values.nulled).toBe(null);
    expect("neverBound" in result.values).toBeFalsy();
  });

  it("LET3b: the authored expression, not a scan-time JSON reading of it, is bound", function* () {
    // The scanner resolves an ordinary component's `{undefined}` to JSON null.
    // A `<Let value>` keeps the authored text, so what reaches the binding is
    // what the expression evaluates to.
    const segment = scanSegments('<Let as="x" value={undefined} />')[0];
    if (segment?.type !== "component") {
      throw new Error("expected a component segment");
    }
    expect(segment.expressions.value).toBe("undefined");
    expect("value" in segment.props).toBeFalsy();

    const result = yield* run('<Let as="x" value={undefined} />');
    expect(result.values.x).toBe(undefined);
  });

  it("LET3c: a falsy value is a source, not an absent one", function* () {
    for (const [authored, bound] of [
      ["value={0}", 0],
      ["value={false}", false],
      ["value={null}", null],
      ['value={""}', ""],
    ] as const) {
      const result = yield* run(`<Let as="x" ${authored} />`);

      expect(result.output).toBe("");
      expect(result.values.x).toBe(bound);
    }
  });
});

describe("Tier LET — the source is chosen before it runs", () => {
  it("LET4: value with a child refuses, evaluating neither side", function* () {
    const count = counter();
    const result = yield* run(
      '<Let as="x" value={bump()}>\n<Counted />\n</Let>',
      { bump: count.bump },
      { Counted: markdownComponent("Counted", "counted body\n") },
    );

    expect(result.output).toContain("ERROR");
    expect(count.calls).toBe(0);
    expect(result.imports).toEqual([]);
    expect("x" in result.values).toBeFalsy();
  });

  it("LET4b: a whitespace-only child is a child", function* () {
    const count = counter();
    const result = yield* run('<Let as="x" value={bump()}>\n \n</Let>', { bump: count.bump });

    expect(result.output).toContain("ERROR");
    expect(count.calls).toBe(0);
    expect("x" in result.values).toBeFalsy();
  });

  it("LET5: select with value refuses before the value is evaluated", function* () {
    const count = counter();
    const result = yield* run('<Let as="x" select="paragraph" value={bump()} />', {
      bump: count.bump,
    });

    expect(result.output).toContain("ERROR");
    expect(count.calls).toBe(0);
    expect("x" in result.values).toBeFalsy();
  });

  it("LET6: a construct with no source refuses; whitespace children are a source", function* () {
    const selfClosing = yield* run('<Let as="x" />');
    expect(selfClosing.output).toContain("ERROR");
    expect("x" in selfClosing.values).toBeFalsy();

    const pairedEmpty = yield* run('<Let as="x"></Let>');
    expect(pairedEmpty.output).toContain("ERROR");
    expect("x" in pairedEmpty.values).toBeFalsy();

    const whitespace = yield* run('<Let as="x">\n \n</Let>');
    expect(whitespace.output).toBe("");
    expect(whitespace.values.x).toBe("");
  });

  it("LET7: every preflight refusal binds nothing and runs no value expression", function* () {
    const forms = [
      '<Let as="x" bogus="y" value={bump()} />',
      "<Let value={bump()} />",
      "<Let as={name} value={bump()} />",
      '<Let as="123bad" value={bump()} />',
      '<Let as="" value={bump()} />',
    ];

    for (const form of forms) {
      const count = counter();
      const result = yield* run(form, { bump: count.bump, name: "chosen" });

      expect(result.output).toContain("ERROR");
      expect(count.calls).toBe(0);
      expect(Object.keys(result.values)).toEqual(["bump", "name"]);
    }
  });

  it("LET7b: an unknown prop names what <Let> does accept", function* () {
    const result = yield* run('<Let as="x" bogus="y">text</Let>');
    expect(result.output).toContain('only accepts "as", "value" and "select" props');
  });
});

describe("Tier LET — failure and overwrite", () => {
  it("LET8: a failing value expression is positioned and binds nothing", function* () {
    const result = yield* run('Intro.\n\n<Let as="x" value={boom()} />', {
      boom: () => {
        throw new Error("no value here");
      },
    });

    expect(result.output).toContain('Failed to evaluate expression prop "value={boom()}"');
    expect(result.output).toContain("on <Let />");
    expect(result.output).toContain("no value here");
    expect(result.output).toContain("(3:1)");
    expect("x" in result.values).toBeFalsy();
  });

  it("LET9: last writer wins across both sources", function* () {
    const renderedLast = yield* run(
      ['<Let as="x" value={42} />', '<Let as="x">rendered</Let>'].join("\n\n"),
    );
    expect(renderedLast.values.x).toBe("rendered");

    const directLast = yield* run(
      ['<Let as="x">rendered</Let>', '<Let as="x" value={42} />'].join("\n\n"),
    );
    expect(directLast.values.x).toBe(42);
  });

  it("LET10b: a projected direct value binds where the caller's content is expanded", function* () {
    const result = yield* run(
      ["<Wrapper>", '<Let as="fromCaller" value={source} />', "</Wrapper>"].join("\n"),
      { source: { id: 7 } },
      { Wrapper: markdownComponent("Wrapper", "<Content />\n") },
    );

    expect(result.output.trim()).toBe("");
    // The component's own body owns the binding: `<Let>` writes into the
    // environment it expands in, and projection does not move that.
    expect("fromCaller" in result.values).toBeFalsy();
  });
});

describe("Tier LET — a whole document", () => {
  beforeAll(() => useTempFileCompiler());

  it("LET10: a direct binding reaches prose, an expression prop, and a later eval", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": [
        "```ts eval",
        'const settings = { title: "Release" };',
        "```",
        "",
        '<Let as="alias" value={settings} />',
        "",
        '<Let as="title" value={settings.title} />',
        "",
        "Prose reads {title}.",
        "",
        "<Note label={alias.title} />",
        "",
        "```ts eval",
        'return alias === settings ? "identical" : "different";',
        "```",
      ].join("\n"),
      "components/Note.md": [
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    label:",
        "      type: string",
        "  additionalProperties: false",
        "---",
        "",
        "Note says {props.label}.",
      ].join("\n"),
    });

    const output = asText(yield* collect(yield* execute({ path: "README.md", stream })));

    expect(output).toContain("Prose reads Release.");
    expect(output).toContain("Note says Release.");
    expect(output).toContain("identical");
  });

  it("LET11: a partial replay rebinds by reference and records nothing of its own", function* () {
    const document = [
      "```ts eval",
      "const source = { id: 7 };",
      "```",
      "",
      '<Let as="alias" value={source} />',
      "",
      "```ts eval",
      'return alias === source ? "identical" : "different";',
      "```",
    ].join("\n");

    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": document });

    const golden = asText(yield* collect(yield* execute({ path: "README.md", stream })));
    expect(golden).toContain("identical");

    const full = stream.snapshot();
    const evals = full.filter((e) => e.type === "yield" && e.description.type === "eval");
    expect(evals.length).toBe(2);

    // The crash: everything through the producing eval is on the record, and
    // the consuming eval and the root Close are not.
    const prefix = full.slice(0, full.indexOf(evals[1]));
    expect(prefix.map(kindOf)).toEqual(["import_component", "eval"]);

    const resumedStream = new InMemoryStream(prefix);
    const resumed = asText(
      yield* collect(yield* execute({ path: "README.md", stream: resumedStream })),
    );

    // The alias is the reconstructed object, not a copy of it.
    expect(resumed).toContain("identical");
    expect(resumed).not.toContain("different");

    // The producing eval, the consuming eval, the root import and the Close —
    // and nothing the `<Let>` between them wrote.
    expect(resumedStream.snapshot().map(kindOf)).toEqual([
      "import_component",
      "eval",
      "eval",
      "close",
    ]);
  });

  it("LET12: Let is the syntax; Capture is an ordinary component", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ['<Let as="bound" value={1} />', "", "<Capture />"].join("\n"),
      "components/Let.md": "A REPOSITORY FILE RAN\n",
      "components/Capture.md": "an ordinary component ran.\n",
    });

    const output = asText(yield* collect(yield* execute({ path: "README.md", stream })));

    expect(output).toContain("an ordinary component ran.");
    expect(output).not.toContain("A REPOSITORY FILE RAN");
  });
});

/**
 * One document binding one of each kind of value at its root, through both of
 * `<Let>`'s sources.
 *
 * The values are the representatives of the strict JSON boundary — nested data,
 * `null`, a value that is not a plain object, a cycle, a sparse hole, a
 * non-finite number, `undefined` and a function — because that boundary is one
 * walk shared by every producer. Which of them persists is settled once, here,
 * rather than re-asserted for each component that can bind one.
 *
 * Each value is built in the expression that binds it rather than exported by a
 * block first, and the cycle is read in prose rather than in the block: an
 * eval block serializes the values it carries, and what a cycle does to that
 * is eval's own contract rather than anything this says.
 */
const EVERY_KIND = [
  '<Let as="nested" value={{ list: [1, { deep: true }], nothing: null }} />',
  '<Let as="nothing" value={null} />',
  '<Let as="notPlain" value={new Map([["kept", 1]])} />',
  '<Let as="cycle" value={(() => { const held = { name: "self" }; held.self = held; return held; })()} />',
  '<Let as="sparse" value={(() => { const held = [1]; held[2] = 3; return held; })()} />',
  '<Let as="infinite" value={Number.POSITIVE_INFINITY} />',
  '<Let as="absent" value={undefined} />',
  '<Let as="work" value={() => 1} />',
  '<Let as="rendered">plain text</Let>',
  "",
  "Cycle {cycle.name}",
  "",
  "```ts eval",
  "return [",
  "  nested.list[1].deep,",
  "  nothing,",
  '  notPlain.get("kept"),',
  "  sparse.length,",
  "  infinite,",
  "  typeof absent,",
  "  work(),",
  "  rendered,",
  '].join("/");',
  "```",
].join("\n");

/**
 * Where the owned-handle rows' probe component reports it comes from.
 *
 * Declared on an installation, so the same producer resolves on a live run and
 * on a continuation.
 */
const COMPUTED_ORIGIN = "@executablemd/core/tests/let-computed";

/** How many times the probe producer really ran. */
interface Produced {
  calls: number;
}

/** One host component whose unvalidated return is a JSON object. */
function readingComponent(counted: Produced): ExecutionInstallation {
  return {
    components: [
      {
        name: "Reading",
        origin: COMPUTED_ORIGIN,
        props: { type: "object", properties: {}, additionalProperties: false },
        factory: () =>
          // deno-lint-ignore require-yield
          function* Reading(): Operation<Json> {
            counted.calls += 1;
            return { answer: 42 };
          },
      },
    ],
  };
}

/**
 * One host component that says it was reached and then never finishes.
 *
 * The barrier is the component itself rather than a delay: the run is held at
 * a real unfinished operation, and the row below reads the handle while it is
 * genuinely in that state instead of while a timer happens to be pending.
 */
function holdingComponent(reached: { open: () => void }): ExecutionInstallation {
  return {
    components: [
      {
        name: "Holding",
        origin: COMPUTED_ORIGIN,
        props: { type: "object", properties: {}, additionalProperties: false },
        factory: () =>
          function* Holding(): Operation<Json> {
            reached.open();
            yield* suspend();
            return null;
          },
      },
    ],
  };
}

/** One entry that captures at its root and is then held, unfinished. */
const HOLDS_AFTER_CAPTURE = [
  '<Let as="held" value={{ answer: 42 }} />',
  "",
  "<Holding />",
  "",
  "Never reached.",
  "",
].join("\n");

/** One entry that captures at its root through both sources. */
const COMPUTES_ROOT = [
  '<Let as="direct" value={{ answer: 42 }} />',
  "",
  '<Let as="paired">beta</Let>',
  "",
  '<Reading as="functionJson" />',
  "",
  "Rendered body.",
  "",
].join("\n");

/** The same captures, then an ordinary authored failure. */
const COMPUTES_THEN_FAILS = [
  '<Let as="direct" value={{ answer: 42 }} />',
  "",
  '<Reading as="functionJson" />',
  "",
  '<Fail message="stopped on purpose" />',
  "",
].join("\n");

/** One value root: its typed return is not its binding data. */
const VALUE_ROOT = [
  "---",
  "returns:",
  "  verdict: { type: string }",
  "---",
  "",
  '<Let as="noted" value={{ answer: 42 }} />',
  "",
  "```ts eval",
  'const answer = { verdict: "settled" };',
  "```",
  "",
  "<Return value={answer} />",
  "",
].join("\n");

/** The eligible root data this execution reports, or a failure naming why not. */
function* readBindings(execution: HostExecution): Operation<JsonObject> {
  const answer = yield* execution.bindings();
  if (!answer.ok) {
    throw answer.error;
  }
  return answer.value;
}
describe("Tier LET — the ordinary inventory, and which values are eligible", () => {
  beforeAll(() => useTempFileCompiler());

  it("C9: ordinary execution records the exact LET11 inventory and no binding effect", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": EVERY_KIND });

    // Every one of those values binds by reference and is usable here, and the
    // run records the import, the eval and its close. Handing computed data
    // back is not a durable effect, so a `<Let>` still adds no journal entry.
    const output = asText(yield* collect(yield* execute({ path: "README.md", stream })));
    expect(output).toContain("Cycle self");
    expect(output).toContain("true//1/3/Infinity/undefined/1/plain text");
    expect(stream.snapshot().map(kindOf)).toEqual(["import_component", "eval", "close"]);
  });

  it("C7: the eligible data is the JSON subset of the same document's root", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": EVERY_KIND });

    const execution = yield* executeInstalled({ path: "README.md", stream }, []);
    const settled = yield* execution;
    expect(settled.ok).toBe(true);

    // The live bindings are unchanged — the document read every one of them
    // above — and what crosses is decided by one strict JSON walk rather than
    // by which construct produced the value.
    const held = yield* readBindings(execution);
    expect(held["nested"]).toEqual({ list: [1, { deep: true }], nothing: null });
    expect(held["nothing"]).toBe(null);
    expect(held["rendered"]).toBe("plain text");
    // Omitted whole, never coerced: a value that is not plain JSON, a cycle, a
    // sparse hole, a non-finite number, `undefined` and a function.
    for (const omitted of ["notPlain", "cycle", "sparse", "infinite", "absent", "work"]) {
      expect(Object.hasOwn(held, omitted)).toBe(false);
    }
    // `props` is each execution's own namespace and never crosses.
    expect(Object.hasOwn(held, "props")).toBe(false);
  });
});
describe("Tier LET — the computed root data an execution hands back", () => {
  beforeAll(() => useTempFileCompiler());

  it("C1: the owner reports every actual root capture, and output and value stay separate", function* () {
    const counted: Produced = { calls: 0 };
    const stream = new InMemoryStream();
    const execution = yield* executeInstalled({ ...inlineSource(COMPUTES_ROOT), stream }, [
      readingComponent(counted),
    ]);
    const rendered = String(yield* collect(execution));
    const settled = yield* execution;
    expect(settled.ok).toBe(true);
    expect(counted.calls).toBe(1);

    // Every actual root binding, whichever construct wrote it — not a
    // whitelist of capture producers.
    expect(yield* readBindings(execution)).toEqual({
      direct: { answer: 42 },
      paired: "beta",
      functionJson: { answer: 42 },
    });

    // Three separate channels: the rendered body, the public return value and
    // the computed data. None of them is wrapped around another.
    expect(rendered).toContain("Rendered body.");
    expect(settled.ok ? settled.value : undefined).toBe(rendered);
    expect(Object.hasOwn(yield* readBindings(execution), "props")).toBe(false);

    // The journal holds the ordinary inventory and no per-binding effect.
    expect(stream.snapshot().map(kindOf)).toEqual([
      "import_component",
      "import_component",
      "close",
    ]);
  });

  it("C1: a value root's typed return is distinct from its computed data", function* () {
    const stream = new InMemoryStream();
    const execution = yield* executeInstalled({ ...inlineSource(VALUE_ROOT), stream }, []);
    const settled = yield* execution;
    expect(settled.ok).toBe(true);
    expect(settled.ok ? settled.value : undefined).toEqual({ verdict: "settled" });
    const held = yield* readBindings(execution);
    expect(held["noted"]).toEqual({ answer: 42 });
    expect(held["verdict"]).toBe(undefined);
  });

  it("C5: a halted execution's own handle refuses the root it was reading", function* () {
    const stream = new InMemoryStream();
    const arrived = withResolvers<void>();
    const reached = { open: () => arrived.resolve() };
    let retained: HostExecution | undefined;

    yield* scoped(function* () {
      const execution = yield* executeInstalled({ ...inlineSource(HOLDS_AFTER_CAPTURE), stream }, [
        holdingComponent(reached),
      ]);
      // Kept past this scope on purpose: the question is what the handle a host
      // is still holding answers once the run behind it is gone.
      retained = execution;
      yield* arrived.operation;

      // While it is unfinished the handle reads, and reads the real thing —
      // which is what makes the refusal below a refusal rather than an owner
      // that never had anything.
      expect(yield* readBindings(execution)).toEqual({ held: { answer: 42 } });
    });

    // Leaving that scope halts the execution and joins its teardown. The
    // document settled nothing, so there is no result to read and no live
    // environment left to read instead: the same handle refuses, with no map.
    if (retained === undefined) {
      throw new Error("this run never produced a handle to retain");
    }
    const after = yield* retained.bindings();
    expect(after.ok).toBe(false);
    expect(after.ok ? undefined : after.error).toBeInstanceOf(Error);
    expect(Object.hasOwn(after, "value")).toBe(false);
    // And halting it acknowledged nothing of its own.
    expect(stream.snapshot().some((event) => event.type === "close")).toBe(false);
  });

  it("C2: an ordinary failure keeps its computed data, and a cold reader finds both", function* () {
    const counted: Produced = { calls: 0 };
    const stream = new InMemoryStream();
    const execution = yield* executeInstalled({ ...inlineSource(COMPUTES_THEN_FAILS), stream }, [
      readingComponent(counted),
    ]);
    const settled = yield* execution;

    // The public outcome is the failure it was, and the live error survives.
    expect(settled.ok).toBe(false);
    expect(settled.ok ? "" : settled.error.message).toContain("stopped on purpose");
    // And the data computed before the failure is still the execution's own.
    const answered = yield* readBindings(execution);
    expect(answered).toEqual({
      direct: { answer: 42 },
      functionJson: { answer: 42 },
    });
    expect(counted.calls).toBe(1);

    // C4: the answer is the reader's own graph. Writing through it is allowed
    // and reaches nothing: the accepted result is what the execution decided,
    // and a consumer editing its copy cannot edit that.
    const nested = answered["direct"];
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error("this control needs a nested object to write through");
    }
    nested["answer"] = 999;
    expect(yield* readBindings(execution)).toEqual({
      direct: { answer: 42 },
      functionJson: { answer: 42 },
    });
    expect(counted.calls).toBe(1);

    const records = stream.snapshot();
    // Three imports — the root, the producer and `<Fail>` itself — and one
    // ordinary close. Handing the byproduct back adds no effect of its own.
    expect(records.map(kindOf)).toEqual([
      "import_component",
      "import_component",
      "import_component",
      "close",
    ]);

    // Cold: a fresh owner over the same retained bytes reads the recorded
    // result's data, runs no producer and appends nothing.
    const cold: Produced = { calls: 0 };
    const reread = new InMemoryStream(records);
    const reopened = yield* executeInstalled(
      { ...inlineSource(COMPUTES_THEN_FAILS), stream: reread },
      [readingComponent(cold)],
    );
    const again = yield* reopened;
    expect(again.ok).toBe(false);
    expect(yield* readBindings(reopened)).toEqual({
      direct: { answer: 42 },
      functionJson: { answer: 42 },
    });
    expect(cold.calls).toBe(0);
    expect(reread.snapshot().length).toBe(records.length);
    // Neither the bytes the mutation was made against nor a separate execution
    // over them moved: the same records, and the same accepted data.
    expect(stream.snapshot()).toEqual(records);
  });
});
