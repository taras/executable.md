/**
 * Tier TG — test-agent smoke (specs/test-agent-spec.md acceptance
 * §3–§4): one document through useTesting + the TestAgent and Agent
 * vocabularies, the REAL ACPX runtime, and a real `xmd test-agent`
 * worker subprocess; then a replay of the completed main journal that
 * produces the same result without contacting ACPX or a worker.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import * as path from "node:path";
import { execute, installAgentVocabulary } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { installTestAgentVocabulary } from "../src/vocabulary.ts";

const DOC = path.resolve("smoke-test/test-agent/README.md");
const CLI = path.resolve("packages/cli/src/cli.ts");

function* runSmoke(
  stream: InMemoryStream,
  workerCommand: string[],
): Operation<{ result: Result<string>; output: string; results: readonly TestResult[] }> {
  return yield* scoped(function* () {
    const testing = yield* useTesting();
    yield* installTestAgentVocabulary({ workerCommand });
    yield* installAgentVocabulary();
    const execution = yield* execute({ docPath: DOC, stream });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    const results = yield* testing.results;
    return { result, output: next.value, results };
  });
}

describe("Tier TG — test-agent smoke", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("TG1: live ACPX + worker run passes, and replay repeats it without contact", function* () {
    const stream = new InMemoryStream();

    const live = yield* runSmoke(stream, ["deno", "run", "--allow-all", CLI, "test-agent"]);
    expect(live.results.map((entry) => entry.status)).toEqual(["pass"]);
    expect(live.result.ok).toBe(true);
    expect(live.output).not.toContain("ERROR");

    const appended = stream.appendCount;
    // An unspawnable worker command proves replay never contacts ACPX
    // or a worker.
    const replay = yield* runSmoke(stream, ["/nonexistent/xmd-test-agent-must-not-spawn"]);
    expect(replay.results.map((entry) => entry.status)).toEqual(["pass"]);
    expect(replay.result.ok).toBe(true);
    expect(replay.output).toBe(live.output);
    expect(stream.appendCount).toBe(appended);
  });
});
