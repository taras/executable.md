import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, Ok, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import {
  boundedEvaluation,
  EvaluationCandidateError,
  EvaluationInfrastructureError,
  EvaluationLimitError,
  EvaluationStaleError,
  encodeEvaluationResult,
  evaluationFailure,
  executeInstalled,
  fileReadEntry,
  globReadEntry,
} from "../host.ts";
import type { EvaluationBounds, ExecutionInstallation } from "../host.ts";
import type { GeneratedObservationResult } from "../src/generated-xmd.ts";
import { GeneratedXmdError } from "../src/generated-xmd.ts";
import { collect } from "../src/collect.ts";
import { retainedSource } from "../src/root-source.ts";
import { recordedFiles } from "./support/fragment-files.ts";
import { isJsonObject } from "../src/json.ts";
import { inspectSyntax } from "../src/inspect.ts";
import { Component } from "../src/component-api.ts";
import { FilesProviderUnavailableError } from "@executablemd/runtime/files";

function runCapture(
  source: string,
  profile: ExecutionInstallation,
  bounds: EvaluationBounds = Object.freeze({ durationMs: 1000, resultBytes: 65536 }),
  stream = new InMemoryStream(),
): Operation<Result<GeneratedObservationResult>> {
  return scoped(function* () {
    let outcome: Result<GeneratedObservationResult> | undefined;
    const component: ExecutionInstallation = {
      components: [
        {
          name: "Capture",
          origin: "test://capture",
          props: { type: "object", properties: {}, additionalProperties: false },
          factory(claim) {
            const capture = boundedEvaluation(claim, bounds);
            return function* (_props, invocation) {
              outcome = yield* capture(invocation);
              return outcome.ok
                ? outcome.value
                : {
                    refusal:
                      outcome.error instanceof EvaluationLimitError
                        ? outcome.error.limit
                        : "candidate",
                  };
            };
          },
        },
      ],
    };
    const returned = yield* collect(
      yield* executeInstalled(
        {
          ...retainedSource(
            "capture.md",
            `---\nreturns:\n  type: object\n---\n<Capture as="answer"><Evaluate text={${JSON.stringify(source)}} /></Capture>\n<Return value={answer} />`,
          ),
          stream,
        },
        [profile, component],
      ),
    );
    if (outcome === undefined) {
      if (
        isJsonObject(returned) &&
        Array.isArray(returned.observations) &&
        typeof returned.output === "string"
      ) {
        const observations = returned.observations.map((observation) => {
          if (!isJsonObject(observation) || typeof observation.name !== "string") {
            throw new Error("Invalid historical observation.");
          }
          return { name: observation.name, value: observation.value };
        });
        return Ok({ observations, output: returned.output });
      }
      if (
        isJsonObject(returned) &&
        (returned.refusal === "duration" || returned.refusal === "result-bytes")
      ) {
        return Err(new EvaluationLimitError(returned.refusal));
      }
      if (isJsonObject(returned) && returned.refusal === "candidate") {
        return Err(new EvaluationCandidateError("candidate", "historical refusal"));
      }
      throw new Error("No historical capture outcome.");
    }
    return outcome;
  });
}

