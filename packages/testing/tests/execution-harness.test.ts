/**
 * `<Execution>` — a Markdown test running another document as a real root
 * (specs/testing-spec.md, issue #454).
 *
 * The trusted host here is the stub in `execution-host-stub.ts`: these tests are
 * about the harness — targets and inline source, declaration installation,
 * display versus collection, journal policy, outcomes and authority — and not
 * about production assembly, which is the CLI's contract and is held there.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, scoped, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import {
  Component,
  hasContent,
  registerComponents,
  TestBehavior,
  tryContent,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { Json, PropsSchema } from "@executablemd/core";
import type {
  ChildConfiguration,
  ChildDeclaration,
  ChildDeclarationChild,
} from "../src/child-configuration.ts";
import { useTesting } from "../src/use-testing.ts";
import { testHarnessInstallation } from "../src/execution-harness.ts";
import { ExecutionHost } from "../src/execution-host.ts";
import type { ExecutionHostProvider, ExecutionHostRequest } from "../src/execution-host.ts";
import type { TestResult } from "../src/test-api.ts";
import { stubExecutionHost } from "./execution-host-stub.ts";
import type { StubHostLog, StubHostOptions } from "./execution-host-stub.ts";

interface HarnessRun {
  readonly output: string;
  readonly chunks: readonly string[];
  readonly completion: Result<Json>;
  readonly results: readonly TestResult[];
  readonly log: StubHostLog;
}

interface RunOptions {
  /** Extra installs, run after the testing session and before the document. */
  readonly around?: () => Operation<void>;
  readonly emit?: StubHostOptions["emit"];
  /** Called for each chunk the outer document emits, as it arrives. */
  readonly onChunk?: (chunk: string) => Operation<void>;
}

function* runHarness(
  files: Record<string, string>,
  options: RunOptions = {},
): Operation<HarnessRun> {
  return yield* scoped(function* () {
    yield* useStubFs(files);
    const tests = yield* useTesting();
    const stub = stubExecutionHost({
      files,
      ...(options.emit === undefined ? {} : { emit: options.emit }),
    });
    const log = stub.log;
    if (options.around) {
      yield* options.around();
    }
    // The harness authority is a delivery the host attaches, so these tests are
    // the host: without this, `<Execution>` is recognized and refused.
    const execution = yield* executeInstalled({ path: "README.md", stream: new InMemoryStream() }, [
      testHarnessInstallation(stub.provider),
    ]);
    const chunks: string[] = [];
    const output = yield* forEach(function* (chunk: string) {
      chunks.push(chunk);
      if (options.onChunk) {
        yield* options.onChunk(chunk);
      }
    }, execution.output);
    const completion = yield* execution;
    return { output, chunks, completion, results: yield* tests.results, log };
  });
}

/** What ended a run that produced no test result. */
function failureOf(run: HarnessRun): string {
  return run.completion.ok ? "" : run.completion.error.message;
}

/** The one test in a run, or a readable failure when the run had none. */
function only(run: HarnessRun): TestResult {
  const [first] = run.results;
  if (first === undefined) {
    throw new Error(`no test was recorded; run ended with ${failureOf(run)}`);
  }
  return first;
}

function doc(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

const CHILD_WITH_PROPS = doc(
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    who: { type: string }",
  "  required: [who]",
  "  additionalProperties: false",
  "---",
  "",
  "hello {props.who}",
);

describe('<Execution host="run">', () => {
  it("runs a referenced document as a root, with root props and text return", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        '<Test name="child">',
        '<Execution host="run" target="reports/quarterly-summary.md" props={{ who: "world" }} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertEquals actual={child.kind} expected="settled" />',
        "<AssertEquals actual={child.result.ok} expected={true} />",
        '<AssertStringIncludes actual={output} expected="hello world" />',
        "</Execution>",
        "</Test>",
      ),
      "reports/quarterly-summary.md": CHILD_WITH_PROPS,
    });
    expect(only(run).status).toBe("pass");
    expect(run.log.requests[0]?.target).toBe("reports/quarterly-summary.md");
  });

  it("selects one target inside a document without component addressability", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        '<Test name="target">',
        '<Execution host="run" target="guide.md#Second" as="child">',
        '<CollectOutput as="output" />',
        "",
        "<AssertEquals actual={child.result.ok} expected={true} />",
        '<AssertStringIncludes actual={output} expected="second body" />',
        "</Execution>",
        "</Test>",
      ),
      "guide.md": doc("# First", "", "first body", "", "# Second", "", "second body"),
    });
    expect(only(run).status).toBe("pass");
    expect(run.output).not.toContain("first body");
  });

  it("carries a text root's rendered markdown as the settled value", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        '<Test name="text">',
        '<Execution host="run" target="child.md" as="child">',
        '<AssertStringIncludes actual={child.result.value} expected="child body" />',
        "</Execution>",
        "</Test>",
      ),
      "child.md": doc("child body"),
    });
    expect(only(run).status).toBe("pass");
  });

  it("runs inline source under the <eval> identity, with no authored file", function* () {
    const files = { "README.md": "" };
    files["README.md"] = doc(
      '<Test name="inline">',
      '<Execution host="run" source={"inline body\\n"} as="child">',
      '<CollectOutput as="output" />',
      "",
      '<AssertStringIncludes actual={output} expected="inline body" />',
      "</Execution>",
      "</Test>",
    );
    const run = yield* runHarness(files);
    expect(only(run).status).toBe("pass");
    // The identity the child reports is the inline one, and the harness named
    // no file for it to have come from. That production takes the same path is
    // held by packages/cli/tests/testing-execution-host.test.ts.
    expect(run.log.roots).toEqual(["<eval>"]);
    expect(run.log.requests[0]?.target).toBeUndefined();
    expect(Object.keys(files)).toEqual(["README.md"]);
  });

  it("refuses a run that names both a target and a source", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        '<Test name="both">',
        '<Execution host="run" target="child.md" source={"x"} as="child" />',
        "</Test>",
      ),
      "child.md": doc("child"),
    });
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("exactly one of");
    expect(run.log.requests).toEqual([]);
  });
});

