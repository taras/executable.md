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
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { asText } from "./helpers.ts";
import type { ComponentDefinition, EvalEnv, Segment } from "../src/types.ts";

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

  it("LET3: a present value binds an own name, and undefined is one of them", function* () {
    // `void 0` is the authored form that reaches expansion as `undefined`: the
    // scanner resolves a bare `{undefined}` to JSON null before any component
    // sees it, so the expression is what carries the value through.
    const result = yield* run(
      ['<Let as="absent" value={void 0} />', '<Let as="empty">text</Let>'].join("\n\n"),
    );

    expect("absent" in result.values).toBeTruthy();
    expect(result.values.absent).toBe(undefined);
    expect("neverBound" in result.values).toBeFalsy();
  });

  it("LET3b: a scanner-resolved value={undefined} is still the direct source", function* () {
    const result = yield* run('<Let as="present" value={undefined} />');

    expect("present" in result.values).toBeTruthy();
    expect(result.output).toBe("");
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
