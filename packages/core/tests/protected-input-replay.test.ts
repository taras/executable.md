import { parseInputRecord } from "../src/secrets/input-record.ts";
import { parseJsonObject } from "../src/json.ts";
import { ELICITATION_SCHEMA_FIELD } from "../src/elicit-journal.ts";
import { SOURCE_POSITION_FIELD } from "../src/source-position.ts";
import { useProtectedInputObserver, protectedInputCommand } from "./support/protected-input.ts";
import { until } from "effection";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, withResolvers } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { Elicitation } from "../src/elicitation-api.ts";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { registerComponents } from "../src/components/registration.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { useNormalizedOutput } from "../src/output/normalize.ts";

const schema = {
  type: "object",
  properties: { code: { type: "string", writeOnly: true }, public: { type: "string" } },
  required: ["code", "public"],
  additionalProperties: false,
};
const source = [
  "```ts eval",
  `const schema = ${JSON.stringify(schema)};`,
  "```",
  '<Elicit schema={schema} as="answer">Enter code.</Elicit>',
  "```ts eval",
  "const alias = answer.code; const copied = { codes: [alias] }; const selected = copied.codes[0];",
  "```",
  "```bash exec",
  "printf A",
  "```",
  "<Hold />",
  "```bash exec",
  "printf '%s' '{selected}'",
  "```",
  "<Json value={answer} />",
].join("\n\n");

describe("protected input continuation", () => {
  it("continues a genuinely unfinished stream with fresh fields and no repeated completed command or eval", function* () {
    yield* useTempFileCompiler();
    yield* useNormalizedOutput();
    const observer = yield* useProtectedInputObserver();
    const held = withResolvers<void>();
    let first = true;
    let asks = 0;
    let a = 0;
    let b = 0;
    let compiled = 0;
    let freshReceived = false;
    const answers: string[] = [];
    const requests: string[] = [];
    yield* registerComponents([
      {
        name: "Hold",
        origin: "protected-test",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          if (first) {
            held.resolve();
            yield* suspend();
          }
          return "";
        },
      },
    ]);
    yield* Elicitation.around(
      {
        *elicit([request]) {
          asks++;
          requests.push(request.message);
          let value = String(Math.floor(100000 + Math.random() * 900000));
          while (answers.includes(value)) {
            value = String(Math.floor(100000 + Math.random() * 900000));
          }
          answers.push(value);
          const posted = yield* until(
            fetch(observer.url + "/answer", { method: "POST", body: value }),
          );
          yield* until(posted.text());
          return asks === 1 ? { code: value, public: "fixed" } : { code: value };
        },
      },
      { at: "min" },
    );
    yield* API.Env.around({
      *compile([code, options], next) {
        if (code.includes("const copied")) {
          compiled++;
        }
        return yield* next(code, options);
      },
    });
    yield* API.Process.around({
      *exec([options], next) {
        if (options.command[2]?.trim() === "printf A") {
          a++;
        } else {
          b++;
          freshReceived = options.command.join(" ").includes(answers[answers.length - 1]);
        }
        return yield* next(options);
      },
    });
    yield* useStubFs({
      "doc.md": source.replace(
        "printf '%s' '{selected}'",
        protectedInputCommand("selected", observer.url),
      ),
    });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        yield* collect(yield* execute({ path: "doc.md", stream }));
      });
      yield* held.operation;
      expect(a).toBe(1);
      yield* task.halt();
    });
    expect(
      stream.snapshot().some((event) => event.type === "close" && event.coroutineId === "root"),
    ).toBe(false);
    first = false;
    const output = yield* collect(yield* execute({ path: "doc.md", stream }));
    expect(asks).toBe(2);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(compiled).toBe(1);
    expect(freshReceived).toBe(true);
    expect(observer.commands).toBe(1);
    expect(observer.latestExact).toBe(true);
    expect(requests[1].includes("fixed")).toBe(true);
    const published = String(output) + JSON.stringify(stream.snapshot());
    expect(answers.some((answer) => published.includes(answer))).toBe(false);
    const count = stream.appendCount;
    yield* collect(yield* execute({ path: "doc.md", stream }));
    expect(asks).toBe(2);
    expect(b).toBe(1);
    expect(stream.appendCount).toBe(count);
  });
});