describe("child failure", () => {
  const FAILING = {
    "README.md": "",
    "boom.md": doc("```sh exec", "exit 3", "```"),
  };

  it("is assertable when the outcome is bound", function* () {
    const run = yield* runHarness({
      ...FAILING,
      "README.md": doc(
        '<Test name="bound">',
        '<Execution host="run" target="boom.md" as="child">',
        "<AssertEquals actual={child.result.ok} expected={false} />",
        "</Execution>",
        "</Test>",
      ),
    });
    expect(only(run).status).toBe("pass");
  });

  it("fails the owning test when the outcome is not bound", function* () {
    const run = yield* runHarness({
      ...FAILING,
      "README.md": doc(
        '<Test name="unbound">',
        '<Execution host="run" target="boom.md" />',
        "</Test>",
      ),
    });
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("ran a child that failed");
  });

  it("keeps the output rendered before the failure", function* () {
    const run = yield* runHarness({
      ...FAILING,
      "README.md": doc(
        '<Test name="partial">',
        '<Execution host="run" target="boom.md" as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="before the failure" />',
        "</Execution>",
        "</Test>",
      ),
      "boom.md": doc("before the failure", "", "```sh exec", "exit 3", "```"),
    });
    expect(only(run).status).toBe("pass");
  });
});

describe("display and collection", () => {
  it("displays each chunk before the child has settled", function* () {
    const displayed = withResolvers<void>();
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="progressive">',
          '<Execution host="run" source={"unused"} as="child">',
          '<CollectOutput as="output" />',
          "",
          '<AssertStringIncludes actual={output} expected="first" />',
          '<AssertStringIncludes actual={output} expected="second" />',
          "</Execution>",
          "</Test>",
        ),
      },
      {
        // The gate is at the consumer, not on a clock: the second chunk is not
        // produced until the first has been received by this document's own
        // output reader, so a harness that buffered would deadlock rather than
        // pass late.
        *emit(chunk) {
          yield* chunk("first\n");
          yield* displayed.operation;
          yield* chunk("second\n");
        },
        *onChunk(text: string) {
          if (text.includes("first")) {
            displayed.resolve();
          }
        },
      },
    );
    expect(only(run).status).toBe("pass");
    // Read from the chunks the consumer received, which is where a child's
    // output is: it is this document's output *stream*, not the text this
    // document rendered.
    expect(run.chunks.join("")).toContain("first");
    expect(run.chunks.join("")).toContain("second");
  });

  it("displays a child that nothing collects", function* () {
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="uncollected">',
          '<Execution host="run" source={"unused"} as="child" />',
          "</Test>",
        ),
      },
      {
        *emit(chunk) {
          yield* chunk("shown anyway\n");
        },
      },
    );
    expect(only(run).status).toBe("pass");
    expect(run.chunks.join("")).toContain("shown anyway");
  });

  it("leaves <Let> lexical: it never sees the child's stream", function* () {
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="capture">',
          '<Let as="lexical">',
          '<Execution host="run" source={"unused"} as="child" />',
          "lexical text",
          "</Let>",
          '<AssertStringIncludes actual={lexical} expected="lexical text" />',
          '<AssertEquals actual={lexical.includes("child stream")} expected={false} />',
          "</Test>",
        ),
      },
      {
        *emit(chunk) {
          yield* chunk("child stream\n");
        },
      },
    );
    expect(only(run).status).toBe("pass");
  });
});

describe("journal policy", () => {
  const CHILD = { "child.md": doc("child body") };

  it("allocates no journal for a transient run", function* () {
    const run = yield* runHarness({
      ...CHILD,
      "README.md": doc(
        '<Test name="transient">',
        '<Execution host="run" target="child.md" as="child" />',
        "</Test>",
      ),
    });
    expect(only(run).status).toBe("pass");
    expect(run.log.requests[0]?.journal).toBe("transient");
  });

  it("refuses <CollectJournal> without a selected journal, before the child runs", function* () {
    const run = yield* runHarness({
      ...CHILD,
      "README.md": doc(
        '<Test name="no-journal">',
        '<Execution host="run" target="child.md" as="child">',
        '<CollectJournal as="journal" />',
        "</Execution>",
        "</Test>",
      ),
    });
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("<CollectJournal>");
    expect(run.log.requests).toEqual([]);
  });

  it("retains and collects a diagnostic run journal", function* () {
    const run = yield* runHarness({
      ...CHILD,
      "README.md": doc(
        '<Test name="diagnostic">',
        '<Execution host="run" target="child.md" as="child">',
        "<DiagnosticJournal />",
        '<CollectJournal as="journal" />',
        "",
        "<AssertEquals actual={journal.length > 0} expected={true} />",
        "</Execution>",
        "</Test>",
      ),
    });
    expect(only(run).status).toBe("pass");
    expect(run.log.requests[0]?.journal).toBe("diagnostic");
    expect(run.log.requests[0]?.collectJournal).toBe(true);
  });

  it("installs every declaration before the child's root is imported", function* () {
    const run = yield* runHarness({
      ...CHILD,
      "README.md": doc(
        '<Test name="before-import">',
        '<Execution host="run" target="child.md" as="child">',
        "<DiagnosticJournal />",
        '<CollectOutput as="output" />',
        '<CollectJournal as="journal" />',
        "",
        "<AssertEquals actual={child.result.ok} expected={true} />",
        "</Execution>",
        "</Test>",
      ),
    });
    expect(only(run).status).toBe("pass");
    // The profile the terminal settled on is complete at the moment the host is
    // first asked for a child, which is before it imports anything.
    expect(run.log.requests[0]).toMatchObject({ journal: "diagnostic", collectJournal: true });
  });
});

