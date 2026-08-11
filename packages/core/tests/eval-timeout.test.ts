/**
 * Tier T7 — the timeout modifier around an eval block (spec §3.3).
 *
 * An eval block reaches no Process operation, so the modifier's own timebox is
 * the only thing that can bound it. That is what these cases read: what the
 * block is boxed at, and where that number came from. The duration grammar
 * lives with the parser (Tier DU) and what reaches a command lives with the
 * exec terminal (Tier XE).
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Config } from "@executablemd/runtime";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";

describe("Tier T7 — timeout modifier", () => {
  beforeAll(() => useTempFileCompiler());

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

  it("T50: a bare timeout boxes the block at the run's exec default", function* () {
    const stream = new InMemoryStream();
    yield* Config.around({ timeoutExec: () => 30_000 }, { at: "min" });
    yield* useStubFs({
      "test.md": "```js timeout eval\nconst x = 1;\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).not.toContain("timed out");
  });

  it("T50a: a bare timeout with no exec default refuses instead of running unbounded", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js timeout eval\nconst x = 1;\n```\n",
    });

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("names no duration");
  });

  /**
   * The timebox itself, at the value the run configured: an eval block that
   * sleeps past it is cancelled, and the message names the duration used.
   */
  it("T57: the timebox of a bare timeout is the run's exec default", function* () {
    const stream = new InMemoryStream();
    yield* Config.around({ timeoutExec: () => 25 }, { at: "min" });
    yield* useStubFs({
      "test.md": '```ts timeout eval\nyield* sleep(300);\noutput("SLEPT");\n```\n',
    });

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("eval block timed out after 25ms");
    expect(output).not.toContain("SLEPT");
  });

  it("T58: a declared duration boxes the block at what it declared", function* () {
    const stream = new InMemoryStream();
    yield* Config.around({ timeoutExec: () => 60_000 }, { at: "min" });
    yield* useStubFs({
      "test.md": '```ts timeout=25ms eval\nyield* sleep(300);\noutput("SLEPT");\n```\n',
    });

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("eval block timed out after 25ms");
    expect(output).not.toContain("SLEPT");
  });
});
