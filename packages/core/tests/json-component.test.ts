/**
 * Tier JSON — `<Json>` (spec §6.12).
 *
 * Two halves. The first is what the text looks like and what parses back out
 * of it, driven through real expansion of authored source. The second is what
 * a document cannot safely say: the operands there are hostile on purpose — a
 * getter that counts its own reads, a `toJSON` that throws, a cycle, a
 * `bigint` — and Markdown has no way to write them without an eval block that
 * would teach the wrong thing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, writeTextFile } from "@effectionx/fs";
import { useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { registerComponents } from "../src/components/registration.ts";
import { CORE_REGISTRY } from "../src/components/registry.ts";
import type {
  ComponentFailure,
  ErrorSegment,
  EvalEnv,
  FunctionComponentDefinition,
  Json,
} from "../src/types.ts";

/**
 * Core's own registered `<Json>`, taken from the registry rather than from the
 * module — so what these cases drive is the definition a document resolves,
 * captured operand and all.
 */
function coreJson(): FunctionComponentDefinition {
  const entry = CORE_REGISTRY.get("Json")?.default?.definition;
  if (entry === undefined || entry.kind !== "function") {
    throw new Error("core supplies no <Json> definition");
  }
  return entry;
}

interface Run {
  output: string;
  observed: ErrorSegment[];
  /** Every failure offered to the `handleFailure` chain, from outside the run. */
  offered: ComponentFailure[];
}

/** Expand `source` with core's `<Json>` resolvable and `values` in scope. */
function run(source: string, values: Record<string, unknown> = {}): Operation<Run> {
  return scoped(function* () {
    const observed: ErrorSegment[] = [];
    const offered: ComponentFailure[] = [];
    yield* Component.around({
      *raise([segment], next) {
        observed.push(segment);
        return yield* next(segment);
      },
      *handleFailure([failure], next) {
        offered.push(failure);
        return yield* next(failure);
      },
    });
    const env: EvalEnv = { values };
    yield* Component.around({ env: () => env }, { at: "min" });
    const definition = coreJson();
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          if (name !== "Json") {
            throw new Error(`Cannot resolve component: ${name}`);
          }
          return definition;
        },
      },
      { at: "min" },
    );
    const origin = { path: "doc.md", baseOffset: 0, baseLine: 1 };
    const segments = yield* expandSegments(scanSegments(source, origin), {}, {}, new Set());
    return { output: renderSegments(segments), observed, offered };
  });
}

/** Everything a run reported, as one string. */
function reported(result: Run): string {
  return result.observed.map((segment) => segment.message).join("\n");
}

/** Whether `target` is reachable from `error` by identity. */
function reaches(error: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (error === target) {
    return true;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some((e) => reaches(e, target, seen))) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined
    ? reaches(error.cause, target, seen)
    : false;
}

