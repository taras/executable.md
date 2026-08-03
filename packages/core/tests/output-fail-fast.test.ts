/**
 * Tier OFF — `<Output>` is fail-fast (spec §6.9).
 *
 * A region shows an operator what a stage produced; it must not also let a
 * failed stage reach the step after it. What the region rendered before the
 * failure is preserved and emitted, the execution then fails, and nothing later
 * begins. Continuing past a failure is asked for explicitly, with
 * `<CaptureErrors>`.
 *
 * The evidence these tests accept for "did not run" is the journal: rendered
 * text says what was produced, and a step that never started produces none
 * either way.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { forEach } from "@effectionx/stream-helpers";
import { execute } from "../src/execute.ts";
import { expandSegments } from "../src/expand.ts";
import { Component } from "../src/component-api.ts";
import { captureErrors } from "../src/component-failures.ts";
import { registerComponents } from "../src/components/registration.ts";
import { AmbientErrorPolicy, DocumentationError } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type { FunctionComponent, FunctionComponentDefinition, Segment } from "../src/types.ts";

interface Run {
  /** Chunks in the order consumers received them. */
  chunks: string[];
  output: string;
  ok: boolean;
  error: unknown;
  events: DurableEvent[];
  stream: InMemoryStream;
}

/** The command each exec block ran, in order — what actually started. */
function commands(events: DurableEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "yield" && event.description.type === "exec"
      ? [String(event.description.name)]
      : [],
  );
}

/** An exec stub that fails the command named FAIL and echoes anything else. */
function* useStagedExec(): Operation<void> {
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec([options], _next) {
      const script = (options.command[2] ?? "").trim();
      if (script.includes("FAIL")) {
        return { exitCode: 1, stdout: "PREVIEW\n", stderr: "stage failed" };
      }
      return { exitCode: 0, stdout: `${script}\n`, stderr: "" };
    },
  });
}

function run(files: Record<string, string>, stream = new InMemoryStream()): Operation<Run> {
  return scoped(function* () {
    yield* useStubFs(files);
    yield* useStagedExec();

    const execution = yield* execute({ path: "doc.md", stream });
    const chunks: string[] = [];
    yield* forEach(function* (chunk: string) {
      chunks.push(chunk);
    }, execution.output);
    const result = yield* execution;

    return {
      chunks,
      output: chunks.join(""),
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      events: stream.snapshot(),
      stream,
    };
  });
}

/**
 * The same run, with function components registered rather than read from disk.
 * `execute()` installs its own terminal `importComponent`, so a registration is
 * how a test puts its own component in a document's reach.
 */
function runRegistered(
  files: Record<string, string>,
  components: Record<string, FunctionComponentDefinition>,
  stream = new InMemoryStream(),
): Operation<Run> {
  return scoped(function* () {
    yield* registerComponents(
      Object.entries(components).map(([name, definition]) => ({
        name,
        origin: "output-fail-fast.test",
        props: definition.props,
        fn: definition.fn,
      })),
    );
    return yield* run(files, stream);
  });
}

/** Every error an aggregate carries, at any depth, plus the aggregate itself. */
function aggregateMembers(error: unknown): unknown[] {
  const found: unknown[] = [];
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const next = pending.pop();
    found.push(next);
    if (next instanceof AggregateError) {
      pending.push(...next.errors);
    }
    if (next instanceof Error && next.cause !== undefined) {
      pending.push(next.cause);
    }
  }
  return found;
}

/** Expansion under a chosen policy, for the boundaries a document cannot reach. */
function expandUnder(
  policy: "collect" | "output" | "throw",
  source: string,
  components: Record<string, FunctionComponentDefinition>,
): Operation<Segment[]> {
  return scoped(function* () {
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          const found = components[name];
          if (!found) {
            throw new Error(`Component not found: ${name}`);
          }
          return found;
        },
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          return { output: "", exitCode: 0, stderr: "" };
        },
        env: () => ({ values: {} }),
      },
      { at: "min" },
    );
    yield* AmbientErrorPolicy.set(policy);
    return yield* expandSegments(scanSegments(source), {}, {}, new Set());
  });
}