describe("bounded ordinary Evaluate composition", () => {
  it("accepts a complete result below the deadline through the actual content projection", function* () {
    const stream = new InMemoryStream();
    const result = yield* runCapture(
      "hello",
      { evaluation: { read: [fileReadEntry()], files: recordedFiles() } },
      undefined,
      stream,
    );
    expect(result).toEqual(Ok({ observations: [], output: "hello" }));
    const admission = stream
      .snapshot()
      .find((event) => event.type === "yield" && event.description.type === "generated_xmd");
    expect(admission?.coroutineId).toBe("root.0");
    const long = yield* runCapture(
      '<File path="x" />',
      {
        evaluation: {
          read: [fileReadEntry()],
          files: recordedFiles(
            { x: "long deadline" },
            {
              *hold() {
                yield* sleep(5);
              },
            },
          ),
        },
      },
      Object.freeze({ durationMs: 2147483648, resultBytes: 65536 }),
    );
    expect(long.ok).toBe(true);
  });

  it("counts the complete JSON envelope, not only rendered ASCII or JavaScript code units", function* () {
    const profile = { evaluation: { read: [fileReadEntry()], files: recordedFiles() } };
    for (const [source, accepted] of [
      ["x".repeat(65536 - 31), true],
      ["x".repeat(65537 - 31), false],
      ["é".repeat(32752) + "x", true],
      ["é".repeat(32753), false],
    ]) {
      if (typeof source !== "string") {
        throw new Error("invalid test source");
      }
      const outcome = yield* runCapture(source, profile);
      expect(outcome.ok).toBe(accepted);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(EvaluationLimitError);
        expect(outcome).not.toHaveProperty("value");
      }
    }
  });

  it("cancels a live read and awaits delayed teardown before reporting the local deadline", function* () {
    const order: string[] = [];
    const result = yield* runCapture(
      '<File path="x" />',
      {
        evaluation: {
          read: [fileReadEntry()],
          files: {
            ...recordedFiles(),
            *readTextFile() {
              yield* ensure(function* () {
                yield* sleep(10);
                order.push("cleanup complete");
              });
              order.push("read started");
              yield* suspend();
              return Ok("");
            },
          },
        },
      },
      Object.freeze({ durationMs: 30, resultBytes: 65536 }),
    );
    order.push("outcome");
    expect(order).toEqual(["read started", "cleanup complete", "outcome"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EvaluationLimitError);
    }
  });

  it("keeps cleanup failure terminal after overflow instead of returning the first recoverable error", function* () {
    const cleanup = new Error("cleanup sentinel");
    const result = yield* runCapture('<File path="x" />', {
      evaluation: {
        read: [fileReadEntry()],
        files: {
          ...recordedFiles(),
          *readTextFile() {
            yield* ensure(function* () {
              throw cleanup;
            });
            return Ok("x".repeat(65536));
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EvaluationInfrastructureError);
    }
  });

  it("reports candidate admission by exported type and drops its staged admission", function* () {
    const stream = new InMemoryStream();
    const result = yield* runCapture(
      "<Agent />",
      { evaluation: { read: [fileReadEntry()], files: recordedFiles() } },
      undefined,
      stream,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EvaluationCandidateError);
    }
    expect(
      stream
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "generated_xmd"),
    ).toEqual([]);
  });
});

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