describe("authority", () => {
  it("refuses <Execution> outside a canonical <Test>", function* () {
    const run = yield* runHarness({
      "README.md": doc("<Testing>", '<Execution host="run" target="child.md" />', "</Testing>"),
      "child.md": doc("child"),
    });
    expect(run.completion.ok).toBe(false);
    expect(failureOf(run)).toContain("canonical <Test>");
    expect(run.log.requests).toEqual([]);
  });

  it("grants nothing to a repository component named Test", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        "<Testing>",
        '<Test name="counterfeit">',
        '<Execution host="run" target="child.md" />',
        "</Test>",
        "</Testing>",
      ),
      // Chosen ahead of core's default, so core's <Test> never runs and no
      // harness is minted for what it expands.
      "components/Test.md": doc(
        "---",
        "props:",
        "  type: object",
        "  properties:",
        "    name: { type: string }",
        "  additionalProperties: false",
        "---",
        "",
        "<Content />",
      ),
      "child.md": doc("child"),
    });
    expect(failureOf(run)).toContain("canonical <Test>");
    expect(run.log.requests).toEqual([]);
  });

  it("lets public middleware refuse, and never lets it publish a child", function* () {
    const seen: string[] = [];
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="middleware">',
          '<Execution host="run" target="child.md" as="child" />',
          "</Test>",
        ),
        "child.md": doc("child"),
      },
      {
        *around() {
          yield* ExecutionHost.around({
            // Answers without delegating: a handler that returns is not a child,
            // so the invocation reports that nothing ran rather than accepting
            // whatever the handler decided.
            // deno-lint-ignore require-yield
            *run([request]: [ExecutionHostRequest]) {
              seen.push(request.profile.host);
            },
          });
        },
      },
    );
    expect(seen).toEqual(["run"]);
    expect(run.log.requests).toEqual([]);
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("without delegating");
  });

  it("refuses a second delegation of one request", function* () {
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="replay">',
          '<Execution host="run" target="child.md" as="child" />',
          "</Test>",
        ),
        "child.md": doc("child"),
      },
      {
        *around() {
          yield* ExecutionHost.around({
            *run([request]: [ExecutionHostRequest], next) {
              yield* next(request);
              yield* next(request);
            },
          });
        },
      },
    );
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("more than once");
    // The terminal only records the request; the child runs after the chain
    // unwinds, and a chain that violated the protocol never gets that far.
    expect(run.log.requests).toEqual([]);
  });

  it("refuses a request another invocation issued", function* () {
    let stolen: ExecutionHostRequest | undefined;
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="stolen">',
          '<Execution host="run" target="child.md" as="first" />',
          '<Execution host="run" target="child.md" as="second" />',
          "</Test>",
        ),
        "child.md": doc("child"),
      },
      {
        *around() {
          yield* ExecutionHost.around({
            *run([request]: [ExecutionHostRequest], next) {
              if (stolen === undefined) {
                stolen = request;
                yield* next(request);
                return;
              }
              yield* next(stolen);
            },
          });
        },
      },
    );
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("another <Execution> issued");
  });

  it("refuses a declaration written outside <Execution>", function* () {
    const run = yield* runHarness({
      "README.md": doc('<Test name="loose">', '<CollectOutput as="output" />', "</Test>"),
    });
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("declaration inside <Execution>");
  });

  it("gives a repository component named CollectOutput ordinary semantics", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        '<Test name="shadowed">',
        '<Execution host="run" target="child.md" as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="repository" />',
        "</Execution>",
        "</Test>",
      ),
      // Selected ahead of this package's default, so the scan ends where it is
      // written and it expands with the assertions as any component would.
      "components/CollectOutput.md": doc("repository text"),
      "child.md": doc("child"),
    });
    expect(only(run).status).toBe("pass");
  });
});

