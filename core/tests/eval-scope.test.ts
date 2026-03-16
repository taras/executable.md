/**
 * Tier T10 — eval-scope hierarchy tests (spec §11).
 *
 * Tests that eval scopes are properly scoped to components and
 * that child/parent scope relationships work correctly.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@effectionx/durable-streams";
import { stubRuntime } from "@effectionx/durable-effects";
import type { DurableRuntime, StatResult } from "@effectionx/durable-streams";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

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

describe("Tier T10 — eval-scope hierarchy", () => {
  // T61: Document with eval blocks — scope created per document
  it("T61: eval blocks run within document scope", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md":
        "```js eval\nconst a = 1;\n```\n\n```js eval\nconst b = a + 1;\n```\n",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    // Both blocks should execute without error
    // Text between two adjacent eval blocks may produce a newline
    expect(output.trim()).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T62: Eval blocks coexist with exec blocks
  it("T62: eval and exec blocks coexist", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md":
        "```js eval\nconst x = 42;\n```\n\n```bash exec\necho hello\n```\n\n```js eval\nconst y = x + 1;\n```\n",
    });

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    // Exec output should be present
    expect(output).toContain("hello");
    // No errors
    expect(output).not.toContain("ERROR");
  });
});
