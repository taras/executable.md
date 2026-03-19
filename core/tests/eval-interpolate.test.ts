/**
 * Tier P — Eval binding interpolation tests.
 *
 * Verifies that bare `{name}` references in code block content resolve
 * from the eval binding environment (env.values).
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { interpolateEvalBindings } from "../src/eval-interpolate.ts";

describe("Tier P — Eval binding interpolation", () => {
  // P1: Bare binding resolves from env.values
  it("P1: bare binding resolves from env.values", function* () {
    const result = interpolateEvalBindings(
      "./server --port {port}",
      { port: 49821 },
    );
    expect(result).toBe("./server --port 49821");
  });

  // P2: Bare binding with no env entry left verbatim
  it("P2: bare binding with no env entry left verbatim", function* () {
    const result = interpolateEvalBindings(
      "./server --port {port}",
      {},
    );
    expect(result).toBe("./server --port {port}");
  });

  // P3: Bare binding does not match namespaced refs
  it("P3: namespaced refs not affected by eval binding pass", function* () {
    const result = interpolateEvalBindings(
      "{meta.title} and {props.name} and {port}",
      { port: 8080 },
    );
    expect(result).toBe("{meta.title} and {props.name} and 8080");
  });

  // P4: Multiple bindings in one content
  it("P4: multiple bindings in one content", function* () {
    const result = interpolateEvalBindings(
      "{host}:{port}",
      { host: "127.0.0.1", port: 3000 },
    );
    expect(result).toBe("127.0.0.1:3000");
  });

  // P5: Non-string binding converted via String()
  it("P5: non-string binding converted via String()", function* () {
    const result = interpolateEvalBindings(
      "port={port} active={active}",
      { port: 49821, active: true },
    );
    expect(result).toBe("port=49821 active=true");
  });

  // P6: Binding interpolation leaves escaped/complex patterns alone
  it("P6: complex patterns with dots are not replaced", function* () {
    const result = interpolateEvalBindings(
      "{a.b} {c.d.e} {simple}",
      { simple: "yes" },
    );
    expect(result).toBe("{a.b} {c.d.e} yes");
  });

  // P7: Empty content returns empty string
  it("P7: empty content returns empty string", function* () {
    const result = interpolateEvalBindings("", { port: 8080 });
    expect(result).toBe("");
  });

  // P8: Content with no bindings passes through unchanged
  it("P8: content with no binding syntax passes through", function* () {
    const result = interpolateEvalBindings(
      "echo hello world",
      { port: 8080 },
    );
    expect(result).toBe("echo hello world");
  });

  // P9: Underscore and dollar sign in binding names
  it("P9: underscore and dollar sign binding names", function* () {
    const result = interpolateEvalBindings(
      "{_private} {$special} {__dunder__}",
      { _private: "a", $special: "b", __dunder__: "c" },
    );
    expect(result).toBe("a b c");
  });

  // P10: Binding value is undefined
  it("P10: undefined binding value converted via String()", function* () {
    const result = interpolateEvalBindings(
      "{x}",
      { x: undefined },
    );
    expect(result).toBe("undefined");
  });

  // P11: Binding value is null
  it("P11: null binding value converted via String()", function* () {
    const result = interpolateEvalBindings(
      "{x}",
      { x: null },
    );
    expect(result).toBe("null");
  });

  // P12: Regression — template literal ${name} is mangled by interpolation
  // The regex matches {name} inside JS template literals like `${name}`,
  // producing `$<value>`. Eval blocks must skip interpolation entirely
  // (handled by expand.ts guard). This test documents the collision so
  // the interpolation function itself is never applied to eval content.
  it("P12: regression — template literal ${name} would be mangled", function* () {
    // Demonstrates the collision: if interpolation runs on eval block content
    // containing `${port}`, the result is `$49821` instead of `${port}`.
    const result = interpolateEvalBindings(
      "const url = `http://127.0.0.1:${port}/health`;",
      { port: 49821 },
    );
    // This is the WRONG result — proves why eval blocks must skip interpolation
    expect(result).toBe("const url = `http://127.0.0.1:$49821/health`;");
    expect(result).not.toContain("${port}");
  });

  // P13: Dotted path resolves nested property
  it("P13: dotted path resolves nested property", function* () {
    const result = interpolateEvalBindings(
      "PR #{pr.meta.number}: {pr.meta.title}",
      { pr: { meta: { number: "42", title: "feat: add feature" } } },
    );
    expect(result).toBe("PR #42: feat: add feature");
  });

  // P14: Deep dotted path
  it("P14: deep dotted path resolves", function* () {
    const result = interpolateEvalBindings(
      "{a.b.c.d}",
      { a: { b: { c: { d: "deep" } } } },
    );
    expect(result).toBe("deep");
  });

  // P15: Missing intermediate in dotted path — left verbatim
  it("P15: missing intermediate in dotted path left verbatim", function* () {
    const result = interpolateEvalBindings(
      "{pr.nonexistent.field}",
      { pr: { meta: { title: "test" } } },
    );
    expect(result).toBe("{pr.nonexistent.field}");
  });

  // P16: Bare identifier still works (backward compat)
  it("P16: bare identifier still works with dotted path support", function* () {
    const result = interpolateEvalBindings(
      "port={port}",
      { port: 8080 },
    );
    expect(result).toBe("port=8080");
  });

  // P17: Root key not in bindings — left verbatim even with dots
  it("P17: root key not in bindings left verbatim", function* () {
    const result = interpolateEvalBindings(
      "{unknown.path}",
      { other: "value" },
    );
    expect(result).toBe("{unknown.path}");
  });

  // P18: Dotted path with null intermediate
  it("P18: null intermediate in dotted path left verbatim", function* () {
    const result = interpolateEvalBindings(
      "{pr.meta.title}",
      { pr: { meta: null } },
    );
    expect(result).toBe("{pr.meta.title}");
  });

  // P19: Mixed bare and dotted in same text
  it("P19: mixed bare and dotted in same text", function* () {
    const result = interpolateEvalBindings(
      "{pr.stats.totalFiles} files, port {port}",
      { pr: { stats: { totalFiles: 5 } }, port: 3000 },
    );
    expect(result).toBe("5 files, port 3000");
  });
});
