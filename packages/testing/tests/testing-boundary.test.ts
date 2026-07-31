/**
 * Tier TB — what `<Testing>` reports, and when.
 *
 * A boundary reports how many tests ran. That count only means anything once
 * the body has finished: a projection that stopped partway never counted the
 * tests it had not reached, so it has no outcome to report and nothing to
 * journal. These pin that, and the resolution rule that lets a repository
 * component replace `<Testing>` entirely.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { registerComponents, useTempFileCompiler } from "@executablemd/core";
import { runDoc } from "./helpers.ts";
import type { DocRun } from "./helpers.ts";

/** Every journalled boundary entry, by the name it recorded. */
function* boundaryEntries(stream: InMemoryStream): Operation<string[]> {
  const events = yield* stream.readAll();
  const names: string[] = [];
  for (const event of events) {
    if (event.type === "yield" && event.description.type === "testing_boundary") {
      names.push(String(event.description.name));
    }
  }
  return names;
}

/** The failure `<Boom />` throws, so a test can assert on the exact object. */
const BOOM = new Error("the component failed");

/**
 * Run with a `<Boom />` that fails the way any component does.
 *
 * An ordinary component failure fails the operation it is part of, so this is
 * how expansion stops partway rather than collecting — no middleware standing
 * in for a failure, just a component that fails.
 */
function stopping(files: Record<string, string>, stream: InMemoryStream): Operation<DocRun> {
  return scoped(function* () {
    yield* registerComponents([
      {
        name: "Boom",
        origin: "test",
        props: { type: "object", properties: {}, additionalProperties: false },
        // deno-lint-ignore require-yield
        *fn() {
          throw BOOM;
        },
      },
    ]);
    return yield* runDoc(files, { stream });
  });
}

describe("Tier TB — a boundary that never finished", () => {
  beforeAll(() => useTempFileCompiler());

  it("TB1: a stopped body reports no outcome and journals nothing", function* () {
    const stream = new InMemoryStream();
    const doc = [
      "<Testing>",
      '<Test name="t"><Assert expr={true} /></Test>',
      "",
      "<Boom />",
      "",
      "AFTER",
      "",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* stopping({ "README.md": doc }, stream);

    // The original failure reaches completion, by identity…
    expect(run.completion.ok).toBe(false);
    expect(run.completion.ok === false && run.completion.error).toBe(BOOM);
    // …nothing after it rendered…
    expect(run.output).not.toContain("AFTER");
    // …no outcome was observed for a boundary that never finished…
    expect(run.boundaries).toEqual([]);
    // …and nothing was journalled for it.
    expect(yield* boundaryEntries(stream)).toEqual([]);
  });

  it("TB2: replaying that journal hydrates no boundary outcome", function* () {
    const stream = new InMemoryStream();
    const doc = ["<Testing>", "", "<Boom />", "", "</Testing>", ""].join("\n");

    yield* stopping({ "README.md": doc }, stream);

    // Same journal, replayed: there is no recorded outcome to restore.
    const replay = yield* stopping({ "README.md": doc }, stream);
    expect(replay.boundaries).toEqual([]);
    expect(yield* boundaryEntries(stream)).toEqual([]);
  });

  it("TB3: a body that only collected is complete, and does report", function* () {
    const stream = new InMemoryStream();
    const doc = [
      "<Testing>",
      "",
      "<Missing />",
      "",
      '<Test name="t"><Assert expr={true} /></Test>',
      "",
      "</Testing>",
      "",
    ].join("\n");

    // No interceptor: the error settles under the collecting policy, so the
    // projection finishes and the boundary is a real count.
    const run = yield* runDoc({ "README.md": doc }, { stream });

    expect(run.boundaries).toEqual([{ tests: 1, failed: 0 }]);
    expect(yield* boundaryEntries(stream)).toHaveLength(1);
  });
});

describe("Tier TB — a repository component replaces <Testing>", () => {
  beforeAll(() => useTempFileCompiler());

  it("TB4: a local Testing component is selected, and the package's never runs", function* () {
    const run = yield* runDoc({
      "README.md": [
        "<Testing>",
        '<Test name="would-run"><Assert expr={false} /></Test>',
        "</Testing>",
        "",
      ].join("\n"),
      "components/Testing.md": "LOCAL TESTING BOUNDARY\n",
    });

    // The repository component answered…
    expect(run.output).toContain("LOCAL TESTING BOUNDARY");
    // …so the package implementation never activated testing: the `<Test>`
    // inside stayed inert, recorded no result, and reported no boundary.
    expect(run.results).toEqual([]);
    expect(run.boundaries).toEqual([]);
    expect(run.output).not.toContain("would-run");
  });
});
