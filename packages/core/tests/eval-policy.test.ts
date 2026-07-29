/**
 * Tier O — the error policy a persistent evaluation projects under (spec §4.3).
 *
 * A `persist eval` block runs on the invocation's eval-scope loop task, created
 * before the block's own documentation or `<Output>` policy existed. The policy
 * therefore travels with the block's binding environment rather than through the
 * surrounding context, and these tests read it back through the only surface
 * that can tell the two apart: what happens to an error raised by the content
 * the block projects.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useEchoExec, useStubFs } from "@executablemd/runtime/test";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { DocumentationError } from "../src/errors.ts";

const PROJECTING_BLOCK = [
  "```ts persist eval",
  "const projected = yield* renderChildren();",
  "output(projected);",
  "```",
];

describe("Tier O — Eval scope hierarchy", () => {
  beforeAll(() => useTempFileCompiler());

  // O23: the block sits in documentation, so its projection settles under the
  // throwing policy — the failure aborts the body instead of rendering.
  it("O23: a persistent projection in documentation settles under the throwing policy", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": [...PROJECTING_BLOCK, "", "<Output>", "done", "</Output>"].join("\n"),
      "doc.md": "<Wrap>\n<Missing />\n</Wrap>",
    });
    yield* useEchoExec();

    let failure: unknown;
    try {
      yield* collect(yield* execute({ path: "doc.md", stream }));
    } catch (error) {
      failure = error;
    }

    // Documentation fail-fast: the projected error aborts the body rather than
    // rendering, which a collecting policy would never do.
    expect(failure).toBeInstanceOf(DocumentationError);
    expect(String(failure)).toContain("Missing");
  });

  // O24: the same block inside an <Output> region collects instead, so the
  // projected error renders as a comment and the region still emits.
  it("O24: a persistent projection inside <Output> settles under the collecting policy", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "components/Wrap.md": ["<Output>", ...PROJECTING_BLOCK, "</Output>"].join("\n"),
      "doc.md": "<Wrap>\n<Missing />\n</Wrap>",
    });
    yield* useEchoExec();

    const output = yield* collect(yield* execute({ path: "doc.md", stream }));

    expect(output).toContain("ERROR");
  });
});