describe("the authority path", () => {
  const DOC = {
    "README.md": doc(
      '<Test name="no-authority">',
      '<Execution host="run" target="child.md" />',
      "</Test>",
    ),
    "child.md": doc("child"),
  };

  /** One run, with the host attaching exactly what the case is about. */
  function* runWith(
    files: Record<string, string>,
    installations: (provider: ExecutionHostProvider) => readonly ExecutionInstallation[],
    around?: () => Operation<void>,
  ): Operation<{ results: readonly TestResult[]; failure: string; log: StubHostLog }> {
    return yield* scoped(function* () {
      yield* useStubFs(files);
      // Installed ahead of the session, so a handler this case composes onto a
      // behavior hook is the outermost one and actually observes the call.
      if (around) {
        yield* around();
      }
      const tests = yield* useTesting();
      const stub = stubExecutionHost({ files });
      const execution = yield* executeInstalled(
        { path: "README.md", stream: new InMemoryStream() },
        installations(stub.provider),
      );
      yield* forEach(function* () {}, execution.output);
      const completion = yield* execution;
      return {
        results: yield* tests.results,
        failure: completion.ok ? "" : completion.error.message,
        log: stub.log,
      };
    });
  }

  it("refuses inside a real <Test> when the host attached no installer", function* () {
    // The capability exists only as the argument of a delivery, so a host that
    // attached no receiver leaves every test without one — including this one,
    // which is a canonical <Test> in every other respect.
    const run = yield* runWith(DOC, () => []);
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("canonical <Test>");
  });

  it("refuses when a harness exists but no trusted host profile does", function* () {
    const run = yield* scoped(function* () {
      yield* useStubFs(DOC);
      const tests = yield* useTesting();
      const execution = yield* executeInstalled(
        { path: "README.md", stream: new InMemoryStream() },
        [testHarnessInstallation()],
      );
      yield* forEach(function* () {}, execution.output);
      yield* execution;
      return { results: yield* tests.results, failure: "" };
    });
    expect(run.results[0]?.error?.message).toContain("trusted host profile");
  });

  it("hands nothing to installers planted under the context's name", function* () {
    const stolen: unknown[] = [];
    // The name is public — it is in the source. What is not public is the value:
    // canonical execution publishes one this module built, and a look-alike is
    // refused rather than delivered to.
    const Planted = createContext<unknown>("core.test.harness-installers", undefined);
    const run = yield* runWith(
      DOC,
      (provider) => [testHarnessInstallation(provider)],
      function* () {
        yield* Planted.set({
          installers: [
            function* (harness: unknown) {
              stolen.push(harness);
            },
          ],
        });
      },
    );
    // Two facts, and the second is why the first is not an accident. The
    // planted installer is handed nothing; and the delivery it tried to stand in
    // for is unaffected, because canonical execution publishes its own holder
    // inside the invocation — nearer than anything a caller set outside it — and
    // would refuse an unbranded value even if one were nearer.
    expect(stolen).toEqual([]);
    expect(run.results[0]?.status).toBe("pass");
  });

  it("ignores providers planted under the former public provider context", function* () {
    const called: string[] = [];
    const FormerProvider = createContext<ExecutionHostProvider | undefined>(
      "testing.execution-host.provider",
      undefined,
    );
    const run = yield* runWith(
      DOC,
      (provider) => [testHarnessInstallation(provider)],
      function* () {
        yield* FormerProvider.set({
          *runChild(_invocation) {
            called.push("synthetic");
            return { outcome: { kind: "settled", result: { ok: true, value: "" } }, output: "" };
          },
        });
      },
    );
    expect(called).toEqual([]);
    expect(run.log.roots).toEqual(["child.md"]);
    expect(run.results[0]?.status).toBe("pass");
  });

  it("does not let Component middleware turn a bound child failure into an unbound failure", function* () {
    const run = yield* runWith(
      {
        "README.md": doc(
          '<Test name="bound">',
          '<Execution host="run" target="boom.md" as="child">',
          "<AssertEquals actual={child.result.ok} expected={false} />",
          "</Execution>",
          "</Test>",
        ),
        "boom.md": doc("```sh exec", "exit 3", "```"),
      },
      (provider) => [testHarnessInstallation(provider)],
      function* () {
        yield* Component.around({
          // deno-lint-ignore require-yield
          *hasBinding() {
            return false;
          },
        });
      },
    );
    expect(run.results[0]?.status).toBe("pass");
  });

  it("does not let Component middleware rescue an unbound child failure", function* () {
    const run = yield* runWith(
      {
        "README.md": doc(
          '<Test name="unbound">',
          '<Execution host="run" target="boom.md" />',
          "</Test>",
        ),
        "boom.md": doc("```sh exec", "exit 3", "```"),
      },
      (provider) => [testHarnessInstallation(provider)],
      function* () {
        yield* Component.around({
          // deno-lint-ignore require-yield
          *hasBinding() {
            return true;
          },
        });
      },
    );
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("ran a child that failed");
  });

  it("leaves no public Component operation that can suppress early publication", function* () {
    expect("publishBinding" in Component.operations).toBe(false);
  });

  it("freezes the host profile before middleware sees it", function* () {
    let hasReplacement = true;
    let topLevelFrozen = false;
    let propsFrozen = false;
    const run = yield* runWith(
      {
        "README.md": doc(
          '<Test name="immutable">',
          '<Execution host="run" target="child.md" props={{ who: "original" }} as="child">',
          '<CollectOutput as="output" />',
          "",
          '<AssertStringIncludes actual={output} expected="hello original" />',
          '<AssertEquals actual={output.includes("fake")} expected={false} />',
          "</Execution>",
          "</Test>",
        ),
        "child.md": doc(
          "---",
          "props:",
          "  type: object",
          "  properties:",
          "    who: { type: string }",
          "  required: [who]",
          "  additionalProperties: false",
          "---",
          "",
          "hello {props.who}",
        ),
        "other.md": doc("wrong target"),
      },
      (provider) => [testHarnessInstallation(provider)],
      function* () {
        yield* ExecutionHost.around({
          *run([request]: [ExecutionHostRequest], next) {
            hasReplacement = "withProfile" in request;
            try {
              Object.assign(request.profile, {
                target: "other.md",
                source: "fake",
                action: "resume",
                journal: "diagnostic",
              });
            } catch {
              topLevelFrozen = true;
            }
            try {
              Object.assign(request.profile.props, { who: "fake" });
            } catch {
              propsFrozen = true;
            }
            yield* next(request);
          },
        });
      },
    );
    expect(hasReplacement).toBe(false);
    expect(topLevelFrozen).toBe(true);
    expect(propsFrozen).toBe(true);
    expect(run.log.requests[0]?.target).toBe("child.md");
    expect(run.log.requests[0]?.props).toEqual({ who: "original" });
    expect(run.results[0]?.status).toBe("pass");
  });

  it("does not carry the capability in what <Test>'s behavior is called with", function* () {
    const arguments_: unknown[][] = [];
    const run = yield* runWith(
      {
        "README.md": doc('<Test name="behavior">', "body", "</Test>"),
      },
      (provider) => [testHarnessInstallation(provider)],
      function* () {
        // Public middleware on the behavior hook. It sees what a test was
        // written with and nothing else: no argument carries authority, so a
        // second loaded copy composing here acquires none either.
        yield* TestBehavior.around({
          *test(args, next) {
            arguments_.push([...args]);
            return yield* next(...args);
          },
        });
      },
    );
    expect(run.results[0]?.status).toBe("pass");
    expect(arguments_.length).toBe(1);
    expect(arguments_[0]?.length).toBe(1);
    expect(arguments_[0]?.[0]).toEqual({ name: "behavior" });
  });
});

