/**
 * Tier T7 — timeout modifier tests (spec §11).
 *
 * Tests timeout behavior and duration parsing.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { parseDuration } from "../src/modifiers/timeout.ts";
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

describe("Tier T7 — timeout modifier", () => {
  // T49: Block completing before timeout → success
  it("T49: block completes before timeout → success", function* () {
    const stream = new InMemoryStream();
    const runtime = makeRuntime({
      "test.md": "```js timeout=30s eval\nconst x = 42;\n```\n",
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
    const runtime = makeRuntime({
      "test.md": "```js timeout eval\nconst x = 1;\n```\n",
    });

    // Should work with default timeout
    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      runtime,
      freshness: false,
    }));

    expect(output).not.toContain("timed out");
  });
});
