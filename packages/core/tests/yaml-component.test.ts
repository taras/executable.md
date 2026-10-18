/**
 * Tier YAML — `<Yaml>` (spec §6.12).
 *
 * Two halves, for the same reason `<Json>`'s cases have two. The first is what
 * the text says and what parses back out of it, driven through real expansion
 * of authored source against the real engine. The second is what a document
 * cannot safely write: the operands there are hostile on purpose — a cycle, a
 * `toJSON` that throws, a getter that counts its own reads — and Markdown has
 * no way to express them without teaching the wrong thing.
 *
 * What is deliberately checked side by side is that `<Json>` and `<Yaml>`
 * describe *one* value. Both render the same binding, both are parsed back, and
 * the two readings are compared with the binding itself — so a formatting
 * choice that changed a type would fail here rather than in whatever read the
 * YAML later.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, ensure, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, writeTextFile } from "@effectionx/fs";
import { useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";

import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { registerComponents } from "../src/components/registration.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { createValueQuery } from "../src/value-query.ts";
import type { ComponentRegistration } from "../src/components/registration.ts";

/** A directory for one case's document, removed when the case ends. */
function* useFixture(): Operation<string> {
  const made = yield* until(mkdtemp(join(tmpdir(), "yaml-component-")));
  yield* ensure(() => rm(made, { recursive: true, force: true }));
  return yield* until(realpath(made));
}

/**
 * A registered source for an operand a document cannot write.
 *
 * Its return binds by reference, so what reaches `<Yaml>` is this exact object
 * — which is what makes a cycle, a hook and a getter reachable at all.
 */
function source(value: unknown): ComponentRegistration {
  return {
    name: "Source",
    origin: "yaml-component-test",
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<unknown> {
      return value;
    },
  };
}

