/**
 * Eval block return value tests.
 *
 * Verifies that if an eval block's generator returns a non-null value,
 * that value becomes the block's rendered output. output() takes
 * precedence over return. Null/undefined returns produce no output.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { stubRuntime } from "@executablemd/durable-effects";
import type { DurableRuntime, StatResult } from "@executablemd/durable-streams";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeRuntime(files: Record<string, string>): DurableRuntime {
  return stubRuntime({
    *readTextFile(filePath: string) {
      const content = files[filePath];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${filePath}`);
      }
      return content;
    },
    *stat(filePath: string): Generator<never, StatResult, unknown> {
      const exists = filePath in files;
      return { exists, isFile: exists, isDirectory: false };
    },
    *exec(options: { command: string[]; timeout?: number }) {
      const cmd = options.command.join(" ");
      if (cmd.includes("bash -c")) {
        const script = (options.command[2] ?? "").trim();
        if (script.startsWith("echo ")) {
          return { exitCode: 0, stdout: script.slice(5) + "\n", stderr: "" };
        }
        return { exitCode: 0, stdout: script + "\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

describe("Eval block return value", () => {
  // ER1: return string → rendered output
  it("ER1: return string → rendered output", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\nreturn "hello from eval";\n```\n',
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toContain("hello from eval");
  });

  // ER2: return number → coerced to string
  it("ER2: return number → coerced to string", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js eval\nreturn 42;\n```\n",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toContain("42");
  });

  // ER3: return null → no output
  it("ER3: return null → no output", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "before\n```js eval\nreturn null;\n```\nafter",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    // No output from the eval block
    expect(output).toBe("before\nafter");
  });

  // ER4: return undefined → no output
  it("ER4: return undefined → no output", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "before\n```js eval\nreturn undefined;\n```\nafter",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toBe("before\nafter");
  });

  // ER5: output() takes precedence over return
  it("ER5: output() takes precedence over return", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\noutput("explicit");\nreturn "ignored";\n```\n',
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toContain("explicit");
    expect(output).not.toContain("ignored");
  });

  // ER6: return in persist eval → works same as normal
  it("ER6: return in persist eval → works same as normal", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js persist eval\nreturn "persisted output";\n```\n',
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toContain("persisted output");
  });

  // ER7: no return → no output (existing behavior)
  it("ER7: no return → no output (existing behavior)", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "before\n```js eval\nconst x = 42;\n```\nafter",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    // Eval block with no return produces no output
    expect(output).toBe("before\nafter");
  });

  // ER8: return value journaled + replayed correctly
  it("ER8: return value journaled and replayed correctly", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\nreturn "replay-me";\n```\n',
    });

    // Golden run
    const output1 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output1).toContain("replay-me");

    // Replay
    const output2 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output2).toContain("replay-me");
  });
});
