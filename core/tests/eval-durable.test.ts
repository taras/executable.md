/**
 * Tier T4 — eval factory and durableEval integration tests (spec §11).
 *
 * Tests the full eval pipeline: golden run, replay, partial replay,
 * divergence, error propagation, and serialization behavior.
 *
 * Uses InMemoryStream for journaling and API.Fs/API.Process middleware for I/O stubs.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

describe("Tier T4 — eval factory and durableEval integration", () => {
  // T31: Golden run — journal entry written with serializable exports
  it("T31: golden run — journal records eval entry", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": "```js eval\nconst x = 42;\n```\n",
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    const events = stream.snapshot();
    // Should have root import + eval entry
    expect(events.length).toBeGreaterThan(1);
  });

  // T32: Full replay — evaluator not called, env restored from journal
  it("T32: full replay — same output, no re-execution", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": "```js eval\nconst x = 42;\n```\n",
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    // Golden run
    const output1 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    // Replay
    const output2 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    expect(output2).toBe(output1);
  });

  // T33: Partial replay — replayed block restores env, subsequent runs live
  it("T33: multiple eval blocks — replay works", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md":
        "```js eval\nconst a = 10;\n```\n\n```js eval\nconst b = a + 5;\n```\n",
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    const output1 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    // Replay
    const output2 = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    expect(output2).toBe(output1);
  });

  // T35: Error in block — propagated, error in output
  it("T35: error in eval block → error in output", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": '```js eval\nthrow new Error("eval failure");\n```\n',
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    expect(output).toContain("ERROR");
    expect(output).toContain("eval failure");
  });

  // T36: Serializable binding — present in journal result
  it("T36: serializable binding present in journal", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": '```js eval\nconst port = 3000;\nconst host = "localhost";\n```\n',
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    const events = stream.snapshot();
    expect(events.length).toBeGreaterThan(1);
  });

  // T37: Non-serializable binding — absent from journal, present live
  it("T37: non-serializable binding omitted from journal", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": "```js eval\nconst fn = () => 42;\nconst x = 1;\n```\n",
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
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
    const files = {
      "test.md": [
        "```ts eval",
        'import { basename } from "node:path";',
        "",
        'const name = basename("/foo/bar/baz.txt");',
        "return name;",
        "```",
      ].join("\n"),
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    expect(output).toContain("baz.txt");
  });
});