/** Run `source` as a document, with `extra` registered. */
function run(body: string, extra: readonly ComponentRegistration[] = []): Operation<Result<Json>> {
  return scoped(function* () {
    const root = yield* useFixture();
    yield* useHostFiles();
    if (extra.length > 0) {
      yield* registerComponents([...extra]);
    }
    yield* writeTextFile(join(root, "doc.md"), body);
    try {
      return Ok(
        yield* collect(
          yield* execute({ path: join(root, "doc.md"), stream: new InMemoryStream() }),
        ),
      );
    } catch (error) {
      return Err(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** The rendered text of a successful run. */
function text(outcome: Result<Json>): string {
  if (!outcome.ok) {
    throw outcome.error;
  }
  return String(outcome.value);
}

/**
 * What one refused invocation said.
 *
 * `<Yaml>` declares `printErrors`, like `<Json>`: a malformed invocation is a
 * printed error in the document rather than a failed run, which is what keeps
 * one bad element from taking the rest of the page with it. So what a case
 * reads is the text the document ended up with — and a run that genuinely
 * failed is reported as that instead.
 */
function reason(outcome: Result<Json>): string {
  return outcome.ok ? String(outcome.value) : outcome.error.message;
}

/** Parse YAML back, through the same engine the component rendered it with. */
function* fromYaml(yaml: string): Operation<Json> {
  const owner = createValueQuery();
  try {
    return yield* owner.select("from_yaml", yaml);
  } finally {
    owner.close();
  }
}

/**
 * E9's representative value.
 *
 * One value rather than a schema suite: nested structure, the two scalars whose
 * YAML spelling decides their type, a number, a string that reads as a number,
 * and a multiline string whose whole point is that it survives.
 */
const REPRESENTATIVE = {
  name: "widget",
  count: 2,
  ready: false,
  missing: null,
  version: "1.20",
  truthy: "false",
  tags: ["a", "b"],
  nested: { deep: { ok: true }, list: [1, [2]] },
  note: "first\nsecond",
};

describe("Tier YAML — what the text says", () => {
  beforeAll(() => useTempFileCompiler());

  it("Y1: Json and Yaml describe one value, and both parse back to it", function* () {
    const outcome = yield* run(
      [
        '<Source as="payload" />',
        "",
        '<Json value={payload} as="json" />',
        '<Yaml value={payload} as="yaml" />',
        "",
        "<Output>",
        "{json}",
        "--",
        "{yaml}",
        "</Output>",
        "",
      ].join("\n"),
      [source(REPRESENTATIVE)],
    );

    const rendered = text(outcome);
    const [json, yaml] = rendered.split("\n--\n");
    expect(json).toBeDefined();
    expect(yaml).toBeDefined();
    // The same value from both readings, and the same as the binding: a
    // formatting choice that changed a type fails here.
    expect(JSON.parse(String(json))).toEqual(REPRESENTATIVE);
    expect(yield* fromYaml(String(yaml).trimStart())).toEqual(REPRESENTATIVE);
  });

  it("Y1: Json's exact text is unchanged", function* () {
    const outcome = yield* run('<Source as="payload" />\n\n<Json value={payload} />\n', [
      source({ name: "widget", version: 2, tags: ["a", "b"] }),
    ]);

    // The layout `<Json>` has always had, restated here because this change
    // moved the one serialization call both components share.
    expect(text(outcome).trim()).toBe(
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
  });

  it("Y1: Yaml is a complete document: two-space, no separators, one final LF", function* () {
    const outcome = yield* run(
      '<Source as="payload" />\n\n<Yaml value={payload} as="yaml" />\n\n{yaml}',
      [source({ name: "widget", tags: ["a", "b"], nested: { deep: true } })],
    );

    const rendered = text(outcome);
    const yaml = rendered.slice(rendered.indexOf("name:"));
    expect(yaml).toBe(
      ["name: widget", "tags:", "  - a", "  - b", "nested:", "  deep: true", ""].join("\n"),
    );
    // The vendor's own terminating newline, and exactly one of it: nothing
    // appends a separator or a second line.
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml.endsWith("\n\n")).toBe(false);
    expect(yaml).not.toContain("---");
  });

  it("Y1: a scalar whose type depends on quoting keeps it", function* () {
    const outcome = yield* run(
      '<Source as="payload" />\n\n<Yaml value={payload} as="yaml" />\n\n{yaml}',
      [source({ truthy: "false", version: "1.20", note: "a\nb" })],
    );

    const rendered = text(outcome);
    const yaml = rendered.slice(rendered.indexOf("truthy:"));
    // Quoted where the type depends on it, and a block scalar for the
    // multiline string — which is what makes the parse-back above exact.
    expect(yaml).toContain('truthy: "false"');
    expect(yaml).toContain('version: "1.20"');
    expect(yield* fromYaml(yaml)).toEqual({ truthy: "false", version: "1.20", note: "a\nb" });
  });

  it("Y1: rendering twice does not change the binding", function* () {
    const payload = { name: "widget", tags: ["a"] };
    const outcome = yield* run(
      [
        '<Source as="payload" />',
        "",
        '<Yaml value={payload} as="first" />',
        "",
        '<Yaml value={payload} as="second" />',
        "",
        "<Output>",
        "{first}--{second}",
        "</Output>",
        "",
      ].join("\n"),
      [source(payload)],
    );

    const [first, second] = text(outcome).split("--");
    expect(String(first).trim().length).toBeGreaterThan(0);
    // The same text both times, from the same value: nothing the first
    // rendering did changed what the second one described. Compared on the
    // document's own surrounding whitespace rather than through it, because
    // what is being asked about is the two renderings.
    expect(String(second).trim()).toBe(String(first).trim());
    expect(payload).toEqual({ name: "widget", tags: ["a"] });
  });
});

describe("Tier YAML — an invocation it cannot render", () => {
  beforeAll(() => useTempFileCompiler());

  it("Y2: a missing value fails, and names the prop", function* () {
    expect(reason(yield* run("<Yaml />\n"))).toContain("requires a `value` prop");
  });

  it("Y2: paired content fails, and says what it renders instead", function* () {
    expect(reason(yield* run("<Yaml>text</Yaml>\n"))).toContain("not content");
  });

  it("Y2: an unknown prop fails against its own closed schema", function* () {
    expect(reason(yield* run("<Yaml value={1} indent={4} />\n"))).toContain("indent");
  });

  it("Y2: an invalid as fails before anything renders", function* () {
    expect(reason(yield* run('<Yaml value={1} as="not a name" />\n'))).toContain('"as"');
  });

  it("Y2: an undefined operand has no JSON text at all", function* () {
    const outcome = yield* run('<Source as="payload" />\n\n<Yaml value={payload} />\n', [
      source(undefined),
    ]);
    expect(reason(outcome)).toContain("produced no JSON text");
  });

  it("Y2: a cycle is a serialization that started and could not finish", function* () {
    const cycle: Record<string, unknown> = { name: "widget" };
    cycle.self = cycle;
    const outcome = yield* run('<Source as="payload" />\n\n<Yaml value={payload} />\n', [
      source(cycle),
    ]);
    expect(reason(outcome)).toContain("serialization of this value failed");
  });

  it("Y2: a throwing toJSON is read once and reported as that failure", function* () {
    let hooks = 0;
    const outcome = yield* run('<Source as="payload" />\n\n<Yaml value={payload} />\n', [
      source({
        toJSON() {
          hooks += 1;
          throw new Error("this hook refuses");
        },
      }),
    ]);

    expect(reason(outcome)).toContain("serialization of this value failed");
    // One call, never repeated to describe the failure: the hook is the
    // document's own code and asking twice would run it twice.
    expect(hooks).toBe(1);
  });

  it("Y2: a counting getter is read exactly once", function* () {
    let reads = 0;
    const outcome = yield* run(
      '<Source as="payload" />\n\n<Yaml value={payload} as="yaml" />\n\n{yaml}',
      [
        source({
          get name(): string {
            reads += 1;
            return "widget";
          },
        }),
      ],
    );

    expect(text(outcome)).toContain("name: widget");
    expect(reads).toBe(1);
  });

  it("Y2: a failed render binds nothing and renders nothing", function* () {
    const outcome = yield* run(
      '<Source as="payload" />\n\n<Yaml value={payload} as="yaml" />\n\n{yaml}\n',
      [source(undefined)],
    );
    expect(reason(outcome)).toContain("produced no JSON text");
  });
});
