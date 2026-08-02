import { describe, it } from "@executablemd/test-support/bdd";
import { scoped } from "effection";
import { expect } from "@executablemd/test-support/expect";
import { AssertionError } from "node:assert/strict";
import { Component } from "@executablemd/core";
import type { ComponentElement } from "@executablemd/core";
import { createTestHandlers } from "../src/handlers.ts";
import { failureOf, runDoc } from "./helpers.ts";

const STRICT = [
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    n: { type: number }",
  "  required: [n]",
  "  additionalProperties: false",
  "---",
  "n={props.n}",
  "",
].join("\n");

function inTest(body: string): Record<string, string> {
  return {
    "Strict.md": STRICT,
    "README.md": `<Testing><Test name="t">\n${body}\n</Test></Testing>\n`,
  };
}

describe("<AssertThrows>", () => {
  it("passes when the body raises an error matching a substring", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message="must be number"><Strict n="x" /></AssertThrows>'),
    );
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
  });

  it("passes when the body raises an error matching a RegExp", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message={/must be number/}><Strict n="x" /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("pass");
  });

  it("fails when the body raises no error", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message="must be number"><Strict n={5} /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("fail");
  });

  it("fails when the raised error does not match", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message="totally different"><Strict n="x" /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("fail");
  });

  it("rejects a missing message prop", function* () {
    const run = yield* runDoc(inTest('<AssertThrows><Strict n="x" /></AssertThrows>'));
    expect(run.results[0]?.status).toBe("fail");
    expect(run.output).toContain('requires a "message"');
  });

  it("rejects an unknown prop", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message="must" bogus="y"><Strict n="x" /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("fail");
    // Engine wording: an undeclared prop is rejected by the schema now that
    // `message` is a capture stripped before validation.
    expect(run.results[0]?.error?.message).toContain('"/bogus"');
    expect(run.results[0]?.error?.message).toContain("must NOT have additional properties");
  });

  it("rejects an expression-valued as", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message="must" as={1 + 1}><Strict n="x" /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("fail");
    // The engine owns `as`, and rejects an expression-valued one itself.
    expect(run.results[0]?.error?.message).toContain("must be a string literal");
  });

  it("rejects an invalid as identifier", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message="must" as="123bad"><Strict n="x" /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("fail");
    expect(run.output).toContain("identifier");
  });

  it("rejects a message that evaluates to an unsupported type", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message={1 + 1}><Strict n="x" /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("string or a RegExp");
  });

  it("binds the complete caught error (incl. cause) via as", function* () {
    const run = yield* runDoc(
      inTest(
        [
          '<AssertThrows message="must be number" as="thrown"><Strict n="x" /></AssertThrows>',
          '<AssertEquals actual={thrown.cause.componentName} expected="Strict" />',
        ].join("\n"),
      ),
    );
    expect(run.completion.ok).toBe(true);
    expect(run.results.every((r) => r.status === "pass")).toBe(true);
  });

  it("re-propagates a non-raise throw (a failing assertion in the body)", function* () {
    const run = yield* runDoc(
      inTest(
        '<AssertThrows message="must be number"><AssertEquals actual={1} expected={2} /></AssertThrows>',
      ),
    );
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message ?? "").not.toContain("none was raised");
  });

  it("stops expanding body children after the first raised error, rendering nothing", function* () {
    const run = yield* runDoc({
      "Strict.md": STRICT,
      "README.md":
        '<AssertThrows message="must be number"><Strict n="x" />SHOULD-NOT-APPEAR</AssertThrows>\n',
    });
    expect(run.completion.ok).toBe(true);
    expect(run.output).not.toContain("SHOULD-NOT-APPEAR");
    expect(run.output).not.toContain("must be number");
  });

  it("swallows silently outside a <Test> during regular execution", function* () {
    const run = yield* runDoc({
      "Strict.md": STRICT,
      "README.md":
        'before\n<AssertThrows message="must be number"><Strict n="x" /></AssertThrows>\nafter\n',
    });
    expect(run.completion.ok).toBe(true);
    expect(run.output).toContain("before");
    expect(run.output).toContain("after");
    expect(run.output).not.toContain("AssertThrows");
  });

  // Accepted loss: the return channel now carries the caught segment for `as`
  // to bind, and no other channel preserves a durable rendered segment — so a
  // passing <AssertThrows> renders nothing, even with --verbose. Failure
  // behavior is unchanged, which the cases above pin.
  it("emits no pass diagnostic, even with verbose", function* () {
    const run = yield* runDoc(
      {
        "Strict.md": STRICT,
        "README.md": '<AssertThrows message="must be number"><Strict n="x" /></AssertThrows>\n',
      },
      { verbose: true },
    );
    expect(run.completion.ok).toBe(true);
    expect(run.output).not.toContain("**AssertThrows** passed");
  });

  it("aborts the document outside a <Test> when no error is raised, with a visible diagnostic", function* () {
    const run = yield* runDoc(
      {
        "Strict.md": STRICT,
        "README.md": 'before\n<AssertThrows message="x"><Strict n={5} /></AssertThrows>\nnever\n',
      },
      { verbose: true },
    );
    expect(failureOf(run)).toBeInstanceOf(AssertionError);
    expect(run.output).toContain("**AssertThrows** failed");
    expect(run.output).not.toContain("never");
  });
});
