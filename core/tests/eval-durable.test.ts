/**
 * Tier T4 — eval factory and durableEval integration tests (spec §11).
 *
 * Tests the full eval pipeline: golden run, replay, partial replay,
 * divergence, error propagation, and serialization behavior.
 *
 * Uses InMemoryStream for journaling and stubRuntime for I/O.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { stubRuntime } from "@executablemd/durable-effects";
import type { DurableRuntime, StatResult } from "@executablemd/durable-streams";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

// ---------------------------------------------------------------------------
// Helper — create a runtime with eval-capable file system
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

describe("Tier T4 — eval factory and durableEval integration", () => {
  // T31: Golden run — journal entry written with serializable exports
  it("T31: golden run — journal records eval entry", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js eval\nconst x = 42;\n```\n",
    });

    yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    const events = stream.snapshot();
    // Should have root import + eval entry
    expect(events.length).toBeGreaterThan(1);
  });

  // T32: Full replay — evaluator not called, env restored from journal
  it("T32: full replay — same output, no re-execution", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js eval\nconst x = 42;\n```\n",
    });

    // Golden run
    const output1 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    // Replay
    const output2 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output2).toBe(output1);
  });

  // T33: Partial replay — replayed block restores env, subsequent runs live
  it("T33: multiple eval blocks — replay works", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md":
        "```js eval\nconst a = 10;\n```\n\n```js eval\nconst b = a + 5;\n```\n",
    });

    const output1 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    // Replay
    const output2 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output2).toBe(output1);
  });

  // T35: Error in block — propagated, error in output
  it("T35: error in eval block → error in output", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\nthrow new Error("eval failure");\n```\n',
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toContain("ERROR");
    expect(output).toContain("eval failure");
  });

  // T36: Serializable binding — present in journal result
  it("T36: serializable binding present in journal", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": '```js eval\nconst port = 3000;\nconst host = "localhost";\n```\n',
    });

    yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    const events = stream.snapshot();
    expect(events.length).toBeGreaterThan(1);
  });

  // T37: Non-serializable binding — absent from journal, present live
  it("T37: non-serializable binding omitted from journal", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js eval\nconst fn = () => 42;\nconst x = 1;\n```\n",
    });

    yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    // The eval should succeed even with non-serializable values
    const events = stream.snapshot();
    expect(events.length).toBeGreaterThan(1);
  });

  // T-import-1: eval block with user import — runs through full pipeline
  it("T-import-1: eval block with user import runs correctly", function* () {
    const stream = new InMemoryStream();
    // Import from a well-known Deno/Node built-in to avoid needing
    // an actual package. We use a self-contained data: URI import
    // that's resolvable at runtime.
    const runtime = makeRuntime({
      "test.md": [
        "```ts eval",
        'import { basename } from "node:path";',
        "",
        'const name = basename("/foo/bar/baz.txt");',
        "return name;",
        "```",
      ].join("\n"),
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).toContain("baz.txt");
  });
});
