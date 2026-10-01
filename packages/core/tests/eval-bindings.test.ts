/**
 * Tier T5 — Binding environment tests (spec §11).
 *
 * Tests cross-block binding sharing, shadowing, empty blocks,
 * undeclared references, and syntax errors.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute, executeInstalled } from "../src/execute.ts";
import type { ExecutionInitialization, ExecutionInstallation } from "../src/execute.ts";
import { inlineSource } from "../src/root-source.ts";
import { collect } from "../src/collect.ts";
import { asText, completion, failureMessage } from "./helpers.ts";
import type { Json } from "../src/types.ts";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Operation } from "effection";

describe("Tier T5 — Binding environment", () => {
  beforeAll(() => useTempFileCompiler());
  // T38: Block 2 reads binding exported by Block 1 via env preamble
  it("T38: block 2 reads binding from block 1", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md":
        "```js eval\nconst port = 8080;\n```\n\n```js eval\nconst url = 'http://localhost:' + port;\n```\n",
    });
    yield* useEchoExec();

    // Should not throw — port is available in block 2
    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    // Eval blocks produce no rendered output (only text between blocks remains)
    expect(output.trim()).toBe("");
    // No errors
    expect(output).not.toContain("ERROR");
  });

  // T39: Block 3 shadowing Block 1's binding — downstream sees Block 3's value
  it("T39: shadowing — later block overrides earlier binding", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md":
        "```js eval\nconst x = 1;\n```\n\n```js eval\nconst x = 2;\n```\n\n```js eval\nconst y = x;\n```\n",
    });
    yield* useEchoExec();

    // Should succeed — x is 2 in block 3 (shadowed by block 2)
    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    expect(output).not.toContain("ERROR");
  });

  // T40: Empty block — no exports, no error
  it("T40: empty eval block — no exports, no error", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\n\n```\n",
    });
    yield* useEchoExec();

    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    expect(output).toBe("");
  });

  // T41: Block referencing undeclared binding not in env — nothing recovers it,
  // so the run's outcome is that failure.
  it("T41: undeclared reference → the run fails", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\nconst y = undeclaredVar + 1;\n```\n",
    });
    yield* useEchoExec();

    const result = yield* completion({ path: "test.md", stream });

    expect(result.ok).toBe(false);
    expect(failureMessage(result)).toContain("undeclaredVar");
  });

  // T42: Syntax error in block — parse-time error before execution
  it("T42: syntax error → the run fails", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\nconst x = ;\n```\n",
    });
    yield* useEchoExec();

    const result = yield* completion({ path: "test.md", stream });

    expect(result.ok).toBe(false);
    expect(failureMessage(result)).not.toBe("");
  });
});

/**
 * EB1 — the root bindings a trusted host supplies beside the root source.
 *
 * The REPL hands a later entry the root JSON values its earlier entries durably
 * published, so what is under test here is the seam that accepts them: when the
 * record is read, whose object graph the execution ends up holding, and what a
 * document may then do with it.
 *
 * Every row drives the real trusted-host entrypoint with real installations.
 * The installations exist to *move* while the run is in flight — a preparation
 * and an `install()` that both rewrite the caller's record — because "copied
 * before installations begin" is a claim about ordering that only something
 * mutating in between can disprove.
 */
/**
 * One initialization carrying whatever `initialBindings` is at runtime.
 *
 * `initialBindings` is typed as JSON, and what has to hold is that the *parser*
 * refuses a value the type already forbids — a host loading another copy of
 * core, or reading its own record back from a file, is not type-checked against
 * this one. The value is *defined* onto the record rather than asserted into the
 * type, so nothing here claims the value is something it is not: a property
 * descriptor carries an arbitrary value by design, which is exactly the
 * untrusted shape the parser exists to meet.
 */
