/**
 * Tier T5 — Binding environment tests (spec §11).
 *
 * Tests cross-block binding sharing, shadowing, empty blocks,
 * undeclared references, and syntax errors.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

describe("Tier T5 — Binding environment", () => {
  // T38: Block 2 reads binding exported by Block 1 via env preamble
  it("T38: block 2 reads binding from block 1", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md":
        "```js eval\nconst port = 8080;\n```\n\n```js eval\nconst url = 'http://localhost:' + port;\n```\n",
    });
    yield* useEchoExec();

    // Should not throw — port is available in block 2
    const output = yield* collect(
      yield* runDocument({
        docPath: "test.md",
        stream,
      }),
    );

    // Eval blocks produce no rendered output (only text between blocks remains)
    expect(output.trim()).toBe("");
    // No errors
    expect(output).not.toContain("ERROR");
  });

  // T39: Block 3 shadowing Block 1's binding — downstream sees Block 3's value
  it("T39: shadowing — later block overrides earlier binding", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md":
        "```js eval\nconst x = 1;\n```\n\n```js eval\nconst x = 2;\n```\n\n```js eval\nconst y = x;\n```\n",
    });
    yield* useEchoExec();

    // Should succeed — x is 2 in block 3 (shadowed by block 2)
    const output = yield* collect(
      yield* runDocument({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).not.toContain("ERROR");
  });

  // T40: Empty block — no exports, no error
  it("T40: empty eval block — no exports, no error", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\n\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* runDocument({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toBe("");
  });

  // T41: Block referencing undeclared binding not in env — error
  it("T41: undeclared reference → error in output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\nconst y = undeclaredVar + 1;\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* runDocument({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("ERROR");
  });

  // T42: Syntax error in block — parse-time error before execution
  it("T42: syntax error → error in output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md": "```js eval\nconst x = ;\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(
      yield* runDocument({
        docPath: "test.md",
        stream,
      }),
    );

    expect(output).toContain("ERROR");
  });
});
