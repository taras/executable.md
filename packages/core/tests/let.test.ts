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
import { Err, scoped } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { execute, executeInstalled } from "../src/execute.ts";
import { inlineSource } from "../src/root-source.ts";
import { parseRootBindingPublication } from "../src/root-binding-publications.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { asText } from "./helpers.ts";
import type { ComponentDefinition, EvalEnv, Segment } from "../src/types.ts";
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

describe("Tier LET — root captures an execution retains, and one that retains none", () => {
  beforeAll(() => useTempFileCompiler());

  it("P9: ordinary execute() keeps the exact LET11 inventory", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": EVERY_KIND });

    // Every one of those values binds by reference and is usable here, and the
    // run records the import, the two evals and its close — a `<Let>` adds no
    // journal entry of its own to an execution that retains no root captures.
    const output = asText(yield* collect(yield* execute({ path: "README.md", stream })));
    expect(output).toContain("Cycle self");
    expect(output).toContain("true//1/3/Infinity/undefined/1/plain text");
    expect(stream.snapshot().map(kindOf)).toEqual(["import_component", "eval", "close"]);
  });

  it("P9: the same document under retention publishes only the JSON values", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": EVERY_KIND });

    const execution = yield* executeInstalled({ path: "README.md", stream }, [], {
      rootBindingPublications: "json-v1",
    });
    const output = asText(yield* collect(execution));

    // Nothing about the entry changes: the live bindings are the exact values
    // the expressions produced, including the ones no journal can hold.
    expect(output).toContain("Cycle self");
    expect(output).toContain("true//1/3/Infinity/undefined/1/plain text");

    // One outcome per successful capture, in authored order — and the kind each
    // one is follows the strict JSON walk rather than the producer that bound it.
    const published = stream
      .snapshot()
      .filter((event) => event.type === "yield" && event.description.type === "root_binding")
      .map((event) => {
        const parsed = parseRootBindingPublication(event);
        if (!parsed.ok) {
          throw parsed.error;
        }
        return [parsed.value.binding, parsed.value.publication.kind];
      });
    expect(published).toEqual([
      ["nested", "json"],
      ["nothing", "json"],
      ["notPlain", "entry-local"],
      ["cycle", "entry-local"],
      ["sparse", "entry-local"],
      ["infinite", "entry-local"],
      ["absent", "entry-local"],
      ["work", "entry-local"],
      ["rendered", "json"],
    ]);
  });

  it("P9: a retention this version does not know refuses before anything installs", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": '<Let as="bound" value={1} />\n' });

    let raised: Error | undefined;
    try {
      // Read rather than written: a host's initialization is data it holds, and
      // a version this build does not know is exactly what arrives that way.
      yield* executeInstalled(
        { path: "README.md", stream },
        [],
        JSON.parse('{"rootBindingPublications":"json-v2"}'),
      );
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }

    expect(raised?.message).toContain("json-v1");
    // Nothing ran: no installation, no document, and no record at all.
    expect(stream.snapshot()).toEqual([]);
  });
});

/**
 * Where this suite's own probe component reports it comes from.
 *
 * Declared on an installation, so the counted suffix resolves the same way on
 * the live run and on the continuation.
 */
const SUFFIX_ORIGIN = "@executablemd/core/tests/let";

/** How many times the counted suffix component really ran. */
interface Suffix {
  calls: number;
}

/** One host component the continuation rows count the suffix with. */
function suffixComponent(counted: Suffix): ExecutionInstallation {
  return {
    components: [
      {
        name: "After",
        origin: SUFFIX_ORIGIN,
        props: { type: "object", properties: {}, additionalProperties: false },
        factory: () =>
          // deno-lint-ignore require-yield
          function* After(): Operation<Json> {
            counted.calls += 1;
            return "suffix";
          },
      },
    ],
  };
}

/** One root capture, then work no record describes until the run reaches it. */
const CAPTURE_THEN_SUFFIX = ['<Let as="saved" value="alpha" />', "", "<After />", ""].join("\n");

/** The retained events through the first root publication, and nothing after. */
function throughPublication(records: readonly DurableEvent[]): DurableEvent[] {
  const at = records.findIndex(
    (event) => event.type === "yield" && event.description.type === "root_binding",
  );
  if (at === -1) {
    throw new Error("this history retained no root publication to continue from");
  }
  return records.slice(0, at + 1);
}

/** The same prefix with its publication's retained record replaced. */
function withRecord(prefix: readonly DurableEvent[], value: Json): DurableEvent[] {
  return prefix.map((event) =>
    event.type === "yield" && event.description.type === "root_binding"
      ? { ...event, result: { status: "ok", value } }
      : event,
  );
}

/** The same events with each root admission's retained publication mode removed. */
function unmarked(records: readonly DurableEvent[]): DurableEvent[] {
  return records.map((event) => {
    if (event.type !== "yield" || event.description.type !== "import_component") {
      return event;
    }
    const { [PUBLICATIONS_FIELD]: _mode, ...rest } = event.description;
    return { ...event, description: { ...rest } };
  });
}

/** Where a root admission retains the publication mode. */
const PUBLICATIONS_FIELD = "executablemd.root-binding-publications";

/** What one continuation settled to, and what it did on the way. */
interface Continued {
  readonly outcome: Result<Json>;
  readonly appended: string[];
  readonly calls: number;
}

/**
 * Continue `prefix` with the identical source and retention, and report what
 * the run settled to, what it appended and whether the suffix ran.
 */
