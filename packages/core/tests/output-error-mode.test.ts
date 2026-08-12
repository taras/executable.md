/**
 * Tier OM — the `output` error mode (spec §6.9).
 *
 * A region shows an operator what a stage produced; it must not also let a
 * failed stage reach the step after it. An undecided error in an `<Output>`
 * region fails the run, what the region rendered before the failure is
 * preserved and emitted, and nothing later begins. Printing instead is asked
 * for explicitly, with `<PrintErrors>`.
 *
 * The evidence these tests accept for "did not run" is the journal: rendered
 * text says what was produced, and a step that never started produces none
 * either way.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Stdio } from "@effectionx/process";
import type { DurableEvent } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { forEach } from "@effectionx/stream-helpers";
import { execute } from "../src/execute.ts";
import { expandSegments } from "../src/expand.ts";
import { Component, content } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { registerComponents } from "../src/components/registration.ts";
import { DocumentationError, ErrorMode } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type { FunctionComponentDefinition, Segment } from "../src/types.ts";

interface Run {
  /** Chunks in the order consumers received them. */
  chunks: string[];
  output: string;
  /** What a foreground command displayed while the run went on (#441). */
  displayed: string;
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
    *exec([options], _next) {
      const script = (options.command[2] ?? "").trim();
      const failing = script.includes("FAIL");
      const text = failing ? "PREVIEW\n" : `${script}\n`;
      yield* Stdio.operations.stdout(new TextEncoder().encode(text));
      if (options.retain === false) {
        return { exitCode: failing ? 1 : 0, stdout: undefined, stderr: undefined };
      }
      return {
        exitCode: failing ? 1 : 0,
        stdout: text,
        stderr: failing ? "stage failed" : "",
      };
    },
  });
}

