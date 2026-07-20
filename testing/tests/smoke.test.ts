/**
 * Smoke harness — infrastructure only. The smoke-test document tests
 * itself: its guide is captured into a root binding and inspected by the
 * embedded <Test> bodies (smoke-test/README.md). This harness composes
 * useTesting() around core execute(), asserts the exact embedded tests
 * pass in discovery order, keeps the journal-size check host-side, and
 * verifies a full replay reproduces the identical outcome without
 * appending journal events.
 */
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
  "Components",
  "Execution",
  "Captures",
  "Evaluation",
  "Providers",
  "Output regions",
  "Durability",
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
