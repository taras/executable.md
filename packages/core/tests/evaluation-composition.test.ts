import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, Ok, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { createDurableOperation, InMemoryStream } from "@executablemd/durable-streams";
import type { DurableStream } from "@executablemd/durable-streams";
import {
  boundedEvaluation,
  EvaluationCandidateError,
  EvaluationInfrastructureError,
  EvaluationLimitError,
  EvaluationStaleError,
  executeInstalled,
  fileReadEntry,
  fileWriteEntry,
  globReadEntry,
  jsonCompositionEntry,
} from "../host.ts";
import type { EvaluationBounds, ExecutionInstallation } from "../host.ts";
import { collect } from "../src/collect.ts";
import { retainedSource } from "../src/root-source.ts";
import { recordedFiles } from "./support/fragment-files.ts";
import { inspectSyntax } from "../src/inspect.ts";
import { content } from "../src/component-api.ts";
import { prepareEvaluationProfile } from "../src/evaluation-profile.ts";

const bounds = Object.freeze({ durationMs: 1000, outputBytes: 65536 });

function profile(files = recordedFiles()): ExecutionInstallation {
  return { evaluation: { composition: [jsonCompositionEntry()], read: [fileReadEntry()], files } };
}

function runCapture(
  source: string,
  installation = profile(),
  selected: EvaluationBounds = bounds,
  stream: DurableStream = new InMemoryStream(),
  tail = "",
  projection?: string,
): Operation<Result<string>> {
  return scoped(function* () {
    let outcome: Result<string> | undefined;
    try {
      const rendered = yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(
              "capture.md",
              `<Capture>${projection ?? `<Evaluate text={${JSON.stringify(source)}} />${tail}`}</Capture>`,
            ),
            stream,
          },
          [
            installation,
            {
              components: [
                {
                  name: "Capture",
                  origin: "test://capture",
                  props: { type: "object" },
                  factory(claim) {
                    const capture = boundedEvaluation(claim, selected);
                    return function* (_props, invocation) {
                      outcome = yield* capture(invocation);
                      if (!outcome.ok) {
                        throw outcome.error;
                      }
                      return outcome.value;
                    };
                  },
                },
              ],
            },
          ],
        ),
      );
      if (outcome !== undefined) {
        return outcome;
      }
      if (typeof rendered !== "string") {
        throw new Error("Expected historical text.");
      }
      return Ok(rendered);
    } catch (error) {
      if (outcome !== undefined) {
        return outcome;
      }
      throw error;
    }
  });
}

function syntaxInstallation(
  counters: { installs: number; claims: number; reads: number },
  identity = "reference-v1",
  revision = "1",
): ExecutionInstallation {
  return {
    symbols: Object.freeze(
      Object.assign(
        function* () {
          counters.reads += 1;
          return yield* inspectSyntax({ includes: [] });
        },
        { identity },
      ),
    ),
    evaluation: {
      read: [
        {
          kind: "component-answer",
          name: "Syntax",
          identity: { origin: "test://syntax", key: "Syntax", revision },
          forms: ["self-closing"],
        },
      ],
    },
    componentAnswers: [
      {
        origin: "test://syntax",
        *install(registrar) {
          counters.installs += 1;
          let claimed = false;
          yield* registrar.around(function* (request, next) {
            const answer = yield* next();
            if (request.name === "Syntax" && !claimed) {
              claimed = true;
              counters.claims += 1;
              request.claim(answer, { key: "Syntax", revision });
            }
            return answer;
          });
        },
      },
    ],
  };
}

