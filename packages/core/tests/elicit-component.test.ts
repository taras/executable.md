/**
 * `<Elicit>` (spec §6.16).
 *
 * `Elicit.test.md` covers the authoring contract in Markdown; these cover what a
 * document cannot construct — a provider that counts its calls, one that never
 * answers, a journal resumed against an edited question.
 *
 * Every test installs a real provider on the Elicitation Api. Nothing here stubs
 * a module or reaches into the component: the substitution happens at the same
 * contextual boundary a host uses, so what passes here is what a host gets.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, race, resource, scoped, sleep, suspend, until } from "effection";
import type { Operation } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collect } from "../src/collect.ts";
import { prepareElicitation, runPreparedElicitation } from "../src/elicit.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import type { ElicitationRequest } from "../src/elicitation-api.ts";
import { execute } from "../src/execute.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";

function useWorkspace(): Operation<string> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "elicit-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* provide(root);
  });
}

/** Every request a provider was given, in order. */
interface Recorder {
  requests: ElicitationRequest[];
}

/**
 * Install a provider on the *calling* scope and hand back what it records.
 *
 * Not a `resource`: middleware installs on the scope that runs the install, and
 * a resource's body runs on its own — so a provider installed there would be
 * invisible to the execution the test is about to start.
 *
 * `answer` is a function rather than a value so a test can decide per call —
 * counting, failing, or returning something the schema will reject.
 */
function* installProvider(
  answer: (request: ElicitationRequest, index: number) => Operation<unknown>,
): Operation<Recorder> {
  const recorder: Recorder = { requests: [] };
  yield* Elicitation.around(
    {
      *elicit([request]) {
        recorder.requests.push(request);
        return yield* answer(request, recorder.requests.length - 1);
      },
    },
    // The position a provider must install at: the default lets an outer
    // install shadow a nested one, which is the opposite of what a provider is.
    { at: "min" },
  );
  return recorder;
}

function constant(value: unknown): (request: ElicitationRequest) => Operation<unknown> {
  // deno-lint-ignore require-yield
  return function* () {
    return value;
  };
}

interface Run {
  output: string;
  requests: ElicitationRequest[];
  failure?: Error;
}

/**
 * Execute `source` with `answer` installed, returning what the document
 * produced and what the provider saw.
 *
 * A failure is captured rather than raised so a test can assert on the
 * diagnostic and on how far the run got, which is most of what these cover.
 */
