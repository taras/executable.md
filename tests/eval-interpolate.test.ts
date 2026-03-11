/**
 * Tier P — Eval binding interpolation tests.
 *
 * Verifies that bare `{name}` references in code block content resolve
 * from the eval binding environment (env.values).
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
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
});
