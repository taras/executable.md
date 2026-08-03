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
import { scoped } from "effection";
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
import { AmbientErrorPolicy } from "../src/errors.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import type { FunctionComponentDefinition, Segment } from "../src/types.ts";

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
    const result = yield* run({
      "doc.md": "<Output>\n\n```bash exec\nFAIL\n```\n\n</Output>",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toContain("Command failed");
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

describe("Tier OFF — a capture is not output", () => {
  // OFF9 — an `as` invocation produces a binding, so what its body rendered
  // before failing is not promoted into the document.
  it("keeps a failing as= invocation's prefix out of the document", function* () {
    const result = yield* run({
      "components/Stage.md": [
        "<Output>",
        "",
        "```bash exec",
        "echo PREFIX",
        "```",
        "",
        "```bash exec",
        "FAIL",
        "```",
        "",
        "</Output>",
      ].join("\n"),
      "doc.md": '<Output>\n\n<Stage as="captured" />\n\n</Output>',
    });

    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("PREFIX");
  });
});
