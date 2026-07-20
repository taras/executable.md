import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, sleep, spawn } from "effection";
import type { Operation, Subscription } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { API } from "@executablemd/runtime";
import { execute, Execution } from "@executablemd/core";
import { Test, TestFailureError, testing } from "../src/test-api.ts";
import { useTesting } from "../src/use-testing.ts";
import { failureOf, runDoc } from "./helpers.ts";

function* drain(
  subscription: Subscription<string, string>,
): Operation<{ chunks: string[]; close: string }> {
  const chunks: string[] = [];
  let next = yield* subscription.next();
  while (!next.done) {
    chunks.push(next.value);
    next = yield* subscription.next();
  }
  return { chunks, close: next.value };
}

describe("useTesting composition", () => {
  it("composes around core execute and returns session results", function* () {
    const outcome = yield* scoped(function* () {
      yield* useStubFs({
        "README.md": '<Test name="one"><Assert expr={true} /></Test>\n',
      });
      const tests = yield* useTesting();
      const execution = yield* execute({ docPath: "README.md", stream: new InMemoryStream() });
      const result = yield* execution;
      const results = yield* tests.results;
      return { result, results };
    });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.results.map((r) => [r.name, r.status])).toEqual([["one", "pass"]]);
    expect(Object.isFrozen(outcome.results)).toBe(true);
  });

  it("keeps results available after a testing failure", function* () {
    const outcome = yield* scoped(function* () {
      yield* useStubFs({
        "README.md": '<Test name="bad"><Assert expr={false} /></Test>\n',
      });
      const tests = yield* useTesting();
      const execution = yield* execute({ docPath: "README.md", stream: new InMemoryStream() });
      const result = yield* execution;
      const results = yield* tests.results;
      return { result, results };
    });
    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.error).toBeInstanceOf(TestFailureError);
    }
    expect(outcome.results.map((r) => [r.name, r.status])).toEqual([["bad", "fail"]]);
  });

  it("preserves a core Err unchanged", function* () {
    const result = yield* scoped(function* () {
      yield* useStubFs({});
      yield* useTesting();
      const execution = yield* execute({ docPath: "missing.md", stream: new InMemoryStream() });
      return yield* execution;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(TestFailureError);
      expect(result.error.message).toContain("missing.md");
    }
  });

  it("enforces one execute() call per session", function* () {
    // Results are cumulative across a session: without the guard, a
    // zero-test second document would succeed on the strength of the first
    // document's passing test.
    let thrown: Error | undefined;
    const first = yield* scoped(function* () {
      yield* useStubFs({
        "README.md": '<Test name="one"><Assert expr={true} /></Test>\n',
        "empty.md": "no tests here\n",
      });
      yield* useTesting();
      const execution = yield* execute({ docPath: "README.md", stream: new InMemoryStream() });
      const result = yield* execution;
      try {
        yield* execute({ docPath: "empty.md", stream: new InMemoryStream() });
      } catch (failure) {
        thrown = failure instanceof Error ? failure : new Error(String(failure));
      }
      return result;
    });
    expect(first.ok).toBe(true);
    expect(thrown?.message).toContain("one execute() call");
  });

  it("enforces one session per execution scope", function* () {
    let error: Error | undefined;
    yield* scoped(function* () {
      yield* useTesting();
      try {
        yield* useTesting();
      } catch (failure) {
        error = failure instanceof Error ? failure : new Error(String(failure));
      }
    });
    expect(error?.message).toContain("one session per execution scope");
  });

  it("removes all session middleware with its scope", function* () {
    yield* scoped(function* () {
      yield* useStubFs({ "README.md": "<Test><Assert expr={true} /></Test>\n" });
      yield* useTesting();
      const execution = yield* execute({ docPath: "README.md", stream: new InMemoryStream() });
      const result = yield* execution;
      expect(result.ok).toBe(true);
    });

    // Outside the session scope: activation, collectors, and policy are gone.
    expect(yield* testing).toBe(false);
    expect(yield* Test.operations.results()).toEqual([]);
    const second = yield* runDoc({ "README.md": "<Test><Assert expr={true} /></Test>\n" });
    expect(second.completion.ok).toBe(true);
    expect(second.output).not.toContain("Assert");
    expect(second.results).toEqual([]);
  });

  it("completion returns Err instead of throwing for document failures", function* () {
    const run = yield* runDoc({}, { docPath: "missing.md" });
    const error = failureOf(run);
    expect(error?.message).toContain("missing.md");
    expect(run.output).toBe("");
  });

  it("a failure before the handle exists may still throw", function* () {
    let thrown: Error | undefined;
    yield* scoped(function* () {
      yield* useStubFs({ "README.md": "hello\n" });
      yield* Execution.around({
        // deno-lint-ignore require-yield
        *execute() {
          throw new Error("pre-handle setup exploded");
        },
      });
      try {
        yield* execute({ docPath: "README.md", stream: new InMemoryStream() });
      } catch (failure) {
        thrown = failure instanceof Error ? failure : new Error(String(failure));
      }
    });
    expect(thrown?.message).toBe("pre-handle setup exploded");
  });

  it("a late subscriber still receives all chunks and the close value", function* () {
    const { late, value } = yield* scoped(function* () {
      yield* useStubFs({ "README.md": "hello world\n" });
      yield* useTesting();
      const execution = yield* execute({
        docPath: "README.md",
        stream: new InMemoryStream(),
      });
      const result = yield* execution;
      const drained = yield* scoped(function* () {
        return yield* drain(yield* execution.output);
      });
      return { late: drained, value: result };
    });
    // No tests in the doc — the session rejects, but output is intact.
    expect(value.ok).toBe(false);
    expect(late.close).toContain("hello world");
    expect(late.chunks.join("")).toContain("hello world");
  });

  it("an early caller-scope halt tears down the document and leased eval scope", function* () {
    Reflect.deleteProperty(globalThis, "__useTestingHaltMarker");
    yield* API.Process.around({
      *exec(_args, _next) {
        yield* sleep(10_000);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const doc = [
      "<Testing>",
      '<Test name="hangs">',
      "```js persist eval",
      "globalThis.__useTestingHaltMarker = true;",
      "yield* spawn(function* () { try { yield* suspend(); } finally { globalThis.__useTestingHaltMarker = false; } });",
      "```",
      "```bash exec",
      "sleep 600",
      "```",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");
    yield* useStubFs({ "README.md": doc });

    yield* scoped(function* () {
      yield* useTesting();
      const execution = yield* execute({ docPath: "README.md", stream: new InMemoryStream() });
      yield* spawn(function* () {
        yield* scoped(function* () {
          yield* drain(yield* execution.output);
        });
      });
      // Give the document time to start the test and spawn its effect,
      // then leave the scope — halting everything mid-test.
      yield* sleep(200);
    });

    expect(Reflect.get(globalThis, "__useTestingHaltMarker")).toBe(false);
  });
});
