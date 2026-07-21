import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import type { CodeBlockResult, Segment } from "../src/types.ts";

interface EachRun {
  segments: Segment[];
  output: string;
  env: Record<string, unknown> | undefined;
}

function runEach(
  source: string,
  opts: {
    env?: Record<string, unknown>;
    withEnv?: boolean;
    codeResult?: CodeBlockResult;
  } = {},
): Operation<EachRun> {
  return scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          throw new Error(`Component not found: ${name}`);
        },
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          return opts.codeResult ?? { output: "mock output\n", exitCode: 0, stderr: "" };
        },
      },
      { at: "min" },
    );
    let envValues: Record<string, unknown> | undefined;
    if (opts.withEnv !== false) {
      const testEnv = { values: { ...(opts.env ?? {}) } };
      yield* Component.around({ env: () => testEnv }, { at: "min" });
      envValues = testEnv.values;
    }
    const segments = yield* expandSegments(scanSegments(source), {}, {}, new Set());
    return { segments, output: renderSegments(segments), env: envValues };
  });
}

function errorMessages(segments: Segment[]): string[] {
  return segments.filter((s) => s.type === "error").map((s) => s.message);
}

describe("Tier Each — native iteration directive", () => {
  it("E1: renders the body once per item, resolving dotted paths", function* () {
    const run = yield* runEach(
      '<Each in={[{sym: "A"}, {sym: "B"}]} let="row">(row={row.sym})</Each>',
    );
    expect(run.output).toBe("(row=A)(row=B)");
  });

  it("E2: empty array renders nothing", function* () {
    const run = yield* runEach('<Each in={[]} let="row">(row={row.sym})</Each>');
    expect(run.output).toBe("");
    expect(errorMessages(run.segments)).toHaveLength(0);
  });

  it("E3: resolves the iterable from an eval binding expression", function* () {
    const run = yield* runEach('<Each in={items} let="row">(row={row.sym})</Each>', {
      env: { items: [{ sym: "A" }, { sym: "B" }] },
    });
    expect(run.output).toBe("(row=A)(row=B)");
  });

  it("E4: nested <Each> reusing the same binding shadows then restores it", function* () {
    const run = yield* runEach(
      '<Each in={[{v: "O", items: [1, 2]}]} let="x">before={x.v};<Each in={x.items} let="x">in={x};</Each>after={x.v};</Each>',
    );
    expect(run.output).toBe("before=O;in=1;in=2;after=O;");
    expect(run.env?.x).toBeUndefined();
  });

  it("E5: the item binding does not leak to siblings or the parent env", function* () {
    const run = yield* runEach('<Each in={[1, 2]} let="n">n={n};</Each> after={n}');
    expect(run.output).toBe("n=1;n=2; after={n}");
    expect(run.env?.n).toBeUndefined();
  });

  it("E6: as captures the whole rendered loop and emits nothing inline", function* () {
    const run = yield* runEach('<Each in={[1, 2]} let="n" as="captured">n={n};</Each>INLINE');
    expect(run.output).toBe("INLINE");
    expect(run.env?.captured).toBe("n=1;n=2;");
  });

  it("E7: an uncaptured loop preserves body ErrorSegments (not stringified)", function* () {
    const run = yield* runEach('<Each in={[1, 2]} let="n"><Output>bad</Output></Each>');
    expect(run.segments.filter((s) => s.type === "error")).toHaveLength(2);
    expect(run.segments.every((s) => s.type !== "text")).toBe(true);
  });

  it("E8: an uncaptured loop preserves non-text segments (ExecOutput)", function* () {
    const source = [
      '<Each in={[1, 2]} let="n">',
      "",
      "```bash exec",
      "echo hi",
      "```",
      "",
      "</Each>",
    ].join("\n");
    const run = yield* runEach(source);
    expect(run.segments.filter((s) => s.type === "execOutput")).toHaveLength(2);
  });

  it("E9: missing in is rejected", function* () {
    const run = yield* runEach('<Each let="row">x</Each>');
    expect(errorMessages(run.segments)[0]).toContain('requires an "in" prop');
  });

  it("E10: a non-array in is rejected", function* () {
    const run = yield* runEach('<Each in={42} let="row">x</Each>');
    expect(errorMessages(run.segments)[0]).toContain("must resolve to an array");
  });

  it("E11: missing let is rejected", function* () {
    const run = yield* runEach("<Each in={[1]}>x</Each>");
    expect(errorMessages(run.segments)[0]).toContain('requires a "let" prop');
  });

  it("E12: let as an expression is rejected", function* () {
    const run = yield* runEach("<Each in={[1]} let={dyn}>x</Each>", { env: { dyn: "row" } });
    expect(errorMessages(run.segments)[0]).toContain("must be a string literal");
  });

  it("E13: reserved words are rejected as the let binding", function* () {
    for (const word of ["in", "let", "await"]) {
      const run = yield* runEach(`<Each in={[1]} let="${word}">x</Each>`);
      expect(errorMessages(run.segments)[0]).toContain("valid JavaScript binding name");
    }
  });

  it("E14: as as an expression is rejected", function* () {
    const run = yield* runEach('<Each in={[1]} let="row" as={dyn}>x</Each>', {
      env: { dyn: "cap" },
    });
    expect(errorMessages(run.segments)[0]).toContain(
      'Prop "as" on <Each /> must be a string literal',
    );
  });

  it("E15: unknown literal and expression props are rejected", function* () {
    const literal = yield* runEach('<Each in={[1]} let="row" foo="bar">x</Each>');
    expect(errorMessages(literal.segments)[0]).toContain('only accepts "in", "let", and "as"');
    const expr = yield* runEach('<Each in={[1]} let="row" bar={dyn}>x</Each>', { env: { dyn: 1 } });
    expect(errorMessages(expr.segments)[0]).toContain('only accepts "in", "let", and "as"');
  });

  it("E16: as without a parent environment is rejected", function* () {
    const run = yield* runEach('<Each in={[1, 2]} let="n" as="cap">n={n};</Each>', {
      withEnv: false,
    });
    expect(errorMessages(run.segments)[0]).toContain("requires a parent evaluation environment");
  });

  it("E17: the strengthened binding rule also governs a reserved as binding", function* () {
    const run = yield* runEach('<Each in={[1]} let="row" as="in">x</Each>');
    expect(errorMessages(run.segments)[0]).toContain("valid JavaScript binding name");
  });

  it("E20: ordinary identifiers including _name and $name remain valid bindings", function* () {
    for (const word of ["item", "_name", "$name"]) {
      const run = yield* runEach(`<Each in={[1, 2]} let="${word}">X</Each>`);
      expect(errorMessages(run.segments)).toHaveLength(0);
      expect(run.output).toBe("XX");
    }
  });
});