describe("bounded capture replay and authority", () => {
  it("freshly attests authority but restores a completed capture without fragment or Syntax lookups", function* () {
    const counts = { installs: 0, claims: 0, reads: 0 };
    const stream = new InMemoryStream();
    const source = '<Syntax names={["File"]} />';
    const first = yield* runCapture(source, syntaxInstallation(counts), undefined, stream);
    expect(first.ok).toBe(true);
    const history = stream.snapshot();
    const partial = new InMemoryStream(
      history.filter((event) => event.type !== "close" || event.coroutineId !== "root"),
    );
    const second = yield* runCapture(source, syntaxInstallation(counts), undefined, partial);
    expect(second).toEqual(first);
    expect(counts).toEqual({ installs: 2, claims: 2, reads: 1 });
    const third = yield* runCapture(
      source,
      syntaxInstallation(counts),
      undefined,
      new InMemoryStream(history),
    );
    expect(third).toEqual(first);
    expect(counts).toEqual({ installs: 3, claims: 3, reads: 1 });
    expect(
      history
        .filter((event) => event.type === "yield" && event.description.type === "syntax_symbols")
        .map((event) => event.coroutineId),
    ).toEqual(["root.0"]);
  });

  it("refuses changed bounds, reference and admitted identity before completed-root reuse", function* () {
    const counts = { installs: 0, claims: 0, reads: 0 };
    const source = '<Syntax names={["File"]} />';
    const stream = new InMemoryStream();
    yield* runCapture(source, syntaxInstallation(counts), undefined, stream);
    for (const variant of [
      { durationMs: 1001, resultBytes: 65536, reference: "reference-v1", revision: "1", source },
      { durationMs: 1000, resultBytes: 65537, reference: "reference-v1", revision: "1", source },
      { durationMs: 1000, resultBytes: 65536, reference: "reference-v2", revision: "1", source },
      { durationMs: 1000, resultBytes: 65536, reference: "reference-v1", revision: "2", source },
      {
        durationMs: 1000,
        resultBytes: 65536,
        reference: "reference-v1",
        revision: "1",
        source: "different",
      },
    ]) {
      let failure: unknown;
      try {
        yield* runCapture(
          variant.source,
          syntaxInstallation(counts, variant.reference, variant.revision),
          Object.freeze({ durationMs: variant.durationMs, resultBytes: variant.resultBytes }),
          new InMemoryStream(stream.snapshot()),
        );
      } catch (error) {
        failure = error;
      }
      if (failure === undefined) {
        throw new Error(`Replay accepted changed input: ${JSON.stringify(variant)}`);
      }
      expect(failure).toBeInstanceOf(EvaluationStaleError);
    }
    expect(counts.reads).toBe(1);
  });

  it("keeps an oversized Syntax value out of persistence, including Syntax's internal record", function* () {
    const stream = new InMemoryStream();
    const counts = { installs: 0, claims: 0, reads: 0 };
    const source = '<Syntax names={["File"]} />';
    const result = yield* runCapture(
      source,
      syntaxInstallation(counts),
      Object.freeze({ durationMs: 1000, resultBytes: 128 }),
      stream,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EvaluationLimitError);
    }
    expect(counts.reads).toBe(1);
    expect(
      stream
        .snapshot()
        .filter(
          (event) =>
            event.type === "yield" &&
            ["syntax_symbols", "generated_xmd"].includes(event.description.type),
        ),
    ).toEqual([]);
    const replay = yield* runCapture(
      source,
      syntaxInstallation(counts),
      Object.freeze({ durationMs: 1000, resultBytes: 128 }),
      new InMemoryStream(
        stream.snapshot().filter((event) => event.type !== "close" || event.coroutineId !== "root"),
      ),
    );
    expect(replay.ok).toBe(false);
    expect(counts.reads).toBe(1);
    let stale: unknown;
    try {
      yield* runCapture(
        source,
        syntaxInstallation(counts),
        Object.freeze({ durationMs: 1001, resultBytes: 128 }),
        new InMemoryStream(stream.snapshot()),
      );
    } catch (error) {
      stale = error;
    }
    expect(stale).toBeInstanceOf(EvaluationStaleError);
    expect(counts.reads).toBe(1);
  });

  it("restores captured File and Glob values as history, not as fresh provider information", function* () {
    const files = recordedFiles({ x: "old" });
    let searches = 0;
    const profile: ExecutionInstallation = {
      evaluation: {
        read: [fileReadEntry(), globReadEntry()],
        files: {
          ...files,
          *globFiles() {
            searches += 1;
            return Ok(["x"]);
          },
        },
      },
    };
    const stream = new InMemoryStream();
    const source = '<Glob include={["*"]} as="paths" /><File path="x" as="note" />';
    const first = yield* runCapture(source, profile, undefined, stream);
    files.entries.set("x", "new");
    const second = yield* runCapture(
      source,
      profile,
      undefined,
      new InMemoryStream(
        stream.snapshot().filter((event) => event.type !== "close" || event.coroutineId !== "root"),
      ),
    );
    expect(second).toEqual(first);
    expect(searches).toBe(1);
    expect(files.performed).toEqual(["read x"]);
    for (const replayIdentity of [
      Object.freeze({ scope: "other", policy: "read-write-v1" }),
      Object.freeze({ scope: "test://workspace", policy: "changed" }),
    ]) {
      let failure: unknown;
      try {
        yield* runCapture(
          source,
          {
            evaluation: {
              ...profile.evaluation!,
              files: { ...profile.evaluation!.files!, replayIdentity },
            },
          },
          undefined,
          new InMemoryStream(stream.snapshot()),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EvaluationStaleError);
    }
    expect(searches).toBe(1);
  });

  it("does not let public content middleware author completion", function* () {
    let fabricated = 0;
    const result = yield* runCapture("canonical", {
      evaluation: { read: [fileReadEntry()], files: recordedFiles() },
      *install() {
        yield* Component.around({
          *content() {
            fabricated += 1;
            return "forged";
          },
        });
      },
    });
    expect(result).toEqual(Ok({ observations: [], output: "canonical" }));
    expect(fabricated).toBe(0);
  });

  it("requires fresh protected attestation and rejects changed forms and table order before reuse", function* () {
    const counts = { installs: 0, claims: 0, reads: 0 };
    const original = syntaxInstallation(counts);
    const files = recordedFiles({ x: "old" });
    const profile: ExecutionInstallation = {
      ...original,
      evaluation: {
        ...original.evaluation,
        read: [...original.evaluation!.read!, fileReadEntry()],
        files,
      },
    };
    const stream = new InMemoryStream();
    yield* runCapture('<Syntax names={["File"]} />', profile, undefined, stream);
    const variants: ExecutionInstallation[] = [
      { ...profile, componentAnswers: [] },
      {
        ...profile,
        evaluation: { ...profile.evaluation, read: [...profile.evaluation!.read!].reverse() },
      },
      {
        ...profile,
        evaluation: {
          ...profile.evaluation,
          read: profile.evaluation!.read!.map((entry) =>
            entry.name === "Syntax" ? { ...entry, forms: ["paired"] } : entry,
          ),
        },
      },
    ];
    for (const variant of variants) {
      let failure: unknown;
      try {
        yield* runCapture(
          '<Syntax names={["File"]} />',
          variant,
          undefined,
          new InMemoryStream(stream.snapshot()),
        );
      } catch (error) {
        failure = evaluationFailure(error);
      }
      expect(failure).toBeInstanceOf(EvaluationStaleError);
    }
    expect(counts.reads).toBe(1);
    expect(files.performed).toEqual([]);
  });

  it("treats a partially published accepted flush as child history, never a completed answer", function* () {
    const counts = { installs: 0, claims: 0, reads: 0 };
    const stream = new InMemoryStream();
    const source = '<Syntax names={["File"]} />';
    const accepted = yield* runCapture(source, syntaxInstallation(counts), undefined, stream);
    const events = stream.snapshot();
    const childClose = events.findIndex(
      (event) => event.type === "close" && event.coroutineId === "root.0",
    );
    expect(childClose).toBeGreaterThan(0);
    const partial = new InMemoryStream(events.slice(0, childClose));
    expect(yield* runCapture(source, syntaxInstallation(counts), undefined, partial)).toEqual(
      accepted,
    );
    expect(counts.reads).toBe(1);
    expect(
      partial
        .snapshot()
        .filter((event) => event.type === "yield" && event.description.type === "syntax_symbols"),
    ).toHaveLength(1);
    function inspect(value: unknown): void {
      expect(typeof value).not.toBe("function");
      if (typeof value === "object" && value !== null) {
        for (const key of Reflect.ownKeys(value)) {
          expect([
            "stage",
            "staging",
            "route",
            "protectedBodies",
            "profile",
            "provider",
            "projectContent",
          ]).not.toContain(String(key));
          inspect(Reflect.get(value, key));
        }
      }
    }
    inspect(partial.snapshot());
  });
});

