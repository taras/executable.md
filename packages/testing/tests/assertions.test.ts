import { beforeEach, describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { Component, useTempFileCompiler } from "@executablemd/core";
import { expect } from "@executablemd/test-support/expect";
import { AssertionError } from "node:assert/strict";
import { TestFailureError } from "../src/test-api.ts";
import { journalBeforeEach } from "@executablemd/test-support/failure-journal";
import { documentCases, failureOf } from "./helpers.ts";

const documentCase = documentCases();

describe("assertion components", () => {
  beforeEach(journalBeforeEach("packages/testing/tests/assertions.test.ts"));
  beforeAll(() => useTempFileCompiler());
  documentCase("passing assertions in testing mode emit diagnostics", function* (runFresh) {
    const run = yield* runFresh(
      {
        "README.md":
          '<Testing><Test name="eq"><AssertEquals actual={1} expected={1} /></Test></Testing>\n',
      },
      { testing: false },
    );
    expect(run.completion.ok).toBe(true);
    expect(run.output).toContain("**AssertEquals** passed");
    expect(run.results).toEqual([{ status: "pass", name: "eq", location: "README.md:1:10" }]);
  });

  documentCase("a validation diagnostic is observed once and rendered once", function* (runFresh) {
    const observed: string[] = [];
    yield* Component.around({
      *raise([error], next) {
        observed.push(error.message);
        return yield* next(error);
      },
    });
    // Written in a region that prints: rendering the diagnostic once is half of
    // what this pins, and reading it needs the document to render it.
    const run = yield* runFresh({
      "README.md":
        "<PrintErrors>\n<AssertEquals actual={1} expected={1} bogus={2} />\n</PrintErrors>\n",
    });
    expect(observed).toHaveLength(1);
    // Engine wording now: an undeclared prop is rejected by the schema, since a
    // capture is stripped before validation and everything else must be described.
    expect(observed[0]).toContain("must NOT have additional properties");
    expect(observed[0]).toContain('"/bogus"');
    expect(run.output.match(/must NOT have additional properties/g)).toHaveLength(1);
  });

  documentCase(
    "assertions outside a test pass silently during regular execution",
    function* (runFresh) {
      const run = yield* runFresh({
        "README.md": "before\n<AssertEquals actual={1} expected={1} />\nafter\n",
      });
      expect(run.completion.ok).toBe(true);
      expect(run.output).not.toContain("AssertEquals");
      expect(run.output).toContain("before");
      expect(run.output).toContain("after");
    },
  );

  documentCase("assertions outside a test emit diagnostics with verbose", function* (runFresh) {
    const run = yield* runFresh(
      { "README.md": "<AssertEquals actual={1} expected={1} />\n" },
      { verbose: true },
    );
    expect(run.completion.ok).toBe(true);
    expect(run.output).toContain("**AssertEquals** passed");
  });

  documentCase("a failed assertion outside a test aborts the document", function* (runFresh) {
    const run = yield* runFresh({
      "README.md": "before\n<AssertEquals actual={1} expected={2} />\nnever\n",
    });
    const error = failureOf(run);
    expect(error).toBeInstanceOf(AssertionError);
    expect(run.output).not.toContain("never");
    // Diagnostics hidden without verbose — but the assertion still threw.
    expect(run.output).not.toContain("AssertEquals");
  });

  documentCase(
    "a failed assertion outside a test keeps its diagnostic with verbose",
    function* (runFresh) {
      const run = yield* runFresh(
        { "README.md": "before\n<AssertEquals actual={1} expected={2} />\nnever\n" },
        { verbose: true },
      );
      expect(failureOf(run)).toBeInstanceOf(AssertionError);
      expect(run.output).toContain("**AssertEquals** failed");
      expect(run.output).toContain("before");
    },
  );

  documentCase("expected children behave like <Let> trimming", function* (runFresh) {
    const doc = [
      "<Testing><Test>",
      '<Let as="result">',
      "Hello World",
      "</Let>",
      "<AssertEquals actual={result}>",
      "Hello World",
      "</AssertEquals>",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runFresh({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((r) => r.status)).toEqual(["pass"]);
  });

  documentCase("rejects both expected prop and expected children", function* (runFresh) {
    const doc =
      "<Testing><Test><AssertEquals actual={1} expected={1}>1</AssertEquals></Test></Testing>\n";
    const run = yield* runFresh({ "README.md": doc });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.kind).toBe("error");
    expect(run.results[0]?.error?.message).toContain("not both");
  });

  documentCase("rejects expected children on unary and numeric assertions", function* (runFresh) {
    const doc =
      "<Testing><Test><AssertGreater actual={2} expected={1}>x</AssertGreater></Test></Testing>\n";
    const run = yield* runFresh({ "README.md": doc });
    expect(run.results[0]?.error?.message).toContain("expected children");
  });

  documentCase("match assertions require a real RegExp", function* (runFresh) {
    const doc = '<Testing><Test><AssertMatch actual={"abc"} expected={"b"} /></Test></Testing>\n';
    const run = yield* runFresh({ "README.md": doc });
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("RegExp");
  });

  documentCase("match assertions accept a RegExp expression", function* (runFresh) {
    const doc = '<Testing><Test><AssertMatch actual={"abc"} expected={/b/} /></Test></Testing>\n';
    const run = yield* runFresh({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
  });

  documentCase("unknown props are rejected per kind", function* (runFresh) {
    const doc = "<Testing><Test><Assert expr={true} actual={1} /></Test></Testing>\n";
    const run = yield* runFresh({ "README.md": doc });
    // `actual` is a capture for the binary kinds but not for unary-truthy, so
    // <Assert> never declares it and the schema rejects it like any other
    // undeclared prop.
    expect(run.results[0]?.error?.message).toContain('"/actual"');
    expect(run.results[0]?.error?.message).toContain("must NOT have additional properties");
  });

  documentCase("missing required props are rejected", function* (runFresh) {
    const doc = "<Testing><Test><AssertGreater actual={2} /></Test></Testing>\n";
    const run = yield* runFresh({ "README.md": doc });
    expect(run.results[0]?.error?.message).toContain('"expected"');
  });

  documentCase("assertion expressions see live bindings from eval blocks", function* (runFresh) {
    const doc = [
      "<Testing><Test>",
      "```js eval",
      "const answer = { deep: [1, 2, 3] };",
      "```",
      "<AssertEquals actual={answer} expected={{ deep: [1, 2, 3] }} />",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runFresh({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
  });

  documentCase(
    "assertion expressions see caller bindings through <Content> projection",
    function* (runFresh) {
      const doc = [
        "```js eval",
        'const fromCaller = "outer-value";',
        "```",
        "<Testing><Wrap><Test>",
        '<AssertEquals actual={fromCaller} expected={"outer-value"} />',
        "</Test></Wrap></Testing>",
        "",
      ].join("\n");
      const wrap = "projected: <Content />\n";
      const run = yield* runFresh({ "README.md": doc, "components/Wrap.md": wrap });
      expect(run.completion.ok).toBe(true);
      expect(run.results[0]?.status).toBe("pass");
    },
  );

  documentCase("formatter-visible toJSON/toString cannot change the outcome", function* (runFresh) {
    const doc = [
      "<Testing><Test>",
      "```js eval",
      "const cursed = { toJSON() { throw new Error('evil json'); }, toString() { throw new Error('evil string'); } };",
      "```",
      "<AssertStrictEquals actual={cursed} expected={cursed} />",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runFresh({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
    expect(run.output).toContain("unformattable");
  });

  documentCase("a non-string msg is rejected by type check, never formatted", function* (runFresh) {
    // If msg were formatted before the assertion, the hostile toJSON or
    // toString would throw and replace the validation outcome.
    const doc = [
      "<Testing><Test>",
      "<AssertEquals actual={1} expected={1} msg={({ toJSON() { throw new Error('hostile-json'); }, toString() { throw new Error('hostile-string'); } })} />",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runFresh({ "README.md": doc });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.kind).toBe("error");
    expect(run.results[0]?.error?.message).toContain('"msg"');
    expect(run.results[0]?.error?.message).not.toContain("hostile-json");
    expect(run.results[0]?.error?.message).not.toContain("hostile-string");
  });

  documentCase(
    "a throwing getter read at format time cannot change the outcome",
    function* (runFresh) {
      const doc = [
        "<Testing><Test>",
        "<Assert expr={({ get boom() { throw new Error('format-time read'); } })} />",
        "</Test></Testing>",
        "",
      ].join("\n");
      const run = yield* runFresh({ "README.md": doc });
      expect(run.completion.ok).toBe(true);
      expect(run.results[0]?.status).toBe("pass");
      expect(run.output).toContain("[object Object]");
    },
  );

  // §5b: `as` and `slot` are the engine's, consumed before validation, so an
  // assertion accepts them like any other component rather than rejecting them
  // from a hand-written allowed-list.
  documentCase(
    "accepts `as` on a value assertion, binding its diagnostic text",
    function* (runFresh) {
      const doc = [
        "<Testing>",
        '<Test name="t">',
        '<AssertEquals actual={1} expected={1} as="note" />',
        '<AssertStringIncludes actual={note} expected="AssertEquals" />',
        "</Test>",
        "</Testing>",
        "",
      ].join("\n");

      const run = yield* runFresh({ "README.md": doc });

      expect(run.results[0]?.status).toBe("pass");
    },
  );

  // A registration is a default, so a repository file of the same name wins.
  // The local component declares a props schema: a markdown component without
  // one accepts no props at all, and would be rejected before it could answer.
  documentCase("a repository AssertEquals overrides the registered default", function* (runFresh) {
    const local = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    actual: {}",
      "    expected: {}",
      "---",
      "",
      "LOCAL ASSERT",
      "",
    ].join("\n");

    const run = yield* runFresh({
      "README.md": [
        "<Testing>",
        '<Test name="t"><AssertEquals actual={1} expected={2} /></Test>',
        "</Testing>",
        "",
      ].join("\n"),
      "components/AssertEquals.md": local,
    });

    // Mismatched operands that the registered assertion would fail on. It
    // passes, so the repository component answered instead.
    expect(run.results[0]?.status).toBe("pass");
  });

  // Parity with the handler this replaced: an operand that throws is reported
  // by the assertion that owns it, not as the invocation's own failure.
  documentCase(
    "reports an operand expression that throws as its own diagnostic",
    function* (runFresh) {
      const doc = [
        "<Testing>",
        '<Test name="t">',
        '<AssertEquals actual={(() => { throw new Error("operand exploded"); })()} expected={1} />',
        "</Test>",
        "</Testing>",
        "",
      ].join("\n");

      const run = yield* runFresh({ "README.md": doc });

      expect(run.results[0]?.status).toBe("fail");
      expect(run.results[0]?.error?.message).toContain(
        'failed to evaluate the "actual" expression',
      );
      expect(run.results[0]?.error?.message).toContain("operand exploded");
    },
  );

  // `undefined` cannot survive the JSON gate, so before captures this could not
  // be written at all — the engine rejected the prop before the assertion ran.
  documentCase(
    "<AssertExists> fails on undefined rather than rejecting the prop",
    function* (runFresh) {
      const doc = [
        "<Testing>",
        '<Test name="t">',
        "<AssertExists actual={undefined} />",
        "</Test>",
        "</Testing>",
        "",
      ].join("\n");

      const run = yield* runFresh({ "README.md": doc });

      // The assertion's own comparison failed — not the engine refusing the prop,
      // which is what happened before `actual` became a capture.
      expect(run.results[0]?.status).toBe("fail");
      expect(run.results[0]?.error?.kind).toBe("assertion");
      expect(run.results[0]?.error?.message).not.toContain("non-serializable");
    },
  );
});
