/**
 * Tier PC — `<Parse>` and `<SafeParse>` (spec §6.12).
 *
 * The public success and safe-failure behavior is told by the colocated
 * documents beside the components. What is left here is what a document cannot
 * observe about itself: the order the schema and the content are handled in,
 * what a failure carries, what propagates through, and that a replay repeats
 * none of it.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import type { Json } from "../src/types.ts";

interface Run {
  /** Rendered output, or the failure message when the document aborted. */
  output: string;
  failed: boolean;
  /** Commands a child code block actually ran. */
  commands: string[];
}

/**
 * Run a one-document root, recording the commands its content executed.
 *
 * A document failure is captured rather than thrown: several cases are about
 * *what* the failure says, and about what did not happen before it.
 */
function run(source: string): Operation<Run> {
  return scoped(function* () {
    const commands: string[] = [];
    yield* API.Process.around({
      // deno-lint-ignore require-yield
      *exec([options], _next) {
        commands.push(options.command.join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    yield* useStubFs({ "doc.md": source });

    const stream = new InMemoryStream();
    const result = yield* execute({ path: "doc.md", stream });
    const outcome = yield* result;
    if (!outcome.ok) {
      return { output: outcome.error.message, failed: true, commands };
    }
    return { output: asText(outcome.value), failed: false, commands };
  });
}

function asText(value: Json): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const OBJECT_SCHEMA = '{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }';

describe("Tier PC — Parse and SafeParse", { sanitizeOps: false, sanitizeResources: false }, () => {
  beforeAll(() => useTempFileCompiler());

  it("PC1: schema is required", function* () {
    const { output } = yield* run(`<Parse as="value">1</Parse>`);
    expect(output).toContain("Parse");
    expect(output).toContain("schema");
  });

  it("PC2: a capture name is required", function* () {
    const { output } = yield* run(`<Parse schema={${OBJECT_SCHEMA}}>{ "a": "x" }</Parse>`);
    expect(output).toContain("must be invoked");
    expect(output).toContain('as="binding"');
  });

  it("PC3: schema text that is not JSON fails", function* () {
    const { output } = yield* run(`<Parse schema={"{ not json"} as="v">1</Parse>`);
    expect(output).toContain("schema text is not JSON");
  });

  it("PC4: a schema that is not a valid draft-07 schema fails", function* () {
    const { output } = yield* run(`<Parse schema={{ type: "nonsense" }} as="v">1</Parse>`);
    expect(output).toContain("not a valid draft-07 JSON Schema");
  });

  it("PC5: an asynchronous schema is rejected", function* () {
    const { output } = yield* run(
      `<Parse schema={{ $async: true, type: "object" }} as="v">{ }</Parse>`,
    );
    expect(output).toContain("asynchronous schema");
  });

  it("PC6: a schema that is not an object is rejected", function* () {
    const { output } = yield* run(`<Parse schema={true} as="v">1</Parse>`);
    expect(output).toContain("must be a JSON Schema object");
  });

  // The whole point of compiling first: an unusable schema must not let the
  // document do work whose result it would then refuse to judge.
  it("PC7: the schema compiles before any child effect runs", function* () {
    const source = [
      `<Parse schema={{ type: "nonsense" }} as="v">`,
      "",
      "```sh exec",
      "echo should-not-run",
      "```",
      "",
      "</Parse>",
    ].join("\n");
    const { output, commands } = yield* run(source);
    expect(output).toContain("not a valid draft-07 JSON Schema");
    expect(commands).toEqual([]);
  });

  it("PC8: SafeParse compiles before child effects too", function* () {
    const source = [
      `<SafeParse schema={{ $async: true }} as="v">`,
      "",
      "```sh exec",
      "echo should-not-run",
      "```",
      "",
      "</SafeParse>",
    ].join("\n");
    const { output, commands } = yield* run(source);
    expect(output).toContain("asynchronous schema");
    expect(commands).toEqual([]);
  });

  // SafeParse absorbs JSON syntax and instance validation, and nothing else.
  it("PC9: a child failure propagates through SafeParse unchanged", function* () {
    const { output } = yield* run(
      `<SafeParse schema={{ type: "object" }} as="result"><Missing /></SafeParse>`,
    );
    expect(output).toContain("Missing");
    expect(output).not.toContain('"ok"');
  });

  it("PC10: a Parse failure names the component and carries its issues", function* () {
    const { output } = yield* run(`<Parse schema={${OBJECT_SCHEMA}} as="v">{ "a": 1 }</Parse>\n`);
    expect(output).toContain("Parse");
    expect(output).toContain("content failed its schema");
    expect(output).toContain("must be string");
  });

  it("PC11: malformed JSON is reported as a parse failure", function* () {
    const { output } = yield* run(`<Parse schema={{ type: "object" }} as="v">nope</Parse>`);
    expect(output).toContain("content is not JSON");
  });

  it("PC12: neither component renders output", function* () {
    const source = [
      `<Parse schema={{ type: "number" }} as="n">1</Parse>`,
      `<SafeParse schema={{ type: "number" }} as="r">2</SafeParse>`,
      "done",
    ].join("\n\n");
    const { output, failed } = yield* run(source);
    expect(failed).toBe(false);
    expect(output.trim()).toBe("done");
  });

  it("PC13: an external reference fails with the documented limit", function* () {
    const { output } = yield* run(
      `<Parse schema={{ $ref: "https://example.com/s.json" }} as="v">1</Parse>`,
    );
    expect(output).toContain("could not resolve a schema reference");
    expect(output).toContain("#192");
  });

  // Parsing performs no effects and a built-in records no import, so a second
  // run over a completed journal must reproduce the result without appending.
  it("PC14: a replay reproduces the result and journals nothing new", function* () {
    const source = [
      `<Parse schema={${OBJECT_SCHEMA}} as="v">{ "a": "x" }</Parse>`,
      "",
      "value is {v.a}",
    ].join("\n");

    yield* useStubFs({ "doc.md": source });
    const stream = new InMemoryStream();

    const live = yield* collect(yield* execute({ path: "doc.md", stream }));
    const appended = stream.appendCount;

    const replay = yield* collect(yield* execute({ path: "doc.md", stream }));
    expect(replay).toEqual(live);
    expect(stream.appendCount).toBe(appended);
    expect(asText(live)).toContain("value is x");
  });
});
