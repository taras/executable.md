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
import { call, createContext, ensure, Err, scoped, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { ephemeral, InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import {
  applyModifiers,
  Component,
  env,
  registerComponents,
  TestBehavior,
  useTempFileCompiler,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type {
  CodeBlockContext,
  ComponentRegistration,
  Json,
  Modifier,
  ModifierFactory,
} from "@executablemd/core";
import { useTesting } from "../src/use-testing.ts";
import { testHarnessInstallation } from "../src/execution-harness.ts";
import { ExecutionHost } from "../src/execution-host.ts";
import type { ExecutionHostProvider, ExecutionHostRequest } from "../src/execution-host.ts";
import type { TestResult } from "../src/test-api.ts";
import { stubExecutionHost } from "./execution-host-stub.ts";
import type { StubHostLog, StubHostOptions } from "./execution-host-stub.ts";
import type { ChildSettlement } from "../src/execution-host.ts";

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
  readonly settle?: StubHostOptions["settle"];
  /** Called for each chunk the outer document emits, as it arrives. */
  readonly onChunk?: (chunk: string) => Operation<void>;
  /** Modifiers this execution registers, as any trusted host may. */
  readonly modifiers?: Record<string, ModifierFactory>;
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
      ...(options.settle === undefined ? {} : { settle: options.settle }),
    });
    const log = stub.log;
    if (options.around) {
      yield* options.around();
    }
    // The harness authority is a delivery the host attaches, so these tests are
    // the host: without this, `<Execution>` is recognized and refused.
    const execution = yield* executeInstalled(
      {
        path: "README.md",
        stream: new InMemoryStream(),
        ...(options.modifiers === undefined ? {} : { modifiers: options.modifiers }),
      },
      [testHarnessInstallation(stub.provider)],
    );
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

  it("leaves <Capture> lexical: it never sees the child's stream", function* () {
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="capture">',
          '<Capture as="lexical">',
          '<Execution host="run" source={"unused"} as="child" />',
          "lexical text",
          "</Capture>",
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

  it("refuses a structural copy of a request", function* () {
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="copied">',
          '<Execution host="run" target="child.md" as="child" />',
          "</Test>",
        ),
        "child.md": doc("child"),
      },
      {
        *around() {
          yield* ExecutionHost.around({
            *run([request]: [ExecutionHostRequest], next) {
              // Every member the request publishes, on an object this handler
              // built. What it does not carry is what canonical core kept.
              yield* next({ ...request });
            },
          });
        },
      },
    );
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("no <Execution> issued");
    expect(run.log.requests).toEqual([]);
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

describe("publication is the engine's, not the environment's", () => {
  /** What the trusted provider answers, and what nothing else could invent. */
  const AUTHORITATIVE = "authoritative child failure";

  function failingChild(): ChildSettlement {
    return {
      outcome: { kind: "settled", result: Err(new Error(AUTHORITATIVE)) },
      output: "",
    };
  }

  /**
   * Public `Component.env` middleware answering with a fresh environment that
   * already contains a successful child outcome.
   *
   * Fresh on every read is the whole attack: publication into the environment
   * would land in a throwaway, and the assertion would read this one. Nothing
   * here mutates the engine — it only answers the question the engine asks.
   */
  function* fabricateSuccess(binding: string): Operation<void> {
    yield* Component.around({
      env: () => ({
        values: { [binding]: { kind: "settled", result: { ok: true, value: "synthetic" } } },
      }),
    });
  }

  const ASSERTS_FAILURE = doc(
    '<Test name="authoritative">',
    '<Execution host="run" target="child.md" as="run">',
    "<AssertEquals actual={run.result.ok} expected={false} />",
    `<AssertEquals actual={run.result.error.message} expected="${AUTHORITATIVE}" />`,
    "</Execution>",
    "</Test>",
  );

  it("binds the provider's exact failure, not middleware's fabricated success", function* () {
    const run = yield* runHarness(
      { "README.md": ASSERTS_FAILURE, "child.md": doc("child") },
      { settle: failingChild, around: () => fabricateSuccess("run") },
    );
    // Both halves matter. The provider ran once, so the child is real; and the
    // assertions read what it answered, so the fabrication reached nothing.
    expect(run.log.requests.length).toBe(1);
    expect(only(run).status).toBe("pass");
  });

  it("keeps the published value when middleware changes environments afterwards", function* () {
    let reads = 0;
    const run = yield* runHarness(
      { "README.md": ASSERTS_FAILURE, "child.md": doc("child") },
      {
        settle: failingChild,
        *around() {
          // A different fresh environment on every read, so an implementation
          // that published into one and looked up in another cannot happen to
          // agree. Publication precedes the assertion pass, and what the
          // assertions read is the engine's copy either way.
          yield* Component.around({
            env: () => {
              reads += 1;
              return {
                values: {
                  run: { kind: "settled", result: { ok: true, value: `synthetic-${reads}` } },
                },
              };
            },
          });
        },
      },
    );
    expect(reads).toBeGreaterThan(1);
    expect(only(run).status).toBe("pass");
  });

  it("still fails the owning test when a failing child is not bound", function* () {
    // The unbound path publishes nothing, so this is the case the overlay must
    // not have quietly rescued.
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="unbound-under-fabrication">',
          '<Execution host="run" target="child.md" />',
          "</Test>",
        ),
        "child.md": doc("child"),
      },
      { settle: failingChild, around: () => fabricateSuccess("run") },
    );
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain(AUTHORITATIVE);
  });
});

