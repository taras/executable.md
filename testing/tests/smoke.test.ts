import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { execute } from "@executablemd/core";
import type { ExecuteOptions } from "@executablemd/core";
import { useTesting } from "../src/use-testing.ts";
import type { TestResult } from "../src/test-api.ts";

const EMBEDDED_TESTS = [
  "Root frontmatter interpolates into the heading",
  "Root frontmatter interpolates into prose",
  "Note renders its default level",
  "Note renders an overridden level",
  "Section renders children through its Content slot",
  "Feature expands its nested Note",
  "Dotted component names resolve to directory paths",
  "exec renders command stdout",
  "silent exec suppresses rendered output",
  "Non-executable code blocks pass through verbatim",
  "Props interpolate into the component body",
  "A scalar array of strings renders",
  "An object array fills a nested default",
  "A wrong array element type is rejected",
  "A missing required object key is rejected, exposing the cause",
  "An undeclared object property is rejected",
  "A wrong-typed object field is rejected",
  "An invalid nested enum value is rejected",
  "Expression props resolve from eval bindings",
  "JSON literal props resolve at scan time",
  "Non-string bindings coerce in text",
  "Eval bindings resolve in prose text",
  "Meta and eval bindings share the same text",
  "Escaped braces stay literal",
  "Unresolved references pass through verbatim",
  "Component as-capture binds without rendering inline",
  "Capture binds inline content",
  "Capture select extracts the matching node",
  "Unclosed bold heals at a component boundary",
  "Eval blocks render no output",
  "Eval blocks share bindings",
  "Persist keeps spawned tasks alive across blocks",
  "Timeout-bounded eval blocks complete",
  "findFreePort allocates a free port",
  "Eval bindings interpolate into exec blocks",
  "A daemon serves requests until its scope closes",
  "Sample sends its prompt to the provider",
  "Sample consumes children as content",
  "Named slots place content in their regions",
  "Named slots compose with the default slot",
  "Instruction sets the provider system prompt",
  "Exec output is journaled with the run timestamp",
  "Output regions render only the selected region",
];

interface SmokeSession {
  result: Result<string>;
  results: readonly TestResult[];
}

function* runSmokeSession(options: ExecuteOptions): Operation<SmokeSession> {
  return yield* scoped(function* () {
    const tests = yield* useTesting();
    const execution = yield* execute(options);
    const result = yield* execution;
    return { result, results: yield* tests.results };
  });
}

describe("smoke test", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("smoke document passes its embedded tests live and on replay", function* () {
    const stream = new InMemoryStream();
    const options: ExecuteOptions = {
      docPath: "smoke-test/README.md",
      stream,
      componentDirs: ["smoke-test", "core/components"],
    };

    const live = yield* runSmokeSession(options);
    if (!live.result.ok) {
      throw live.result.error;
    }
    expect(live.results.map((entry) => [entry.name, entry.status])).toEqual(
      EMBEDDED_TESTS.map((name) => [name, "pass"]),
    );
    expect(stream.snapshot().length).toBeGreaterThan(10);
    const liveAppendCount = stream.appendCount;

    const replay = yield* runSmokeSession(options);
    expect(replay.result).toEqual(live.result);
    expect(replay.results).toEqual(live.results);
    expect(stream.appendCount).toBe(liveAppendCount);
  });
});
