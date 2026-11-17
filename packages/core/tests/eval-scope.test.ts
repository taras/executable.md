/**
 * Tier T10 — eval-scope hierarchy tests (spec §11).
 *
 * Tests that eval scopes are properly scoped to components and
 * that child/parent scope relationships work correctly.
 */
import { describe, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { expect } from "@executablemd/test-support/expect";
import { Stdio } from "@effectionx/process";
import { useStubFs, useEchoExec } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { asText } from "./helpers.ts";
import { journalCases } from "../../test-support/journal-cases.ts";

const journalCase = journalCases("packages/core/tests/eval-scope.test.ts");

describe("Tier T10 — eval-scope hierarchy", () => {
  beforeAll(() => useTempFileCompiler());
  // T61: Document with eval blocks — scope created per document
  journalCase("T61: eval blocks run within document scope", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md": "```js eval\nconst a = 1;\n```\n\n```js eval\nconst b = a + 1;\n```\n",
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

    // Both blocks should execute without error
    // Text between two adjacent eval blocks may produce a newline
    expect(output.trim()).toBe("");
    expect(output).not.toContain("ERROR");
  });

  // T62: Eval blocks coexist with exec blocks
  journalCase("T62: eval and exec blocks coexist", "test.md", function* (stream) {
    yield* useStubFs({
      "test.md":
        "```js eval\nconst x = 42;\n```\n\n```bash exec\necho hello\n```\n\n```js eval\nconst y = x + 1;\n```\n",
    });
    yield* useEchoExec();

    let displayed = "";
    const decoder = new TextDecoder();
    yield* Stdio.around({
      *stdout([bytes]) {
        displayed += decoder.decode(bytes);
      },
    });
    const output = asText(
      yield* collect(
        yield* execute({
          path: "test.md",
          stream,
        }),
      ),
    );

    // The command's output reached the reader; the eval blocks around it are
    // unaffected (#441).
    expect(displayed).toContain("hello");
    expect(output).not.toContain("ERROR");
  });
});