describe("bounded capture hostile controls", () => {
  it("leaves an ordinary unwrapped Evaluate unbounded", function* () {
    const text = "x".repeat(70000);
    const returned = yield* scoped(function* () {
      return yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(
              "unbounded.md",
              `---\nreturns:\n  type: object\n---\n<Evaluate text={${JSON.stringify(text)}} as="answer" />\n<Return value={answer} />`,
            ),
            stream: new InMemoryStream(),
          },
          [{ evaluation: { read: [fileReadEntry()], files: recordedFiles() } }],
        ),
      );
    });
    expect(returned).toEqual({ observations: [], output: text });
  });

  it("rejects malformed or mutable bounds at factory preparation, before fragment or provider work", function* () {
    const bad: unknown[] = [
      {},
      Object.freeze({ durationMs: 1000 }),
      Object.freeze({ resultBytes: 65536 }),
      { durationMs: 1000, resultBytes: 65536 },
      ...[NaN, Infinity, -1, 0, 1.5].map((durationMs) =>
        Object.freeze({ durationMs, resultBytes: 65536 }),
      ),
      ...[NaN, Infinity, -1, 1.5].map((resultBytes) =>
        Object.freeze({ durationMs: 1000, resultBytes }),
      ),
      Object.freeze({ durationMs: 1000, resultBytes: 65536, extra: true }),
      Object.freeze({
        get durationMs() {
          throw new Error("getter must not run");
        },
        resultBytes: 65536,
      }),
    ];
    for (const bounds of bad) {
      let ran = false;
      let failure: unknown;
      try {
        yield* scoped(function* () {
          yield* collect(
            yield* executeInstalled(
              { ...retainedSource("bad.md", "<Capture />"), stream: new InMemoryStream() },
              [
                {
                  components: [
                    {
                      name: "Capture",
                      origin: "test://invalid",
                      props: { type: "object" },
                      factory(claim) {
                        Reflect.apply(boundedEvaluation, undefined, [claim, bounds]);
                        return function* () {
                          ran = true;
                          return "";
                        };
                      },
                    },
                  ],
                },
              ],
            ),
          );
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EvaluationInfrastructureError);
      expect(ran).toBe(false);
    }
  });

  it("charges captured File and Glob values, escaping and multibyte data before acceptance", function* () {
    const encoder = new TextEncoder();
    for (const text of ["a", "é", "😀", '"\\\n']) {
      const value = text.repeat(50);
      const files = recordedFiles({ x: value });
      const profile = {
        evaluation: {
          read: [fileReadEntry(), globReadEntry()],
          files: {
            ...files,
            *globFiles() {
              return Ok([value]);
            },
          },
        },
      };
      const source = '<File path="x" as="file" /><Glob include={["*"]} as="paths" />';
      const expected = {
        observations: [
          { name: "File", value },
          { name: "Glob", value: [value] },
        ],
        output: "",
      };
      const bytes = encoder.encode(encodeEvaluationResult(expected)).byteLength;
      expect(
        yield* runCapture(source, profile, Object.freeze({ durationMs: 1000, resultBytes: bytes })),
      ).toEqual(Ok(expected));
      const refused = yield* runCapture(
        source,
        profile,
        Object.freeze({ durationMs: 1000, resultBytes: bytes - 1 }),
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error).toBeInstanceOf(EvaluationLimitError);
      }
    }
    expect(
      encodeEvaluationResult({
        observations: [{ name: "value", value: { z: 1, "2": 2, "10": 10, a: [true] } }],
        output: "",
      }),
    ).toBe(
      '{"observations":[{"name":"value","value":{"10":10,"2":2,"a":[true],"z":1}}],"output":""}',
    );
    const split = {
      observations: [
        { name: "File", value: "\ud83d" },
        { name: "File", value: "\ude00" },
      ],
      output: "😀",
    };
    const splitBytes = encoder.encode(encodeEvaluationResult(split)).byteLength;
    expect(
      yield* runCapture(
        '<File path="high" /><File path="low" />',
        {
          evaluation: {
            read: [fileReadEntry()],
            files: recordedFiles({ high: "\ud83d", low: "\ude00" }),
          },
        },
        Object.freeze({ durationMs: 1000, resultBytes: splitBytes }),
      ),
    ).toEqual(Ok(split));
  });

  it("rejects duplicate or late preparation instead of silently replacing retained bounds", function* () {
    for (const mode of ["duplicate", "late"]) {
      const files = recordedFiles({ x: "must not read" });
      let failure: unknown;
      try {
        yield* scoped(function* () {
          yield* collect(
            yield* executeInstalled(
              {
                ...retainedSource(
                  "duplicate.md",
                  "<Capture><Evaluate text={'<File path=\"x\" />'} /></Capture>",
                ),
                stream: new InMemoryStream(),
              },
              [
                {
                  evaluation: { read: [fileReadEntry()], files },
                  components: [
                    {
                      name: "Capture",
                      origin: "test://duplicate",
                      props: { type: "object" },
                      factory(claim) {
                        const bounds = Object.freeze({ durationMs: 1000, resultBytes: 65536 });
                        const capture = boundedEvaluation(claim, bounds);
                        if (mode === "duplicate") {
                          boundedEvaluation(claim, bounds);
                        }
                        return function* (_props, invocation) {
                          boundedEvaluation(claim, bounds);
                          return yield* capture(invocation);
                        };
                      },
                    },
                  ],
                },
              ],
            ),
          );
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EvaluationInfrastructureError);
      expect(files.performed).toEqual([]);
    }
  });

  it("accepts exactly 65536 bytes of captured File or Glob JSON and refuses byte 65537", function* () {
    const encoder = new TextEncoder();
    for (const name of ["File", "Glob"]) {
      for (const prefix of ["a", 'é😀"\\\n']) {
        const seed = prefix.repeat(40);
        const result = (text: string) => ({
          observations: [{ name, value: name === "File" ? text : [text] }],
          output: "",
        });
        const bytes = encoder.encode(encodeEvaluationResult(result(seed))).byteLength;
        const value = seed + "x".repeat(65536 - bytes);
        const source =
          name === "File" ? '<File path="x" as="file" />' : '<Glob include={["*"]} as="paths" />';
        for (const extra of ["", "x"]) {
          const files = recordedFiles({ x: value + extra });
          const stream = new InMemoryStream();
          const expected = result(value + extra);
          expect(encoder.encode(encodeEvaluationResult(expected)).byteLength).toBe(
            65536 + extra.length,
          );
          const outcome = yield* runCapture(
            source,
            {
              evaluation: {
                read: [fileReadEntry(), globReadEntry()],
                files: {
                  ...files,
                  *globFiles() {
                    return Ok([value + extra]);
                  },
                },
              },
            },
            undefined,
            stream,
          );
          if (extra === "") {
            expect(outcome).toEqual(Ok(expected));
          } else {
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
              expect(outcome.error).toBeInstanceOf(EvaluationLimitError);
            }
            expect(outcome).not.toHaveProperty("value");
            expect(JSON.stringify(stream.snapshot())).not.toContain(value);
          }
        }
      }
    }
  });

  it("does not let nested captures extend an enclosing deadline or byte ceiling", function* () {
    for (const mode of ["bytes", "duration"]) {
      let outcome: Result<GeneratedObservationResult> | undefined;
      let cleaned = false;
      const stream = new InMemoryStream();
      yield* scoped(function* () {
        yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(
                "nested.md",
                "<Outer><Inner><Evaluate text={'<File path=\"x\" />'} /></Inner></Outer>",
              ),
              stream,
            },
            [
              {
                evaluation: {
                  read: [fileReadEntry()],
                  files: {
                    ...recordedFiles(),
                    *readTextFile() {
                      yield* ensure(function* () {
                        yield* sleep(5);
                        cleaned = true;
                      });
                      if (mode === "duration") {
                        yield* suspend();
                      }
                      return Ok("x".repeat(500));
                    },
                  },
                },
                components: ["Outer", "Inner"].map((name) => ({
                  name,
                  origin: "test://nested",
                  props: { type: "object" },
                  factory(claim) {
                    const capture = boundedEvaluation(
                      claim,
                      Object.freeze({
                        durationMs: name === "Outer" ? 40 : 1000,
                        resultBytes: name === "Outer" ? 128 : 65536,
                      }),
                    );
                    return function* (_props, invocation) {
                      const result = yield* capture(invocation);
                      if (name === "Outer") {
                        outcome = result;
                      }
                      return "";
                    };
                  },
                })),
              },
            ],
          ),
        );
      });
      expect(cleaned).toBe(true);
      expect(outcome?.ok).toBe(false);
      if (outcome !== undefined && !outcome.ok) {
        expect(outcome.error).toBeInstanceOf(EvaluationLimitError);
      }
      expect(
        stream
          .snapshot()
          .filter((event) => event.type === "yield" && event.description.type === "generated_xmd"),
      ).toEqual([]);
    }
  });

  it("keeps publication failure terminal and never exposes the accepted result", function* () {
    const stream = new InMemoryStream();
    const broken = new Error("append sentinel");
    stream.onAppend = (event) => {
      if (event.type === "yield" && event.description.type === "generated_xmd") {
        throw broken;
      }
    };
    let failure: unknown;
    try {
      const outcome = yield* runCapture(
        "small",
        { evaluation: { read: [fileReadEntry()], files: recordedFiles() } },
        undefined,
        stream,
      );
      if (!outcome.ok) {
        failure = outcome.error;
      }
    } catch (error) {
      failure = evaluationFailure(error);
    }
    expect(failure).toBeInstanceOf(EvaluationInfrastructureError);
    expect(stream.snapshot().filter((event) => event.type === "close")).toEqual([]);
  });

  it("does not accept a nested wrapper's edited public result as canonical completion", function* () {
    let outer: Result<GeneratedObservationResult> | undefined;
    yield* scoped(function* () {
      yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource(
              "edited.md",
              "<Outer><Inner><Evaluate text={'<File path=\"x\" />'} /></Inner></Outer>",
            ),
            stream: new InMemoryStream(),
          },
          [
            {
              evaluation: { read: [fileReadEntry()], files: recordedFiles({ x: "historical" }) },
              components: ["Outer", "Inner"].map((name) => ({
                name,
                origin: "test://edited",
                props: { type: "object" },
                factory(claim) {
                  const capture = boundedEvaluation(
                    claim,
                    Object.freeze({ durationMs: 1000, resultBytes: 65536 }),
                  );
                  return function* (_props, invocation) {
                    const result = yield* capture(invocation);
                    if (name === "Outer") {
                      outer = result;
                    } else if (result.ok) {
                      Reflect.set(result.value, "output", "forged");
                      Reflect.set(result.value.observations[0]!, "value", "forged");
                    }
                    return "";
                  };
                },
              })),
            },
          ],
        ),
      );
    });
    expect(outer).toEqual(
      Ok({ observations: [{ name: "File", value: "historical" }], output: "historical" }),
    );
  });

  for (const mode of ["success", "refused", "deadline"]) {
    it(`keeps teardown terminal after ${mode}`, function* () {
      const cleanup = new Error(`cleanup ${mode}`);
      const result = yield* runCapture(
        '<File path="x" />',
        {
          evaluation: {
            read: [fileReadEntry()],
            files: {
              ...recordedFiles(),
              *readTextFile() {
                yield* ensure(function* () {
                  yield* sleep(5);
                  throw cleanup;
                });
                if (mode === "deadline") {
                  yield* suspend();
                }
                return mode === "refused" ? Err(new Error("private file error")) : Ok("small");
              },
            },
          },
        },
        Object.freeze({ durationMs: 30, resultBytes: 65536 }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EvaluationInfrastructureError);
      }
    });
  }

  it("does not convert caller cancellation into a local refusal or publish a closed child", function* () {
    const started = withResolvers<void>();
    let cleaned = false;
    let escaped = false;
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        yield* runCapture(
          '<File path="x" />',
          {
            evaluation: {
              read: [fileReadEntry()],
              files: {
                ...recordedFiles(),
                *readTextFile() {
                  yield* ensure(function* () {
                    yield* sleep(5);
                    cleaned = true;
                  });
                  started.resolve();
                  yield* suspend();
                  return Ok("");
                },
              },
            },
          },
          undefined,
          stream,
        );
        escaped = true;
      });
      yield* started.operation;
      yield* task.halt();
    });
    expect(cleaned).toBe(true);
    expect(escaped).toBe(false);
    expect(stream.snapshot().filter((event) => event.type === "close")).toEqual([]);
  });

  it("distinguishes ordinary read and Syntax refusals from unexpected provider exceptions", function* () {
    const missing = yield* runCapture('<File path="missing" />', {
      evaluation: { read: [fileReadEntry()], files: recordedFiles() },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBeInstanceOf(EvaluationCandidateError);
    }
    const syntax = yield* runCapture(
      '<Syntax names={["NotAComponent"]} />',
      syntaxInstallation({ installs: 0, claims: 0, reads: 0 }),
    );
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) {
      expect(syntax.error).toBeInstanceOf(EvaluationCandidateError);
    }
    const provider = new Error("private provider sentinel");
    const broken = yield* runCapture('<File path="x" />', {
      evaluation: {
        read: [fileReadEntry()],
        files: {
          ...recordedFiles(),
          *readTextFile() {
            throw provider;
          },
        },
      },
    });
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.error).toBeInstanceOf(EvaluationInfrastructureError);
      expect(broken.error.cause).toBe(provider);
    }
    const unavailable = new FilesProviderUnavailableError();
    const absent = yield* runCapture('<File path="x" />', {
      evaluation: {
        read: [fileReadEntry()],
        files: {
          ...recordedFiles(),
          *readTextFile() {
            return Err(unavailable);
          },
        },
      },
    });
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.error).toBeInstanceOf(EvaluationInfrastructureError);
    }
    const cyclic = new Error("cycle");
    cyclic.cause = cyclic;
    expect(evaluationFailure(cyclic)).toBeInstanceOf(EvaluationInfrastructureError);
    expect(
      evaluationFailure(new GeneratedXmdError("The generated request was refused.")),
    ).toBeInstanceOf(EvaluationInfrastructureError);
  });

  it("refuses corrupt closed records and missing child outcomes before another read", function* () {
    const files = recordedFiles({ x: "historical" });
    const profile = { evaluation: { read: [fileReadEntry()], files } };
    const stream = new InMemoryStream();
    const source = '<File path="x" />';
    yield* runCapture(source, profile, undefined, stream);
    for (const change of [
      "missing-close",
      "missing-header",
      "version",
      "source",
      "extra",
      "bad-result",
      "admission",
      "retained-identity",
      "retained-form",
    ]) {
      const events = stream
        .snapshot()
        .filter(
          (event) =>
            !(
              change === "missing-close" &&
              event.type === "close" &&
              event.coroutineId === "root.0"
            ) &&
            !(
              change === "missing-header" &&
              event.type === "yield" &&
              event.description.type === "evaluation_stage"
            ),
        );
      for (const event of events) {
        if (event.result.status !== "ok" || !isJsonObject(event.result.value)) {
          continue;
        }
        if (event.type === "close" && event.coroutineId === "root.0") {
          if (change === "version") {
            event.result.value.version = 2;
          }
          if (change === "source") {
            event.result.value.source = "changed";
          }
          if (change === "extra") {
            event.result.value.extra = true;
          }
          if (change === "bad-result") {
            event.result.value.outcome = { status: "accepted", result: { output: "partial" } };
          }
        }
        if (
          change === "admission" &&
          event.type === "yield" &&
          event.description.type === "generated_xmd"
        ) {
          event.result.value.source = "changed";
        }
        if (
          event.type === "yield" &&
          event.description.type === "generated_xmd" &&
          isJsonObject(event.result.value.policy)
        ) {
          const allowed = event.result.value.policy.allowed;
          if (Array.isArray(allowed) && isJsonObject(allowed[0])) {
            if (change === "retained-form") {
              allowed[0].forms = ["paired"];
            }
            if (change === "retained-identity" && isJsonObject(allowed[0].identity)) {
              allowed[0].identity.revision = "changed";
            }
          }
        }
      }
      let failure: unknown;
      try {
        yield* runCapture(source, profile, undefined, new InMemoryStream(events));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EvaluationStaleError);
    }
    expect(files.performed).toEqual(["read x"]);
  });
});