describe("ordinary generated findings", () => {
  it("rejects malformed, mutable and duplicate bounds before any fragment work", function* () {
    let getterReads = 0;
    const accessor = Object.freeze({
      get durationMs() {
        getterReads++;
        return 1;
      },
      outputBytes: 1,
    });
    for (const input of [
      undefined,
      null,
      {},
      { durationMs: 1, outputBytes: 1 },
      Object.freeze({ durationMs: 1 }),
      Object.freeze({ outputBytes: 1 }),
      Object.freeze({ ...bounds, extra: true }),
      accessor,
      ...[0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map((durationMs) =>
        Object.freeze({ ...bounds, durationMs }),
      ),
      ...[-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map((outputBytes) =>
        Object.freeze({ ...bounds, outputBytes }),
      ),
    ]) {
      const files = recordedFiles({ x: "unused" });
      let failure: unknown;
      try {
        yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource("bad-bounds.md", "<Evaluate text={'<File path=\"x\" />'} />"),
              stream: new InMemoryStream(),
            },
            [
              profile(files),
              {
                components: [
                  {
                    name: "Capture",
                    origin: "test://capture",
                    props: { type: "object" },
                    factory(claim) {
                      Reflect.apply(boundedEvaluation, undefined, [claim, input]);
                      return function* () {
                        return "";
                      };
                    },
                  },
                ],
              },
            ],
          ),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EvaluationInfrastructureError);
      expect(files.performed).toEqual([]);
    }
    expect(getterReads).toBe(0);
    let duplicate: unknown;
    try {
      yield* collect(
        yield* executeInstalled(
          { ...retainedSource("duplicate.md", "unused"), stream: new InMemoryStream() },
          [
            profile(),
            {
              components: [
                {
                  name: "Capture",
                  origin: "test://capture",
                  props: { type: "object" },
                  factory(claim) {
                    boundedEvaluation(claim, bounds);
                    boundedEvaluation(claim, bounds);
                    return function* () {
                      return "";
                    };
                  },
                },
              ],
            },
          ],
        ),
      );
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(Error);
  });

  it("keeps cleanup terminal after success, read refusal, overflow and deadline expiry", function* () {
    for (const mode of ["success", "refusal", "overflow", "duration"]) {
      const cleanup = new Error(`cleanup ${mode}`);
      const files = recordedFiles(
        { x: mode === "overflow" ? "too much" : "x" },
        {
          *hold() {
            if (mode === "duration") {
              yield* suspend();
            }
          },
        },
      );
      if (mode === "refusal") {
        files.entries.delete("x");
      }
      const installation: ExecutionInstallation = {
        ...profile(files),
        components: [
          {
            name: "Cleanup",
            origin: "test://cleanup",
            props: { type: "object" },
            factory() {
              return function* () {
                yield* ensure(function* () {
                  yield* sleep(3);
                  throw cleanup;
                });
                return yield* content();
              };
            },
          },
        ],
      };
      const result = yield* runCapture(
        "",
        installation,
        Object.freeze({
          durationMs: mode === "duration" ? 20 : 1000,
          outputBytes: mode === "overflow" ? 1 : 65536,
        }),
        new InMemoryStream(),
        "",
        "<Cleanup><Evaluate text={'<File path=\"x\" />'} /></Cleanup>",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EvaluationInfrastructureError);
        expect(result.error).toMatchObject({ phase: "cleanup" });
      }
    }
  });

  it("replays a settled refusal as the same typed failure without redoing a fragment", function* () {
    for (const source of ["<NoSuchComponent />", "x".repeat(3)]) {
      const stream = new InMemoryStream();
      const selected = Object.freeze({ durationMs: 1000, outputBytes: 2 });
      const first = yield* runCapture(source, profile(), selected, stream);
      const childOnly = new InMemoryStream(
        stream.snapshot().filter((event) => event.type !== "close" || event.coroutineId !== "root"),
      );
      const second = yield* runCapture(source, profile(), selected, childOnly);
      expect(second.ok).toBe(false);
      if (!first.ok && !second.ok) {
        expect(second.error.constructor).toBe(first.error.constructor);
      }
    }
  });

  it("rejects composition conflicts at capture, not after an earlier read", function* () {
    const json = jsonCompositionEntry();
    for (const entries of [
      [json, json],
      [json, { ...json, forms: ["paired"], identity: { ...json.identity, revision: "changed" } }],
      [{ ...json, forms: [] }],
      [{ ...json, name: "File" }],
      [{ ...json, identity: { origin: "", key: "Json", revision: "1" } }],
    ]) {
      let failure: unknown;
      try {
        // Invalid host forms deliberately cross the same runtime boundary as a JavaScript host.
        const prepare = Reflect.apply(prepareEvaluationProfile, undefined, [
          { composition: entries, read: [fileReadEntry()], files: recordedFiles() },
        ]);
        yield* prepare;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
    }
  });

  it("interprets local data in structural constructs and refuses runtime-unbound data before the consumer body", function* () {
    const files = recordedFiles({ x: "data" });
    const source =
      '<Let value={["one", "two"]} as="items" /><Each in={items} let="item"><Json value={{ item }} /></Each><File path="x" as="readme" />{readme}';
    const result = yield* runCapture(source, profile(files));
    if (!result.ok) {
      throw result.error;
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('"item": "one"');
      expect(result.value).toContain('"item": "two"');
      expect(result.value).toContain("data");
    }
    let consumed = 0;
    const json = jsonCompositionEntry();
    const installation: ExecutionInstallation = {
      evaluation: {
        ...profile().evaluation!,
        composition: [
          {
            ...json,
            name: "Consume",
            identity: { ...json.identity, key: "Consume" },
            definition: {
              ...json.definition,
              fn: function* () {
                consumed++;
                return "";
              },
            },
          },
        ],
      },
    };
    const unbound = yield* runCapture(
      '<If condition={false}><Let value="absent" as="value" /></If><Consume value={{ value }} />',
      installation,
    );
    expect(unbound.ok).toBe(false);
    if (!unbound.ok) {
      expect(unbound.error).toBeInstanceOf(EvaluationCandidateError);
    }
    expect(consumed).toBe(0);
  });

  it("does not let nested work extend the enclosing deadline and awaits caller cancellation cleanup", function* () {
    for (const cancel of [false, true]) {
      const started = withResolvers<void>();
      let cleaned = false;
      const files = recordedFiles(
        { x: "waiting" },
        {
          *hold() {
            yield* ensure(function* () {
              yield* sleep(5);
              cleaned = true;
            });
            started.resolve();
            yield* suspend();
          },
        },
      );
      const installation: ExecutionInstallation = {
        ...profile(files),
        components: [
          {
            name: "Inner",
            origin: "test://inner",
            props: { type: "object" },
            factory(claim) {
              const capture = boundedEvaluation(
                claim,
                Object.freeze({ durationMs: 100000, outputBytes: 100000 }),
              );
              return function* (_props, invocation) {
                const result = yield* capture(invocation);
                if (!result.ok) {
                  throw result.error;
                }
                return result.value;
              };
            },
          },
        ],
      };
      const task = yield* spawn(() =>
        runCapture(
          "",
          installation,
          Object.freeze({ durationMs: cancel ? 100000 : 25, outputBytes: 65536 }),
          new InMemoryStream(),
          "",
          "<Inner><Evaluate text={'<File path=\"x\" />'} /></Inner>tail",
        ),
      );
      yield* started.operation;
      if (cancel) {
        yield* task.halt();
      } else {
        const result = yield* task;
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(EvaluationLimitError);
        }
      }
      expect(cleaned).toBe(true);
    }
  });

  it("checks current identities and malformed history before either child or root reuse", function* () {
    const counts = { installs: 0, claims: 0, reads: 0 };
    const stream = new InMemoryStream();
    const source = '<Syntax names={["File"]} />';
    expect((yield* runCapture(source, syntaxInstallation(counts), bounds, stream)).ok).toBe(true);
    for (const mutation of [
      "source",
      "reference",
      "identity",
      "form",
      "duration",
      "bytes",
      "missing",
      "malformed",
      "retained-source",
      "syntax-record",
    ]) {
      const current = { installs: 0, claims: 0, reads: 0 };
      const configured = syntaxInstallation(
        current,
        mutation === "reference" ? "reference-v2" : "reference-v1",
        mutation === "identity" ? "2" : "1",
      );
      const installation: ExecutionInstallation =
        mutation === "form" && configured.evaluation !== undefined
          ? {
              ...configured,
              evaluation: {
                ...configured.evaluation,
                read: configured.evaluation.read.map((entry) => ({ ...entry, forms: ["paired"] })),
              },
            }
          : configured;
      const history = stream
        .snapshot()
        .filter(
          (event) =>
            mutation !== "missing" ||
            event.type !== "yield" ||
            event.description.type !== "evaluation_environment",
        );
      for (const event of history) {
        if (
          mutation === "syntax-record" &&
          event.type === "yield" &&
          event.description.type === "syntax_symbols"
        ) {
          event.result = { status: "ok", value: { symbols: 1 } };
        }
        if (
          event.type === "yield" &&
          event.description.type === "generated_xmd" &&
          event.result.status === "ok"
        ) {
          if (mutation === "malformed") {
            event.result.value = null;
          }
          if (
            mutation === "retained-source" &&
            typeof event.result.value === "object" &&
            event.result.value !== null &&
            !Array.isArray(event.result.value)
          ) {
            event.result.value.source = "changed";
          }
        }
      }
      let failure: unknown;
      try {
        const result = yield* runCapture(
          mutation === "source" ? "changed" : source,
          installation,
          Object.freeze({
            durationMs: mutation === "duration" ? 999 : 1000,
            outputBytes: mutation === "bytes" ? 65535 : 65536,
          }),
          new InMemoryStream(history),
        );
        if (!result.ok) {
          failure = result.error;
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EvaluationStaleError);
      expect(current.reads).toBe(0);
    }
  });

  it("reports persistence and unexpected provider failures as terminal infrastructure", function* () {
    for (const persistence of [true, false]) {
      const failure = new Error("private host failure");
      const stream = new InMemoryStream();
      if (persistence) {
        stream.onAppend = (event) => {
          if (event.type === "yield" && event.description.type === "generated_xmd") {
            throw failure;
          }
        };
      }
      const files = recordedFiles(
        { x: "unused" },
        {
          *hold() {
            throw failure;
          },
        },
      );
      const result = yield* runCapture('<File path="x" />', profile(files), bounds, stream);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EvaluationInfrastructureError);
        expect(result.error).toMatchObject({ phase: persistence ? "persistence" : "runtime" });
      }
    }
  });

  it("normalizes runtime data-prop refusals before invoking their consumer", function* () {
    const files = recordedFiles();
    const result = yield* runCapture(
      '<Let value={2} as="path" /><File path={path} />',
      profile(files),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EvaluationCandidateError);
      expect(result.error.cause).toBeInstanceOf(Error);
    }
    expect(files.performed).toEqual([]);
  });
  it("settles nested projections before taking either snapshot, live and on closed-child replay", function* () {
    let innerBodies = 0;
    const installation: ExecutionInstallation = {
      ...profile(),
      components: [
        {
          name: "Inner",
          origin: "test://inner",
          props: { type: "object" },
          factory(claim) {
            const capture = boundedEvaluation(
              claim,
              Object.freeze({ durationMs: 2000, outputBytes: 100000 }),
            );
            return function* (_props, invocation) {
              innerBodies++;
              const result = yield* capture(invocation);
              if (!result.ok) {
                throw result.error;
              }
              return result.value;
            };
          },
        },
      ],
    };
    const projection = '<Inner><Evaluate text="inner" /></Inner>tail';
    const stream = new InMemoryStream();
    expect(yield* runCapture("", installation, bounds, stream, "", projection)).toEqual(
      Ok("innertail"),
    );
    const resumed = new InMemoryStream(
      stream.snapshot().filter((event) => event.type !== "close" || event.coroutineId !== "root"),
    );
    expect(yield* runCapture("", installation, bounds, resumed, "", projection)).toEqual(
      Ok("innertail"),
    );
    expect(innerBodies).toBe(1);
    const overflow = yield* runCapture(
      "",
      installation,
      Object.freeze({ durationMs: 1000, outputBytes: 8 }),
      new InMemoryStream(),
      "",
      projection,
    );
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error).toBeInstanceOf(EvaluationLimitError);
    }
  });

  it("retains ordinary effects after runtime refusal and overflow instead of rolling them back", function* () {
    for (const tail of ['<File path="missing" />', "x".repeat(9)]) {
      const stream = new InMemoryStream();
      const performed: string[] = [];
      const files = {
        ...recordedFiles(),
        *readTextFile(input: { path: string }): Operation<Result<string>> {
          if (input.path === "missing") {
            return Err(new Error("missing"));
          }
          const value: unknown = yield createDurableOperation(
            { type: "test_read", name: input.path },
            function* () {
              performed.push(input.path);
              return "retained";
            },
          );
          if (typeof value !== "string") {
            throw new Error("Invalid retained read");
          }
          return Ok(value);
        },
      };
      const result = yield* runCapture(
        `<File path="first" as="first" />${tail}`,
        profile(files),
        Object.freeze({ durationMs: 1000, outputBytes: 8 }),
        stream,
      );
      expect(result.ok).toBe(false);
      expect(performed).toEqual(["first"]);
      const effects = stream
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "test_read");
      expect(effects).toHaveLength(1);
      expect(effects[0]?.coroutineId).toContain(".projection-");
      expect(
        stream
          .snapshot()
          .some((event) => event.type === "close" && event.coroutineId.includes(".projection-")),
      ).toBe(true);
    }
  });

  it("waits for ordinary persistence, retains cancellation history, and resumes the first unrecorded child effect", function* () {
    const persisted = new InMemoryStream();
    const appending = withResolvers<void>();
    const ack = withResolvers<void>();
    const second = withResolvers<void>();
    const performed: string[] = [];
    let resumedFirst = false;
    const stream: DurableStream = {
      readAll: () => persisted.readAll(),
      *append(event) {
        if (
          event.type === "yield" &&
          event.description.type === "test_read" &&
          event.description.name === "first"
        ) {
          appending.resolve();
          yield* ack.operation;
        }
        yield* persisted.append(event);
      },
    };
    const files = {
      ...recordedFiles(),
      *readTextFile(input: { path: string }) {
        const value: unknown = yield createDurableOperation(
          { type: "test_read", name: input.path },
          function* () {
            performed.push(input.path);
            if (input.path === "second") {
              second.resolve();
              yield* suspend();
            }
            return input.path;
          },
        );
        resumedFirst = true;
        if (typeof value !== "string") {
          throw new Error("Invalid retained read");
        }
        return Ok(value);
      },
    };
    const source = '<File path="first" /><File path="second" />';
    const task = yield* spawn(() => runCapture(source, profile(files), bounds, stream));
    yield* appending.operation;
    expect(resumedFirst).toBe(false);
    expect(
      persisted
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "test_read"),
    ).toHaveLength(0);
    ack.resolve();
    yield* second.operation;
    expect(resumedFirst).toBe(true);
    const interrupted = persisted.snapshot();
    yield* task.halt();
    expect(
      persisted
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "test_read"),
    ).toHaveLength(1);
    const continuationFiles = {
      ...recordedFiles(),
      *readTextFile(input: { path: string }) {
        const value: unknown = yield createDurableOperation(
          { type: "test_read", name: input.path },
          function* () {
            performed.push(`resume ${input.path}`);
            return input.path;
          },
        );
        if (typeof value !== "string") {
          throw new Error("Invalid retained read");
        }
        return Ok(value);
      },
    };
    expect(
      yield* runCapture(
        source,
        profile(continuationFiles),
        bounds,
        new InMemoryStream(interrupted),
      ),
    ).toEqual(Ok("firstsecond"));
    expect(performed).toEqual(["first", "second", "resume second"]);
  });
  it("renders ordinary Evaluate output and lets Let capture it without a result envelope", function* () {
    const source =
      '<File path="readme" as="readme" /><Json value={{ readme, nested: [null, true, { count: 2 }] }} />';
    const files = recordedFiles({ readme: "contents" });
    const document = `<Let as="findings"><Evaluate text={${JSON.stringify(source)}} /></Let>\n<Json value={findings} />`;
    const result = yield* collect(
      yield* executeInstalled(
        { ...retainedSource("ordinary.md", document), stream: new InMemoryStream() },
        [profile(files)],
      ),
    );
    expect(JSON.parse(String(result))).toBe(
      JSON.stringify({ readme: "contents", nested: [null, true, { count: 2 }] }, null, 2),
    );
    expect(files.performed).toEqual(["read readme"]);
  });

  it("keeps Json available under write selection without granting a read effect", function* () {
    const files = recordedFiles();
    const installation = {
      evaluation: {
        composition: [jsonCompositionEntry()],
        read: [fileReadEntry()],
        write: [fileWriteEntry()],
        files,
      },
    };
    const text = '<Json value={{ only: ["composition"] }} />';
    const result = yield* collect(
      yield* executeInstalled(
        {
          stream: new InMemoryStream(),
          ...retainedSource(
            "write.md",
            `<Evaluate allow={["write"]} text={${JSON.stringify(text)}} />`,
          ),
        },
        [installation],
      ),
    );
    expect(JSON.parse(String(result))).toEqual({ only: ["composition"] });
  });

  it("composes Glob, File and protected Syntax bindings only through authored Json", function* () {
    const counts = { installs: 0, claims: 0, reads: 0 };
    const installation = syntaxInstallation(counts);
    const files = {
      ...recordedFiles({ "README.md": "readme" }),
      *globFiles() {
        return Ok([]);
      },
    };
    const configured: ExecutionInstallation = {
      ...installation,
      evaluation: {
        ...installation.evaluation!,
        composition: [jsonCompositionEntry()],
        read: [globReadEntry(), fileReadEntry(), ...installation.evaluation!.read],
        files,
      },
    };
    const source =
      '<Glob include={["**/AGENTS.md"]} as="paths" /><File path="README.md" as="readme" /><Syntax names={["Elicit", "File"]} as="syntax" /><Json value={{ paths, readme, syntax }} />';
    const result = yield* runCapture(source, configured);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rendered = JSON.parse(result.value);
      expect(rendered.paths).toEqual([]);
      expect(rendered.readme).toBe("readme");
      expect(rendered.syntax).toContain("File");
      expect(Object.keys(rendered)).toEqual(["paths", "readme", "syntax"]);
    }
    expect(counts.reads).toBe(1);
  });

  it("rejects every executable expression form before an earlier read, not just at Json", function* () {
    for (const expression of [
      "globalThis",
      "missing",
      "readme()",
      "new Date()",
      "-1",
      "1 + 2",
      "readme = 1",
      "readme++",
      "[...readme]",
      "{...readme}",
      "{[readme]: 1}",
      "`template`",
      "globalThis.process",
      "readme.constructor",
      "() => 1",
    ]) {
      const files = recordedFiles({ x: "data" });
      const result = yield* runCapture(
        `<File path="x" as="readme" /><Json value={${expression}} />`,
        profile(files),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EvaluationCandidateError);
      }
      expect(files.performed).toEqual([]);
    }
  });

  it("counts rendered UTF-8 bytes, not an envelope, escaping, or hidden bound values", function* () {
    for (const [text, accepted] of [
      ["x".repeat(65536), true],
      ["x".repeat(65537), false],
      ["é".repeat(32768), true],
      ["é".repeat(32769), false],
      ["😀".repeat(16384), true],
      ["😀".repeat(16385), false],
    ]) {
      if (typeof text !== "string") {
        throw new Error("Bad fixture");
      }
      const result = yield* runCapture(text);
      expect(result.ok).toBe(accepted);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EvaluationLimitError);
        expect(result).not.toHaveProperty("value");
      }
    }
    const hidden = yield* runCapture(
      '<File path="huge" as="unused" />ok',
      profile(recordedFiles({ huge: "x".repeat(100000) })),
      Object.freeze({ durationMs: 1000, outputBytes: 2 }),
    );
    expect(hidden).toEqual(Ok("ok"));
    const unwrapped = yield* collect(
      yield* executeInstalled(
        {
          ...retainedSource(
            "unbounded.md",
            `<Evaluate text={${JSON.stringify("x".repeat(65537))}} />`,
          ),
          stream: new InMemoryStream(),
        },
        [profile()],
      ),
    );
    expect(unwrapped).toBe("x".repeat(65537));
    for (const length of [65534, 65535]) {
      const json = yield* runCapture(`<Json value={${JSON.stringify("x".repeat(length))}} />`);
      expect(json.ok).toBe(length === 65534);
    }
    const files = recordedFiles({ late: "must not read" });
    const loop = yield* runCapture(
      '<Each in={[1, 2]} let="item">12345<File path="late" as="ignored" /></Each>',
      profile(files),
      Object.freeze({ durationMs: 1000, outputBytes: 4 }),
    );
    expect(loop.ok).toBe(false);
    expect(files.performed).toEqual([]);
  });

  it("rejects a changed filesystem identity and stores only structural durable data", function* () {
    const stream = new InMemoryStream();
    const source = '<File path="x" />';
    expect(
      yield* runCapture(source, profile(recordedFiles({ x: "historical" })), bounds, stream),
    ).toEqual(Ok("historical"));
    const files = {
      ...recordedFiles({ x: "current" }),
      replayIdentity: Object.freeze({ scope: "test://other-workspace", policy: "read-write-v1" }),
    };
    let failure: unknown;
    try {
      yield* runCapture(source, profile(files), bounds, new InMemoryStream(stream.snapshot()));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EvaluationStaleError);
    expect(files.performed).toEqual([]);
    function inspect(value: unknown): void {
      expect(typeof value).not.toBe("function");
      if (value !== null && typeof value === "object") {
        expect([Object.prototype, Array.prototype]).toContain(Object.getPrototypeOf(value));
        for (const member of Object.values(value)) {
          inspect(member);
        }
      }
    }
    inspect(stream.snapshot());
    expect(
      stream
        .snapshot()
        .some(
          (event) =>
            event.type === "yield" &&
            ["evaluation_stage", "evaluation_result"].includes(event.description.type),
        ),
    ).toBe(false);
  });

  it("includes trailing projection output instead of freezing at Evaluate completion", function* () {
    const stream = new InMemoryStream();
    const first = yield* runCapture("inner", profile(), bounds, stream, "tail");
    expect(first).toEqual(Ok("innertail"));
    const resumed = new InMemoryStream(
      stream.snapshot().filter((event) => event.type !== "close" || event.coroutineId !== "root"),
    );
    expect(yield* runCapture("inner", profile(), bounds, resumed, "tail")).toEqual(first);
  });

  it("waits for delayed cleanup before a typed deadline refusal", function* () {
    let cleaned = false;
    const files = recordedFiles(
      { x: "never" },
      {
        *hold() {
          yield* ensure(function* () {
            yield* sleep(5);
            cleaned = true;
          });
          yield* suspend();
        },
      },
    );
    const result = yield* runCapture(
      '<File path="x" />',
      profile(files),
      Object.freeze({ durationMs: 30, outputBytes: 65536 }),
    );
    expect(cleaned).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EvaluationLimitError);
    }
  });

  it("freshly attests completed history without reading Syntax again", function* () {
    const counts = { installs: 0, claims: 0, reads: 0 };
    const stream = new InMemoryStream();
    const source = '<Syntax names={["File"]} />';
    const first = yield* runCapture(source, syntaxInstallation(counts), bounds, stream);
    expect(first.ok).toBe(true);
    const resumed = new InMemoryStream(
      stream.snapshot().filter((event) => event.type !== "close" || event.coroutineId !== "root"),
    );
    expect(yield* runCapture(source, syntaxInstallation(counts), bounds, resumed)).toEqual(first);
    expect(
      yield* runCapture(
        source,
        syntaxInstallation(counts),
        bounds,
        new InMemoryStream(stream.snapshot()),
      ),
    ).toEqual(first);
    expect(counts).toEqual({ installs: 3, claims: 3, reads: 1 });
  });
});