describe("equal inputs retain distinct occurrence identities", () => {
  it("restores two questions to their distinct fresh answers rather than matching their old bytes", function* () {
    yield* useTempFileCompiler();
    yield* useNormalizedOutput();
    const observer = yield* useProtectedInputObserver();
    const held = withResolvers<void>();
    let first = true;
    let initial = "";
    let asks = 0;
    const fresh: string[] = [];
    yield* registerComponents([
      {
        name: "Hold",
        origin: "protected-test",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          if (first) {
            held.resolve();
            yield* suspend();
          }
          return "";
        },
      },
    ]);
    yield* Elicitation.around({
      *elicit() {
        asks++;
        if (initial === "") {
          initial = String(Math.floor(100000 + Math.random() * 900000));
        }
        let value = initial;
        if (!first) {
          do {
            value = String(Math.floor(100000 + Math.random() * 900000));
          } while (value === initial || fresh.includes(value));
          fresh.push(value);
        }
        const sent = yield* until(fetch(observer.url + "/answer", { method: "POST", body: value }));
        yield* until(sent.text());
        return { code: value };
      },
    });
    const declaration =
      '{type:"object",properties:{code:{type:"string",writeOnly:true}},required:["code"],additionalProperties:false}';
    const document = [
      `<Elicit schema={${declaration}} as="first">First</Elicit>`,
      `<Elicit schema={${declaration}} as="second">Second</Elicit>`,
      "```ts eval",
      "const aliases = [first.code, second.code]; const left = aliases[0]; const right = aliases[1];",
      "```",
      "<Hold />",
      "```bash exec",
      protectedInputCommand("left", observer.url),
      "```",
      "```bash exec",
      protectedInputCommand("right", observer.url),
      "```",
    ].join("\n\n");
    yield* useStubFs({ "doc.md": document });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        yield* collect(yield* execute({ path: "doc.md", stream }));
      });
      yield* held.operation;
      yield* task.halt();
    });
    expect(
      stream.snapshot().some((event) => event.type === "close" && event.coroutineId === "root"),
    ).toBe(false);
    first = false;
    yield* collect(yield* execute({ path: "doc.md", stream }));
    expect(asks).toBe(4);
    expect(observer.commands).toBe(2);
    expect(observer.latestExact).toBe(true);
    expect(fresh[0] === fresh[1]).toBe(false);
    expect(observer.contains(JSON.stringify(stream.snapshot()))).toBe(false);
  });
});

import { content, ContentError } from "../mod.ts";

describe("conversion failure preserves earlier acknowledgements", () => {
  it("restores A and the recovered failure in an unfinished root without starting B", function* () {
    yield* useTempFileCompiler();
    yield* useNormalizedOutput();
    let first = true;
    let a = 0;
    let b = 0;
    let compiled = 0;
    const inputs: string[] = [];
    const held = withResolvers<void>();
    yield* registerComponents([
      {
        name: "Recover",
        origin: "protected-test",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          try {
            return yield* content();
          } catch (error) {
            if (error instanceof ContentError) {
              return "RECOVERED";
            }
            throw error;
          }
        },
      },
      {
        name: "Hold",
        origin: "protected-test",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          if (first) {
            held.resolve();
            yield* suspend();
          }
          return "";
        },
      },
    ]);
    yield* Elicitation.around({
      *elicit() {
        let value = String(Math.floor(100000 + Math.random() * 900000));
        while (inputs.includes(value)) {
          value = String(Math.floor(100000 + Math.random() * 900000));
        }
        inputs.push(value);
        return inputs.length === 1 ? { code: value, public: "fixed" } : { code: value };
      },
    });
    yield* API.Env.around({
      *compile([code, options], next) {
        if (code.includes("unsupportedSequential")) {
          compiled++;
        }
        return yield* next(code, options);
      },
    });
    yield* API.Process.around({
      *exec([options], next) {
        if (options.command[2].trim() === "printf A") {
          a++;
        } else {
          b++;
        }
        return yield* next(options);
      },
    });
    yield* useStubFs({
      "doc.md": [
        "```ts eval",
        `const schema = ${JSON.stringify(schema)};`,
        "```",
        '<Elicit schema={schema} as="answer">Code.</Elicit>',
        "```bash exec",
        "printf A",
        "```",
        "<Recover>",
        "```ts eval",
        "const unsupportedSequential = String(answer.code);",
        "```",
        "```bash exec",
        "printf B",
        "```",
        "</Recover>",
        "<Hold />",
      ].join("\n\n"),
    });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        yield* collect(yield* execute({ path: "doc.md", stream }));
      });
      yield* held.operation;
      yield* task.halt();
    });
    expect(
      stream.snapshot().some((event) => event.type === "close" && event.coroutineId === "root"),
    ).toBe(false);
    first = false;
    const output = yield* collect(yield* execute({ path: "doc.md", stream }));
    expect(String(output).includes("RECOVERED")).toBe(true);
    expect(a).toBe(1);
    expect(b).toBe(0);
    expect(compiled).toBe(1);
    expect(inputs.some((value) => JSON.stringify(stream.snapshot()).includes(value))).toBe(false);
  });
});