function run(files: Record<string, string>, stream = new InMemoryStream()): Operation<Run> {
  return scoped(function* () {
    let displayed = "";
    const decoder = new TextDecoder();
    yield* Stdio.around({
      *stdout([bytes]) {
        displayed += decoder.decode(bytes);
      },
      *stderr([bytes]) {
        displayed += decoder.decode(bytes);
      },
    });
    yield* useStubFs(files);
    yield* useStagedExec();
    // `<File>` reaches `API.Files`, which has no host default.
    yield* useHostFiles();

    const execution = yield* execute({ path: "doc.md", stream });
    const chunks: string[] = [];
    yield* forEach(function* (chunk: string) {
      chunks.push(chunk);
    }, execution.output);
    const result = yield* execution;

    return {
      chunks,
      output: chunks.join(""),
      displayed,
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
        origin: "output-error-mode.test",
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

/** Expansion under a chosen error mode, for the boundaries a document cannot reach. */
function expandUnder(
  mode: "print" | "output" | "throw",
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
    yield* ErrorMode.set(mode);
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

/**
 * A printing component that asks for its content and does not recover from a
 * content failure — the shape `<Parse>`, `<Glob>` and `<SafeParse>` have, and
 * the one where the failure that left a nested region reaches the boundary
 * itself rather than a failure the component built from it.
 */
const RELAYING: FunctionComponentDefinition = {
  kind: "function",
  name: "Relaying",
  props: { type: "object", properties: {}, additionalProperties: false },
  fn: printErrors(function* () {
    return yield* content();
  }),
};

const PRINTING: FunctionComponentDefinition = {
  kind: "function",
  name: "Printing",
  props: { type: "object", properties: {}, additionalProperties: false },
  // deno-lint-ignore require-yield
  fn: printErrors(function* () {
    throw new Error("printed thing");
  }),
};

describe("Tier OM — a failing <Output> keeps what it rendered", () => {
  it("OM1: emits the partial selection, fails, and runs no later sibling", function* () {
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

    expect(result.displayed).toContain("BEFORE");
    expect(result.ok).toBe(false);
    // The block after the failure never started.
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });

  it("OM2: keeps a component region's partial selection and fails the document", function* () {
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

    expect(result.displayed).toContain("BEFORE");
    expect(result.ok).toBe(false);
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });

  // The integration pin with #307/#310: a command that printed before it failed
  // is a failure, its stdout stays visible, and nothing after it runs.
  it("OM3: keeps the stdout of a non-zero command and stops the document there", function* () {
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

    expect(result.displayed).toContain("PREVIEW");
    expect(result.ok).toBe(false);
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });

  it("OM4: preserves an earlier region and runs neither the documentation nor the region after it", function* () {
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

    expect(result.displayed).toContain("FIRST");
    expect(result.ok).toBe(false);
    expect(result.displayed).not.toContain("SECOND");
    const started = commands(result.events);
    expect(started.some((name) => name.includes("DOCUMENTATION"))).toBe(false);
    expect(started.some((name) => name.includes("SECOND"))).toBe(false);
  });
});

describe("Tier OM — <PrintErrors> is how a region prints instead", () => {
  it("OM5a: prints the error once and lets the region continue", function* () {
    const expanded = yield* expandUnder(
      "output",
      "<PrintErrors>\n<Broken />\n</PrintErrors>\n\nMARKER",
      { Broken: BROKEN },
    );
    const output = renderSegments(expanded);

    expect(output.match(/broken thing/g) ?? []).toHaveLength(1);
    expect(output).toContain("MARKER");
  });

  // The discriminating mutation of the same fixture.
  it("OM5b: fails and suppresses the marker without the printing boundary", function* () {
    let threw = false;
    try {
      yield* expandUnder("output", "<Broken />\n\nMARKER", { Broken: BROKEN });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("OM5c: completes a document whose region printed its failure", function* () {
    const result = yield* run({
      "components/Stage.md": [
        "<Output>",
        "",
        "<PrintErrors>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</PrintErrors>",
        "",
        "MARKER",
        "",
        "</Output>",
      ].join("\n"),
      "doc.md": "<Stage />",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("MARKER");
  });

  it("OM5d: lets a printErrors(fn) component continue inside a region", function* () {
    const expanded = yield* expandUnder("output", "<Printing />\n\nMARKER", {
      Printing: PRINTING,
    });
    const output = renderSegments(expanded);

    expect(output.match(/printed thing/g) ?? []).toHaveLength(1);
    expect(output).toContain("MARKER");
  });

  // Documentation is hidden, so a printed error there is one nobody can read
  // and the execution still ends.
  it("OM5e: does not override `throw`", function* () {
    let threw = false;
    try {
      yield* expandUnder("throw", "<PrintErrors>\n<Broken />\n</PrintErrors>\n\nMARKER", {
        Broken: BROKEN,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // A printing root used to render this failure and run the next block. A
  // foreground command's nonzero exit is checked now: printing may decide how
  // it is reported, never that the run succeeded (#441).
  /**
   * Recovery authority comes from an element the document was written with, and
   * travels to the region's own expansion as an argument. Effection resolves a
   * context by name, so a separately created context with the same name is the
   * same binding: an enclosing caller could otherwise set one and turn a run
   * that failed into a run that succeeded, without the document containing the
   * construct that authorizes it. The name is written out rather than imported,
   * which is what makes this an attack instead of a demonstration.
   */
  it("OM5g: a counterfeit printsCheckedFailures context cannot keep the run", function* () {
    const Counterfeit = createContext<boolean>("component.printsCheckedFailures", false);

    const result = yield* scoped(function* () {
      yield* Counterfeit.set(true);
      // It really is set for everything the run does.
      expect(yield* Counterfeit.get()).toBe(true);
      return yield* run({
        "doc.md": [
          "```bash exec",
          "FAIL",
          "```",
          "",
          "MARKER",
          "",
          "```bash exec",
          "echo LATER",
          "```",
        ].join("\n"),
      });
    });

    // The document contains no error-handling construct, so it fails.
    expect(result.ok).toBe(false);
    expect(String((result.error as Error).message)).toContain("Command failed");
    // Nothing after the failure ran or rendered.
    expect(result.output).not.toContain("MARKER");
    expect(result.displayed).not.toContain("LATER");
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
    // And no counterfeit value reached the outcome.
    expect(JSON.stringify(result.events)).not.toContain("printsCheckedFailures");
  });

  /**
   * The positive control for OM5g: the same failing command, the same later
   * work, and a real `<PrintErrors>` element around it.
   */
  it("OM5h: a real <PrintErrors> region prints the checked failure and continues", function* () {
    const result = yield* run({
      "doc.md": [
        "<PrintErrors>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</PrintErrors>",
        "",
        "MARKER",
        "",
        "```bash exec",
        "echo LATER",
        "```",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    // Printed where the document asked for it, and the run went on.
    expect(result.output).toContain("Command failed");
    expect(result.output).toContain("MARKER");
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(true);
  });

  /**
   * The region's authority follows the work the region causes, not the
   * segments literally between its tags. An iteration is that work: the
   * document wrote the block inside the region, and `<Each>` is how the region
   * runs it.
   */
  it("OM5i: covers a checked failure inside an <Each> in the region", function* () {
    const result = yield* run({
      "doc.md": [
        "<PrintErrors>",
        "",
        '<Each in={[1]} let="n">',
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</Each>",
        "",
        "</PrintErrors>",
        "",
        "MARKER",
        "",
        "```bash exec",
        "echo LATER",
        "```",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Command failed");
    expect(result.output).toContain("MARKER");
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(true);
  });

  /**
   * Content the caller wrote inside the region and projected through a
   * component is the region's own text: it was written there, and the
   * invocation is only how it is placed.
   */
  it("OM5j: covers caller content projected through a component in the region", function* () {
    const result = yield* run({
      "components/Frame.md": "<Content />\n",
      "doc.md": [
        "<PrintErrors>",
        "",
        "<Frame>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</Frame>",
        "",
        "</PrintErrors>",
        "",
        "MARKER",
        "",
        "```bash exec",
        "echo LATER",
        "```",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Command failed");
    expect(result.output).toContain("MARKER");
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(true);
  });

  /**
   * The other edge of the same boundary: authority ends with the region. A
   * failing command written after `</PrintErrors>` is an ordinary checked
   * failure, and the region before it changes nothing about that.
   */
  it("OM5k: does not cover a checked failure after the region closes", function* () {
    const result = yield* run({
      "doc.md": [
        "<PrintErrors>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</PrintErrors>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "MARKER",
        "",
        "```bash exec",
        "echo LATER",
        "```",
      ].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(String((result.error as Error).message)).toContain("Command failed");
    expect(result.output).not.toContain("MARKER");
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });

  it("OM5f: a checked command failure fails a root without <Output>", function* () {
    const result = yield* run({
      "doc.md": ["```bash exec", "FAIL", "```", "", "```bash exec", "echo LATER", "```"].join("\n"),
    });

    expect(result.ok).toBe(false);
    expect(String((result.error as Error).message)).toContain("Command failed");
    expect(result.displayed).not.toContain("LATER");
    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
  });
});

describe("Tier OM — the failed document is a determined outcome", () => {
  it("OM6: reports the original failure object on a live run", function* () {
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

  it("OM6b: reports a settled printed error as the documentation failure it is", function* () {
    const result = yield* run({
      "doc.md": "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>",
    });

    expect(result.ok).toBe(false);
    const carried = aggregateMembers(result.error);
    const documentation = carried.find((member) => member instanceof DocumentationError);
    if (!(documentation instanceof DocumentationError)) {
      throw new Error(`expected a DocumentationError, received ${String(result.error)}`);
    }
    expect(documentation.mode).toBe("output");
    expect(documentation.segment.message).toContain("Command failed");
    expect(documentation.segment.source).toContain("FAIL");
  });

  it("OM6c: reports the aggregate a body and its teardown produced together", function* () {
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

  it("OM7: replays the same partial output and failure, running nothing again", function* () {
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
    // The command's own text went to the reader on the first run and is not
    // part of the document either time (#441).
    expect(second.output).not.toContain("BEFORE");
    expect(String(second.error)).toContain(String(first.error));
    // Replay ran no command again: the recorded outcome answered for the run.
    expect(commands(stream.snapshot())).toHaveLength(commandsAfterFirst);
  });

  /**
   * The other half of OM7: an outcome the document explicitly recovered replays
   * as recovered, from the record and without the command. Both outcomes are
   * determined on the first run, and replay reproduces the one that was
   * determined rather than deciding again.
   */
  it("OM7b: replays an explicitly recovered outcome without running the command", function* () {
    const files = {
      "doc.md": [
        "<PrintErrors>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</PrintErrors>",
        "",
        "MARKER",
      ].join("\n"),
    };
    const stream = new InMemoryStream();

    const first = yield* run(files, stream);
    const commandsAfterFirst = commands(stream.snapshot()).length;
    const second = yield* run(files, stream);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.output).toBe(first.output);
    expect(second.output).toContain("Command failed");
    expect(second.output).toContain("MARKER");
    // The recorded outcome answered for the run; nothing started again.
    expect(commands(stream.snapshot())).toHaveLength(commandsAfterFirst);
  });

  it("OM8: closes the journal ok around the failed outcome", function* () {
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
 * the construct, and has a marker after it: the prefix survives, the printed
 * error that ended the run does not appear in what was rendered, and the marker
 * never runs. The success half asserts an exact count, so a producer that both
 * writes into the region and hands its segments back reddens here.
 */
describe("Tier OM — every visible producer keeps its prefix", () => {
  const CASES: { key: string; name: string; failing: string; succeeding: string }[] = [
    {
      key: "a",
      name: "the selected <If> branch",
      failing: "<If condition={true}>\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</If>\n\nMARKER",
      succeeding: "<If condition={true}>\n\nPREFIX\n\n</If>",
    },
    {
      key: "b",
      name: "<Loop> iterations",
      failing: "<Loop max={2}>\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Loop>\n\nMARKER",
      succeeding: "<Loop max={1}>\n\nPREFIX\n\n</Loop>",
    },
    {
      key: "c",
      name: "<Each> without as",
      failing: '<Each in={[1]} let="n">\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Each>\n\nMARKER',
      succeeding: '<Each in={[1]} let="n">\n\nPREFIX\n\n</Each>',
    },
    {
      key: "d",
      name: "projected <Content />",
      failing: "<Wrapper>\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Wrapper>\n\nMARKER",
      succeeding: "<Wrapper>\n\nPREFIX\n\n</Wrapper>",
    },
    {
      key: "e",
      name: "an answered <Answers> body",
      failing:
        "<Answers>\n<Answer value={{ ok: true }} />\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Answers>\n\nMARKER",
      succeeding: "<Answers>\n<Answer value={{ ok: true }} />\n\nPREFIX\n\n</Answers>",
    },
  ];

  const WRAPPER = "<Content />";

  for (const subject of CASES) {
    it(`OM9 ${subject.key}: keeps what ${subject.name} rendered before failing`, function* () {
      const result = yield* run({
        "components/Wrapper.md": WRAPPER,
        "doc.md": `<Output>\n\n${subject.failing}\n\n</Output>`,
      });

      expect(result.output).toContain("PREFIX");
      expect(result.ok).toBe(false);
      expect(result.output).not.toContain("MARKER");
      // The error that ended the run is the failure, not the output.
      expect(result.output).not.toContain("<!-- ERROR");
    });

    it(`OM10 ${subject.key}: renders ${subject.name} exactly once when it succeeds`, function* () {
      const result = yield* run({
        "components/Wrapper.md": WRAPPER,
        "doc.md": `<Output>\n\n${subject.succeeding}\n\n</Output>`,
      });

      expect(result.ok).toBe(true);
      expect(result.output.match(/PREFIX/g) ?? []).toHaveLength(1);
    });
  }
});

describe("Tier OM — work the document was not going to render never reaches the output", () => {
  const STAGE = ["<Output>", "", "PREFIX", "", "```bash exec", "FAIL", "```", "", "</Output>"].join(
    "\n",
  );

  it("OM11a: keeps a <Capture as> prefix out of the document", function* () {
    const result = yield* run({
      "doc.md":
        '<Output>\n\n<Capture as="held">\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Capture>\n\n</Output>',
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });

  it("OM11b: keeps an <Each as> prefix out of the document", function* () {
    const result = yield* run({
      "doc.md":
        '<Output>\n\n<Each in={[1]} let="n" as="held">\n\nPREFIX\n\n```bash exec\nFAIL\n```\n\n</Each>\n\n</Output>',
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });

  it("OM11c: keeps a string projection's prefix out of the document", function* () {
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

  it("OM11d: keeps documentation out of the document", function* () {
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

  it("OM11e: keeps a failing as= invocation's prefix out of the document", function* () {
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
describe("Tier OM — a malformed recorded failure is refused", () => {
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

  const CASES: { key: string; name: string; edit: (failure: unknown) => void }[] = [
    { key: "a", name: "a name that is not text", edit: (failure) => setField(failure, "name", 7) },
    { key: "b", name: "a missing message", edit: (failure) => dropField(failure, "message") },
    {
      key: "c",
      name: "a segment source that is not text",
      edit: (failure) => setField(field(failure, "segment"), "source", 7),
    },
    {
      key: "d",
      name: "a segment with no message",
      edit: (failure) => dropField(field(failure, "segment"), "message"),
    },
    {
      key: "e",
      name: "a cause that is not text",
      edit: (failure) => setField(failure, "cause", { of: 1 }),
    },
    {
      key: "f",
      name: "aggregate members that are not a list",
      edit: (failure) => setField(failure, "errors", "two"),
    },
    {
      key: "g",
      name: "an aggregate member with no message",
      edit: (failure) => setField(failure, "errors", [{ name: "Error" }]),
    },
  ];

  for (const subject of CASES) {
    it(`OM12 ${subject.key}: refuses ${subject.name}`, function* () {
      const events = yield* corrupted(subject.edit);
      const result = yield* replayed(events);

      expect(result.ok).toBe(false);
      // Refused while reading the journal, not reported as the document's own
      // failure: the recorded error never reaches the completion.
      expect(String(result.error)).not.toContain("Command failed");
    });
  }

  it("OM12h: names the situation rather than the field it tripped over", function* () {
    const events = yield* corrupted((failure) => dropField(failure, "message"));
    const result = yield* replayed(events);

    expect(String(result.error)).toContain("A failure description carries a name and a message.");
  });

  it("OM12i: refuses a record written before the outcome contract", function* () {
    const events = yield* corrupted(() => {});
    const close = events.find((event) => event.type === "close");
    if (close === undefined || close.result.status !== "ok") {
      throw new Error("the failed run recorded no ok close");
    }
    dropField(close.result.value, "status");
    const result = yield* replayed(events);

    expect(String(result.error)).toContain("records its outcome");
    expect(String(result.error)).toContain("#318");
  });

  it("OM12j: replays an intact recorded failure", function* () {
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
describe("Tier OM — the recorded failure is exactly these fields", () => {
  const FAILING_DOC = "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>";

  function recordedFailure(events: DurableEvent[]): unknown {
    const close = events.find((event) => event.type === "close");
    if (close === undefined || close.result.status !== "ok") {
      throw new Error("the failed run recorded no ok close");
    }
    return Reflect.get(Object(close.result.value), "error");
  }

  /** A failed run's journal, with one field of its recorded failure rewritten. */
  function recorded(edit: (failure: unknown) => void): Operation<DurableEvent[]> {
    return scoped(function* () {
      const stream = new InMemoryStream();
      const result = yield* run({ "doc.md": FAILING_DOC }, stream);
      edit(recordedFailure(result.events));
      return result.events;
    });
  }

  it("OM13a: records no cause and no members for a failure that had neither", function* () {
    const events = yield* recorded(() => {});
    const failure = Object(recordedFailure(events));

    expect(Object.hasOwn(failure, "name")).toBe(true);
    expect(Object.hasOwn(failure, "message")).toBe(true);
    expect(Object.hasOwn(failure, "segment")).toBe(true);
    // Absent, not a null standing in for absence.
    expect(Object.hasOwn(failure, "cause")).toBe(false);
    expect(Object.hasOwn(failure, "errors")).toBe(false);
  });

  it("OM13b: reconstructs no cause at all when the record carries none", function* () {
    const events = yield* recorded(() => {});
    const result = yield* run({ "doc.md": FAILING_DOC }, new InMemoryStream(events));

    if (!(result.error instanceof Error)) {
      throw new Error(`expected an Error, received ${String(result.error)}`);
    }
    expect(Object.hasOwn(result.error, "cause")).toBe(false);
  });

  it('OM13c: reconstructs the cause "undefined" as a cause rather than as absence', function* () {
    // A failure may carry an own cause whose value is `undefined` — a component
    // can throw exactly that — and the record says so with the text rather than
    // by leaving the field out. The two must not collapse into each other.
    const events = yield* recorded((failure) => Reflect.set(Object(failure), "cause", "undefined"));
    const result = yield* run({ "doc.md": FAILING_DOC }, new InMemoryStream(events));

    if (!(result.error instanceof Error)) {
      throw new Error(`expected an Error, received ${String(result.error)}`);
    }
    expect(Object.hasOwn(result.error, "cause")).toBe(true);
    expect(result.error.cause).toBe("undefined");
  });

  it("OM13d: reconstructs an Error from the recorded fields on replay", function* () {
    const stream = new InMemoryStream();
    const first = yield* run({ "doc.md": FAILING_DOC }, stream);
    const second = yield* run({ "doc.md": FAILING_DOC }, stream);

    expect(second.ok).toBe(false);
    // Not the same object — identity does not cross the journal, and no test
    // may claim it does. What crosses is the recorded name and message.
    expect(second.error).not.toBe(first.error);
    if (!(second.error instanceof Error)) {
      throw new Error(`expected an Error, received ${String(second.error)}`);
    }
    const recordedFields = Object(recordedFailure(second.events));
    expect(second.error.name).toBe(recordedFields["name"]);
    expect(second.error.message).toBe(recordedFields["message"]);
    expect(second.error).not.toBeInstanceOf(AggregateError);
  });

  it("OM13e: reconstructs an AggregateError when the record carries members", function* () {
    const events = yield* recorded((failure) =>
      Reflect.set(Object(failure), "errors", [
        { name: "Error", message: "body failed" },
        { name: "TypeError", message: "teardown failed" },
      ]),
    );
    const result = yield* run({ "doc.md": FAILING_DOC }, new InMemoryStream(events));

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

/**
 * Transitivity. A printing boundary is a decision about the region it names, not
 * about decisions a callee made for itself. A component's own `<Output>` region
 * stops at its failure however it was invoked — otherwise a caller resumes work
 * that region's author gated behind it, invisibly, and every built-in that
 * prints its own failures (`<File>`, `<Parse>`, `<SafeParse>`, `<Glob>`,
 * `<TempDir>`) would do it just by wrapping the invocation.
 */
describe("Tier OM — a printing boundary does not resume a callee's own region", () => {
  const STAGE = [
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
  ].join("\n");

  it("OM14: stops a nested region wrapped in <PrintErrors>", function* () {
    const result = yield* run({
      "components/Stage.md": STAGE,
      "doc.md": "<PrintErrors>\n<Stage />\n\nMARKER\n</PrintErrors>",
    });

    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
    // The region's decision reaches the caller too: a failure a region already
    // decided is not something a wrapper undoes, so the execution ends rather
    // than resuming past somebody else's stop.
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("MARKER");
    // What the region rendered first is still preserved.
    expect(result.displayed).toContain("BEFORE");
  });

  // The same, where the boundary is a built-in that prints its own failures
  // rather than an explicit request from the author.
  it("OM15: stops a nested region wrapped in <File>", function* () {
    const result = yield* run({
      "components/Stage.md": STAGE,
      "doc.md": '<File path="out.txt">\n<Stage />\n</File>\n\nMARKER',
    });

    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
    // `<File>` prints the failure that left the region — it does not resume the
    // region, and it never writes a file built from content that failed.
    expect(result.output).toContain("<!-- ERROR");
    expect(result.output).toContain("MARKER");
  });

  // The same failure through a printing component that does not recover from a
  // content failure of its own: the region's failure is what gets printed.
  it("OM15b: prints the region's own failure at a printing component that does not recover", function* () {
    const result = yield* runRegistered(
      {
        "components/Stage.md": STAGE,
        "doc.md": "<Relaying>\n<Stage />\n</Relaying>\n\nMARKER",
      },
      { Relaying: RELAYING },
    );

    expect(commands(result.events).some((name) => name.includes("LATER"))).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("<!-- ERROR");
    expect(result.output).toContain("MARKER");
  });

  it("OM16: still prints what is raised under its own error mode", function* () {
    const result = yield* run({
      "components/Stage.md": "```bash exec\nFAIL\n```\n",
      "doc.md": "<Output>\n\n<PrintErrors>\n<Stage />\n</PrintErrors>\n\nMARKER\n\n</Output>",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("MARKER");
  });
});

describe("Tier OM — the partial output reaches the stream, not only the close", () => {
  // A consumer reading chunks is the case the preservation exists for.
  it("OM17: streams the failing region's output after an earlier segment streamed", function* () {
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
      "doc.md": "intro paragraph\n\n<Stage />",
    });

    expect(result.ok).toBe(false);
    // The chunk stream, not just the close value: a CLI writing stdout as it
    // arrives must see what the region produced before it failed.
    const prefix = result.chunks.slice(0, result.chunks.length - 1).join("");
    expect(result.chunks.join("")).toContain("intro paragraph");
    expect(result.displayed).toContain("BEFORE");
    // More than one chunk: the intro went out before the region ran at all.
    expect(prefix).toContain("intro paragraph");
  });
});

/**
 * A printed error is data in both directions. A child decides its own errors,
 * where they are raised; a consumer reads what the child produced and decides
 * nothing again.
 */
describe("Tier OM — a printed error crosses an invocation as data", () => {
  it("OM18: a child's printed error does not fail a parent's documentation", function* () {
    const result = yield* run({
      "components/Child.md": [
        "<Output>",
        "",
        "<PrintErrors>",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</PrintErrors>",
        "",
        "</Output>",
      ].join("\n"),
      "components/Parent.md": "<Child />\n\n<Output>\n\nTAIL\n\n</Output>",
      "doc.md": "<Parent />",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("TAIL");
  });

  it("OM19: an uncaptured failure in the same position still propagates", function* () {
    const result = yield* run({
      "components/Child.md": "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>",
      "components/Parent.md": "<Child />\n\n<Output>\n\nTAIL\n\n</Output>",
      "doc.md": "<Parent />",
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("TAIL");
  });
});
