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
import { scoped, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { execute, registerComponents } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { useTesting } from "../src/use-testing.ts";
import { ExecutionHost } from "../src/execution-host.ts";
import type { ExecutionHostRequest } from "../src/execution-host.ts";
import type { TestResult } from "../src/test-api.ts";
import { useStubExecutionHost } from "./execution-host-stub.ts";
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
    const log = yield* useStubExecutionHost({
      files,
      ...(options.emit === undefined ? {} : { emit: options.emit }),
    });
    if (options.around) {
      yield* options.around();
    }
    const execution = yield* execute({ path: "README.md", stream: new InMemoryStream() });
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

describe("without a trusted host", () => {
  it("refuses before the child's root is imported", function* () {
    const run = yield* scoped(function* () {
      const files = {
        "README.md": doc(
          '<Test name="no-host">',
          '<Execution host="run" target="child.md" as="child" />',
          "</Test>",
        ),
        "child.md": doc("child"),
      };
      yield* useStubFs(files);
      const tests = yield* useTesting();
      yield* registerComponents([]);
      const execution = yield* execute({ path: "README.md", stream: new InMemoryStream() });
      const output = yield* forEach(function* () {}, execution.output);
      const completion = yield* execution;
      return { output, chunks: [], completion, results: yield* tests.results, log: undefined };
    });
    expect(run.results[0]?.status).toBe("fail");
    expect(run.results[0]?.error?.message).toContain("trusted host profile");
  });
});