describe("protected input preserves durable protocol identity", () => {
  it("continues an unfinished run when the entered text is also a protocol word", function* () {
    yield* useTempFileCompiler();
    yield* useNormalizedOutput();
    const held = withResolvers<void>();
    let first = true;
    let asks = 0;
    let commands = 0;
    yield* registerComponents([
      {
        name: "Hold",
        origin: "protected-identity-test",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          if (first) {
            held.resolve();
            yield* suspend();
          }
          return "";
        },
      },
    ]);
    yield* Elicitation.around({
      *elicit() {
        asks++;
        return { exec: asks === 1 ? ["ex", "ec"].join("") : ["fresh", "input"].join("-") };
      },
    });
    yield* API.Process.around({
      *exec() {
        commands++;
        return { exitCode: 0, stdout: undefined, stderr: undefined };
      },
    });
    const declaration = {
      type: "object",
      properties: { exec: { type: "string", writeOnly: true } },
      required: ["exec"],
      additionalProperties: false,
    };
    yield* useStubFs({
      "exec.md": [
        `<Elicit schema={${JSON.stringify(declaration)}} as="answer">Enter input.</Elicit>`,
        "```ts eval",
        "const exec = answer.exec;",
        "```",
        "```bash exec",
        "printf public",
        "```",
        "<Hold />",
        "<Json value={exec} />",
      ].join("\n\n"),
    });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const task = yield* spawn(function* () {
        yield* collect(yield* execute({ path: "exec.md", stream }));
      });
      yield* held.operation;
      yield* task.halt();
    });
    expect(
      stream.snapshot().some((event) => event.type === "close" && event.coroutineId === "root"),
    ).toBe(false);
    const elicited = stream
      .snapshot()
      .find((event) => event.type === "yield" && event.description.type === "elicit");
    if (elicited?.type !== "yield" || elicited.result.status !== "ok") {
      throw new Error("Missing marked elicitation receipt.");
    }
    expect(ELICITATION_SCHEMA_FIELD in elicited.description).toBe(true);
    expect(SOURCE_POSITION_FIELD in elicited.description).toBe(true);
    const receipt = parseInputRecord(parseJsonObject(elicited.result.value)["executablemd.input"]);
    expect(
      receipt.kind === "object" &&
        receipt.members.exec?.kind === "input" &&
        receipt.members.exec.field.field === "exec",
    ).toBe(true);
    const evaluated = stream
      .snapshot()
      .find((event) => event.type === "yield" && event.description.type === "eval");
    if (evaluated?.type !== "yield" || evaluated.result.status !== "ok") {
      throw new Error("Missing designated eval references.");
    }
    const exports = parseInputRecord(
      parseJsonObject(evaluated.result.value)["executablemd.input-exports"],
    );
    expect(
      exports.kind === "object" &&
        exports.members.exec?.kind === "input" &&
        exports.members.exec.field.field === "exec",
    ).toBe(true);
    const command = stream
      .snapshot()
      .find((event) => event.type === "yield" && event.description.type === "exec");
    if (command?.type !== "yield") {
      throw new Error("Missing canonical command identity.");
    }
    const program = Array.isArray(command.description.command)
      ? command.description.command[2]
      : undefined;
    expect(
      typeof program === "string" &&
        command.description.name === "exec:" + program.slice(0, 40).replace(/\n/g, " "),
    ).toBe(true);
    expect(SOURCE_POSITION_FIELD in command.description).toBe(true);
    expect(commands).toBe(1);
    first = false;
    const output = yield* collect(yield* execute({ path: "exec.md", stream }));
    expect(asks).toBe(2);
    expect(commands).toBe(1);
    expect(String(output).includes("[redacted]")).toBe(true);
  });
});