function run(
  workspace: string,
  source: string,
  answer: (request: ElicitationRequest, index: number) => Operation<unknown>,
  stream: InMemoryStream = new InMemoryStream(),
): Operation<Run> {
  return scoped(function* () {
    const path = join(workspace, "doc.md");
    yield* writeTextFile(path, source);
    const recorder = yield* installProvider(answer);
    try {
      const output = yield* collect(yield* execute({ path, stream }));
      return { output: String(output), requests: recorder.requests };
    } catch (error) {
      return {
        output: "",
        requests: recorder.requests,
        failure: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

/** Execute with no provider installed at all. */
function runWithoutProvider(workspace: string, source: string): Operation<Run> {
  return scoped(function* () {
    const path = join(workspace, "doc.md");
    yield* writeTextFile(path, source);
    try {
      const output = yield* collect(yield* execute({ path, stream: new InMemoryStream() }));
      return { output: String(output), requests: [] };
    } catch (error) {
      return {
        output: "",
        requests: [],
        failure: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}

/**
 * The journal without the root's close, which is what makes the next run replay
 * what is there and then continue live rather than restoring a completed
 * execution.
 */
function* partial(stream: InMemoryStream): Operation<InMemoryStream> {
  const events = yield* stream.readAll();
  return new InMemoryStream(
    events.filter((event) => !(event.type === "close" && event.coroutineId === "root")),
  );
}

const DECISION_SCHEMA =
  '{"type":"object","properties":{"decision":{"type":"string","enum":["approve","reject"]}},' +
  '"required":["decision"],"additionalProperties":false}';

function document(body: string, schema: string = DECISION_SCHEMA): string {
  return [
    "```js eval",
    `const responseSchema = JSON.parse(${JSON.stringify(schema)});`,
    "```",
    "",
    `<Elicit schema={responseSchema} as="response">${body}</Elicit>`,
    "",
    "Decision: {response.decision}",
    "",
  ].join("\n");
}

describe("Elicit: the question", () => {
  beforeAll(() => useTempFileCompiler());

  it("hands the provider the rendered message and the compiled schema, and nothing else", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      document("Approve the plan?"),
      constant({ decision: "approve" }),
    );

    expect(result.failure).toBe(undefined);
    expect(result.requests).toHaveLength(1);
    expect(Object.keys(result.requests[0]).sort()).toEqual(["message", "schema"]);
    expect(result.requests[0].message).toContain("Approve the plan?");
    expect(result.requests[0].schema).toEqual(JSON.parse(DECISION_SCHEMA));
    expect(result.output).toContain("Decision: approve");
  });

  it("renders nothing of its own", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      document("Approve the plan?"),
      constant({ decision: "approve" }),
    );

    expect(result.output).not.toContain("Approve the plan?");
  });

  it("accepts a schema as captured JSON text", function* () {
    const workspace = yield* useWorkspace();
    const source = [
      "```js eval",
      `const schemaText = ${JSON.stringify(DECISION_SCHEMA)};`,
      "```",
      "",
      '<Elicit schema={schemaText} as="response">Approve?</Elicit>',
      "",
      "Decision: {response.decision}",
      "",
    ].join("\n");

    const result = yield* run(workspace, source, constant({ decision: "reject" }));

    expect(result.failure).toBe(undefined);
    expect(result.requests[0].schema).toEqual(JSON.parse(DECISION_SCHEMA));
    expect(result.output).toContain("Decision: reject");
  });
});

describe("Elicit: what it refuses", () => {
  beforeAll(() => useTempFileCompiler());

  it("fails with no provider configured, before asking anything", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* runWithoutProvider(workspace, document("Approve?"));

    expect(result.failure?.message).toContain("no elicitation provider configured");
  });

  /**
   * The schema compiles before the body expands, so an unusable schema produces
   * no invocation-content effects. The body writes a file: asserting the file
   * does not exist is what proves the ordering, where asserting only that the
   * run failed would pass even if the body had run first.
   */
  it("compiles the schema before the invocation content expands", function* () {
    const workspace = yield* useWorkspace();
    const marker = join(workspace, "expanded.txt");
    const source = [
      "```js eval",
      'const badSchema = {"type":"object","properties":{"decision":{"type":"not-a-type"}}};',
      "```",
      "",
      '<Elicit schema={badSchema} as="response">',
      "",
      "```js eval",
      `Deno.writeTextFileSync(${JSON.stringify(marker)}, "expanded");`,
      "```",
      "",
      "</Elicit>",
      "",
    ].join("\n");

    const result = yield* run(workspace, source, constant({ decision: "approve" }));

    expect(result.failure).toBeDefined();
    expect(result.requests).toHaveLength(0);
    expect(yield* exists(marker)).toBe(false);
  });

  it("refuses a schema declaring __proto__ as a name, naming the position", function* () {
    const workspace = yield* useWorkspace();
    const schema = '{"type":"object","properties":{"__proto__":{"type":"string"}}}';

    const result = yield* run(
      workspace,
      document("Approve?", schema),
      constant({ decision: "approve" }),
    );

    expect(result.failure?.message).toContain("__proto__");
    expect(result.failure?.message).toContain("#/properties");
    expect(result.requests).toHaveLength(0);
  });

  it("refuses a reference that leaves the schema, naming the position", function* () {
    const workspace = yield* useWorkspace();
    const schema = '{"type":"object","properties":{"decision":{"$ref":"other.json#/x"}}}';

    const result = yield* run(
      workspace,
      document("Approve?", schema),
      constant({ decision: "approve" }),
    );

    expect(result.failure?.message).toContain("other.json#/x");
    expect(result.failure?.message).toContain("#192");
    expect(result.requests).toHaveLength(0);
  });

  it("refuses a schema that is not an object", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      document("Approve?", "[1,2]"),
      constant({ decision: "approve" }),
    );

    expect(result.failure?.message).toContain("schema must be a JSON Schema object");
    expect(result.requests).toHaveLength(0);
  });

  it("refuses schema text that is not JSON", function* () {
    const workspace = yield* useWorkspace();
    const source = ['<Elicit schema="not json at all" as="response">Approve?</Elicit>', ""].join(
      "\n",
    );

    const result = yield* run(workspace, source, constant({ decision: "approve" }));

    expect(result.failure?.message).toContain("schema text is not JSON");
    expect(result.requests).toHaveLength(0);
  });
});

describe("Elicit: judging the answer", () => {
  beforeAll(() => useTempFileCompiler());

  it("validates the provider's answer against the same schema", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(workspace, document("Approve?"), constant({ decision: "maybe" }));

    expect(result.failure?.message).toContain("failed its schema");
    expect(result.failure?.message).toContain("decision");
  });

  it("fails once, without asking a second time", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(workspace, document("Approve?"), constant({ wrong: true }));

    expect(result.failure).toBeDefined();
    expect(result.requests).toHaveLength(1);
  });

  /**
   * An error crossing the execution boundary keeps its name and message and
   * nothing else — the journal protocol reconstructs it. So the structured
   * issues are asserted where they are raised, and their rendering is asserted
   * where a document would read it.
   */
  it("raises normalized issues, not only prose", function* () {
    const prepared = prepareElicitation(JSON.parse(DECISION_SCHEMA));
    let raised: Error | undefined;

    yield* scoped(function* () {
      yield* Elicitation.around(
        {
          *elicit() {
            return { decision: 7 };
          },
        },
        { at: "min" },
      );
      try {
        yield* runPreparedElicitation(prepared, "Approve?");
      } catch (error) {
        raised = error instanceof Error ? error : new Error(String(error));
      }
    });

    // Every issue, not the first one: the validator collects them all, and a
    // diagnostic that reported one at a time would send a person round twice.
    expect(readIssues(raised)).toEqual([
      { instancePath: "/decision", keyword: "type" },
      { instancePath: "/decision", keyword: "enum" },
    ]);
  });

  it("renders those issues into the diagnostic a document sees", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(workspace, document("Approve?"), constant({ decision: 7 }));

    expect(result.failure?.message).toContain("<Elicit />");
    expect(result.failure?.message).toContain('"/decision" must be string');
  });

  /**
   * A provider's own failure travels verbatim. Wrapping it would replace the
   * only description of what actually went wrong — the provider knows why it
   * could not reach anyone and `<Elicit>` does not.
   */
  it("propagates a provider failure rather than swallowing it", function* () {
    const workspace = yield* useWorkspace();

    const result = yield* run(
      workspace,
      document("Approve?"),
      // deno-lint-ignore require-yield
      function* () {
        throw new Error("the provider could not reach anyone");
      },
    );

    expect(result.failure?.message).toBe("the provider could not reach anyone");
    expect(result.output).toBe("");
  });
});