function initialization(initialBindings: unknown): ExecutionInitialization {
  const given: ExecutionInitialization = {};
  Object.defineProperty(given, "initialBindings", {
    value: initialBindings,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return given;
}

/**
 * One installation that records which of its phases ran.
 *
 * The sentinel a refusal row needs: "this input was rejected" and "this input was
 * rejected *before anything was installed*" are different claims, and only
 * something that would have been called can tell them apart.
 */
function watching(ran: string[]): ExecutionInstallation {
  return {
    *prepare() {
      ran.push("prepare");
    },
    *install() {
      ran.push("install");
    },
  };
}

/** One record holding `inherited` as whatever that value is at runtime. */
function malformed(value: unknown): ExecutionInitialization {
  const record: Record<string, Json> = {};
  Object.defineProperty(record, "inherited", {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return { initialBindings: record };
}

/** What one run of a document under `initialBindings` did. */
function* inheriting(
  source: string,
  initialBindings: Readonly<Record<string, Json>>,
  installations: readonly ExecutionInstallation[] = [],
): Operation<{ output: string; events: DurableEvent[] }> {
  const stream = new InMemoryStream();
  const output = asText(
    yield* collect(
      yield* executeInstalled({ ...inlineSource(source), stream }, [...installations], {
        initialBindings,
      }),
    ),
  );
  return { output, events: yield* stream.readAll() };
}

describe("Tier T5 — initial root bindings a trusted host supplies", () => {
  beforeAll(() => useTempFileCompiler());

  it("EB1: copies a nested record before installations run, and document code reads it", function* () {
    // The caller's own graph, which the second installation rewrites while the
    // run is in flight.
    const held = { plan: { title: "Ship the REPL", steps: 2 }, flags: ["draft", "ready"] };
    const ran: string[] = [];
    const rewrite = (): void => {
      held.plan.title = "Replaced";
      held.plan.steps = 99;
      held.flags[1] = "replaced";
    };

    const { output } = yield* inheriting(
      [
        "```js eval",
        "const read = `${plan.title}/${plan.steps}/${flags[1]}`;",
        "```",
        "",
        "Read: {read}",
        "",
      ].join("\n"),
      held,
      [
        // The same sentinel the refusal rows below rely on. It records here, in
        // an execution that proceeds, which is what makes an empty `ran` there a
        // fact about the refusal rather than about the helper.
        watching(ran),
        {
          *prepare() {
            rewrite();
          },
          *install() {
            rewrite();
          },
        },
      ],
    );

    expect(ran).toEqual(["install", "prepare"]);
    // The values the invocation captured, not the ones the caller holds now.
    expect(output).toContain("Read: Ship the REPL/2/ready");
    // And the caller's graph was never frozen on its behalf: it is still the
    // mutable object it was lent as.
    expect(Object.isFrozen(held.plan)).toBe(false);
    expect(held.plan.title).toBe("Replaced");
  });

  it("EB1: the execution may mutate its own copy, and the caller's graph never moves", function* () {
    // A durable eval value is ordinary mutable data: an entry that inherits a
    // list and appends to it is doing what any block does to any binding. What
    // isolation has to mean is that the *caller's* graph is unreachable from
    // here, not that the document is handed something it cannot work with.
    const held = { items: ["first"], counts: { runs: 1 } };

    const { output } = yield* inheriting(
      [
        "```js eval",
        'items.push("second");',
        "counts.runs += 1;",
        'const read = `${items.join("/")}/${counts.runs}`;',
        "```",
        "",
        "Read: {read}",
        "",
      ].join("\n"),
      held,
    );

    expect(output).toContain("Read: first/second/2");
    // The caller's own graph is exactly as it was lent: neither frozen on its
    // behalf, nor reachable from what the document just edited.
    expect(held.items).toEqual(["first"]);
    expect(held.counts).toEqual({ runs: 1 });
    expect(Object.isFrozen(held.items)).toBe(false);
  });

  it("EB1: refuses `props` as an initial binding rather than silently dropping it", function* () {
    // The props namespace belongs to the execution that validated it, so an
    // initial binding of that name is a contradiction with `options.props`
    // rather than a value to install. Installing it would replace the namespace
    // and skipping it would be a value the caller believes it passed.
    const stream = new InMemoryStream();
    const ran: string[] = [];
    let raised: Error | undefined;
    try {
      yield* executeInstalled({ ...inlineSource("Read: {props}\n"), stream }, [watching(ran)], {
        initialBindings: { props: "retained" },
      });
    } catch (error) {
      raised = error instanceof Error ? error : new Error(String(error));
    }

    expect(raised?.message).toContain("props");
    // Before the boundary, not merely before the document: neither installation
    // phase ran and nothing was journaled, so this is a refusal rather than an
    // execution that got some way in and then stopped.
    expect(ran).toEqual([]);
    expect(yield* stream.readAll()).toEqual([]);
  });

  it("EB1: refuses an initial name no eval block could bind", function* () {
    for (const name of ["not-a-binding", "1st", "with space", "", "class"]) {
      const stream = new InMemoryStream();
      const ran: string[] = [];
      const record: Record<string, Json> = {};
      Object.defineProperty(record, name, {
        value: "retained",
        enumerable: true,
        writable: true,
        configurable: true,
      });

      let raised: Error | undefined;
      try {
        yield* executeInstalled(
          { ...inlineSource("Nothing reads it.\n"), stream },
          [watching(ran)],
          { initialBindings: record },
        );
      } catch (error) {
        raised = error instanceof Error ? error : new Error(String(error));
      }

      // Refused at the boundary, before the document exists — rather than
      // reaching the generated preamble and failing as whatever that happens to
      // be. The sentinel is what makes that "at the boundary" rather than
      // "eventually": neither installation phase ran.
      expect(raised?.message).toContain("binding");
      expect(ran).toEqual([]);
      expect(yield* stream.readAll()).toEqual([]);
    }
  });

  it("EB1: an authored export replaces an initial value through the ordinary rules", function* () {
    const { output } = yield* inheriting(
      [
        "```js eval",
        "const inherited = 'authored';",
        "```",
        "",
        "Value: {inherited} Other: {kept}",
        "",
      ].join("\n"),
      { inherited: "retained", kept: "retained" },
    );

    expect(output).toContain("Value: authored Other: retained");
  });

  it("EB1: refuses input that is not JSON before any installation or document work", function* () {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;

    for (const supplied of [
      // One member a host could not have written.
      malformed(() => 1),
      malformed(Number.POSITIVE_INFINITY),
      malformed(cycle),
      malformed(new Date(0)),
      malformed(undefined),
      // And the whole record being something other than a record.
      initialization([]),
      initialization("retained"),
      initialization(null),
    ]) {
      const stream = new InMemoryStream();
      const ran: string[] = [];
      let raised: Error | undefined;
      try {
        yield* executeInstalled(
          { ...inlineSource("Read: {inherited}\n"), stream },
          [watching(ran)],
          supplied,
        );
      } catch (error) {
        raised = error instanceof Error ? error : new Error(String(error));
      }

      expect(raised?.name).toBe("JsonParseError");
      // Nothing was installed, nothing was prepared, and the journal is empty:
      // the refusal happened before this execution had any effect at all.
      expect(ran).toEqual([]);
      expect(yield* stream.readAll()).toEqual([]);
    }
  });

  it("EB1: a retained `__proto__` binding is installed as an ordinary name", function* () {
    // Its own enumerable member, which is what `JSON.parse` produces and
    // therefore what a journal read back from a file can hold. Nothing here sets
    // a prototype: an object literal would have, which is why this is defined.
    const record: Record<string, Json> = {};
    Object.defineProperty(record, "__proto__", {
      value: "retained",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.keys(record)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);

    const { output } = yield* inheriting(
      ["```js eval", "const copied = `${__proto__}`;", "```", "", "Read: {copied}", ""].join("\n"),
      record,
    );

    // The document read the name, rather than reading whatever the engine's
    // prototype setter left behind — which under some runtimes is nothing at all.
    expect(output).toContain("Read: retained");
  });

  it("EB1: ordinary execute() inherits nothing, so the same document fails", function* () {
    const stream = new InMemoryStream();
    const source = "```js eval\nconst read = inherited;\n```\n";

    // The same bytes succeed through the host entrypoint.
    const { output } = yield* inheriting(source, { inherited: "retained" });
    expect(output).not.toContain("ERROR");

    const result = yield* completion({ ...inlineSource(source), stream });

    expect(result.ok).toBe(false);
    expect(failureMessage(result)).toContain("inherited");
  });
});
