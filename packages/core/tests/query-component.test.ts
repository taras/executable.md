/**
 * Tier QRY — `<Query>` (spec §6.22).
 *
 * Four questions, in the order an author meets them. What the two modes write
 * and bind; what the expression language is allowed to decode and how many
 * answers it may give; what the engine can reach while it evaluates; and what
 * happens when the value under query came from a producer that already ran.
 *
 * Expansion output is read raw where framing is the point, and real execution
 * is used where registration, binding and producers are the point — a selection
 * that only ever ran through a hand-built invocation would prove nothing about
 * the component a document resolves.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API, Files, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { CORE_REGISTRY } from "../src/components/registry.ts";
import type { ErrorSegment, EvalEnv, FunctionComponentDefinition, Json } from "../src/types.ts";

/** Core's own registered definition, so what runs is what a document resolves. */
function core(name: string): FunctionComponentDefinition {
  const entry = CORE_REGISTRY.get(name)?.default?.definition;
  if (entry === undefined || entry.kind !== "function") {
    throw new Error(`core supplies no <${name}> definition`);
  }
  return entry;
}

interface Run {
  output: string;
  observed: ErrorSegment[];
}

/** Expand `source` with core's own `<Query>`/`<Yaml>`/`<Json>` and `values` in scope. */
function run(source: string, values: Record<string, unknown> = {}): Operation<Run> {
  return scoped(function* () {
    const observed: ErrorSegment[] = [];
    yield* Component.around({
      *raise([segment], next) {
        observed.push(segment);
        return yield* next(segment);
      },
    });
    const env: EvalEnv = { values };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          if (name !== "Query" && name !== "Yaml" && name !== "Json") {
            throw new Error(`Cannot resolve component: ${name}`);
          }
          return core(name);
        },
      },
      { at: "min" },
    );
    const origin = { path: "doc.md", baseOffset: 0, baseLine: 1 };
    const segments = yield* expandSegments(scanSegments(source, origin), {}, {}, new Set());
    return { output: renderSegments(segments), observed };
  });
}

/** Everything a run reported, as one string. */
function reported(result: Run): string {
  return result.observed.map((segment) => segment.message).join("\n");
}

/** A temporary directory of this case's own, removed with its scope. */
function useFixture(): Operation<string> {
  return resource(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "query-component-")));
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* provide(yield* until(realpath(dir)));
  });
}

describe("Tier QRY — the two ordinary modes", () => {
  const DATA = {
    name: "widget",
    count: 2,
    tags: ["a", "b"],
    nothing: null,
    off: false,
    empty: [] as unknown[],
    nested: { inner: { deep: true } },
    quoted: '{"a":1}',
    lines: "first\nsecond {brace}",
  };

  it("Q1: every unbound type is written as JSON", function* () {
    const result = yield* run(
      [
        '<Query value={data} yq=".name" />',
        '<Query value={data} yq=".count" />',
        '<Query value={data} yq=".tags" />',
        '<Query value={data} yq=".nothing" />',
        '<Query value={data} yq=".off" />',
        '<Query value={data} yq=".empty" />',
        '<Query value={data} yq=".nested" />',
        "",
      ].join("\n\n"),
      { data: DATA },
    );

    expect(reported(result)).toBe("");
    // A string is JSON-quoted like any other JSON value: one reading, whatever
    // the selected type turns out to be.
    expect(result.output).toContain('"widget"');
    expect(result.output).toContain("\n2\n");
    expect(result.output).toContain('[\n  "a",\n  "b"\n]');
    expect(result.output).toContain("\nnull\n");
    expect(result.output).toContain("\nfalse\n");
    expect(result.output).toContain("\n[]\n");
    expect(result.output).toContain('{\n  "inner": {\n    "deep": true\n  }\n}');
  });

  it("Q1: a quoted and a multiline string keep their JSON escaping", function* () {
    const result = yield* run(
      '<Query value={data} yq=".quoted" />\n\n<Query value={data} yq=".lines" />\n',
      { data: DATA },
    );

    expect(reported(result)).toBe("");
    expect(result.output).toContain('"{\\"a\\":1}"');
    expect(result.output).toContain('"first\\nsecond {brace}"');
  });

  it("Q1: a bound selection keeps its type and writes nothing", function* () {
    const result = yield* run(
      [
        '<Query value={data} yq=".nested" as="picked" />',
        "<Json value={picked} />",
        '<Query value={data} yq=".off" as="flag" />',
        "flag is {flag}",
        '<Query value={data} yq=".empty" as="none" />',
        "<Json value={none} />",
        "",
      ].join("\n\n"),
      { data: DATA },
    );

    expect(reported(result)).toBe("");
    // The structured value reached the binding: `<Json>` renders the object it
    // was given rather than text somebody printed.
    expect(result.output).toContain('{\n  "inner": {\n    "deep": true\n  }\n}');
    expect(result.output).toContain("flag is false");
    expect(result.output).toContain("[]");
    // And the bound elements themselves wrote nothing of their own.
    expect(result.output).not.toContain('"inner": {\n    "deep": true\n  }\n}\n{');
  });

  it("Q1: a missing value, a missing yq, an alias, content and bad as all refuse", function* () {
    const alone = yield* run('<Query yq=".name" />\n', { data: DATA });
    expect(reported(alone)).toContain("value");

    const unqueried = yield* run("<Query value={data} />\n", { data: DATA });
    expect(reported(unqueried)).toContain("yq");

    const aliased = yield* run('<Query value={data} expression=".name" />\n', { data: DATA });
    expect(reported(aliased)).toContain("expression");

    const withContent = yield* run('<Query value={data} yq=".name">body</Query>\n', { data: DATA });
    expect(reported(withContent)).toContain("not from content");

    const badBinding = yield* run('<Query value={data} yq=".name" as="not a name" />\n', {
      data: DATA,
    });
    expect(reported(badBinding)).not.toBe("");
  });

  it("Q1: a refused selection leaves an earlier binding as it was", function* () {
    const result = yield* run(
      [
        '<Query value={data} yq=".name" as="picked" />',
        '<Query value={data} yq="!!!" as="picked" />',
        "picked is {picked}",
        "",
      ].join("\n\n"),
      { data: DATA },
    );

    expect(reported(result)).not.toBe("");
    // The prior data, not the input it was handed and not an empty value.
    expect(result.output).toContain("picked is widget");
  });
});

