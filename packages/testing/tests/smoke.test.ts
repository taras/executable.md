import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { useTempFileCompiler } from "@executablemd/core";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { execute } from "@executablemd/core";
import type { ExecuteOptions } from "@executablemd/core";
import { useTesting } from "../src/use-testing.ts";
import type { TestResult } from "../src/test-api.ts";
import type { Json } from "@executablemd/core";
import { SERVICE_HOSTNAME } from "@executablemd/runtime";
import { useStubService } from "@executablemd/runtime/test";

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
  "Each renders its body once per item",
  "Each over an empty array renders nothing",
  "Each with as captures the whole rendered loop",
  "Each item binding is visible to body eval blocks",
  "Component as-capture binds without rendering inline",
  "Capture binds inline content",
  "Capture select extracts the matching node",
  "Unclosed bold heals at a component boundary",
  "Eval blocks render no output",
  "Eval blocks share bindings",
  "Persist keeps spawned tasks alive across blocks",
  "Timeout-bounded eval blocks complete",
  "Eval bindings interpolate into exec blocks",
  "Ephemeral eval reconstructs live bindings without rendering",
  "A daemon stays alive until its scope closes",
  "A cooperative service publishes a scoped live endpoint",
  "A standalone Thing's resource outlives it",
  "An empty paired Thing renders nothing and keeps nothing",
  "A paired Thing's resource is live only while its content expands",
  "Sample sends its prompt to the provider",
  "Sample consumes children as content",
  "Named slots place content in their regions",
  "Named slots compose with the default slot",
  "Instruction sets the provider system prompt",
  "Exec output is journaled with the run timestamp",
  "Output regions render only the selected region",
  "A text component returns its rendered markdown",
  "A value component binds its validated value and renders nothing",
  "The caller renders whatever presentation it wants from the value",
  "If renders its children when the condition is true",
  "If without Else renders nothing when the condition is false",
  "If selects the Else branch when the condition is false",
  "If selects the leading branch when the condition is true",
  "If resolves its condition from an existing binding",
  "If resolves a computed boolean expression",
  "Content around the selected branch keeps its order",
  "A capture from the selected branch stays available afterward",
  "The unselected branch creates no binding",
  "Nested conditionals select independently",
  "The unselected branch never runs",
  "Loop expands its body once per iteration",
  "Loop resolves its bound from an existing binding",
  "A binding carries from one iteration to the next",
  "The final binding stays available after the loop",
  "Break ends the loop and the rest of its iteration",
  "Break inside If exits only when the condition selects it",
  "Break exits only the nearest loop",
  "Content after Break never runs",
  "A Break the caller hands to a component exits the caller's loop",
  "A Break a component writes belongs to the component's own loop",
];

interface SmokeSession {
  result: Result<Json>;
  results: readonly TestResult[];
}

function* runSmokeSession(options: ExecuteOptions): Operation<SmokeSession> {
  return yield* scoped(function* () {
    yield* useStubService(Object.freeze({ hostname: SERVICE_HOSTNAME, port: 45_678 }));
    const tests = yield* useTesting();
    const execution = yield* execute(options);
    const result = yield* execution;
    return { result, results: yield* tests.results };
  });
}

describe("smoke test", { sanitizeOps: false, sanitizeResources: false }, () => {
  beforeAll(() => useTempFileCompiler());
  it("smoke document passes its embedded tests live and on replay", function* () {
    const stream = new InMemoryStream();
    const options: ExecuteOptions = {
      path: "smoke-test/README.md",
      stream,
      componentDirs: ["smoke-test", "packages/core/components"],
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
