import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { AssertionError } from "@std/assert";
import { TestFailureError } from "../src/test-api.ts";
import { failureOf, runDoc } from "./helpers.ts";

describe("assertion components", () => {
  it("passing assertions in testing mode emit diagnostics", function* () {
    const run = yield* runDoc(
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

  it("assertions outside a test pass silently during regular execution", function* () {
    const run = yield* runDoc({
      "README.md": "before\n<AssertEquals actual={1} expected={1} />\nafter\n",
    });
    expect(run.completion.ok).toBe(true);
    expect(run.output).not.toContain("AssertEquals");
    expect(run.output).toContain("before");
    expect(run.output).toContain("after");
  });

  it("assertions outside a test emit diagnostics with verbose", function* () {
    const run = yield* runDoc(
      { "README.md": "<AssertEquals actual={1} expected={1} />\n" },
      { verbose: true },
    );
    expect(run.completion.ok).toBe(true);
    expect(run.output).toContain("**AssertEquals** passed");
  });

  it("a failed assertion outside a test aborts the document", function* () {
    const run = yield* runDoc({
      "README.md": "before\n<AssertEquals actual={1} expected={2} />\nnever\n",
    });
    const error = failureOf(run);
    expect(error).toBeInstanceOf(AssertionError);
    expect(run.output).not.toContain("never");
    // Diagnostics hidden without verbose — but the assertion still threw.
    expect(run.output).not.toContain("AssertEquals");
  });

  it("a failed assertion outside a test keeps its diagnostic with verbose", function* () {
    const run = yield* runDoc(
      { "README.md": "before\n<AssertEquals actual={1} expected={2} />\nnever\n" },
      { verbose: true },
    );
    expect(failureOf(run)).toBeInstanceOf(AssertionError);
    expect(run.output).toContain("**AssertEquals** failed");
    expect(run.output).toContain("before");
  });

  it("expected children behave like <Capture> trimming", function* () {
    const doc = [
      "<Testing><Test>",
      '<Capture as="result">',
      "Hello World",
      "</Capture>",
      "<AssertEquals actual={result}>",
      "Hello World",
      "</AssertEquals>",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results.map((r) => r.status)).toEqual(["pass"]);
  });

  it("rejects both expected prop and expected children", function* () {
    const doc =
      "<Testing><Test><AssertEquals actual={1} expected={1}>1</AssertEquals></Test></Testing>\n";
    const run = yield* runDoc({ "README.md": doc });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.kind).toBe("error");
    expect(run.results[0]?.error?.message).toContain("not both");
  });

  it("rejects expected children on unary and numeric assertions", function* () {
    const doc =
      "<Testing><Test><AssertGreater actual={2} expected={1}>x</AssertGreater></Test></Testing>\n";
    const run = yield* runDoc({ "README.md": doc });
    expect(run.results[0]?.error?.message).toContain("expected children");
  });

  it("match assertions require a real RegExp", function* () {
    const doc = '<Testing><Test><AssertMatch actual={"abc"} expected={"b"} /></Test></Testing>\n';
    const run = yield* runDoc({ "README.md": doc });
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("RegExp");
  });

  it("match assertions accept a RegExp expression", function* () {
    const doc = '<Testing><Test><AssertMatch actual={"abc"} expected={/b/} /></Test></Testing>\n';
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
  });

  it("unknown props are rejected per kind", function* () {
    const doc = "<Testing><Test><Assert expr={true} actual={1} /></Test></Testing>\n";
    const run = yield* runDoc({ "README.md": doc });
    expect(run.results[0]?.error?.message).toContain('"actual"');
  });

  it("missing required props are rejected", function* () {
    const doc = "<Testing><Test><AssertGreater actual={2} /></Test></Testing>\n";
    const run = yield* runDoc({ "README.md": doc });
    expect(run.results[0]?.error?.message).toContain('"expected"');
  });

  it("assertion expressions see live bindings from eval blocks", function* () {
    const doc = [
      "<Testing><Test>",
      "```js eval",
      "const answer = { deep: [1, 2, 3] };",
      "```",
      "<AssertEquals actual={answer} expected={{ deep: [1, 2, 3] }} />",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
  });

  it("assertion expressions see caller bindings through <Content> projection", function* () {
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
    const run = yield* runDoc({ "README.md": doc, "components/Wrap.md": wrap });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
  });

  it("formatter-visible toJSON/toString cannot change the outcome", function* () {
    const doc = [
      "<Testing><Test>",
      "```js eval",
      "const cursed = { toJSON() { throw new Error('evil json'); }, toString() { throw new Error('evil string'); } };",
      "```",
      "<AssertStrictEquals actual={cursed} expected={cursed} />",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
    expect(run.output).toContain("unformattable");
  });

  it("a non-string msg is rejected by type check, never formatted", function* () {
    // If msg were formatted before the assertion, the hostile toJSON or
    // toString would throw and replace the validation outcome.
    const doc = [
      "<Testing><Test>",
      "<AssertEquals actual={1} expected={1} msg={({ toJSON() { throw new Error('hostile-json'); }, toString() { throw new Error('hostile-string'); } })} />",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(failureOf(run)).toBeInstanceOf(TestFailureError);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.kind).toBe("error");
    expect(run.results[0]?.error?.message).toContain('"msg"');
    expect(run.results[0]?.error?.message).not.toContain("hostile-json");
    expect(run.results[0]?.error?.message).not.toContain("hostile-string");
  });

  it("a throwing getter read at format time cannot change the outcome", function* () {
    const doc = [
      "<Testing><Test>",
      "<Assert expr={({ get boom() { throw new Error('format-time read'); } })} />",
      "</Test></Testing>",
      "",
    ].join("\n");
    const run = yield* runDoc({ "README.md": doc });
    expect(run.completion.ok).toBe(true);
    expect(run.results[0]?.status).toBe("pass");
    expect(run.output).toContain("[object Object]");
  });
});
