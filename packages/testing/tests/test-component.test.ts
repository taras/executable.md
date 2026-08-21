/**
 * `<Test>` as a registered function component (specs/testing-spec.md).
 *
 * These pin the properties the migration off the `Component.expand` claim had
 * to preserve, each of which broke at least once while it was being made.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Component, registerComponents, useTempFileCompiler } from "@executablemd/core";
import type { ErrorSegment } from "@executablemd/core";
import { createTestHandlers } from "../src/handlers.ts";
import { absorbTestFailure, Staging } from "../src/test-component.ts";
import { runDoc } from "./helpers.ts";

describe("<Test> as a function component", () => {
  beforeAll(() => useTempFileCompiler());

  /** An eval block whose retained work fails while the test is dismantled. */
  const FAILING_CLEANUP = [
    "```js persist eval",
    'yield* spawn(function* () { try { yield* suspend(); } finally { throw new Error("cleanup exploded"); } });',
    "```",
  ].join("\n");
  // The raise interceptor answers nearest-first so <AssertThrows> can catch a
  // diagnostic before the test claims it. That must not cost the property the
  // interception exists for: a raise the test does NOT claim still fails it,
  // even when other middleware observed the segment first.
  it("fails the test on a raise an outer observer already saw", function* () {
    const observed: ErrorSegment[] = [];
    const doc = [
      "<Testing>",
      '<Test name="t">',
      '<Strict n="not a number" />',
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");
    const strict = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    n: { type: number }",
      "  required: [n]",
      "---",
      "",
      "ok",
      "",
    ].join("\n");

    const run = yield* scoped(function* () {
      yield* Component.around({
        *raise([segment], next) {
          observed.push(segment);
          return yield* next(segment);
        },
      });
      return yield* runDoc({ "README.md": doc, "Strict.md": strict });
    });

    // The observer saw it, and the test still failed because of it.
    expect(observed.length).toBeGreaterThan(0);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("must be number");
  });

  // Content a component projects is the CALLER's markdown, so `{meta.x}` in it
  // resolves against the expansion that wrote it, which projection has to be
  // handed.
  it("resolves the document's frontmatter inside a test body", function* () {
    const doc = [
      "---",
      "title: Executable MDX",
      "---",
      "",
      "<Testing>",
      '<Test name="t">',
      '<Let as="heading"># {meta.title}</Let>',
      '<AssertEquals actual={heading} expected={"# Executable MDX"} />',
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results[0]?.status).toBe("pass");
    expect(run.completion.ok).toBe(true);
  });

  // An eval block is not an invocation: what it retains anchors in the test's
  // own eval scope, so its cleanup failing IS the test's invocation teardown.
  // That arrives at the session boundary after <Test> has returned, and has to
  // land on that test's staged result.
  it("records a teardown failure as that test's outcome, and fails only it", function* () {
    const doc = [
      "<Testing>",
      '<Test name="tears">',
      FAILING_CLEANUP,
      "<Assert expr={true} />",
      "</Test>",
      '<Test name="fine"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["tears", "fail", "teardown"],
      ["fine", "pass", undefined],
    ]);
    expect(run.results[0]?.error?.message).toContain("cleanup exploded");
  });

  // The body's account is the more useful one, so a test that already failed
  // keeps its own classification when teardown fails too.
  it("keeps the body's classification when teardown also fails", function* () {
    const doc = [
      "<Testing>",
      '<Test name="both">',
      FAILING_CLEANUP,
      "<Assert expr={false} />",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.kind).toBe("assertion");
  });

  // A component failing beside a test is not the test's outcome: the session
  // layer delegates anything that is not a <Test> invocation.
  it("does not turn a neighbouring component's failure into a test result", function* () {
    const doc = ["<Testing>", '<Test name="only"><Wilting /></Test>', "</Testing>", ""].join("\n");

    const run = yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Wilting",
          origin: "test",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn() {
            yield* ensure(function* () {
              throw new Error("component cleanup exploded");
            });
            return "";
          },
        },
      ]);
      return yield* runDoc({ "README.md": doc });
    });

    // One result, for the test that contained it — classified as an ordinary
    // error, because the component's teardown is the component's, not the
    // test's.
    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.name).toBe("only");
    expect(run.results[0]?.error?.kind).toBe("error");
  });

  /** Every journalled entry of `type`, by the name it recorded, in order. */
  function* entriesOf(stream: InMemoryStream, type: string): Operation<string[]> {
    const events = yield* stream.readAll();
    const names: string[] = [];
    for (const event of events) {
      if (event.type === "yield" && event.description.type === type) {
        names.push(String(event.description.name));
      }
    }
    return names;
  }

  // Staging defers the journal write, so the thing to pin is that deferring it
  // does not reorder it: results are recorded and journalled in discovery
  // order, including the one an upgrade rewrote after its test had returned.
  it("records and journals in discovery order when a middle test tears down badly", function* () {
    const doc = [
      "<Testing>",
      '<Test name="one"><Assert expr={true} /></Test>',
      '<Test name="two">',
      FAILING_CLEANUP,
      "<Assert expr={true} /></Test>",
      '<Test name="three"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const stream = new InMemoryStream();
    const run = yield* runDoc({ "README.md": doc }, { stream });

    expect(run.results.map((r) => [r.name, r.error?.kind])).toEqual([
      ["one", undefined],
      ["two", "teardown"],
      ["three", undefined],
    ]);
    const journalled = yield* entriesOf(stream, "test_result");
    expect(journalled).toHaveLength(3);
    expect(journalled).toEqual([...journalled].sort((a, b) => a.localeCompare(b)));
  });

  // A root run has no <Testing> element, so nothing in the document flushes the
  // last test. The region useTesting installs settles inside durableRun, before
  // the root Close — so the result is journalled, and a replay restores it.
  it("journals the last test of a root run, and restores it on replay", function* () {
    const doc = ['<Test name="last"><Assert expr={true} /></Test>', ""].join("\n");

    const stream = new InMemoryStream();
    const first = yield* runDoc({ "README.md": doc }, { stream, testing: true });
    expect(first.results.map((r) => [r.name, r.status])).toEqual([["last", "pass"]]);
    expect(yield* entriesOf(stream, "test_result")).toHaveLength(1);

    const again = yield* runDoc({ "README.md": doc }, { stream, testing: true });
    expect(again.results.map((r) => [r.name, r.status])).toEqual([["last", "pass"]]);
  });

  // The same, with the upgrade applied: what flushes is the rewritten result,
  // so that is also what the journal holds and what a replay restores.
  it("journals the upgraded result when a root run's last test tears down badly", function* () {
    const doc = ['<Test name="last">', FAILING_CLEANUP, "<Assert expr={true} /></Test>", ""].join(
      "\n",
    );

    const stream = new InMemoryStream();
    const first = yield* runDoc({ "README.md": doc }, { stream, testing: true });
    expect(first.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["last", "fail", "teardown"],
    ]);

    const again = yield* runDoc({ "README.md": doc }, { stream, testing: true });
    expect(again.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["last", "fail", "teardown"],
    ]);
  });

  // The root region is flush-only: it reports no outcome of its own, so a root
  // run's journal looks exactly like one without it.
  it("writes no boundary entry for a root run", function* () {
    const doc = ['<Test name="solo"><Assert expr={true} /></Test>', ""].join("\n");

    const stream = new InMemoryStream();
    yield* runDoc({ "README.md": doc }, { stream, testing: true });

    expect(yield* entriesOf(stream, "testing_boundary")).toEqual([]);
    expect(yield* entriesOf(stream, "test_result")).toHaveLength(1);
  });

  // A timed-out body was halted mid-flight, so there is no partial output to
  // keep — the report is the diagnostic alone (§5.3).
  it("renders only the diagnostic when a test times out", function* () {
    const doc = [
      "<Testing>",
      '<Test name="hangs">',
      "BEFORE THE HANG",
      "",
      "```js persist eval",
      "yield* suspend();",
      "```",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc(
      { "README.md": doc },
      { handlers: createTestHandlers({ timeoutMs: 60 }) },
    );

    expect(run.results[0]?.error?.kind).toBe("timeout");
    expect(run.output).not.toContain("BEFORE THE HANG");
    expect(run.output).toContain("timed out");
  });

  // `timeout=` is the test's own bound: a body the installed default would cut
  // short finishes inside the duration the element declares (§5.3).
  it("lets a declared timeout outlive a shorter installed default", function* () {
    const doc = [
      "<Testing>",
      '<Test name="patient" timeout="5s">',
      "```js eval",
      "yield* sleep(150);",
      "```",
      "<Assert expr={true} />",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc(
      { "README.md": doc },
      { handlers: createTestHandlers({ timeoutMs: 60 }) },
    );

    expect(run.results[0]?.status).toBe("pass");
  });

  // The declared bound also cuts, and the diagnostic names the duration the
  // element declared rather than the default it replaced.
  it("times out at a declared timeout below the default", function* () {
    const doc = [
      "<Testing>",
      '<Test name="hasty" timeout="60ms">',
      "```js persist eval",
      "yield* suspend();",
      "```",
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results[0]?.error?.kind).toBe("timeout");
    expect(run.results[0]?.error?.message).toContain("0.06 seconds");
  });

  // A malformed duration is refused where it was written, and where it was
  // written is one test — the ones after it still run.
  it("fails only the declaring test on a malformed timeout", function* () {
    const doc = [
      "<Testing>",
      '<Test name="broken" timeout="soon">inside</Test>',
      '<Test name="after"><Assert expr={true} /></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results).toHaveLength(2);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("<Test timeout> must be a duration");
    expect(run.results[1]?.status).toBe("pass");
  });

  // A teardown-failed test had already returned, so the engine replaces its
  // output with the boundary's diagnostic — no body text survives (§5.4).
  it("renders only the boundary diagnostic when teardown fails", function* () {
    const doc = [
      "<Testing>",
      '<Test name="tears">',
      "BODY TEXT",
      "",
      FAILING_CLEANUP,
      "</Test>",
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results[0]?.error?.kind).toBe("teardown");
    expect(run.output).not.toContain("BODY TEXT");
    expect(run.output).toContain("cleanup exploded");
  });

  // Outside testing mode a <Test> renders nothing of itself. The blank lines
  // around it are the author's and stay, exactly as they would around any
  // element that renders nothing — so the comparison is against the element
  // removed, not against the lines it sat between removed too (§5.2).
  it("renders nothing of itself when skipped", function* () {
    const withTest = ["before", "", '<Test name="skipped">inside</Test>', "", "after", ""].join(
      "\n",
    );
    const withoutTest = ["before", "", "", "", "after", ""].join("\n");

    const skipped = yield* runDoc({ "README.md": withTest }, { testing: false });
    const plain = yield* runDoc({ "README.md": withoutTest }, { testing: false });

    expect(skipped.output).not.toContain("inside");
    expect(skipped.output).toBe(plain.output);
  });

  // A nested <Test> is invalid, and what that means is the ENCLOSING test's
  // recorded outcome — not the shape of anything it returned.
  it("fails the enclosing test on nesting, recorded as an error", function* () {
    const doc = [
      "<Testing>",
      '<Test name="outer"><Test name="inner"><Assert expr={true} /></Test></Test>',
      "</Testing>",
      "",
    ].join("\n");

    const run = yield* runDoc({ "README.md": doc });

    expect(run.results.map((r) => [r.name, r.status, r.error?.kind])).toEqual([
      ["outer", "fail", "error"],
    ]);
    expect(run.results[0]?.error?.message).toContain("Nested <Test>");
  });

  // §3a case 2: an invocation that died before it could stage. Pinned at the
  // harness rather than through a document, because no document can reach it —
  // to arrive at handleFailure a <Test> must throw before stageResult, and the
  // only such route is the nested-<Test> raise, which always carries the
  // enclosing interceptor's RaisedSegmentError and is therefore delegated. The
  // synthesis still has to be right: a test that died is reported as failed
  // rather than vanishing from the run.
  it("synthesizes a result for a failure with nothing staged", function* () {
    yield* Staging.set({ staged: [] });

    const died = new Error("middleware install exploded");
    const synthesized = yield* absorbTestFailure("README.md:4:1", died);

    expect(synthesized.status).toBe("fail");
    expect(synthesized.error?.kind).toBe("error");
    expect(synthesized.error?.message).toContain("middleware install exploded");
    expect(synthesized.location).toBe("README.md:4:1");

    // Staged, so the ordinary flush writes and records it like any other.
    const queue = yield* Staging.get();
    expect(queue?.staged.map((entry) => entry.location)).toEqual(["README.md:4:1"]);
  });

  // The same call must NOT synthesize when the position is already staged —
  // that is the upgrade path, and a second entry would double-count the test.
  it("upgrades rather than synthesizing when the position is staged", function* () {
    yield* Staging.set({
      staged: [
        { location: "README.md:2:1", result: { status: "pass", location: "README.md:2:1" } },
      ],
    });

    const upgraded = yield* absorbTestFailure("README.md:2:1", new Error("late"));

    expect(upgraded.error?.kind).toBe("teardown");
    const queue = yield* Staging.get();
    expect(queue?.staged).toHaveLength(1);
  });
});