describe("Tier JSON — what the text says", () => {
  it("J1: an object renders two-space JSON that parses back to it", function* () {
    const source = { name: "widget", version: 2, tags: ["a", "b"] };
    const result = yield* run("<Json value={source} />\n", { source });

    expect(result.output.trim()).toBe(
      [
        "{",
        '  "name": "widget",',
        '  "version": 2,',
        '  "tags": [',
        '    "a",',
        '    "b"',
        "  ]",
        "}",
      ].join("\n"),
    );
    // Valid JSON, and the same value: layout is pinned above, meaning here.
    expect(JSON.parse(result.output)).toEqual(source);
  });

  it("J1: nesting indents one level deeper each time", function* () {
    const source = { matrix: [[1, 2]], meta: { deep: { ok: true } } };
    const result = yield* run("<Json value={source} />\n", { source });

    expect(result.output.trim()).toBe(
      [
        "{",
        '  "matrix": [',
        "    [",
        "      1,",
        "      2",
        "    ]",
        "  ],",
        '  "meta": {',
        '    "deep": {',
        '      "ok": true',
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("J1: arrays and scalars use their native JSON text", function* () {
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ["list", ["alpha", "beta"], '[\n  "alpha",\n  "beta"\n]'],
      ["text", "widget", '"widget"'],
      ["count", 42, "42"],
      ["flag", true, "true"],
      ["nothing", null, "null"],
    ];
    for (const [name, value, expected] of cases) {
      const result = yield* run(`<Json value={${name}} />\n`, { [name]: value });
      expect(result.observed).toEqual([]);
      expect(result.output.trim()).toBe(expected);
    }
  });

  it("J2: container members follow native JSON rules", function* () {
    const source = {
      kept: 1,
      dropped: undefined,
      run: () => {},
      tag: Symbol("tag"),
      huge: Infinity,
      unknown: NaN,
      list: [undefined, () => {}, Infinity],
    };
    const result = yield* run("<Json value={source} />\n", { source });

    // Omitted in an object, `null` in an array — `JSON.stringify`'s rules, not
    // this component's, and not normalized on the way through.
    expect(result.output.trim()).toBe(
      [
        "{",
        '  "kept": 1,',
        '  "huge": null,',
        '  "unknown": null,',
        '  "list": [',
        "    null,",
        "    null,",
        "    null",
        "  ]",
        "}",
      ].join("\n"),
    );
  });

  it("J3: the text lands in place, with nothing added around it", function* () {
    const result = yield* run("before<Json value={source} />after\n", { source: { ok: true } });

    expect(result.output).toContain('before{\n  "ok": true\n}after');
  });

  it("J4: ordinary interpolation still coerces rather than serializing", function* () {
    const source = { name: "widget" };
    const result = yield* run("<Json value={source} />|{source}\n", { source });

    const [rendered = "", interpolated = ""] = result.output.trim().split("|");
    expect(rendered).toBe('{\n  "name": "widget"\n}');
    // Unchanged: choosing JSON is something the document says out loud.
    expect(interpolated).toBe("[object Object]");
  });
});

describe("Tier JSON — the operand arrives live", () => {
  it("J4/J6: evaluates the expression once and serializes that exact object", function* () {
    const reads: unknown[] = [];
    const marker = {
      get id() {
        reads.push(this);
        return 7;
      },
    };
    let evaluated = 0;
    const result = yield* run("<Json value={give()} />\n", {
      give: () => {
        evaluated += 1;
        return marker;
      },
    });

    expect(result.output).toContain('{\n  "id": 7\n}');
    expect(evaluated).toBe(1);
    // `this` inside the getter is the very object the document named. A clone,
    // a JSON projection, or a second read would each show up here.
    expect(reads).toEqual([marker]);
  });

  it("J4: the source object and array survive rendering unchanged", function* () {
    const object: Record<string, unknown> = { name: "widget", nested: { depth: 1 } };
    const array: unknown[] = [1, [2]];
    const values = { object, array };
    const result = yield* run("<Json value={object} /><Json value={array} />\n", values);

    expect(result.observed).toEqual([]);
    // The very containers, still their own contents, still writable.
    expect(values.object).toBe(object);
    expect(values.array).toBe(array);
    expect(object).toEqual({ name: "widget", nested: { depth: 1 } });
    expect(array).toEqual([1, [2]]);
    expect(Object.isFrozen(object)).toBe(false);
    expect(Object.isFrozen(array)).toBe(false);
    expect(Object.isExtensible(object)).toBe(true);
    expect(Object.isExtensible(array)).toBe(true);
    expect(result.output).toContain('"name": "widget"');
  });

  it("J6: a successful toJSON hook runs exactly once", function* () {
    let hooks = 0;
    const value = {
      toJSON() {
        hooks += 1;
        return { converted: true };
      },
    };
    const result = yield* run("<Json value={value} />\n", { value });

    expect(result.output).toContain('"converted": true');
    expect(hooks).toBe(1);
  });
});

describe("Tier JSON — the invocation shape is decided first", () => {
  /** A `value` expression that fails the test if anything evaluates it. */
  function tripwire(): { values: Record<string, unknown>; evaluated: () => number } {
    let evaluated = 0;
    return {
      values: {
        detonate: () => {
          evaluated += 1;
          throw new Error("the value expression must not run");
        },
      },
      evaluated: () => evaluated,
    };
  }

  it("J5: a literal `as` is refused, binds nothing, and never evaluates `value`", function* () {
    const wire = tripwire();
    const env = { ...wire.values };
    const result = yield* run('<Json as="captured" value={detonate()} />\n', env);

    expect(reported(result)).toContain("binds nothing");
    expect(wire.evaluated()).toBe(0);
    expect("captured" in env).toBe(false);
  });

  it("J5: paired content is refused before `value` evaluates", function* () {
    const wire = tripwire();
    const result = yield* run("<Json value={detonate()}>text</Json>\n", wire.values);

    expect(reported(result)).toContain("not content");
    expect(wire.evaluated()).toBe(0);
  });

  it("J5: whitespace content is still content", function* () {
    const wire = tripwire();
    const result = yield* run("<Json value={detonate()}> </Json>\n", wire.values);

    expect(reported(result)).toContain("not content");
    expect(wire.evaluated()).toBe(0);
  });

  it("J5: a missing `value` is refused by name", function* () {
    const result = yield* run("<Json />\n");

    expect(reported(result)).toContain("requires a `value` prop");
  });

  it("J5: an unknown prop is still the engine's own refusal", function* () {
    const result = yield* run('<Json value={1} indent="4" />\n');

    expect(reported(result)).toContain("Prop validation failed for <Json />");
    expect(reported(result)).toContain("indent");
  });
});

describe("Tier JSON — the two ways serialization fails", () => {
  const NO_TEXT = "produced no JSON text";
  const THREW = "serialization of this value failed";

  it("J7: root undefined, a function and a symbol produce no JSON text", function* () {
    for (const [source, values] of [
      ["<Json value={nothing} />\n", { nothing: undefined }],
      ["<Json value={fn} />\n", { fn: () => {} }],
      ["<Json value={sym} />\n", { sym: Symbol("tag") }],
    ] as const) {
      const result = yield* run(source, values);
      expect(reported(result)).toContain(NO_TEXT);
      expect(reported(result)).not.toContain(THREW);
      expect(result.output).not.toContain("{");
    }
  });

  it("J7: the authored `value={undefined}` fails as no JSON text, not as null", function* () {
    const result = yield* run("before<Json value={undefined} />after\n");

    expect(reported(result)).toContain(NO_TEXT);
    expect(reported(result)).not.toContain(THREW);
    // The regression this guards: the scanner can read `undefined` as a JSON
    // literal, and reading it produces `null`. Rendering "null" here would mean
    // the operand reached the component as its JSON projection.
    expect(result.output).not.toContain("null");
    // The authored bytes on either side are untouched by the failure.
    expect(result.output).toContain("before");
    expect(result.output).toContain("after");
  });

  it("J7: an authored `value={null}` still renders null", function* () {
    const result = yield* run("<Json value={null} />\n");

    // The pair matters: `undefined` and `null` are different operands, and
    // before the authored expression reached the component they were not.
    expect(result.observed).toEqual([]);
    expect(result.output).toContain("null");
  });

  it("J7: a bigint and a cycle fail as serialization that threw", function* () {
    const cycle: Record<string, unknown> = { name: "loop" };
    cycle.self = cycle;
    for (const [source, values] of [
      ["<Json value={big} />\n", { big: 1n }],
      ["<Json value={cycle} />\n", { cycle }],
    ] as const) {
      const result = yield* run(source, values);
      expect(reported(result)).toContain(THREW);
      expect(reported(result)).not.toContain(NO_TEXT);
    }
  });

  it("J7: a throwing getter keeps its exact cause, its position, and emits no partial JSON", function* () {
    const boom = new Error("the getter refused");
    let reads = 0;
    const value = {
      visible: "VISIBLE",
      get broken(): never {
        reads += 1;
        throw boom;
      },
    };
    const result = yield* run("intro\n\n<Json value={value} />\n", { value });

    expect(reported(result)).toContain(THREW);
    // Serialization got as far as the first property and none of it survived.
    expect(result.output).toContain("intro");
    expect(result.output).not.toContain("VISIBLE");
    // Asked once. A diagnostic that re-serialized to describe the failure would
    // run the document's own getter a second time.
    expect(reads).toBe(1);

    expect(result.offered.length).toBe(1);
    const failure = result.offered[0]!;
    expect(failure.name).toBe("Json");
    expect(failure.position?.path).toBe("doc.md");
    expect(failure.position?.line).toBe(3);
    expect(reaches(failure.error, boom)).toBe(true);
  });

  it("J7: a throwing toJSON keeps its exact cause and runs once", function* () {
    const boom = new Error("the hook refused");
    let hooks = 0;
    const value = {
      toJSON(): never {
        hooks += 1;
        throw boom;
      },
    };
    const result = yield* run("<Json value={value} />\n", { value });

    expect(reported(result)).toContain(THREW);
    expect(hooks).toBe(1);
    expect(result.offered.length).toBe(1);
    expect(reaches(result.offered[0]!.error, boom)).toBe(true);
  });

  it("J5/J7: an operand expression that throws stays a captured-expression failure", function* () {
    const boom = new Error("the expression refused");
    const result = yield* run("<Json value={detonate()} />\n", {
      detonate: () => {
        throw boom;
      },
    });

    // The value never existed, so neither serialization sentence applies.
    expect(reported(result)).not.toContain(NO_TEXT);
    expect(reported(result)).not.toContain(THREW);
    expect(reported(result)).toContain("value={detonate()}");
    expect(reaches(result.offered[0]?.error, boom)).toBe(true);
  });
});

/** A directory for one test's files, removed when the test scope closes. */
function useFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "json-component-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(yield* until(realpath(dir)));
  });
}

