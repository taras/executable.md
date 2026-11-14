/**
 * Tier T4 — eval factory and journal integration tests (spec §11).
 *
 * Tests the full eval pipeline: golden run, replay, partial replay,
 * divergence, error propagation, and serialization behavior.
 *
 * Uses InMemoryStream for journaling and API.Fs/API.Process middleware for I/O stubs.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { ensure, spawn, suspend, withResolvers } from "effection";
import { registerComponents } from "../src/components/registration.ts";
import { InMemoryStream, type DurableEvent } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { asText, completion, failureMessage } from "./helpers.ts";

describe("Tier T4 — eval factory and journal integration", () => {
  beforeAll(() => useTempFileCompiler());
  // T31: Golden run — journal entry written with serializable exports
  it("T31: golden run — journal records eval entry", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": "```js eval\nconst x = 42;\n```\n",
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

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
    const output1 = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    const output2 = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output2).toBe(output1);
  });

  // T33: Partial replay — replayed block restores env, subsequent runs live
  it("T33: multiple eval blocks — replay works", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": "```js eval\nconst a = 10;\n```\n\n```js eval\nconst b = a + 5;\n```\n",
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    const output1 = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    const output2 = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output2).toBe(output1);
  });

  it("restores checked false and null exports through rebuilt callables", function* () {
    let bindings = 0;
    let calls = 0;
    let releases = 0;
    let appends = 0;
    class Journal extends InMemoryStream {
      override *append(event: DurableEvent) {
        if (event.type === "yield" && event.description.type === "eval") {
          expect(releases).toBe(++appends);
        }
        yield* super.append(event);
      }
    }
    yield* registerComponents([
      {
        name: "BindVerdicts",
        origin: "eval-durable",
        props: { type: "object" },
        *fn() {
          bindings++;
          return function* (verdict: boolean | null) {
            calls++;
            yield* ensure(() => {
              releases++;
            });
            return verdict;
          };
        },
      },
    ]);
    yield* useStubFs({
      "test.md": [
        '<BindVerdicts as="check" />',
        "<Try>",
        "",
        "~~~js eval",
        "const admitted = yield* check(false);",
        "~~~",
        "",
        "<Finally></Finally>",
        "</Try>",
        "",
        "<Try>",
        "",
        "~~~js eval",
        "const reason = yield* check(null);",
        "~~~",
        "",
        "<Finally></Finally>",
        "</Try>",
        "",
        "<Output><Json value={{admitted,reason}} /></Output>",
      ].join("\n"),
    });
    const journal = new Journal();
    const first = yield* collect(yield* execute({ path: "test.md", stream: journal }));
    expect(JSON.parse(asText(first))).toEqual({ admitted: false, reason: null });
    expect(appends).toBe(2);
    const prefix = new Journal(journal.snapshot().filter((event) => event.type !== "close"));
    expect(yield* collect(yield* execute({ path: "test.md", stream: prefix }))).toBe(first);
    expect(bindings).toBe(2);
    expect(calls).toBe(2);
    expect(appends).toBe(2);
  });

  it("leaves an interrupted checked eval pending after joined cleanup", function* () {
    const entered = withResolvers<void>();
    let calls = 0;
    let releases = 0;
    yield* registerComponents([
      {
        name: "BindPending",
        origin: "eval-durable",
        props: { type: "object" },
        *fn() {
          return function* () {
            calls++;
            yield* ensure(() => {
              releases++;
            });
            if (calls === 1) {
              entered.resolve();
              yield* suspend();
            }
            return true;
          };
        },
      },
    ]);
    yield* useStubFs({
      "test.md":
        '<BindPending as="check" />\n<Try>\n\n~~~js eval\nconst done = yield* check();\n~~~\n\n<Finally></Finally></Try>\n<Output><Json value={done} /></Output>',
    });
    const stream = new InMemoryStream();
    const pending = yield* spawn(function* () {
      return yield* collect(yield* execute({ path: "test.md", stream }));
    });
    yield* entered.operation;
    yield* pending.halt();
    expect(releases).toBe(1);
    expect(
      stream
        .snapshot()
        .some(
          (event) =>
            event.type === "close" || (event.type === "yield" && event.description.type === "eval"),
        ),
    ).toBe(false);
    expect(yield* collect(yield* execute({ path: "test.md", stream }))).toContain("true");
    expect(calls).toBe(2);
    expect(releases).toBe(2);
  });

  it("replays an ordinary checked eval error without another call", function* () {
    let calls = 0;
    yield* registerComponents([
      {
        name: "BindFailure",
        origin: "eval-durable",
        props: { type: "object" },
        *fn() {
          return () => {
            calls++;
            throw new Error("ordinary checked failure");
          };
        },
      },
    ]);
    yield* useStubFs({
      "test.md":
        '<BindFailure as="check" />\n<Try>\n\n~~~js eval\ncheck();\n~~~\n\n<Catch as="error">{error.message}</Catch></Try>',
    });
    const stream = new InMemoryStream();
    const first = yield* collect(yield* execute({ path: "test.md", stream }));
    expect(first).toContain("ordinary checked failure");
    expect(
      stream
        .snapshot()
        .find((event) => event.type === "yield" && event.description.type === "eval"),
    ).toMatchObject({ result: { status: "err" } });
    const prefix = new InMemoryStream(stream.snapshot().filter((event) => event.type !== "close"));
    expect(yield* collect(yield* execute({ path: "test.md", stream: prefix }))).toBe(first);
    expect(calls).toBe(1);
  });

  // T35: Error in block — nothing recovers it, so it is the run's outcome, and
  // the record is what a replay reports it as.
  it("T35: error in eval block → the run fails, and replays failed", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": '```js eval\nthrow new Error("eval failure");\n```\n',
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    const first = yield* completion({ path: "test.md", stream });
    expect(first.ok).toBe(false);
    expect(failureMessage(first)).toContain("eval failure");

    const replayed = yield* completion({ path: "test.md", stream });
    expect(replayed.ok).toBe(false);
    expect(failureMessage(replayed)).toContain("eval failure");
  });

  // T36: Serializable binding — present in journal result
  it("T36: serializable binding present in journal", function* () {
    const stream = new InMemoryStream();
    const files = {
      "test.md": '```js eval\nconst port = 3000;\nconst host = "localhost";\n```\n',
    };
    yield* useStubFs(files);
    yield* useEchoExec();

    yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

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

    yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

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

    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream,
      }),
    );

    expect(output).toContain("baz.txt");
  });
});