describe("Elicit: the provider is contextual", () => {
  beforeAll(() => useTempFileCompiler());

  it("uses the nearest installed provider, and restores the outer one after", function* () {
    const seen: string[] = [];

    yield* scoped(function* () {
      yield* Elicitation.around(
        {
          // deno-lint-ignore require-yield
          *elicit() {
            seen.push("outer");
            return { decision: "approve" };
          },
        },
        { at: "min" },
      );

      yield* scoped(function* () {
        yield* Elicitation.around(
          {
            // deno-lint-ignore require-yield
            *elicit() {
              seen.push("inner");
              return { decision: "reject" };
            },
          },
          { at: "min" },
        );
        expect(yield* Elicitation.operations.elicit(request())).toEqual({ decision: "reject" });
      });

      expect(yield* Elicitation.operations.elicit(request())).toEqual({ decision: "approve" });
    });

    expect(seen).toEqual(["inner", "outer"]);
  });

  it("halts an active provider when the surrounding scope leaves", function* () {
    let released = false;

    yield* race([
      scoped(function* () {
        yield* Elicitation.around({
          *elicit() {
            yield* ensure(() => {
              released = true;
            });
            yield* suspend();
            return null;
          },
        });
        yield* Elicitation.operations.elicit(request());
      }),
      sleep(30),
    ]);

    expect(released).toBe(true);
  });
});