/**
 * Every test here reads `run` from inside the element, where the engine has
 * bound nothing yet: the invocation has not returned, so the only thing that
 * can answer is what it published. A read that resolves at all is the evidence;
 * what it resolves to only says which read it was.
 */
describe("what the assertion body reads", () => {
  const CHILD = doc("child body");

  function* readsBody(body: string[], options: RunOptions = {}): Operation<HarnessRun> {
    return yield* runHarness(
      {
        "README.md": doc(
          '<Test name="reads">',
          '<Execution host="run" target="child.md" as="run">',
          // First, so the declaration scan stops here — at an import, before any
          // expression is evaluated — rather than part-way into the assertions.
          '<AssertEquals actual={run.kind} expected="settled" />',
          ...body,
          "</Execution>",
          "</Test>",
        ),
        "child.md": CHILD,
        "components/Wrapper.md": doc("caller: <Content />", "", "authored: {run.kind}"),
      },
      options,
    );
  }

  it("resolves an expression prop, a condition, and interpolated text", function* () {
    const run = yield* readsBody([
      "<If condition={run.result.ok}>",
      '<Capture as="line">kind={run.kind}</Capture>',
      "</If>",
      '<AssertEquals actual={line} expected="kind=settled" />',
    ]);
    expect(only(run).status).toBe("pass");
  });

  it("resolves in an eval block, and in what that block exports", function* () {
    const run = yield* readsBody(
      [
        "```js eval",
        "const seen = run.kind;",
        "```",
        '<AssertEquals actual={seen} expected="settled" />',
      ],
      // Eval needs a compiler, which the production hosts install and this
      // harness does not. The temp-file one, because the data-URI compiler
      // asks the runtime's loader for a `data:` module and tsx answers none.
      { around: () => useTempFileCompiler() },
    );
    expect(only(run).status).toBe("pass");
  });

  it("follows content projected through a component, and stops at its body", function* () {
    const run = yield* readsBody([
      '<Capture as="wrapped">',
      "<Wrapper>projected {run.kind}</Wrapper>",
      "</Capture>",
      // The caller's text reads the outcome wherever the component renders it.
      '<AssertEquals actual={wrapped.includes("projected settled")} expected={true} />',
      // The component's own text is not written inside the element, so the
      // reference stands unresolved exactly as it would in any other document.
      '<AssertEquals actual={wrapped.includes("authored: settled")} expected={false} />',
      '<AssertStringIncludes actual={wrapped} expected="authored:" />',
    ]);
    expect(only(run).status).toBe("pass");
  });

  it("leaves every other name to ordinary composition", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        '<Capture as="topic">unrelated</Capture>',
        '<Test name="unrelated">',
        '<Execution host="run" target="child.md" as="run">',
        '<AssertEquals actual={run.kind} expected="settled" />',
        // Composed by the ordinary rules and reached through them: the overlay
        // is one name laid over that answer, not a replacement for it.
        '<AssertEquals actual={topic} expected="unrelated" />',
        "</Execution>",
        "</Test>",
      ),
      "child.md": CHILD,
    });
    expect(only(run).status).toBe("pass");
  });

  it("binds the outcome in the ordinary way after the element", function* () {
    const run = yield* runHarness({
      "README.md": doc(
        '<Test name="after">',
        '<Execution host="run" target="child.md" as="run">',
        '<AssertEquals actual={run.kind} expected="settled" />',
        "</Execution>",
        // Outside the element the projection is over. What answers here is the
        // binding the engine makes from what the invocation returned, as it
        // does for any component invoked with `as`.
        '<AssertEquals actual={run.kind} expected="settled" />',
        "</Test>",
      ),
      "child.md": CHILD,
    });
    expect(only(run).status).toBe("pass");
  });

  it("keeps the published value against a write under the same name", function* () {
    const run = yield* readsBody([
      // An ordinary binding write, of the kind any document may make. It lands
      // where it always did; the next read lays the published value over it.
      '<Capture as="run">usurped</Capture>',
      '<AssertEquals actual={run.kind} expected="settled" />',
    ]);
    expect(only(run).status).toBe("pass");
  });
});

