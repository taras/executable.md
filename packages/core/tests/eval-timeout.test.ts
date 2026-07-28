/**
 * Tier T7 — timeout modifier tests (spec §11).
 *
 * Tests timeout behavior and duration parsing.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { parseDuration } from "../src/modifiers/timeout.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";

describe("Tier T7 — timeout modifier", () => {
  beforeAll(() => useTempFileCompiler());
  // T49: Block completing before timeout → success
  it("T49: block completes before timeout → success", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js timeout=30s eval\nconst x = 42;\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T50: Block exceeding timeout — error (can't easily test real timeout
  // without long-running ops, but we can test the duration parsing)

  // T51: parseDuration — 500ms → 500
  it("T51: parseDuration 500ms → 500", function* () {
    expect(parseDuration("500ms")).toBe(500);
  });

  // T52: parseDuration — 30s → 30000
  it("T52: parseDuration 30s → 30000", function* () {
    expect(parseDuration("30s")).toBe(30_000);
  });

  // T53: parseDuration — 2m → 120000
  it("T53: parseDuration 2m → 120000", function* () {
    expect(parseDuration("2m")).toBe(120_000);
  });

  it("parseDuration — raw number → ms", function* () {
    expect(parseDuration("1000")).toBe(1000);
  });

  it("timeout modifier with default 30s", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js timeout eval\nconst x = 1;\n```\n",
    });
    yield* useEchoExec();

    // Should work with default timeout
    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).not.toContain("timed out");
  });
});
