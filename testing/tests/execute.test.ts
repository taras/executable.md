import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, sleep, spawn } from "effection";
import type { Operation, Subscription } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { API } from "@executablemd/runtime";
import { Test, TestFailureError, testing } from "../src/test-api.ts";
import { createExecuteDocument, executeDocument } from "../src/execute.ts";
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

describe("executeDocument", () => {
  it("a late subscriber still receives all chunks and the close value", function* () {
    yield* useStubFs({ "README.md": "hello world\n" });
    const execution = yield* executeDocument({
      docPath: "README.md",
      stream: new InMemoryStream(),
      testing: false,
    });
    // Complete the execution FIRST — only then subscribe.
    const value = yield* execution;
    const late = yield* scoped(function* () {
      return yield* drain(yield* execution.output);
    });
    expect(value).toContain("hello world");
    expect(late.close).toBe(value);
    expect(late.chunks.join("")).toContain("hello world");
  });

  it("multiple subscribers each receive the full sequence", function* () {
    yield* useStubFs({ "README.md": "alpha\n\nbeta\n" });
    const execution = yield* executeDocument({
      docPath: "README.md",
      stream: new InMemoryStream(),
      testing: false,
    });
    yield* execution;
    const [one, two] = yield* scoped(function* () {
      return [yield* drain(yield* execution.output), yield* drain(yield* execution.output)];
    });
    expect(one).toEqual(two);
    expect(one.close).toContain("alpha");
  });

  it("consuming only the completion does not deadlock", function* () {
    yield* useStubFs({ "README.md": "only completion\n" });
    const execution = yield* executeDocument({
      docPath: "README.md",
      stream: new InMemoryStream(),
      testing: false,
    });
    const value = yield* execution;
    expect(value).toContain("only completion");
  });

  it("a bad docPath is an inner runtime failure after publication", function* () {
    yield* useStubFs({});
    const execution = yield* executeDocument({
      docPath: "missing.md",
      stream: new InMemoryStream(),
      testing: false,
    });
    // Output closes (with accumulated output) even though completion rejects.
    const drained = yield* scoped(function* () {
      return yield* drain(yield* execution.output);
    });
    expect(drained.close).toBe("");
    let error: Error | undefined;
    try {
      yield* execution;
    } catch (failure) {
      error = failure instanceof Error ? failure : new Error(String(failure));
    }
    expect(error?.message).toContain("missing.md");
    expect(error).not.toBeInstanceOf(TestFailureError);
  });

  it("a pre-publication setup failure rejects output and completion", function* () {
    const execute = createExecuteDocument({
      // deno-lint-ignore require-yield
      *runDocument() {
        throw new Error("setup exploded");
      },
    });
    const execution = yield* execute({
      docPath: "README.md",
      stream: new InMemoryStream(),
      testing: false,
    });

    let outputError: Error | undefined;
    try {
      yield* scoped(function* () {
        yield* drain(yield* execution.output);
      });
    } catch (failure) {
      outputError = failure instanceof Error ? failure : new Error(String(failure));
    }
    let completionError: Error | undefined;
    try {
      yield* execution;
    } catch (failure) {
      completionError = failure instanceof Error ? failure : new Error(String(failure));
    }
    expect(outputError?.message).toBe("setup exploded");
    expect(completionError?.message).toBe("setup exploded");
  });

  it("testing middleware does not outlive its execution", function* () {
    yield* useStubFs({
      "README.md": "<Test><Assert expr={true} /></Test>\n",
    });
    const first = yield* executeDocument({
      docPath: "README.md",
      stream: new InMemoryStream(),
      testing: true,
    });
    const firstValue = yield* first;
    expect(firstValue).toContain("**Assert** passed");

    // Same caller scope, fresh run WITHOUT testing: the previous run's
    // activation and collectors must be gone — the test is skipped.
    expect(yield* testing).toBe(false);
    const defaults = yield* Test.operations.results();
    expect(defaults).toEqual([]);
    const second = yield* runDoc({ "README.md": "<Test><Assert expr={true} /></Test>\n" });
    expect(second.completion.ok).toBe(true);
    expect(second.output).not.toContain("Assert");
    expect(second.results).toEqual([]);
  });

  it("an early caller-scope halt tears down the document and leased eval scope", function* () {
    const globalValues = globalThis as Record<string, unknown>;
    delete globalValues.__executeHaltMarker;
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
      "globalThis.__executeHaltMarker = true;",
      "yield* spawn(function* () { try { yield* suspend(); } finally { globalThis.__executeHaltMarker = false; } });",
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
      const execution = yield* executeDocument({
        docPath: "README.md",
        stream: new InMemoryStream(),
        testing: false,
      });
      yield* spawn(function* () {
        yield* scoped(function* () {
          yield* drain(yield* execution.output);
        });
      });
      // Give the document time to start the test and spawn its effect,
      // then leave the scope — halting everything mid-test.
      yield* sleep(200);
    });

    expect(globalValues.__executeHaltMarker).toBe(false);
  });
});