describe("cancellation", () => {
  it("tears the child down when the owning test is cancelled", function* () {
    let torndown = 0;
    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="cancelled" timeout="150ms">',
          '<Execution host="run" target="child.md" as="run">',
          '<AssertEquals actual={run.kind} expected="settled" />',
          "</Execution>",
          "</Test>",
        ),
        "child.md": doc("child"),
      },
      {
        // A child that is alive and settling nothing. Registered before the
        // suspension, on the scope the harness created for this child, so
        // whether it was torn down is observable rather than inferred.
        *emit() {
          yield* ensure(() => {
            torndown += 1;
          });
          yield* suspend();
        },
      },
    );
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.kind).toBe("timeout");
    // Exactly once, and by the time the run is over: the outer test owns the
    // child, so a test that stops takes the child it started with it rather
    // than leaving one running against a document that has finished.
    expect(torndown).toBe(1);
  });
});

/**
 * The published outcome survives the public code-block chain.
 *
 * A block is the one assertion read that leaves canonical expansion: it runs
 * through `Component.applyModifiers`, where a handler may transform what it
 * delegates. These hold that transforming it changes what runs — which is what
 * the surface is for — and changes nothing about which outcome the built-in
 * terminal reads.
 *
 * The observation is a throw inside the block, deliberately. An eval *export*
 * cannot discriminate here: the fabricating `Component.env` below answers with a
 * fresh environment on every read, so an export lands in a throwaway and is
 * unreadable whatever the terminal saw.
 */
