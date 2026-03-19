/**
 * Tier T10 — eval-scope hierarchy tests (spec §11).
 *
 * Tests that eval scopes are properly scoped to components and
 * that child/parent scope relationships work correctly.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

describe("Tier T10 — eval-scope hierarchy", () => {
  // T61: Document with eval blocks — scope created per document
  it("T61: eval blocks run within document scope", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "test.md":
        "```js eval\nconst a = 1;\n```\n\n```js eval\nconst b = a + 1;\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
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
    yield* useStubFs({
      "test.md":
        "```js eval\nconst x = 42;\n```\n\n```bash exec\necho hello\n```\n\n```js eval\nconst y = x + 1;\n```\n",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* runDocument({
      docPath: "test.md",
      stream,
      freshness: false,
    }));

    // Exec output should be present
    expect(output).toContain("hello");
    // No errors
    expect(output).not.toContain("ERROR");
  });
});