describe("Tier QRY — what the expression may decode, and how many answers it may give", () => {
  it("Q2: identity over a JSON-looking string keeps it a string", function* () {
    const result = yield* run('<Query value={text} yq="." />\n', { text: '{"a":1}' });

    expect(reported(result)).toBe("");
    expect(result.output.trim()).toBe('"{\\"a\\":1}"');
  });

  it("Q2: from_json and from_yaml decode one text each", function* () {
    const result = yield* run(
      [
        '<Query value={json} yq="from_json | .a" />',
        '<Query value={yaml} yq="from_yaml | .b" />',
        "",
      ].join("\n\n"),
      { json: '{"a":[1,2]}', yaml: "b: widget\n" },
    );

    expect(reported(result)).toBe("");
    expect(result.output).toContain("[\n  1,\n  2\n]");
    expect(result.output).toContain('"widget"');
  });

  it("Q2: a filter and a projection select through the pinned engine", function* () {
    const records = {
      records: [
        { name: "a", status: "ok" },
        { name: "b", status: "failed" },
      ],
    };
    const result = yield* run(
      `<Query value={data} yq='[.records[] | select(.status == "failed") | {"name": .name}]' />\n`,
      { data: records },
    );

    expect(reported(result)).toBe("");
    expect(result.output.trim()).toBe('[\n  {\n    "name": "b"\n  }\n]');
  });

  it("Q2: no answer and several answers both say to collect with brackets", function* () {
    const none = yield* run('<Query value={pair} yq=".[] | select(. == 9)" />\n', { pair: [1, 2] });
    expect(reported(none)).toContain("[ … ]");
    expect(reported(none)).toContain("selected nothing");
    expect(none.output).not.toContain("1");

    const several = yield* run('<Query value={pair} yq=".[]" />\n', { pair: [1, 2] });
    expect(reported(several)).toContain("[ … ]");
    expect(reported(several)).toContain("more than one");
    expect(several.output).not.toContain("1\n2");

    // Collecting is what the guidance says to write, and it works.
    const collected = yield* run('<Query value={pair} yq="[.[]]" />\n', { pair: [1, 2] });
    expect(reported(collected)).toBe("");
    expect(collected.output.trim()).toBe("[\n  1,\n  2\n]");
  });

  it("Q2: an invalid expression fails with its own cause and binds nothing", function* () {
    const result = yield* run('<Query value={data} yq="!!!" as="picked" />\n\n[{picked}]\n', {
      data: { a: 1 },
    });

    const message = reported(result);
    expect(message).toContain("could not evaluate");
    // No fallback: the input is not the answer to a question that failed.
    expect(result.output).not.toContain('"a": 1');
    expect(result.output).toContain("[{picked}]");
  });

  it("Q2: null, false and an empty array are answers, not failures", function* () {
    const result = yield* run(
      [
        '<Query value={data} yq=".nothing" as="a" />',
        '<Query value={data} yq=".off" as="b" />',
        '<Query value={data} yq="[.missing[]?]" as="c" />',
        "<Json value={a} />",
        "<Json value={b} />",
        "<Json value={c} />",
        "",
      ].join("\n\n"),
      { data: { nothing: null, off: false } },
    );

    expect(reported(result)).toBe("");
    expect(result.output).toContain("null");
    expect(result.output).toContain("false");
    expect(result.output).toContain("[]");
  });
});