describe("Tier JSON — durability", () => {
  /**
   * A registered source for the hostile value, because `<Json>` binds nothing
   * and a document cannot write a counting hook without an eval block. Its
   * return binds by reference, so what reaches `<Json>` is this exact object.
   */
  function source(value: unknown) {
    return {
      name: "Source",
      origin: "json-component-test",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        return value;
      },
    };
  }

  function runOn(dir: string, stream: InMemoryStream, value: unknown): Operation<Json> {
    return scoped(function* () {
      yield* useHostFiles();
      yield* registerComponents([source(value)]);
      return yield* collect(yield* execute({ path: join(dir, "doc.md"), stream }));
    });
  }

  /** The journal without the root's close, so the next run continues live. */
  function* partial(stream: InMemoryStream): Operation<InMemoryStream> {
    const events = yield* stream.readAll();
    return new InMemoryStream(
      events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
    );
  }

  function* descriptions(stream: InMemoryStream): Operation<string[]> {
    const events = yield* stream.readAll();
    const types: string[] = [];
    for (const event of events) {
      if (event.type === "yield") {
        types.push(String(event.description.type));
      }
    }
    return types;
  }

  it("J9: no JSON effect is journaled, partial replay re-serializes, completed replay does not", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(dir + "/doc.md", '<Source as="payload" />\n\n<Json value={payload} />\n');

    let hooks = 0;
    const value = {
      toJSON() {
        hooks += 1;
        return { hooks };
      },
    };

    const live = new InMemoryStream();
    const first = String(yield* runOn(dir, live, value));
    expect(first).toContain('"hooks": 1');
    expect(hooks).toBe(1);

    // Every durable record belongs to something that already existed. Component
    // resolution is the ordinary import it has always been, and nothing here
    // describes serialization.
    const types = yield* descriptions(live);
    expect(types).toContain("import_component");
    expect(types.filter((type) => /json|serial|stringify/i.test(type))).toEqual([]);

    // A partial journal reaches the component again and serializes the value
    // this execution reconstructed.
    const resumed = yield* partial(live);
    const second = String(yield* runOn(dir, resumed, value));
    expect(hooks).toBe(2);
    expect(second).toContain('"hooks": 2');
    expect(yield* descriptions(resumed)).toEqual(types);

    // A completed root is reused whole: neither the component nor its hook runs.
    const again = String(yield* runOn(dir, live, value));
    expect(again).toBe(first);
    expect(hooks).toBe(2);
  });
});