describe("the eval terminal reads the published outcome", () => {
  const AUTHORITATIVE = "authoritative child failure";

  function failingChild(): ChildSettlement {
    return {
      outcome: { kind: "settled", result: Err(new Error(AUTHORITATIVE)) },
      output: "",
    };
  }

  /** Fresh on every read, and carrying a success the provider never produced. */
  function* fabricateSuccess(): Operation<void> {
    yield* Component.around({
      env: () => ({
        values: { run: { kind: "settled", result: { ok: true, value: "synthetic" } } },
      }),
    });
  }

  const OBSERVES_ERR = doc(
    '<Test name="authoritative">',
    '<Execution host="run" target="child.md" as="run">',
    "```js eval",
    'if (run.result.ok) { throw new Error("observed synthetic success"); }',
    `if (run.result.error.message !== ${JSON.stringify(AUTHORITATIVE)}) {`,
    '  throw new Error("observed " + JSON.stringify(run));',
    "}",
    "```",
    "</Execution>",
    "</Test>",
  );

  /** The whole hostile arrangement, with one code-block handler swapped in. */
  function* observed(install?: () => Operation<void>): Operation<HarnessRun> {
    return yield* runHarness(
      { "README.md": OBSERVES_ERR, "child.md": doc("child") },
      {
        settle: failingChild,
        *around() {
          yield* useTempFileCompiler();
          yield* fabricateSuccess();
          if (install) {
            yield* install();
          }
        },
      },
    );
  }

  it("exact delegation runs the block and exposes the provider's outcome", function* () {
    const run = yield* observed();
    expect(only(run).status).toBe("pass");
    // Non-vacuous: the block ran (a fabricated read would have thrown) and the
    // trusted provider produced exactly one child.
    expect(run.log.requests.length).toBe(1);
  });

  it("survives a Component.codeBlock handler that copies the context", function* () {
    let copies = 0;
    const run = yield* observed(function* () {
      yield* Component.around({
        *codeBlock(_args, next): Operation<CodeBlockContext> {
          const context = yield* next();
          copies += 1;
          // Every public member, on an object this handler built. What it does
          // not carry is anything the terminal decides its projection from.
          return { ...context };
        },
      });
    });
    expect(copies).toBeGreaterThan(0);
    expect(only(run).status).toBe("pass");
    expect(run.log.requests.length).toBe(1);
  });

  it("survives an applyModifiers handler that copies what it delegates", function* () {
    let delegated = 0;
    const run = yield* observed(function* () {
      yield* Component.around({
        *applyModifiers([modifiers, context], next) {
          delegated += 1;
          return yield* next(
            modifiers.map((modifier: Modifier) => ({ ...modifier })),
            { ...context },
          );
        },
      });
    });
    expect(delegated).toBeGreaterThan(0);
    expect(only(run).status).toBe("pass");
    expect(run.log.requests.length).toBe(1);
  });

  it("leaves an observing handler observing, and the block running", function* () {
    const seen: string[] = [];
    const run = yield* observed(function* () {
      yield* Component.around({
        *applyModifiers([modifiers, context], next) {
          seen.push(context.language);
          return yield* next(modifiers, context);
        },
      });
    });
    // Twice: the harness reads its own children in two passes, and a public
    // handler is composed around the declaration scan exactly as it is around
    // the assertions. What it observed is the ordinary block context both times.
    expect(seen).toEqual(["js", "js"]);
    expect(only(run).status).toBe("pass");
  });

  it("leaves a refusing handler refusing, from the position a provider installs at", function* () {
    let reached = 0;
    let ran = 0;
    const run = yield* observed(function* () {
      // `{ at: "min" }` is the position the public missing-provider diagnostic
      // tells a provider to install at, and the position an engine-adjacent
      // handler shares with canonical core. A terminal installed as middleware
      // would answer ahead of an inherited handler here and this refusal would
      // never run — which is why the canonical terminal is an instance default.
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *applyModifiers(_args, _next) {
            reached += 1;
            throw new Error("refused by middleware");
          },
        },
        { at: "min" },
      );
      // Records whether anything downstream of the refusal ran the block.
      yield* Component.around({
        *applyModifiers([modifiers, context], next) {
          const result = yield* next(modifiers, context);
          ran += 1;
          return result;
        },
      });
    });
    expect(reached).toBeGreaterThan(0);
    expect(ran).toBe(0);
    expect(only(run).status).toBe("fail");
    expect(only(run).error?.message).toContain("refused by middleware");
  });

  it("leaves a handler that does not delegate in full override", function* () {
    let overrode = 0;
    const run = yield* observed(function* () {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          overrode += 1;
          return { output: "", exitCode: 0, stderr: "" };
        },
      });
    });
    // Once per pass, and both times the handler answered instead of the block:
    // an override answers the scan too, so the scan runs to the end of the body
    // rather than stopping at a block it never reached.
    expect(overrode).toBe(2);
    // The block never ran, so it observed nothing and threw nothing. That is the
    // existing override behaviour, unchanged by anything the projection does.
    expect(only(run).status).toBe("pass");
  });

  /**
   * The same source again, under a specifier the module map has not seen —
   * which is what a second copy of a package is at runtime.
   *
   * The specifier is a variable on purpose: `tsc` resolves a literal one and
   * has no notion of a query, while Deno keys the module by the whole URL.
   */
  function loadCopy<T>(specifier: string): Operation<T> {
    return call(() => import(specifier) as Promise<T>);
  }

  it("runs a loaded copy's direct call on this execution's registry, with no projection", function* () {
    // A component calling `applyModifiers()` itself (spec §5.5), through a
    // second copy of core's public operation. The copy's descriptor is a
    // different object under the same stable name, so it reaches the ordinary
    // runner the active execution installed — and that runner composes an
    // ordinary chain, which is the whole of what a direct call may have.
    const copy = yield* loadCopy<{ applyModifiers: typeof applyModifiers }>(
      "../../core/src/component-api.ts?loaded-copy",
    );
    let observed: string | undefined;
    const direct: ComponentRegistration = {
      name: "DirectBlock",
      origin: "execution-harness.test",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        const result = yield* copy.applyModifiers([{ name: "eval" }], {
          language: "js",
          content: "output(String(run.result.ok));",
          blockId: "direct-eval",
        });
        observed = result.output;
        return "";
      },
    };

    const run = yield* runHarness(
      {
        "README.md": doc(
          '<Test name="direct">',
          '<Execution host="run" target="child.md" as="run">',
          "<DirectBlock />",
          "</Execution>",
          "</Test>",
        ),
        "child.md": doc("child"),
      },
      {
        settle: failingChild,
        *around() {
          yield* useTempFileCompiler();
          yield* fabricateSuccess();
          yield* registerComponents([direct]);
        },
      },
    );
    // It ran: an eval terminal from this execution's registry executed the
    // block and produced its output.
    expect(observed).toBe("true");
    // And what it read is the ordinary environment — the fabrication — not the
    // outcome the enclosing assertion projection published. A direct call never
    // inherits a projection, wherever the component making it was written.
    expect(only(run).status).toBe("pass");
  });

  it("gives a registered replacement named eval no projection authority", function* () {
    // A modifier registered under the built-in's name — which is all a second
    // loaded copy of core's own terminal would be, and all any other terminal
    // is. It runs, because the registry answers the word the document wrote.
    let read: unknown;
    const replacement: ModifierFactory = (_params) => (_args, _next) =>
      (function* () {
        read = (yield* ephemeral(env))?.values.run;
        return { output: "", exitCode: 0, stderr: "" };
      })();

    const run = yield* runHarness(
      { "README.md": OBSERVES_ERR, "child.md": doc("child") },
      {
        settle: failingChild,
        modifiers: { eval: replacement },
        *around() {
          yield* useTempFileCompiler();
          yield* fabricateSuccess();
        },
      },
    );
    // What it read is what public middleware composed, never the published
    // outcome: privilege follows the factory identity this execution
    // registered, and this is not that factory.
    expect(read).toEqual({ kind: "settled", result: { ok: true, value: "synthetic" } });
    // And the authored block never ran, so it asserted nothing.
    expect(only(run).status).toBe("pass");
  });
});