const BROKEN: FunctionComponentDefinition = {
  kind: "function",
  name: "Broken",
  props: { type: "object", properties: {}, additionalProperties: false },
  // deno-lint-ignore require-yield
  fn: function* () {
    throw new Error("broken thing");
  },
};

const CAPTURING: FunctionComponentDefinition = {
  kind: "function",
  name: "Capturing",
  props: { type: "object", properties: {}, additionalProperties: false },
  // deno-lint-ignore require-yield
  fn: captureErrors(function* () {
    throw new Error("captured thing");
  }),
};

describe("Tier OFF — a failing <Output> keeps what it rendered", () => {
  // OFF1
  it("emits the partial selection, fails, and runs no later sibling", function* () {
    const result = yield* run({
      "doc.md": [
        "<Output>",
        "",
        "```bash exec",
        "echo BEFORE",
        "```",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "```bash exec",
        "echo LATER",
        "```",
        "",
        "</Output>",
      ].join("\n"),
    });

    expect(result.output).toContain("BEFORE");
    expect(result.ok).toBe(false);
    // The block after the failure never started.
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });

  // OFF2 — the same three assertions through a real invocation.
  it("keeps a component <Output> region's partial selection and fails the document", function* () {
    const result = yield* run({
      "components/Stage.md": [
        "<Output>",
        "",
        "```bash exec",
        "echo BEFORE",
        "```",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</Output>",
      ].join("\n"),
      "doc.md": "<Stage />\n\n```bash exec\necho LATER\n```\n",
    });

    expect(result.output).toContain("BEFORE");
    expect(result.ok).toBe(false);
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });

  // OFF3 — the integration pin with #307/#310: a command that printed before it
  // failed is a failure, its stdout stays visible, and nothing after it runs.
  it("keeps the stdout of a non-zero command and stops the document there", function* () {
    const result = yield* run({
      "doc.md": [
        "<Output>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "```bash exec",
        "echo LATER",
        "```",
        "",
        "</Output>",
      ].join("\n"),
    });

    expect(result.output).toContain("PREVIEW");
    expect(result.ok).toBe(false);
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });

  // OFF4
  it("preserves an earlier region and runs neither the documentation nor the region after it", function* () {
    const result = yield* run({
      "doc.md": [
        "<Output>",
        "",
        "```bash exec",
        "echo FIRST",
        "```",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</Output>",
        "",
        "```bash exec",
        "echo DOCUMENTATION",
        "```",
        "",
        "<Output>",
        "",
        "```bash exec",
        "echo SECOND",
        "```",
        "",
        "</Output>",
      ].join("\n"),
    });

    expect(result.output).toContain("FIRST");
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("SECOND");
    const started = commands(result.events);
    expect(started.some((name) => name.includes("DOCUMENTATION"))).toBe(false);
    expect(started.some((name) => name.includes("SECOND"))).toBe(false);
  });
});

