/**
 * Tier T6 — persist modifier tests (spec §11).
 *
 * Tests persist modifier behavior: blocks complete normally,
 * bindings are available across blocks, replay works.
 *
 * Note: In v1, persist delegates directly to next() — actual
 * resource retention via evalScope.eval() is deferred to v2.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { stubRuntime } from "@executablemd/durable-effects";
import type { DurableRuntime, StatResult } from "@executablemd/durable-streams";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";
import { unbox } from "effection";
import type { Result } from "effection";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeRuntime(files: Record<string, string>): DurableRuntime {
  return stubRuntime({
    *readTextFile(path: string) {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${path}`);
      }
      return content;
    },
    *stat(path: string): Generator<never, StatResult, unknown> {
      const exists = path in files;
      return { exists, isFile: exists, isDirectory: false };
    },
    *exec(options: { command: string[]; timeout?: number }) {
      const script = (options.command[2] ?? "").trim();
      if (script.startsWith("echo ")) {
        return { exitCode: 0, stdout: script.slice(5) + "\n", stderr: "" };
      }
      return { exitCode: 0, stdout: script + "\n", stderr: "" };
    },
  });
}

describe("Tier T6 — persist modifier", () => {
  // T43: eval without persist → block completes normally
  it("T43: eval without persist → block completes", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js eval\nconst x = 42;\n```\n",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T44: persist eval → block completes normally
  it("T44: persist eval → block completes normally", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js persist eval\nconst server = 'running';\n```\n",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T45: persist eval followed by eval → bindings available
  it("T45: persist eval followed by eval → bindings available", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md":
        "```js persist eval\nconst server = 'started';\n```\n\n```js eval\nconst status = server;\n```\n",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output.trim()).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T46: persist on replay → no-op
  it("T46: persist on replay → normal replay", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js persist eval\nconst x = 42;\n```\n",
    });

    const output1 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    const output2 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output2).toBe(output1);
  });

  // T47: unbox extracts Ok value
  it("T47: unbox extracts Ok value", function* () {
    const result: Result<number> = { ok: true, value: 42 };
    expect(unbox(result)).toBe(42);
  });

  // T48: unbox rethrows Err
  it("T48: unbox rethrows Err", function* () {
    const result: Result<number> = { ok: false, error: new Error("fail") };
    let threw = false;
    try {
      unbox(result);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("fail");
    }
    expect(threw).toBe(true);
  });

  // T49b: persist eval retains spawned resource across blocks
  // A background task spawned in a persist eval block sets status.ready
  // after 10ms. The next eval block uses when() to converge on it.
  it("T49b: persist eval retains spawned resource across blocks", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": [
        "```js persist eval",
        "const status = { ready: false };",
        "yield* spawn(function*() {",
        "  yield* sleep(10);",
        "  status.ready = true;",
        "});",
        "```",
        "",
        "```js eval",
        'yield* when(function*() {',
        '  if (!status.ready) throw new Error("not ready");',
        "});",
        "const serverReady = status.ready;",
        "```",
      ].join("\n"),
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output.trim()).toBe("");
    expect(output).not.toContain("ERROR");
  });
});
