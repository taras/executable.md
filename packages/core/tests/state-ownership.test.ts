/**
 * Tier SO — state belongs to the operation that owns it (architecture.md).
 *
 * Every table the engine keeps is created inside the run it describes and
 * reclaimed when that run ends, so nothing one execution recorded is still
 * answering questions during the next. The exception is a declaration an author
 * writes at module evaluation about a function the author owns, which has no run
 * to belong to and lives on the function itself.
 *
 * The evidence these tests accept is a second execution: what run 1 recorded
 * must not answer for run 2.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { printErrors, printsErrors } from "../src/component-failures.ts";
import { attributeCause, SegmentCauses, useSegmentCauses } from "../src/errors.ts";
import { compilePropsSchema, usePropsCompiler } from "../src/validate.ts";
import { compileParseSchema, useParseCompiler } from "../src/components/parse-schema.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { ErrorSegment, FunctionComponent, Json, PropsSchema } from "../src/types.ts";

/** The failure an operation raised, so an assertion can read it. */
function* raised(operation: () => Operation<unknown>): Operation<unknown> {
  try {
    yield* operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

describe("Tier SO — a declaration lives on the function it describes", () => {
  it("SO1: recognises a component its author marked, and only that one", function* () {
    const marked: FunctionComponent = printErrors(function* () {
      return "";
    });
    const plain: FunctionComponent = function* () {
      return "";
    };

    expect(printsErrors(marked)).toBe(true);
    expect(printsErrors(plain)).toBe(false);
  });

  it("SO2: does not carry the declaration into a copy", function* () {
    const marked: FunctionComponent = printErrors(function* () {
      return "";
    });
    const copy: FunctionComponent = Object.assign(function* () {
      return "";
    }, marked);

    // Copying own properties is how a wrapper is usually built, and it copies
    // enumerable symbol keys too. Non-enumerable is what keeps a component that
    // was wrapped from inheriting a decision its author never made about it.
    expect(printsErrors(copy)).toBe(false);
    expect(Object.getOwnPropertySymbols({ ...marked })).toHaveLength(0);
  });

  it("SO3: keys the declaration to the function object, never to its name", function* () {
    const marked: FunctionComponent = printErrors(function* Widget() {
      return "";
    });
    const sameName: FunctionComponent = function* Widget() {
      return "";
    };

    expect(printsErrors(marked)).toBe(true);
    expect(printsErrors(sameName)).toBe(false);
  });

  it("SO4: cannot be forged from outside the module", function* () {
    const forged: FunctionComponent = function* () {
      return "";
    };
    // A registry key anyone can reach is a key anyone can write. The declaration
    // is a module-private symbol, so this is not the one it reads.
    Object.defineProperty(forged, Symbol.for("executablemd.core.printsErrors"), { value: true });

    expect(printsErrors(forged)).toBe(false);
  });
});

describe("Tier SO — the segment-cause table belongs to its run", () => {
  /** The table an execution opened, captured from inside it. */
  function* tableOf(): Operation<object | undefined> {
    return yield* scoped(function* () {
      yield* useSegmentCauses();
      return yield* SegmentCauses.get();
    });
  }

  it("SO5: gives each run a table of its own", function* () {
    const first = yield* tableOf();
    const second = yield* tableOf();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("SO6: does not let what one run recorded answer for the next", function* () {
    // The same object crosses both runs, which is the only way a shared table
    // could be observed at all: a run that owns its table has never seen it.
    const segment: ErrorSegment = { type: "error", message: "shared" };

    yield* scoped(function* () {
      yield* useSegmentCauses();
      yield* attributeCause(segment, new Error("run one"));
      expect((yield* SegmentCauses.get())?.has(segment)).toBe(true);
    });

    yield* scoped(function* () {
      yield* useSegmentCauses();
      expect((yield* SegmentCauses.get())?.has(segment)).toBe(false);
    });
  });

  it("SO7: records nothing at all when no run owns a table", function* () {
    const segment: ErrorSegment = { type: "error", message: "ownerless" };
    yield* attributeCause(segment, new Error("nowhere to put this"));

    yield* scoped(function* () {
      yield* useSegmentCauses();
      expect((yield* SegmentCauses.get())?.has(segment)).toBe(false);
    });
  });
});

/**
 * Ajv keeps every compile in a `Map` keyed by the schema object it was handed,
 * never evicted. An instance that outlived a run would therefore answer a
 * schema object mutated between runs with the first run's validator — which is
 * how "shared state" stops being an abstraction and becomes a wrong answer.
 */
describe("Tier SO — each run compiles with a compiler of its own", () => {
  const REQUIRES_A: PropsSchema = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  };

  it("SO8: recompiles a props schema object a later run changed", function* () {
    const schema: PropsSchema = structuredClone(REQUIRES_A);

    const first = yield* scoped(function* () {
      yield* usePropsCompiler();
      return yield* compilePropsSchema(schema);
    });
    expect(first({ a: "given" })).toBe(true);

    // The host holds the schema object across runs — a registered component is
    // exactly this — and changes what it requires.
    schema["required"] = ["b"];

    const second = yield* scoped(function* () {
      yield* usePropsCompiler();
      return yield* compilePropsSchema(schema);
    });
    expect(second({ a: "given" })).toBe(false);
    expect(second({ b: "given" })).toBe(true);
  });

  it("SO9: gives each run a parse compiler of its own", function* () {
    // Parsing normalizes its declaration through `parseJson`, so it hands Ajv a
    // fresh object every call and never hits the identity cache the props path
    // does. Its accumulation is therefore unbounded growth rather than a stale
    // answer, and what has to be true is the lifetime: a run's compiler, and
    // everything it compiled, goes when the run does.
    const schema: Json = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };

    const first = yield* scoped(function* () {
      const compiler = yield* useParseCompiler();
      const validate = yield* compileParseSchema("Parse", schema);
      expect(validate({ a: "given" })).toBe(true);
      return compiler;
    });

    const second = yield* scoped(function* () {
      const compiler = yield* useParseCompiler();
      const validate = yield* compileParseSchema("Parse", schema);
      expect(validate({ a: "given" })).toBe(true);
      return compiler;
    });

    expect(second).not.toBe(first);
  });

  it("SO10: still compiles a schema object once within one run", function* () {
    // The run's own instance is the whole cache: asking twice inside it costs
    // one compile, which is why dropping the tables beside Ajv changed nothing.
    yield* usePropsCompiler();
    const once = yield* compilePropsSchema(REQUIRES_A);
    const twice = yield* compilePropsSchema(REQUIRES_A);
    expect(twice).toBe(once);
  });

  it("SO11: compiles outside a run without keeping anything", function* () {
    // No run means nothing to reclaim, so each call gets an instance of its own
    // rather than reaching for one that would outlive it.
    const first = yield* compilePropsSchema(REQUIRES_A);
    const second = yield* compilePropsSchema(REQUIRES_A);

    expect(first({ a: "given" })).toBe(true);
    expect(second({ a: "given" })).toBe(true);
    expect(second).not.toBe(first);
  });

  it("SO12: still refuses a schema it cannot compile", function* () {
    yield* usePropsCompiler();
    expect(String(yield* raised(() => compilePropsSchema({ type: "array" })))).toContain(
      'type: "object"',
    );
  });
});

/**
 * The same claim where a host actually meets it: a component registered once
 * and invoked by two executions, whose props schema object the host changed in
 * between. A validator remembered from the first run would let the second run
 * accept props its schema no longer allows.
 */
describe("Tier SO — two executions of a registered component", () => {
  function run(files: Record<string, string>, schema: PropsSchema): Operation<Json> {
    return scoped(function* () {
      yield* registerComponents([
        {
          name: "Widget",
          origin: "state-ownership.test",
          props: schema,
          // deno-lint-ignore require-yield
          fn: function* (props: Record<string, Json>): Operation<string> {
            return `widget:${String(props["a"] ?? "")}${String(props["b"] ?? "")}`;
          },
        },
      ]);
      yield* useStubFs(files);
      return yield* collect(yield* execute({ path: "doc.md", stream: new InMemoryStream() }));
    });
  }

  it("SO13: validates the second run against the schema the host now declares", function* () {
    const schema: PropsSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };

    const first = String(yield* run({ "doc.md": '<Widget a="one" />' }, schema));
    expect(first).toContain("widget:one");

    // The host tightens the contract between runs, on the object it registered.
    schema["required"] = ["a", "b"];

    const second = String(yield* run({ "doc.md": '<Widget a="two" />' }, schema));
    // The invocation no longer satisfies the schema, so it is a printed error
    // rather than a rendered widget.
    expect(second).toContain("<!-- ERROR");
    expect(second).toContain("required property");
    expect(second).not.toContain("widget:two");
  });
});