describe("Tier Each — eval in the loop body", () => {
  it("E18: a body eval block reads the current item binding", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const items = [{ name: 'alpha' }, { name: 'beta' }];",
        "```",
        '<Each in={items} let="item">',
        "```js eval",
        "output('got:' + item.name);",
        "```",
        "</Each>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ docPath: "test.md", stream }));

    expect(output).toContain("got:alpha");
    expect(output).toContain("got:beta");
    expect(output).not.toContain("ERROR");
  });

  it("E19: renders a table row per item end to end", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const rows = [{ k: 'x', v: 1 }, { k: 'y', v: 2 }];",
        "```",
        '<Each in={rows} let="row">',
        "| {row.k} | {row.v} |",
        "</Each>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ docPath: "test.md", stream }));

    expect(output).toContain("| x | 1 |");
    expect(output).toContain("| y | 2 |");
    expect(output).not.toContain("ERROR");
  });

  it("E22: each iteration's eval env is fresh — body bindings do not carry over", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const items = [1, 2];",
        "```",
        '<Each in={items} let="n">',
        "```js eval",
        "output('iter' + n + ':' + ('carry' in env ? env.carry : 'absent'));",
        "env.carry = 'from-' + n;",
        "```",
        "</Each>",
        "```js eval",
        "output('final:' + (typeof carry === 'undefined' ? 'absent' : carry));",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ docPath: "test.md", stream }));

    expect(output).toContain("iter1:absent");
    expect(output).toContain("iter2:absent");
    expect(output).toContain("final:absent");
    expect(output).not.toContain("ERROR");
  });

  it("E21: an <Each> projected through <Content /> resolves caller bindings", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": "<Content />",
      "test.md": [
        "```js eval",
        "const items = [{ n: 1 }, { n: 2 }];",
        "const label = 'L';",
        "```",
        "<Wrap>",
        '<Each in={items} let="item">[{label}:{item.n}]</Each>',
        "</Wrap>",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ docPath: "test.md", stream }));

    expect(output).toContain("[L:1]");
    expect(output).toContain("[L:2]");
    expect(output).not.toContain("ERROR");
  });
});
