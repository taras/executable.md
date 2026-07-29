/**
 * Tier T6 — persist modifier tests (spec §11).
 *
 * Tests persist modifier behavior: blocks complete normally,
 * bindings are available across blocks, replay works.
 *
 * Note: In v1, persist delegates directly to next() — actual
 * resource retention via evalScope.eval() is deferred to v2.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { asText } from "./helpers.ts";
import { unbox } from "effection";
import type { Result } from "effection";

describe("Tier T6 — persist modifier", () => {
  beforeAll(() => useTempFileCompiler());
  // T43: eval without persist → block completes normally
  it("T43: eval without persist → block completes", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\nconst x = 42;\n```\n",
    });
    yield* useEchoExec();

    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    expect(output).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T44: persist eval → block completes normally
  it("T44: persist eval → block completes normally", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js persist eval\nconst server = 'running';\n```\n",
    });
    yield* useEchoExec();

    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    expect(output).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T45: persist eval followed by eval → bindings available
  it("T45: persist eval followed by eval → bindings available", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md":
        "```js persist eval\nconst server = 'started';\n```\n\n```js eval\nconst status = server;\n```\n",
    });
    yield* useEchoExec();

    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    expect(output.trim()).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T46: persist on replay → no-op
  it("T46: persist on replay → normal replay", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js persist eval\nconst x = 42;\n```\n",
    });
    yield* useEchoExec();

    const output1 = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    const output2 = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

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

  // L2: without persist, a resource a block spawns is torn down when the block
  // completes — the negative that gives L3 its meaning.
  it("L2: a non-persist eval block's resource is gone by the next block", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": [
        "```js eval",
        "const status = { alive: false };",
        "yield* spawn(function*() {",
        "  status.alive = true;",
        "  try { yield* suspend(); } finally { status.alive = false; }",
        "});",
        "yield* sleep(1);",
        "```",
        "",
        "```js eval",
        "const observed = status.alive;",
        "output(`alive=${observed}`);",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "test.md", stream }));

    expect(output).toContain("alive=false");
  });

  // L3: a persist resource belongs to the invocation, so a block after the
  // component sees it gone while the document is still running.
  it("L3: a persist resource stops when the invocation completes", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Holder.md": [
        "```js persist eval",
        "globalThis.__l3 = { alive: false };",
        "yield* spawn(function*() {",
        "  globalThis.__l3.alive = true;",
        "  try { yield* suspend(); } finally { globalThis.__l3.alive = false; }",
        "});",
        "yield* sleep(1);",
        "```",
      ].join("\n"),
      "doc.md": [
        "<Holder />",
        "",
        "```js eval",
        "output(`alive=${globalThis.__l3.alive}`);",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    expect(output).toContain("alive=false");
  });

  // T49b: persist eval retains spawned resource across blocks
  // A background task spawned in a persist eval block sets status.ready
  // after 10ms. The next eval block uses when() to converge on it.
  it("T49b: persist eval retains spawned resource across blocks", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
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
        "yield* when(function*() {",
        '  if (!status.ready) throw new Error("not ready");',
        "});",
        "const serverReady = status.ready;",
        "```",
      ].join("\n"),
    });
    yield* useEchoExec();

    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    expect(output.trim()).toBe("");
    expect(output).not.toContain("ERROR");
  });
});