describe("Tier OFF — <CaptureErrors> is how a region continues", () => {
  const CAPTURED_DOC = [
    "<Output>",
    "",
    "<CaptureErrors>",
    "<Broken />",
    "</CaptureErrors>",
    "",
    "MARKER",
    "",
    "</Output>",
  ].join("\n");

  // OFF5a
  it("renders the diagnostic once and lets the region continue", function* () {
    const expanded = yield* expandUnder(
      "output",
      "<CaptureErrors>\n<Broken />\n</CaptureErrors>\n\nMARKER",
      { Broken: BROKEN },
    );
    const output = renderSegments(expanded);

    expect(output.match(/broken thing/g) ?? []).toHaveLength(1);
    expect(output).toContain("MARKER");
  });

  // OFF5b — the discriminating mutation of the same fixture.
  it("fails and suppresses the marker without the capture boundary", function* () {
    let threw = false;
    try {
      yield* expandUnder("output", "<Broken />\n\nMARKER", { Broken: BROKEN });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // OFF5c — through a document, so the region and the root agree.
  it("completes a document whose region captured its failure", function* () {
    const result = yield* run({
      "components/Stage.md": CAPTURED_DOC,
      "doc.md": "<Stage />",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("MARKER");
  });

  // OFF5d — captureErrors(fn) is the same boundary.
  it("lets a captureErrors(fn) component continue inside a region", function* () {
    const expanded = yield* expandUnder("output", "<Capturing />\n\nMARKER", {
      Capturing: CAPTURING,
    });
    const output = renderSegments(expanded);

    expect(output.match(/captured thing/g) ?? []).toHaveLength(1);
    expect(output).toContain("MARKER");
  });

  // OFF5e — documentation is hidden, so a captured diagnostic has nothing to
  // render into and the execution still ends.
  it("keeps documentation fail-fast even for a captured failure", function* () {
    let threw = false;
    try {
      yield* expandUnder("throw", "<CaptureErrors>\n<Broken />\n</CaptureErrors>\n\nMARKER", {
        Broken: BROKEN,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // OFF5f — a root without <Output> keeps collecting.
  it("leaves a root without <Output> collecting", function* () {
    const result = yield* run({
      "doc.md": ["```bash exec", "FAIL", "```", "", "```bash exec", "echo LATER", "```"].join("\n"),
    });

    expect(result.output).toContain("Command failed");
    expect(result.output).toContain("LATER");
    expect(result.ok).toBe(true);
  });
});

describe("Tier OFF — the failed document is a determined outcome", () => {
  // OFF6 — the live completion carries the error the engine actually caught.
  it("reports the original failure object on a live run", function* () {
    const thrown = new Error("the component's own failure");
    const failing: FunctionComponentDefinition = {
      kind: "function",
      name: "Failing",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      fn: function* () {
        throw thrown;
      },
    };
    const result = yield* runRegistered(
      { "doc.md": "<Output>\n\n<Failing />\n\n</Output>" },
      { Failing: failing },
    );

    expect(result.ok).toBe(false);
    // The object itself, not a description of it. Identity is the whole claim:
    // a reconstruction built from the journal cannot contain the very error the
    // component threw.
    const carried = aggregateMembers(result.error);
    expect(carried).toContain(thrown);
    expect(String(result.error)).toContain("the component's own failure");
  });

  // OFF6c — the determined-outcome path, where the failure is a diagnostic the
  // region settled: its type survives to the completion as well as its message.
  it("reports a settled diagnostic as the documentation failure it is", function* () {
    const result = yield* run({
      "doc.md": "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>",
    });

    expect(result.ok).toBe(false);
    const carried = aggregateMembers(result.error);
    const documentation = carried.find((member) => member instanceof DocumentationError);
    if (!(documentation instanceof DocumentationError)) {
      throw new Error(`expected a DocumentationError, received ${String(result.error)}`);
    }
    expect(documentation.segment.message).toContain("Command failed");
    expect(documentation.segment.source).toContain("FAIL");
  });

  // OFF6b — a body failure and a teardown failure arrive together, and both
  // members survive to the completion.
  it("reports the aggregate a body and its teardown produced together", function* () {
    const fromBody = new Error("body failed");
    const fromTeardown = new Error("teardown failed");
    const failing: FunctionComponentDefinition = {
      kind: "function",
      name: "Failing",
      props: { type: "object", properties: {}, additionalProperties: false },
      fn: function* () {
        yield* ensure(function* () {
          throw fromTeardown;
        });
        throw fromBody;
      },
    };
    const result = yield* runRegistered(
      { "doc.md": "<Output>\n\n<Failing />\n\n</Output>" },
      { Failing: failing },
    );

    expect(result.ok).toBe(false);
    const members = aggregateMembers(result.error);
    expect(members).toContain(fromBody);
    expect(members).toContain(fromTeardown);
  });

  // OFF7 — the journal records the outcome, so a replay reproduces both halves
  // without re-entering the workflow.
  it("replays the same partial output and failure, running nothing again", function* () {
    const files = {
      "doc.md": [
        "<Output>",
        "",
        "```bash exec",
        "echo BEFORE",
        "```",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</Output>",
      ].join("\n"),
    };
    const stream = new InMemoryStream();

    const first = yield* run(files, stream);
    const commandsAfterFirst = commands(stream.snapshot()).length;
    const second = yield* run(files, stream);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(second.output).toBe(first.output);
    expect(second.output).toContain("BEFORE");
    expect(String(second.error)).toContain(String(first.error));
    // Replay ran no command again: the recorded outcome answered for the run.
    expect(commands(stream.snapshot())).toHaveLength(commandsAfterFirst);
  });

  // OFF8 — the root close is `ok` around a failed document; only durability and
  // infrastructure failures close `err`.
  it("closes the journal ok around the failed outcome", function* () {
    const result = yield* run({
      "doc.md": "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>",
    });

    const close = result.events.find((event) => event.type === "close");
    expect(close?.result.status).toBe("ok");
    expect(JSON.stringify(close?.result)).toContain('"status":"err"');
  });
});

/**
 * One case per visible producer. Each fixture renders a prefix, fails inside
 * the construct, and has a marker after it: the prefix survives, the diagnostic
 * that ended the run does not appear in what was rendered, and the marker never
 * runs. The success half asserts an exact count, so a producer that both writes
 * into the region and hands its segments back reddens here.
 */
describe("Tier OFF — every visible producer keeps its prefix", () => {
  const CASES: { name: string; failing: string; succeeding: string }[] = [
    {
      name: "the selected <If> branch",
      failing: "<If condition={true}>\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</If>\n\nMARKER",
      succeeding: "<If condition={true}>\n\nPREFIX\n\n</If>",
    },
    {
      name: "<Loop> iterations",
      failing: "<Loop max={2}>\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Loop>\n\nMARKER",
      succeeding: "<Loop max={1}>\n\nPREFIX\n\n</Loop>",
    },
    {
      name: "<Each> without as",
      failing: '<Each in={[1]} let="n">\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Each>\n\nMARKER',
      succeeding: '<Each in={[1]} let="n">\n\nPREFIX\n\n</Each>',
    },
    {
      name: "projected <Content />",
      failing: "<Wrapper>\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Wrapper>\n\nMARKER",
      succeeding: "<Wrapper>\n\nPREFIX\n\n</Wrapper>",
    },
    {
      name: "an answered <Answers> body",
      failing:
        "<Answers>\n<Answer value={{ ok: true }} />\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Answers>\n\nMARKER",
      succeeding: "<Answers>\n<Answer value={{ ok: true }} />\n\nPREFIX\n\n</Answers>",
    },
  ];

  const WRAPPER = "<Content />";

  for (const subject of CASES) {
    it(`keeps what ${subject.name} rendered before failing`, function* () {
      const result = yield* run({
        "components/Wrapper.md": WRAPPER,
        "doc.md": `<Output>\n\n${subject.failing}\n\n</Output>`,
      });

      expect(result.output).toContain("PREFIX");
      expect(result.ok).toBe(false);
      expect(result.output).not.toContain("MARKER");
      // The diagnostic that ended the run is the failure, not the output.
      expect(result.output).not.toContain("<!-- ERROR");
    });

    it(`renders ${subject.name} exactly once when it succeeds`, function* () {
      const result = yield* run({
        "components/Wrapper.md": WRAPPER,
        "doc.md": `<Output>\n\n${subject.succeeding}\n\n</Output>`,
      });

      expect(result.ok).toBe(true);
      expect(result.output.match(/PREFIX/g) ?? []).toHaveLength(1);
    });
  }
});

describe("Tier OFF — an atomic producer never merges its prefix", () => {
  const STAGE = ["<Output>", "", "PREFIX", "", "```bash exec", "FAIL", "```", "", "</Output>"].join(
    "\n",
  );

  it("keeps a <Capture as> prefix out of the document", function* () {
    const result = yield* run({
      "doc.md":
        '<Output>\n\n<Capture as="held">\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Capture>\n\n</Output>',
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });

  it("keeps an <Each as> prefix out of the document", function* () {
    const result = yield* run({
      "doc.md":
        '<Output>\n\n<Each in={[1]} let="n" as="held">\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Each>\n\n</Output>',
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });

  it("keeps a string projection's prefix out of the document", function* () {
    const result = yield* run({
      "components/Renderer.md": [
        "```ts eval",
        "const projected = yield* renderChildren();",
        "output(projected);",
        "```",
      ].join("\n"),
      "doc.md":
        "<Output>\n\n<Renderer>\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Renderer>\n\n</Output>",
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });

  it("keeps documentation out of the document", function* () {
    const result = yield* run({
      "components/Stage.md": [
        "PREFIX",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "<Output>ok</Output>",
      ].join("\n"),
      "doc.md": "<Output>\n\n<Stage />\n\n</Output>",
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });

  it("keeps a failing as= invocation's prefix out of the document", function* () {
    const result = yield* run({
      "components/Stage.md": STAGE,
      "doc.md": '<Output>\n\n<Stage as="held" />\n\n</Output>',
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });
});

/**
 * The journal is data, so a shape this run cannot read is refused rather than
 * coerced into one it can. Each case corrupts exactly one field of a recorded
 * failure and replays it: reporting a failure that quietly disagrees with the
 * one recorded would be worse than refusing to report at all.
 */
describe("Tier OFF — a malformed recorded failure is refused", () => {
  const DOC = "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>";

  /** Read and write a field without copying the object that holds it. */
  function field(holder: unknown, key: string): unknown {
    return Reflect.get(Object(holder), key);
  }

  function setField(holder: unknown, key: string, value: unknown): void {
    Reflect.set(Object(holder), key, value);
  }

  function dropField(holder: unknown, key: string): void {
    Reflect.deleteProperty(Object(holder), key);
  }

  /** The journal of a failed run, with its recorded failure rewritten. */
  function corrupted(edit: (failure: unknown) => void): Operation<DurableEvent[]> {
    return scoped(function* () {
      const stream = new InMemoryStream();
      yield* run({ "doc.md": DOC }, stream);
      const events = stream.snapshot();
      const close = events.find((event) => event.type === "close");
      if (close === undefined || close.result.status !== "ok") {
        throw new Error("the failed run recorded no ok close to corrupt");
      }
      edit(field(close.result.value, "error"));
      return events;
    });
  }

  function replayed(events: DurableEvent[]): Operation<Run> {
    return run({ "doc.md": DOC }, new InMemoryStream(events));
  }

  const CASES: { name: string; edit: (failure: unknown) => void }[] = [
    { name: "a name that is not text", edit: (failure) => setField(failure, "name", 7) },
    { name: "a missing message", edit: (failure) => dropField(failure, "message") },
    {
      name: "a segment source that is not text",
      edit: (failure) => setField(field(failure, "segment"), "source", 7),
    },
    {
      name: "a segment with no message",
      edit: (failure) => dropField(field(failure, "segment"), "message"),
    },
    { name: "a cause that is not text", edit: (failure) => setField(failure, "cause", { of: 1 }) },
    {
      name: "aggregate members that are not a list",
      edit: (failure) => setField(failure, "errors", "two"),
    },
    {
      name: "an aggregate member with no message",
      edit: (failure) => setField(failure, "errors", [{ name: "Error" }]),
    },
  ];

  for (const subject of CASES) {
    it(`refuses ${subject.name}`, function* () {
      const events = yield* corrupted(subject.edit);
      const result = yield* replayed(events);

      expect(result.ok).toBe(false);
      // Refused while reading the journal, not reported as the document's own
      // failure: the recorded diagnostic never reaches the completion.
      expect(String(result.error)).not.toContain("Command failed");
    });
  }

  it("replays an intact recorded failure", function* () {
    const events = yield* corrupted(() => {});
    const result = yield* replayed(events);

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Command failed");
  });
});

/**
 * What crosses the journal, and what does not. Object identity stays behind, so
 * a replayed run reports a reconstruction — these pin exactly which fields that
 * reconstruction is built from, and the presence rules that make an absent
 * cause different from a cause whose value was `undefined`.
 */
describe("Tier OFF — the recorded failure is exactly these fields", () => {
  function recordedFailure(events: DurableEvent[]): unknown {
    const close = events.find((event) => event.type === "close");
    if (close === undefined || close.result.status !== "ok") {
      throw new Error("the failed run recorded no ok close");
    }
    return Reflect.get(Object(close.result.value), "error");
  }

  const FAILING_DOC = "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>";

  /** A failed run's journal, with one field of its recorded failure rewritten. */
  function recorded(edit: (failure: unknown) => void): Operation<DurableEvent[]> {
    return scoped(function* () {
      const stream = new InMemoryStream();
      const result = yield* run({ "doc.md": FAILING_DOC }, stream);
      const events = result.events;
      const close = events.find((event) => event.type === "close");
      if (close === undefined || close.result.status !== "ok") {
        throw new Error("the failed run recorded no ok close");
      }
      edit(Reflect.get(Object(close.result.value), "error"));
      return events;
    });
  }

  it("records no cause and no members for a failure that had neither", function* () {
    const events = yield* recorded(() => {});
    const close = events.find((event) => event.type === "close");
    const failure = Reflect.get(
      Object(close?.result.status === "ok" ? close.result.value : {}),
      "error",
    );

    expect(Object.hasOwn(Object(failure), "name")).toBe(true);
    expect(Object.hasOwn(Object(failure), "message")).toBe(true);
    expect(Object.hasOwn(Object(failure), "segment")).toBe(true);
    // Absent, not a null standing in for absence.
    expect(Object.hasOwn(Object(failure), "cause")).toBe(false);
    expect(Object.hasOwn(Object(failure), "errors")).toBe(false);
  });

  it('reconstructs the cause "undefined" as a cause rather than as absence', function* () {
    // A failure may carry an own cause whose value is `undefined` — a component
    // can throw exactly that — and the record says so with the text rather than
    // by leaving the field out. The two must not collapse into each other.
    const events = yield* recorded((failure) => Reflect.set(Object(failure), "cause", "undefined"));
    const result = yield* run({ "doc.md": FAILING_DOC }, new InMemoryStream(events));

    expect(result.error).toBeInstanceOf(Error);
    if (!(result.error instanceof Error)) {
      throw new Error(`expected an Error, received ${String(result.error)}`);
    }
    expect(Object.hasOwn(result.error, "cause")).toBe(true);
    expect(result.error.cause).toBe("undefined");
  });

  it("reconstructs no cause at all when the record carries none", function* () {
    const events = yield* recorded(() => {});
    const result = yield* run({ "doc.md": FAILING_DOC }, new InMemoryStream(events));

    expect(result.error).toBeInstanceOf(Error);
    if (!(result.error instanceof Error)) {
      throw new Error(`expected an Error, received ${String(result.error)}`);
    }
    expect(Object.hasOwn(result.error, "cause")).toBe(false);
  });

  it("reconstructs an Error from the recorded fields on replay", function* () {
    const stream = new InMemoryStream();
    const first = yield* run(
      { "doc.md": "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>" },
      stream,
    );
    const second = yield* run(
      { "doc.md": "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>" },
      stream,
    );

    expect(second.ok).toBe(false);
    // Not the same object — identity does not cross the journal, and no test
    // may claim it does. What crosses is the recorded name and message.
    expect(second.error).not.toBe(first.error);
    expect(second.error).toBeInstanceOf(Error);
    if (!(second.error instanceof Error)) {
      throw new Error(`expected an Error, received ${String(second.error)}`);
    }
    const recorded = recordedFailure(second.events);
    expect(second.error.name).toBe(Reflect.get(Object(recorded), "name"));
    expect(second.error.message).toBe(Reflect.get(Object(recorded), "message"));
    expect(second.error).not.toBeInstanceOf(AggregateError);
  });

  it("reconstructs an AggregateError when the record carries members", function* () {
    const events = yield* recorded((failure) =>
      Reflect.set(Object(failure), "errors", [
        { name: "Error", message: "body failed" },
        { name: "TypeError", message: "teardown failed" },
      ]),
    );
    const result = yield* run({ "doc.md": FAILING_DOC }, new InMemoryStream(events));

    expect(result.error).toBeInstanceOf(AggregateError);
    if (!(result.error instanceof AggregateError)) {
      throw new Error(`expected an AggregateError, received ${String(result.error)}`);
    }
    expect(result.error.errors.map((member: Error) => member.message)).toEqual([
      "body failed",
      "teardown failed",
    ]);
    expect(result.error.errors.map((member: Error) => member.name)).toEqual(["Error", "TypeError"]);
  });
});
