/**
 * Eval block return value tests.
 *
 * Verifies that if an eval block's generator returns a non-null value,
 * that value becomes the block's rendered output. output() takes
 * precedence over return. Null/undefined returns produce no output.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { journalCases } from "../../test-support/journal-cases.ts";

const journalCase = journalCases("packages/core/tests/eval-return.test.ts");

describe("Eval block return value", () => {
  beforeAll(() => useTempFileCompiler());
  // ER1: return string → rendered output
  journalCase("ER1: return string → rendered output", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": '```js eval\nreturn "hello from eval";\n```\n',
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).toContain("hello from eval");
  });

  // ER2: return number → coerced to string
  journalCase("ER2: return number → coerced to string", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": "```js eval\nreturn 42;\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).toContain("42");
  });

  // ER3: return null → no output
  journalCase("ER3: return null → no output", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": "before\n```js eval\nreturn null;\n```\nafter",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    // No output from the eval block
    expect(output).toBe("before\nafter");
  });

  // ER4: return undefined → no output
  journalCase("ER4: return undefined → no output", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": "before\n```js eval\nreturn undefined;\n```\nafter",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).toBe("before\nafter");
  });

  // ER5: output() takes precedence over return
  journalCase("ER5: output() takes precedence over return", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": '```js eval\noutput("explicit");\nreturn "ignored";\n```\n',
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).toContain("explicit");
    expect(output).not.toContain("ignored");
  });

  // ER6: return in persist eval → works same as normal
  journalCase("ER6: return in persist eval → works same as normal", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": '```js persist eval\nreturn "persisted output";\n```\n',
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).toContain("persisted output");
  });

  // ER7: no return → no output (existing behavior)
  journalCase("ER7: no return → no output (existing behavior)", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": "before\n```js eval\nconst x = 42;\n```\nafter",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    // Eval block with no return produces no output
    expect(output).toBe("before\nafter");
  });

  // ER8: return value journaled + replayed correctly
  it("ER8: return value journaled and replayed correctly", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": '```js eval\nreturn "replay-me";\n```\n',
    });
    yield* useEchoExec();

    // Golden run
    const output1 = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output1).toContain("replay-me");

    const output2 = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output2).toContain("replay-me");
  });
});