function* continuing(
  prefix: readonly DurableEvent[],
  initialization: unknown,
): Operation<Continued> {
  const counted: Suffix = { calls: 0 };
  const stream = new InMemoryStream([...prefix]);
  let outcome: Result<Json>;
  try {
    outcome = yield* yield* executeInstalled(
      { ...inlineSource(CAPTURE_THEN_SUFFIX), stream },
      [suffixComponent(counted)],
      // Read rather than written, so a row can state a retention this build
      // does know and one it does not through the same boundary.
      initialization === undefined ? undefined : JSON.parse(JSON.stringify(initialization)),
    );
  } catch (error) {
    outcome = Err(error instanceof Error ? error : new Error(String(error)));
  }
  return {
    outcome,
    appended: stream
      .snapshot()
      .slice(prefix.length)
      .map((event) => (event.type === "yield" ? event.description.type : event.type)),
    calls: counted.calls,
  };
}

describe("Tier LET — the retained publications a continuation will not read", () => {
  beforeAll(() => useTempFileCompiler());

  it("P9: a retained publication this version cannot read refuses the continuation", function* () {
    const counted: Suffix = { calls: 0 };
    const original = new InMemoryStream();
    const live = yield* yield* executeInstalled(
      { ...inlineSource(CAPTURE_THEN_SUFFIX), stream: original },
      [suffixComponent(counted)],
      { rootBindingPublications: "json-v1" },
    );
    expect(live.ok).toBe(true);
    expect(counted.calls).toBe(1);

    const prefix = throughPublication(original.snapshot());
    expect(prefix.length).toBe(2);

    // The control: the same prefix, its retained record untouched, continues
    // and performs exactly the suffix no record describes. Without this the
    // refusal below would be a refusal of nothing.
    const sound = yield* continuing(prefix, { rootBindingPublications: "json-v1" });
    expect(sound.outcome.ok).toBe(true);
    expect(sound.calls).toBe(1);
    expect(sound.appended).toEqual(["import_component", "close"]);

    // The P9 malformed-version representative, on the core continuation path:
    // a version nobody wrote, under an admission whose mode agrees.
    const malformed = yield* continuing(
      withRecord(prefix, {
        version: 2,
        binding: "saved",
        publication: { kind: "json", value: "alpha" },
      }),
      { rootBindingPublications: "json-v1" },
    );

    // Refused before the binding and before any later work: the suffix never
    // ran, and nothing — no publication, no component, no completion — was
    // appended to a history this version cannot read.
    expect(malformed.outcome.ok).toBe(false);
    expect(malformed.outcome.ok ? "" : malformed.outcome.error.message).toContain(
      "cannot be read by this version",
    );
    expect(malformed.calls).toBe(0);
    expect(malformed.appended).toEqual([]);
  });

  it("P9: a retained record whose binding is not the one it replayed under refuses", function* () {
    const counted: Suffix = { calls: 0 };
    const original = new InMemoryStream();
    yield* yield* executeInstalled(
      { ...inlineSource(CAPTURE_THEN_SUFFIX), stream: original },
      [suffixComponent(counted)],
      { rootBindingPublications: "json-v1" },
    );
    const prefix = throughPublication(original.snapshot());

    // Well formed in itself, and not this effect's: the name the journal
    // matched by says `saved`, and the record inside it says another name.
    const disagreeing = yield* continuing(
      withRecord(prefix, {
        version: 1,
        binding: "elsewhere",
        publication: { kind: "json", value: "alpha" },
      }),
      { rootBindingPublications: "json-v1" },
    );

    expect(disagreeing.outcome.ok).toBe(false);
    expect(disagreeing.calls).toBe(0);
    expect(disagreeing.appended).toEqual([]);
  });

  it("P9: a retained retention this run does not share refuses at owned admission", function* () {
    const counted: Suffix = { calls: 0 };
    const original = new InMemoryStream();
    const live = yield* yield* executeInstalled(
      { ...inlineSource(CAPTURE_THEN_SUFFIX), stream: original },
      [suffixComponent(counted)],
      { rootBindingPublications: "json-v1" },
    );
    expect(live.ok).toBe(true);
    // The whole history, terminal and all: the boundary this guards is the one
    // where a recorded completion would otherwise be reused.
    const whole = original.snapshot();
    expect(whole.some((event) => event.type === "close")).toBe(true);

    // A marked history, invoked by a run that retains nothing. Core's own
    // admission decides this, inside the read every later phase depends on, so
    // nothing is reused and nothing runs.
    const ordinary = yield* continuing(whole, undefined);
    expect(ordinary.outcome.ok).toBe(false);
    expect(ordinary.outcome.ok ? "" : ordinary.outcome.error.message).toContain(
      "retains its root bindings differently",
    );
    expect(ordinary.calls).toBe(0);
    expect(ordinary.appended).toEqual([]);

    // And the other direction: an unmarked history invoked by a run that does
    // retain. The disagreement is refused whichever side states the mode.
    const reversed = yield* continuing(unmarked(whole), {
      rootBindingPublications: "json-v1",
    });
    expect(reversed.outcome.ok).toBe(false);
    expect(reversed.outcome.ok ? "" : reversed.outcome.error.message).toContain(
      "retains its root bindings differently",
    );
    expect(reversed.calls).toBe(0);
    expect(reversed.appended).toEqual([]);

    // The control: that same whole history, invoked under the retention it
    // records, reuses its recorded completion and runs nothing again.
    const agreeing = yield* continuing(whole, { rootBindingPublications: "json-v1" });
    expect(agreeing.outcome.ok).toBe(true);
    expect(agreeing.calls).toBe(0);
    expect(agreeing.appended).toEqual([]);
  });
});
