/**
 * Tier YAML — `<Yaml>` (spec §6.23).
 *
 * `<Json>`'s sibling, read the same way: what the text says, and what a
 * document cannot safely write. The mixed operand below is one value rendered
 * twice — once as JSON by the existing component, once as YAML by this one —
 * and the comparison is made by decoding both texts back and asking whether
 * they describe what is still bound.
 *
 * The hostile operands are here for the reason `<Json>`'s are: a getter that
 * counts its own reads and a cycle cannot be written in Markdown without an
 * eval block that would teach the wrong thing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Component } from "../src/component-api.ts";
import { expandSegments } from "../src/expand.ts";
import { renderSegments } from "../src/render.ts";
import { scanSegments } from "../src/scanner.ts";
import { CORE_REGISTRY } from "../src/components/registry.ts";
import { select } from "../src/components/query-engine.ts";
import type {
  ComponentFailure,
  ErrorSegment,
  EvalEnv,
  FunctionComponentDefinition,
} from "../src/types.ts";

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
  /** Every failure offered to the `handleFailure` chain, from outside the run. */
  offered: ComponentFailure[];
}

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
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          if (name !== "Yaml" && name !== "Json" && name !== "Query") {
            throw new Error(`Cannot resolve component: ${name}`);
          }
          return core(name);
        },
      },
      { at: "min" },
    );
    const origin = { path: "doc.md", baseOffset: 0, baseLine: 1 };
    const segments = yield* expandSegments(scanSegments(source, origin), {}, {}, new Set());
    return { output: renderSegments(segments), observed, offered };
  });
}

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
  return error instanceof Error && error.cause !== undefined
    ? reaches(error.cause, target, seen)
    : false;
}

/** The mixed value both renderers are asked about. */
const MIXED = {
  name: "widget",
  count: 2,
  numeric: "7",
  lines: "first\nsecond",
  tags: ["a", "b"],
  nothing: null,
  off: false,
  nested: { inner: [1, { deep: true }] },
};

describe("Tier YAML — what the text says", () => {
  it("Q5: one value renders as JSON and as YAML, and both decode back to it", function* () {
    const result = yield* run(
      [
        '<Json value={mixed} as="json" />',
        '<Yaml value={mixed} as="yaml" />',
        "JSON:{json}",
        "YAML:{yaml}",
        "",
      ].join("\n\n"),
      { mixed: MIXED },
    );

    expect(reported(result)).toBe("");
    const json = result.output.split("JSON:")[1]?.split("YAML:")[0] ?? "";
    const yaml = result.output.split("YAML:")[1] ?? "";

    // The existing component's own shape, unchanged: two spaces, no trailing
    // newline of its own.
    expect(json.trim()).toBe(JSON.stringify(MIXED, null, 2));
    // The renderer's complete YAML text, two-space and without document
    // separators, ending in the newline it produced.
    expect(yaml).toContain("name: widget\n");
    expect(yaml).toContain("nested:\n  inner:\n    - 1\n    - deep: true\n");
    expect(yaml).not.toContain("---");
    expect(yaml.endsWith("\n")).toBe(true);
    // A numeric-looking string stays a string, and a multiline string survives.
    expect(yaml).toContain('numeric: "7"');
    expect(yaml).toContain("lines: ");
    expect(yaml).toContain("nothing:");
    expect(yaml).toContain("off: false");

    // And the two texts describe the same value: the YAML is decoded by the
    // expression language the document would use, not by a parser this suite
    // brought along.
    const decoded = yield* select("from_yaml", JSON.stringify(yaml));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(JSON.parse(decoded.json)).toEqual(MIXED);
    }
    expect(JSON.parse(json.trim())).toEqual(MIXED);
  });

  it("Q5: a selected binding stays data while both renderers write text", function* () {
    const result = yield* run(
      [
        '<Query value={mixed} yq=".nested" as="picked" />',
        '<Yaml value={picked} as="text" />',
        "<Json value={picked} />",
        "captured:{text}",
        "",
      ].join("\n\n"),
      { mixed: MIXED },
    );

    expect(reported(result)).toBe("");
    // The binding is still the structure: `<Json>` renders an object, not the
    // YAML text the other element captured.
    expect(result.output).toContain(
      '{\n  "inner": [\n    1,\n    {\n      "deep": true\n    }\n  ]\n}',
    );
    expect(result.output).toContain("captured:inner:\n  - 1\n  - deep: true\n");
  });
});

describe("Tier YAML — what a document cannot write", () => {
  it("Q5: the operand is serialized once, and capture failures stay apart", function* () {
    let reads = 0;
    const counted = {
      get name(): string {
        reads += 1;
        return "widget";
      },
    };

    const rendered = yield* run("<Yaml value={payload} />\n", { payload: counted });
    expect(reported(rendered)).toBe("");
    expect(rendered.output).toContain("name: widget");
    // Once: the renderer serializes the operand a single time, and nothing here
    // reads it again to describe what it did.
    expect(reads).toBe(1);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const cyclic = yield* run('<Yaml value={payload} as="text" />\n\n[{text}]\n', {
      payload: cycle,
    });
    expect(reported(cyclic)).toContain("serialization of this value failed");
    // Atomically: nothing partial was captured under that name.
    expect(cyclic.output).toContain("[{text}]");

    const thrown = new Error("the hook refused");
    const hostile = yield* run("<Yaml value={payload} />\n", {
      payload: {
        toJSON() {
          throw thrown;
        },
      },
    });
    // The document's own thrown hook, reachable as the cause of what this
    // component refused with.
    expect(reaches(hostile.offered[0]?.error, thrown)).toBe(true);
  });

  it("Q5: missing value and content refuse before anything is rendered", function* () {
    const missing = yield* run("<Yaml />\n");
    expect(reported(missing)).toContain("requires a `value` prop");

    const withContent = yield* run("<Yaml value={payload}>body</Yaml>\n", { payload: { a: 1 } });
    expect(reported(withContent)).toContain("not content");
    expect(withContent.output).not.toContain("a: 1");
  });
});