/**
 * The declarations that configure a child's deterministic dependencies
 * (specs/testing-spec.md).
 *
 * The `<TestAgent>` half of that contract belongs to `@executablemd/test-agent`,
 * which depends on this package — so what is held here is the seam itself: that
 * a declaration is recognized by the definition it resolved to, that what it
 * produces is frozen data, that a malformed one refuses before a child is
 * created, and that public middleware can read the configuration and change
 * none of it. The stub below stands in for a contributing package exactly as
 * `execution-host-stub.ts` stands in for the CLI.
 */
describe("child configuration declarations", () => {
  const AGENT_PROPS: PropsSchema = {
    type: "object",
    properties: { agent: { type: "string" } },
    additionalProperties: false,
  };

  const SCENARIO_PROPS: PropsSchema = {
    type: "object",
    properties: { src: { type: "string" }, agent: { type: "string" }, session: { type: "string" } },
    required: ["src"],
    additionalProperties: false,
  };

  /** The definition a contributing package registers for the wrapper. */
  // deno-lint-ignore require-yield
  function* PackageTestAgent(): Operation<string> {
    return "the ordinary wrapper";
  }

  /** The definition it registers for the wrapper's own child. */
  // deno-lint-ignore require-yield
  function* PackageScenario(): Operation<string> {
    return "an ordinary scenario";
  }

  /** A same-named definition the package did not register. */
  // deno-lint-ignore require-yield
  function* RepositoryScenario(): Operation<string> {
    return "a repository scenario";
  }

  interface StubScenario {
    agent: string;
    session: string;
    rootDir: string;
    document: { path: string; source: string };
  }

  /**
   * A contributing package's declaration, reduced to what the seam needs.
   *
   * The real one reads behavior documents off disk. This one only produces a
   * `test-agent` configuration, so what the cases are about is the harness's own
   * rules: recognition by definition, what may be nested, at-most-once,
   * declared order, and detachment.
   */
  function stubDeclaration(accepts: unknown = PackageScenario): ChildDeclaration {
    return {
      name: "TestAgent",
      definition: PackageTestAgent,
      open(collect) {
        const scenarios: StubScenario[] = [];
        let defaultAgent = "test";
        let malformed = false;
        function refuse(problem: string): void {
          malformed = true;
          collect.refuse(problem);
        }
        // deno-lint-ignore require-yield
        function* declareScenario(props: Record<string, Json>): Operation<string> {
          const session = typeof props.session === "string" ? props.session : "";
          const agent = typeof props.agent === "string" ? props.agent : defaultAgent;
          if (scenarios.some((mapped) => mapped.agent === agent && mapped.session === session)) {
            refuse(`<TestAgent.Scenario> maps agent "${agent}" more than once.`);
            return "";
          }
          scenarios.push({
            agent,
            session,
            rootDir: "/agents",
            document: { path: String(props.src), source: "behavior" },
          });
          return "";
        }
        return {
          name: "TestAgent",
          children: new Map<unknown, ChildDeclarationChild>([[accepts, declareScenario]]),
          *expand(props: Record<string, Json>): Operation<string> {
            defaultAgent = typeof props.agent === "string" ? props.agent : "test";
            if (yield* hasContent()) {
              const projected = yield* tryContent();
              if (projected.failure !== undefined) {
                throw projected.failure;
              }
              if (projected.text.trim() !== "") {
                refuse("<TestAgent> configures a child, so it holds declarations alone.");
              }
            }
            if (scenarios.length === 0 && !malformed) {
              refuse("<TestAgent> configures a child, so it requires at least one scenario.");
            }
            if (!malformed) {
              collect.configure({ kind: "test-agent", defaultAgent, scenarios });
            }
            return "";
          },
        };
      },
    };
  }

  interface DeclarationRun {
    readonly results: readonly TestResult[];
    readonly failure: string;
    readonly log: StubHostLog;
    readonly output: string;
  }

  function runDeclaring(
    files: Record<string, string>,
    options: {
      readonly declarations?: readonly ChildDeclaration[];
      readonly around?: () => Operation<void>;
    } = {},
  ): Operation<DeclarationRun> {
    return scoped(function* () {
      yield* useStubFs(files);
      // Registered where a contributing package registers them, so the scan
      // meets these definitions through ordinary resolution.
      yield* registerComponents([
        { name: "TestAgent", origin: "stub", fn: PackageTestAgent, props: AGENT_PROPS },
        { name: "TestAgent.Scenario", origin: "stub", fn: PackageScenario, props: SCENARIO_PROPS },
      ]);
      if (options.around) {
        yield* options.around();
      }
      const tests = yield* useTesting();
      const stub = stubExecutionHost({ files });
      const execution = yield* executeInstalled(
        { path: "README.md", stream: new InMemoryStream() },
        [testHarnessInstallation(stub.provider, options.declarations ?? [stubDeclaration()])],
      );
      const output = yield* forEach(function* () {}, execution.output);
      const completion = yield* execution;
      return {
        results: yield* tests.results,
        failure: completion.ok ? "" : completion.error.message,
        log: stub.log,
        output,
      };
    });
  }

  function configurationOf(run: DeclarationRun): readonly ChildConfiguration[] {
    return run.log.requests[0]?.configuration ?? [];
  }

  /** The one test in a run, or a readable failure when the run had none. */
  function single(run: DeclarationRun): TestResult {
    const [first] = run.results;
    if (first === undefined) {
      throw new Error(`no test was recorded; run ended with ${run.failure}`);
    }
    return first;
  }

  it("carries both declarations to the host as ordered, detached data", function* () {
    const run = yield* runDeclaring({
      "README.md": doc(
        '<Test name="declared">',
        '<Execution host="run" target="child.md" as="child">',
        '<TestAgent agent="reviewer">',
        '<TestAgent.Scenario session="review" src="review.md" />',
        '<TestAgent.Scenario src="fallback.md" />',
        "</TestAgent>",
        "",
        "<Answers>",
        '<Answer template="Approve?" value={{ decision: "approve" }} />',
        "</Answers>",
        "",
        "<AssertEquals actual={child.result.ok} expected={true} />",
        "</Execution>",
        "</Test>",
      ),
      "child.md": doc("child body"),
    });
    expect(single(run).status).toBe("pass");
    const configuration = configurationOf(run);
    expect(configuration.map((entry) => entry.kind)).toEqual(["test-agent", "answers"]);
    const [testAgent, answers] = configuration;
    expect(testAgent?.kind === "test-agent" && testAgent.defaultAgent).toBe("reviewer");
    expect(
      testAgent?.kind === "test-agent" &&
        testAgent.scenarios.map((scenario) => [scenario.agent, scenario.session]),
    ).toEqual([
      ["reviewer", "review"],
      ["reviewer", ""],
    ]);
    expect(answers?.kind === "answers" && answers.matchers.length).toBe(1);
  });

  it("reads a declaration once, and not again with the assertions", function* () {
    const run = yield* runDeclaring({
      "README.md": doc(
        '<Test name="once">',
        '<Execution host="run" target="child.md" as="child">',
        "<TestAgent>",
        '<TestAgent.Scenario src="review.md" />',
        "</TestAgent>",
        "",
        "<AssertEquals actual={child.result.ok} expected={true} />",
        "</Execution>",
        "</Test>",
      ),
      "child.md": doc("child body"),
    });
    expect(single(run).status).toBe("pass");
    const [testAgent] = configurationOf(run);
    // Two passes over one declaration would map the same scenario twice, which
    // this stub refuses — so one mapping is the assertion pass having skipped it.
    expect(testAgent?.kind === "test-agent" && testAgent.scenarios.length).toBe(1);
  });

  it("gives a repository component of the declaration's name ordinary semantics", function* () {
    const run = yield* runDeclaring({
      "README.md": doc(
        '<Test name="shadowed">',
        '<Execution host="run" target="child.md" as="child">',
        '<TestAgent as="shadowed" />',
        "",
        "<AssertEquals actual={child.result.ok} expected={true} />",
        '<AssertStringIncludes actual={shadowed} expected="a repository component" />',
        "</Execution>",
        "</Test>",
      ),
      // Chosen ahead of the package's, so the scan ends where it is written and
      // it expands with the assertions as any component would.
      "components/TestAgent.md": doc("a repository component"),
      "child.md": doc("child body"),
    });
    expect(single(run).status).toBe("pass");
    expect(run.log.requests[0]?.configuration).toBe(undefined);
  });

  it("refuses a repository component shadowing a declaration's own child", function* () {
    const run = yield* runDeclaring(
      {
        "README.md": doc(
          '<Test name="nested shadow">',
          '<Execution host="run" target="child.md" as="child">',
          "<TestAgent>",
          '<TestAgent.Scenario src="review.md" />',
          "</TestAgent>",
          "",
          "<AssertEquals actual={child.result.ok} expected={true} />",
          "</Execution>",
          "</Test>",
        ),
        "child.md": doc("child body"),
      },
      // The package registered `PackageScenario`, and this declaration accepts
      // a definition nothing resolves to — the shape a repository
      // `components/TestAgent/Scenario.md` winning resolution produces.
      { declarations: [stubDeclaration(RepositoryScenario)] },
    );
    expect(single(run).status).toBe("fail");
    expect(single(run).error?.message).toContain("accepts only its own declarations");
    expect(run.log.requests.length).toBe(0);
  });

  const MALFORMED: readonly { name: string; body: readonly string[]; says: string }[] = [
    {
      name: "an empty declaration",
      body: ["<TestAgent />"],
      says: "requires at least one scenario",
    },
    {
      name: "a declaration written twice",
      body: [
        "<TestAgent>",
        '<TestAgent.Scenario session="a" src="a.md" />',
        "</TestAgent>",
        "<TestAgent>",
        '<TestAgent.Scenario session="b" src="b.md" />',
        "</TestAgent>",
      ],
      says: "<TestAgent> is declared more than once",
    },
    {
      name: "a declaration holding ordinary content",
      body: ["<TestAgent>", "prose", '<TestAgent.Scenario src="a.md" />', "</TestAgent>"],
      says: "holds declarations alone",
    },
    {
      name: "a duplicate scenario mapping",
      body: [
        "<TestAgent>",
        '<TestAgent.Scenario session="review" src="a.md" />',
        '<TestAgent.Scenario session="review" src="b.md" />',
        "</TestAgent>",
      ],
      says: "more than once",
    },
    {
      name: "an <Answers> with no matchers",
      body: ["<Answers />"],
      says: "requires at least one <Answer>",
    },
    {
      name: "an <Answers> written twice",
      body: [
        "<Answers>",
        '<Answer template="a" value={{ decision: "a" }} />',
        "</Answers>",
        "<Answers>",
        '<Answer template="b" value={{ decision: "b" }} />',
        "</Answers>",
      ],
      says: "<Answers> is declared more than once",
    },
    {
      name: "an <Answers> holding a body",
      body: [
        "<Answers>",
        '<Answer template="a" value={{ decision: "a" }} />',
        "prose",
        "</Answers>",
      ],
      says: "holds matchers alone",
    },
    {
      name: "a malformed matcher",
      body: ["<Answers>", '<Answer template="a" />', "</Answers>"],
      says: 'requires a "value" prop',
    },
    {
      name: "a delegating <Answers>",
      body: [
        "<Answers delegate={true}>",
        '<Answer template="a" value={{ decision: "a" }} />',
        "</Answers>",
      ],
      says: "cannot delegate as child configuration",
    },
    {
      name: "a template referencing a name this document does not bind",
      body: [
        "<Answers>",
        '<Answer template="Approve {plan}?" value={{ decision: "a" }} />',
        "</Answers>",
      ],
      says: "not a bound string value here",
    },
  ];

  for (const malformed of MALFORMED) {
    it(`refuses ${malformed.name} before the child's root is imported`, function* () {
      const run = yield* runDeclaring({
        "README.md": doc(
          '<Test name="malformed">',
          // No such document, so reaching a root at all would fail differently:
          // "the host was never asked" is what the log proves.
          '<Execution host="run" target="absent.md" as="child">',
          ...malformed.body,
          "",
          "<AssertEquals actual={child.result.ok} expected={true} />",
          "</Execution>",
          "</Test>",
        ),
      });
      expect(single(run).status).toBe("fail");
      expect(single(run).error?.message).toContain(malformed.says);
      expect(run.log.requests.length).toBe(0);
      expect(run.log.roots.length).toBe(0);
    });
  }

  it('refuses a declaration on host="workflow"', function* () {
    const run = yield* runDeclaring({
      "README.md": doc(
        '<Test name="workflow">',
        "<WorkflowRun>",
        '<Execution host="workflow" action="start" target="flow.md" as="child">',
        "<TestAgent>",
        '<TestAgent.Scenario src="review.md" />',
        "</TestAgent>",
        "",
        '<AssertEquals actual={child.kind} expected="settled" />',
        "</Execution>",
        "</WorkflowRun>",
        "</Test>",
      ),
      "flow.md": doc("flow"),
    });
    expect(single(run).status).toBe("fail");
    expect(single(run).error?.message).toContain('this execution is host="workflow"');
    expect(run.log.requests.length).toBe(0);
  });

  it("leaves an <Answers> written after the prefix an ordinary region", function* () {
    const run = yield* runDeclaring({
      "README.md": doc(
        '<Test name="ordinary">',
        '<Execution host="run" target="child.md" as="child">',
        "<TestAgent>",
        '<TestAgent.Scenario src="review.md" />',
        "</TestAgent>",
        "",
        "<AssertEquals actual={child.result.ok} expected={true} />",
        "",
        "<Answers>",
        '<Answer template="Approve?" value={{ decision: "approve" }} />',
        "",
        "an answered region",
        "</Answers>",
        "</Execution>",
        "</Test>",
      ),
      "child.md": doc("child body"),
    });
    // Recognized as a declaration it would refuse — a declaration holds
    // matchers alone. Passing is the region having stayed an ordinary one, and
    // one declaration crossed rather than two.
    expect(single(run).status).toBe("pass");
    expect(configurationOf(run).map((entry) => entry.kind)).toEqual(["test-agent"]);
  });

  it("finishes the child's teardown before the assertions expand", function* () {
    const order: string[] = [];
    const run = yield* scoped(function* () {
      const files = {
        "README.md": doc(
          '<Test name="teardown">',
          '<Execution host="run" target="child.md" as="child">',
          "<TestAgent>",
          '<TestAgent.Scenario src="review.md" />',
          "</TestAgent>",
          "",
          "<Mark />",
          "<AssertEquals actual={child.result.ok} expected={true} />",
          "</Execution>",
          "</Test>",
        ),
        "child.md": doc("child body"),
      };
      yield* useStubFs(files);
      yield* registerComponents([
        { name: "TestAgent", origin: "stub", fn: PackageTestAgent, props: AGENT_PROPS },
        { name: "TestAgent.Scenario", origin: "stub", fn: PackageScenario, props: SCENARIO_PROPS },
        {
          name: "Mark",
          origin: "stub",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            order.push("the assertions");
            return "";
          },
        },
      ]);
      const tests = yield* useTesting();
      const stub = stubExecutionHost({
        files,
        onTeardown: () => order.push("the child's teardown"),
      });
      const execution = yield* executeInstalled(
        { path: "README.md", stream: new InMemoryStream() },
        [testHarnessInstallation(stub.provider, [stubDeclaration()])],
      );
      const output = yield* forEach(function* () {}, execution.output);
      const completion = yield* execution;
      return {
        results: yield* tests.results,
        failure: completion.ok ? "" : completion.error.message,
        log: stub.log,
        output,
      };
    });
    expect(single(run).status).toBe("pass");
    // What a declaration installed in the child is torn down before the
    // outcome is published, so an assertion never runs beside a live provider.
    expect(order).toEqual(["the child's teardown", "the assertions"]);
  });

  /**
   * A construct in the declaration prefix, holding what would otherwise be a
   * declaration.
   *
   * `<If>` stands for every construct that expands descendants of its own: it
   * never resolves a component, so recognizing the definition is not enough to
   * tell a declaration written beside the others from one a construct reached.
   * One representative is the whole of what this needs — the rule is about the
   * placement, not about which construct produced it.
   */
  const INDIRECT: readonly { name: string; body: readonly string[]; says: string }[] = [
    {
      name: "a <TestAgent> a construct expanded",
      body: [
        "<If condition={true}>",
        "<TestAgent>",
        '<TestAgent.Scenario src="review.md" />',
        "</TestAgent>",
        "</If>",
      ],
      says: "<TestAgent> configures a child only as a direct child of <Execution>",
    },
    {
      name: "an <Answers> a construct expanded",
      body: [
        "<If condition={true}>",
        "<Answers>",
        '<Answer template="Approve?" value={{ decision: "approve" }} />',
        "</Answers>",
        "</If>",
      ],
      says: "<Answers> configures a child only as a direct child of the execution that runs it",
    },
    {
      name: "a scenario a construct expanded inside a direct declaration",
      body: [
        "<TestAgent>",
        "<If condition={true}>",
        '<TestAgent.Scenario src="review.md" />',
        "</If>",
        "</TestAgent>",
      ],
      says: "written directly inside it",
    },
  ];

  for (const indirect of INDIRECT) {
    it(`refuses ${indirect.name}`, function* () {
      const run = yield* runDeclaring({
        "README.md": doc(
          '<Test name="indirect">',
          // No such document: reaching a root at all would fail differently,
          // so "the host was never asked" is what the log proves.
          '<Execution host="run" target="absent.md" as="child">',
          ...indirect.body,
          "",
          "<AssertEquals actual={child.result.ok} expected={true} />",
          "</Execution>",
          "</Test>",
        ),
      });
      expect(single(run).status).toBe("fail");
      expect(single(run).error?.message).toContain(indirect.says);
      expect(configurationOf(run)).toEqual([]);
      expect(run.log.requests.length).toBe(0);
      expect(run.log.roots.length).toBe(0);
    });
  }

  it("lets public middleware read the configuration and change none of it", function* () {
    let probed = 0;
    const mutable: string[] = [];
    const run = yield* runDeclaring(
      {
        "README.md": doc(
          '<Test name="frozen">',
          '<Execution host="run" target="child.md" as="child">',
          "<TestAgent>",
          '<TestAgent.Scenario session="review" src="review.md" />',
          "</TestAgent>",
          "",
          "<Answers>",
          '<Answer template="Approve?" value={{ decision: "approve" }} />',
          "</Answers>",
          "",
          "<AssertEquals actual={child.result.ok} expected={true} />",
          "</Execution>",
          "</Test>",
        ),
        "child.md": doc("child body"),
      },
      {
        *around() {
          yield* ExecutionHost.around({
            *run([request]: [ExecutionHostRequest], next) {
              const configuration = request.profile.configuration ?? [];
              const edits: Edit[] = [
                ["the request", request.profile, { configuration: [] }],
                ["the configuration list", configuration, { 0: undefined, length: 0 }],
                ...configuration.flatMap(layersOf),
              ];
              // Every nested layer, because a handler that could edit one of
              // them would change what the child is assembled from after the
              // chain has unwound.
              for (const [label, target, edit] of edits) {
                probed += 1;
                try {
                  Object.assign(Object(target), edit);
                  mutable.push(label);
                } catch {
                  // Frozen, which is the whole of what this asks.
                }
              }
              yield* next(request);
            },
          });
        },
      },
    );
    expect(single(run).status).toBe("pass");
    expect(mutable).toEqual([]);
    expect(probed).toBe(12);
    const [testAgent] = configurationOf(run);
    expect(testAgent?.kind === "test-agent" && testAgent.scenarios[0]?.session).toBe("review");
  });
});

