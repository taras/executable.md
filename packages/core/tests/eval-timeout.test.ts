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
import { Config } from "@executablemd/runtime";
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

  it("timeout modifier with no declared duration", function* () {
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

  /**
   * The contextual timeout is what an exec block is bounded by (#153). These
   * two run real commands rather than the echo stub: what is under test is the
   * duration the Process Api resolves, which a stub would answer for.
   */
  it("T54: an exec block that declares no duration is bounded by the contextual one", function* () {
    const stream = new InMemoryStream();
    yield* Config.around({ timeout: () => 25 }, { at: "min" });
    yield* useStubFs({
      "test.md": "```bash exec\nsleep 2\n```\n",
    });

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("timed out after 25ms");
  });

  it("T56: a timeout modifier that names no duration falls back to the run's", function* () {
    const stream = new InMemoryStream();
    yield* Config.around({ timeout: () => 25 }, { at: "min" });
    yield* useStubFs({
      "test.md": "```bash timeout exec\nsleep 2\n```\n",
    });

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("timed out after 25ms");
  });

  /**
   * An eval block reaches no Process Api, so the only thing that can bound it
   * is the modifier's own timebox. That is what makes this the case for the
   * fallback itself rather than for what a command inherits.
   */
  it("T57: the timebox of a modifier that names no duration is the run's timeout", function* () {
    const stream = new InMemoryStream();
    yield* Config.around({ timeout: () => 25 }, { at: "min" });
    yield* useStubFs({
      "test.md": '```ts timeout eval\nyield* sleep(300);\noutput("SLEPT");\n```\n',
    });

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("eval block timed out after 25ms");
    expect(output).not.toContain("SLEPT");
  });

  it("T55: a block's declared duration outranks a shorter contextual one", function* () {
    const stream = new InMemoryStream();
    yield* Config.around({ timeout: () => 25 }, { at: "min" });
    yield* useStubFs({
      "test.md": "```bash timeout=5s exec\nsleep 0.3 && echo RAISED\n```\n",
    });

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("RAISED");
    expect(output).not.toContain("timed out");
  });
});