describe("Tier QRY — what the engine can reach", () => {
  it("Q3: the environment, the filesystem, the clock and a process are all absent", function* () {
    const canaries = yield* run(
      [
        '<Query value={data} yq="strenv(QUERY_CANARY)" />',
        `<Query value={data} yq='load("/query-canary.txt")' />`,
        '<Query value={data} yq="now" />',
        `<Query value={data} yq='"echo ran" | @sh' />`,
        "",
      ].join("\n\n"),
      { data: { a: 1 } },
    );

    // An empty environment answers an environment read with an empty string
    // rather than with the host's value.
    expect(canaries.output).toContain('""');
    expect(canaries.output).not.toContain("host-visible");
    // The file and the clock are refusals, and neither binds anything.
    const message = reported(canaries);
    expect(message).toContain("could not evaluate");
    expect(canaries.output).not.toContain("canary contents");
  });
});

describe("Tier QRY — two producers, each run once, over the page they supplied", () => {
  const FIXTURE = JSON.stringify(
    {
      records: [
        { name: "a", status: "ok" },
        { name: "b", status: "failed" },
      ],
      next: "cursor-2",
    },
    null,
    2,
  );

  /** Every provider call this case's own fixture saw. */
  interface Calls {
    reads: string[];
    globs: string[];
  }

  function watched(calls: Calls): Operation<void> {
    return Files.around({
      *readTextFile([input], next) {
        const answer = yield* next(input);
        calls.reads.push(String(input.path));
        return answer;
      },
      *globFiles([input], next) {
        calls.globs.push([...input.include].join(","));
        return yield* next(input);
      },
    });
  }

  it("Q4: a file read once and a glob listed once answer several queries", function* () {
    const dir = yield* useFixture();
    yield* writeTextFile(join(dir, "input.json"), FIXTURE);
    yield* writeTextFile(
      join(dir, "doc.md"),
      [
        '<File path="input.json" as="text" />',
        `<Query value={text} yq='from_json | [.records[] | select(.status == "failed") | {"name": .name}]' as="failed" />`,
        '<Query value={text} yq="from_json | [.records[] | .name]" as="names" />',
        '<Glob include={["input.json"]} as="paths" />',
        `<Query value={paths} yq='[.[] | {"path": .}]' as="listed" />`,
        "<Json value={failed} />",
        "<Json value={names} />",
        "<Json value={listed} />",
        "",
      ].join("\n\n"),
    );

    const calls: Calls = { reads: [], globs: [] };
    const stream = new InMemoryStream();
    const output = yield* scoped(function* () {
      // The document's own working directory, installed explicitly the way an
      // entrypoint does: `<File>` and `<Glob>` resolve against `Env.cwd`
      // rather than against this process's.
      yield* API.Env.around(
        {
          // deno-lint-ignore require-yield
          *cwd() {
            return dir;
          },
        },
        { at: "min" },
      );
      yield* useHostFiles();
      yield* watched(calls);
      return yield* collect(yield* execute({ path: join(dir, "doc.md"), stream, includes: [dir] }));
    });

    const rendered = String(output);
    expect(rendered).toContain('{\n    "name": "b"\n  }');
    expect(rendered).toContain('[\n  "a",\n  "b"\n]');
    expect(rendered).toContain('"path": "input.json"');
    // Each producer crossed its provider exactly once, however many questions
    // were asked of what it produced.
    expect(calls.reads).toEqual(["input.json"]);
    expect(calls.globs).toHaveLength(1);
    // The next marker is in the value and stays there: nothing followed it and
    // nothing claimed the records were complete.
    expect(rendered).not.toContain("cursor-2");
    expect(
      yield* scoped(function* () {
        yield* useHostFiles();
        return yield* readTextFile(join(dir, "input.json"));
      }),
    ).toBe(FIXTURE);
  });
});