/** One attempted edit: what it is called, what it targets, and what it writes. */
type Edit = [string, unknown, Record<string, unknown>];

/** Every layer of one configuration entry a handler could try to edit. */
function layersOf(entry: ChildConfiguration): Edit[] {
  if (entry.kind === "test-agent") {
    const scenario = entry.scenarios[0];
    const scenarioEdits: Edit[] =
      scenario === undefined
        ? []
        : [
            ["the scenario", scenario, { session: "stolen" }],
            ["the scenario document", scenario.document, { source: "stolen" }],
          ];
    return [
      ["the test-agent entry", entry, { defaultAgent: "stolen" }],
      ["the scenario list", entry.scenarios, { 0: undefined }],
      ...scenarioEdits,
    ];
  }
  const matcher = entry.matchers[0];
  const template = matcher?.template;
  const matcherEdits: Edit[] =
    matcher === undefined ? [] : [["the matcher", matcher, { value: "stolen" }]];
  const templateEdits: Edit[] =
    template === undefined
      ? []
      : [
          ["the template", template, { source: "stolen" }],
          ["the token list", template.tokens, { 0: undefined }],
        ];
  return [
    ["the answers entry", entry, { matchers: [] }],
    ["the matcher list", entry.matchers, { 0: undefined }],
    ["the bindings", entry.bindings, { stolen: "yes" }],
    ...matcherEdits,
    ...templateEdits,
  ];
}
