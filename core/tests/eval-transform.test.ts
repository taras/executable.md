/**
 * Tier T1 — Source transform tests (spec §11).
 *
 * Tests the transformBlock function from src/eval-transform.ts:
 * - Declaration export transforms (const, let, function, class, destructuring)
 * - Free variable import preamble injection
 * - Source map and sourceURL generation
 * - Execution mode detection (generator, async, sync)
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { transformBlock, isJson, serializeExports } from "../src/eval-transform.ts";

describe("Tier T1 — Source transform", () => {
  // T1: const declaration → env.x = x appended after
  it("T1: const declaration → env.x = x appended", function* () {
    const result = transformBlock("const x = 42;", "block-1", []);
    expect(result.code).toContain("const x = 42;");
    expect(result.code).toContain("env.x = x;");
    expect(result.exports).toContain("x");
  });

  // T2: let declaration → env.x = x appended after
  it("T2: let declaration → env.x = x appended", function* () {
    const result = transformBlock("let y = 'hello';", "block-2", []);
    expect(result.code).toContain("let y = 'hello';");
    expect(result.code).toContain("env.y = y;");
    expect(result.exports).toContain("y");
  });

  // T3: function declaration → env.f = f appended after
  it("T3: function declaration → env.f = f appended", function* () {
    const result = transformBlock("function greet() { return 'hi'; }", "block-3", []);
    expect(result.code).toContain("function greet()");
    expect(result.code).toContain("env.greet = greet;");
    expect(result.exports).toContain("greet");
  });

  // T4: class declaration → env.C = C appended after
  it("T4: class declaration → env.C = C appended", function* () {
    const result = transformBlock("class MyClass {}", "block-4", []);
    expect(result.code).toContain("class MyClass {}");
    expect(result.code).toContain("env.MyClass = MyClass;");
    expect(result.exports).toContain("MyClass");
  });

  // T5: Destructuring const { a, b } = obj → env.a = a; env.b = b
  it("T5: destructuring → env writes for each bound name", function* () {
    const result = transformBlock("const { a, b } = obj;", "block-5", ["obj"]);
    expect(result.code).toContain("env.a = a;");
    expect(result.code).toContain("env.b = b;");
    expect(result.exports).toContain("a");
    expect(result.exports).toContain("b");
  });

  // T6: Nested declaration (inside if) → NOT exported
  it("T6: nested declaration inside if → not exported", function* () {
    const result = transformBlock("if (true) { const inner = 1; }", "block-6", []);
    expect(result.exports).not.toContain("inner");
    expect(result.code).not.toContain("env.inner");
  });

  // T7: Free variable in currentEnvKeys → injected as preamble
  it("T7: free variable in currentEnvKeys → preamble injection", function* () {
    const result = transformBlock("const y = x + 1;", "block-7", ["x"]);
    expect(result.code).toContain("const { x } = env;");
    expect(result.imports).toContain("x");
  });

  // T8: Free variable NOT in currentEnvKeys → not injected
  it("T8: free variable not in env → no injection", function* () {
    const result = transformBlock("const y = unknownVar;", "block-8", []);
    expect(result.code).not.toContain("const { unknownVar } = env;");
    expect(result.imports).not.toContain("unknownVar");
  });

  // T9: Block with no declarations → no env-writes, no error
  it("T9: no declarations → no env-writes, no error", function* () {
    const result = transformBlock("console.log('hello');", "block-9", []);
    expect(result.exports).toEqual([]);
    expect(result.code).not.toContain("env.");
    expect(result.code).toContain("console.log('hello');");
  });

  // T10: Source map generated
  it("T10: source map generated", function* () {
    const result = transformBlock("const x = 1;", "block-10", []);
    expect(result.map).toBeTruthy();
    const mapObj = JSON.parse(result.map);
    expect(mapObj.version).toBe(3);
    expect(mapObj.sources).toContain("block-10");
  });

  // T11: //# sourceURL appended
  it("T11: sourceURL appended", function* () {
    const result = transformBlock("const x = 1;", "block-11", []);
    expect(result.code).toContain("//# sourceURL=eval:block-11");
  });

  // T12: Top-level yield → mode "generator"
  it("T12: top-level yield → mode generator", function* () {
    const result = transformBlock("const x = yield* someOp();", "block-12", ["someOp"]);
    expect(result.mode).toBe("generator");
  });

  // T13: Top-level await → mode "async"
  it("T13: top-level await → mode async", function* () {
    const result = transformBlock("const x = await fetch('/api');", "block-13", ["fetch"]);
    expect(result.mode).toBe("async");
  });

  // T14: Neither yield nor await → mode "sync"
  it("T14: no yield/await → mode sync", function* () {
    const result = transformBlock("const x = 42;", "block-14", []);
    expect(result.mode).toBe("sync");
  });

  // T15: yield inside nested function → does NOT set mode to "generator"
  it("T15: yield inside nested function → not generator", function* () {
    const result = transformBlock(
      "const fn = function*() { yield 1; };",
      "block-15",
      [],
    );
    expect(result.mode).toBe("sync");
  });

  // T16: Both top-level yield and await → transform-time error
  it("T16: both yield and await → error", function* () {
    expect(() =>
      transformBlock(
        "const x = yield* op();\nconst y = await fetch();",
        "block-16",
        ["op", "fetch"],
      ),
    ).toThrow("Cannot mix");
  });
});

// ---------------------------------------------------------------------------
// User import extraction
// ---------------------------------------------------------------------------

describe("User import extraction", () => {
  // T17: Single-line import → extracted in userImports, removed from code
  it("T17: single-line import extracted", function* () {
    const result = transformBlock(
      'import { parseDiff } from "@executablemd/code-review-agent";\n\nconst pr = parseDiff();',
      "block-17",
      [],
    );
    expect(result.userImports).toHaveLength(1);
    expect(result.userImports[0]).toBe(
      'import { parseDiff } from "@executablemd/code-review-agent";',
    );
    expect(result.code).not.toContain("import");
    expect(result.code).toContain("const pr = parseDiff();");
    expect(result.exports).toContain("pr");
  });

  // T18: import type → extracted correctly (TypeScript syntax preserved)
  it("T18: import type preserved in userImports", function* () {
    const result = transformBlock(
      'import type { PR } from "@executablemd/code-review-agent";\n\nconst x = 1;',
      "block-18",
      [],
    );
    expect(result.userImports).toHaveLength(1);
    expect(result.userImports[0]).toBe(
      'import type { PR } from "@executablemd/code-review-agent";',
    );
    expect(result.code).not.toContain("import");
    expect(result.code).toContain("const x = 1;");
  });

  // T19: import + const + yield* → import extracted, const exported, mode=generator
  it("T19: import + const + yield coexist", function* () {
    const result = transformBlock(
      'import { foo } from "pkg";\n\nconst x = yield* foo();',
      "block-19",
      [],
    );
    expect(result.userImports).toHaveLength(1);
    expect(result.userImports[0]).toBe('import { foo } from "pkg";');
    expect(result.exports).toContain("x");
    expect(result.mode).toBe("generator");
    expect(result.code).not.toContain("import");
    expect(result.code).toContain("env.x = x;");
  });

  // T20: dynamic import() expression → NOT extracted, stays in code
  it("T20: dynamic import() not extracted", function* () {
    const result = transformBlock(
      'const mod = await import("pkg");',
      "block-20",
      [],
    );
    expect(result.userImports).toHaveLength(0);
    expect(result.code).toContain('import("pkg")');
    expect(result.mode).toBe("async");
  });

  // T21: multi-line import → extracted as single string
  it("T21: multi-line import extracted", function* () {
    const source = [
      "import {",
      "  parseDiff,",
      "  somethingElse,",
      '} from "pkg";',
      "",
      "const x = parseDiff();",
    ].join("\n");
    const result = transformBlock(source, "block-21", []);
    expect(result.userImports).toHaveLength(1);
    expect(result.userImports[0]).toContain("parseDiff");
    expect(result.userImports[0]).toContain("somethingElse");
    expect(result.userImports[0]).toContain('from "pkg"');
    expect(result.code).not.toContain('from "pkg"');
    expect(result.code).toContain("const x = parseDiff();");
  });

  // T22: no imports → userImports empty, code unchanged (backward compat)
  it("T22: no imports → empty userImports", function* () {
    const result = transformBlock("const x = 42;", "block-22", []);
    expect(result.userImports).toHaveLength(0);
    expect(result.code).toContain("const x = 42;");
    expect(result.exports).toContain("x");
  });

  // T23: multiple imports → all extracted
  it("T23: multiple imports all extracted", function* () {
    const source = [
      'import { a } from "pkg-a";',
      'import { b } from "pkg-b";',
      "",
      "const x = a + b;",
    ].join("\n");
    const result = transformBlock(source, "block-23", []);
    expect(result.userImports).toHaveLength(2);
    expect(result.userImports[0]).toBe('import { a } from "pkg-a";');
    expect(result.userImports[1]).toBe('import { b } from "pkg-b";');
    expect(result.code).not.toContain('from "pkg-a"');
    expect(result.code).not.toContain('from "pkg-b"');
    expect(result.code).toContain("const x = a + b;");
  });
});

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

describe("isJson", () => {
  it("primitives are JSON", function* () {
    expect(isJson(null)).toBe(true);
    expect(isJson(42)).toBe(true);
    expect(isJson("hello")).toBe(true);
    expect(isJson(true)).toBe(true);
  });

  it("plain objects and arrays are JSON", function* () {
    expect(isJson({ a: 1 })).toBe(true);
    expect(isJson([1, 2, 3])).toBe(true);
    expect(isJson({ nested: { deep: [1, "two"] } })).toBe(true);
  });

  it("functions are not JSON", function* () {
    expect(isJson(() => {})).toBe(false);
  });

  it("class instances are not JSON", function* () {
    class Foo {}
    expect(isJson(new Foo())).toBe(false);
  });

  it("undefined is not JSON", function* () {
    expect(isJson(undefined)).toBe(false);
  });
});

describe("serializeExports", () => {
  it("extracts named JSON-serializable values", function* () {
    const env = { port: 3000, host: "localhost", fn: () => {} };
    const result = serializeExports(env, ["port", "host", "fn"]);
    expect(result["port"]).toBe(3000);
    expect(result["host"]).toBe("localhost");
    expect(result["fn"]).toBeUndefined();
  });

  it("handles empty names array", function* () {
    const result = serializeExports({ x: 1 }, []);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
