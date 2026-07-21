import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { AssertionError } from "@std/assert";
import { failureOf, runDoc } from "./helpers.ts";

const STRICT = [
  "---",
  "inputs:",
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
    expect(run.output).toContain('does not accept a "bogus"');
  });

  it("rejects an expression-valued as", function* () {
    const run = yield* runDoc(
      inTest('<AssertThrows message="must" as={1 + 1}><Strict n="x" /></AssertThrows>'),
    );
    expect(run.results[0]?.status).toBe("fail");
    expect(run.output).toContain("must be a string literal, not an expression");
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
    expect(run.output).toContain("string or RegExp");
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
    // The failure is the inner AssertEquals, not a "no error raised" from AssertThrows.
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

  it("emits a pass diagnostic outside a <Test> only with verbose", function* () {
    const run = yield* runDoc(
      {
        "Strict.md": STRICT,
        "README.md": '<AssertThrows message="must be number"><Strict n="x" /></AssertThrows>\n',
      },
      { verbose: true },
    );
    expect(run.completion.ok).toBe(true);
    expect(run.output).toContain("**AssertThrows** passed");
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