describe("Elicit: durability", () => {
  beforeAll(() => useTempFileCompiler());

  it("records the answer and restores it without asking again", function* () {
    const workspace = yield* useWorkspace();
    const stream = new InMemoryStream();
    const source = document("Approve?");

    const first = yield* run(workspace, source, constant({ decision: "approve" }), stream);
    expect(first.requests).toHaveLength(1);
    expect(first.output).toContain("Decision: approve");

    // A provider that would fail if it were reached at all, so the assertion is
    // that nothing reached it — not that it happened to answer the same way.
    const replayed = yield* run(
      workspace,
      source,
      // deno-lint-ignore require-yield
      function* () {
        throw new Error("the provider was contacted on replay");
      },
      yield* partial(stream),
    );

    expect(replayed.failure).toBe(undefined);
    expect(replayed.requests).toHaveLength(0);
    expect(replayed.output).toContain("Decision: approve");
  });

  /**
   * A partial replay runs the *recorded* document: `import_component` journals
   * the root's source, so editing the file and resuming does not change the
   * question — and the recorded answer is the answer to the question that was
   * actually asked. This is the behaviour, and it is why the guard below cannot
   * be reached by editing a file.
   */
  it("replays the recorded document, so editing the body does not re-ask", function* () {
    const workspace = yield* useWorkspace();
    const stream = new InMemoryStream();

    yield* run(
      workspace,
      document("Approve the first plan?"),
      constant({ decision: "approve" }),
      stream,
    );

    const edited = yield* run(
      workspace,
      document("Approve a completely different plan?"),
      // deno-lint-ignore require-yield
      function* () {
        throw new Error("the provider was contacted on replay");
      },
      yield* partial(stream),
    );

    expect(edited.failure).toBe(undefined);
    expect(edited.output).toContain("Decision: approve");
  });

  /**
   * The guard exists for the journal that does not describe this run's
   * question — one merged, hand-edited, or carried over from a document that
   * has since changed. Only `type` and `name` decide whether an entry matches,
   * and the name is a source position, so without this a resumed document would
   * bind an answer nobody gave to the question being asked.
   */
  it("refuses a recorded answer whose question does not match this run", function* () {
    const workspace = yield* useWorkspace();
    const stream = new InMemoryStream();
    const source = document("Approve?");

    yield* run(workspace, source, constant({ decision: "approve" }), stream);

    const doctored = yield* run(
      workspace,
      source,
      // deno-lint-ignore require-yield
      function* () {
        throw new Error("the provider was contacted");
      },
      yield* withDifferentQuestion(yield* partial(stream)),
    );

    expect(doctored.failure?.message).toContain("given to a different question");
  });

  it("still restores when only the surrounding prose changed", function* () {
    const workspace = yield* useWorkspace();
    const stream = new InMemoryStream();

    yield* run(workspace, document("Approve?"), constant({ decision: "approve" }), stream);

    const again = yield* run(
      workspace,
      `${document("Approve?")}\nAn unrelated sentence.\n`,
      // deno-lint-ignore require-yield
      function* () {
        throw new Error("the provider was contacted on replay");
      },
      yield* partial(stream),
    );

    expect(again.failure).toBe(undefined);
    expect(again.output).toContain("Decision: approve");
  });
});

/**
 * The same journal, with the elicitation's recorded question replaced.
 *
 * Rewriting the fingerprint is how a journal that answers something else is
 * built without also having to fabricate an execution that produced it.
 */
function* withDifferentQuestion(stream: InMemoryStream): Operation<InMemoryStream> {
  const events = yield* stream.readAll();
  return new InMemoryStream(
    events.map((event) => {
      if (event.type !== "yield" || event.description.type !== "elicit") {
        return event;
      }
      return {
        ...event,
        description: { ...event.description, input: "a-different-question" },
      };
    }),
  );
}

function request(): ElicitationRequest {
  return { message: "ask", schema: { type: "object" } };
}

interface ReadableIssue {
  instancePath: string;
  keyword: string;
}

/** The normalized issues a `SchemaValidationError` carries, if it is one. */
function readIssues(failure: Error | undefined): ReadableIssue[] {
  const issues = (failure as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    if (issue === null || typeof issue !== "object") {
      return [];
    }
    const { instancePath, keyword } = issue as Record<string, unknown>;
    if (typeof instancePath !== "string" || typeof keyword !== "string") {
      return [];
    }
    return [{ instancePath, keyword }];
  });
}
