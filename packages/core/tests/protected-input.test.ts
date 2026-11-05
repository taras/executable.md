import { projectInputValue } from "../host.ts";
import { registerComponents } from "../src/components/registration.ts";
import { capture } from "../src/component-api.ts";
import type { Json, JsonObject } from "../src/types.ts";
import { Stdio } from "@effectionx/process";
import { DocumentOutput } from "../src/api.ts";
import { useNormalizedOutput } from "../src/output/normalize.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { prepareElicitation } from "../src/elicit.ts";
import { projectElicitationAnswer } from "../src/secrets/input-schema.ts";
import { attachInputOwner, createInputOwner } from "../src/secrets/inputs.ts";
import { Elicitation } from "../src/elicitation-api.ts";
import { execute } from "../src/execute.ts";
import { Execution } from "../api.ts";
import { useHeldHost } from "./support/held-host.ts";
import { useComputedBindings } from "../src/computed-bindings.ts";
import { useSecretScannerFactory } from "../src/secrets/policy.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";

const schema = {
  type: "object",
  properties: {
    code: { type: "string", writeOnly: true, minLength: 6 },
    public: { type: "string" },
    optional: { type: "string", writeOnly: true },
  },
  required: ["code", "public"],
  additionalProperties: false,
};

describe("protected input", () => {
  it("preserves captures and Let by reference and refuses an ordinary prop before its body", function* () {
    for (const ordinary of [false, true]) {
      yield* scoped(function* () {
        yield* useTempFileCompiler();
        let entered = "";
        let bodies = 0;
        let commands = 0;
        let exact = false;
        yield* registerComponents([
          {
            name: "ByReference",
            origin: "protected-test",
            props: { type: "object", properties: {}, additionalProperties: false },
            captures: ["value"],
            *fn() {
              return yield* capture("value");
            },
          },
          {
            name: "Ordinary",
            origin: "protected-test",
            props: { type: "object", properties: { value: {} }, additionalProperties: false },
            *fn() {
              bodies++;
              return "";
            },
          },
        ]);
        yield* Elicitation.around({
          *elicit() {
            entered = String(Math.floor(100000 + Math.random() * 900000));
            return { code: entered, public: "useful" };
          },
        });
        yield* API.Process.around({
          *exec([options]) {
            commands++;
            exact = options.command.join(" ").includes(entered);
            return { exitCode: 0, stdout: undefined, stderr: undefined };
          },
        });
        yield* useStubFs({
          "doc.md": [
            "```ts eval",
            `const schema = ${JSON.stringify(schema)};`,
            "```",
            '<Elicit schema={schema} as="answer">Code.</Elicit>',
            ordinary
              ? "<Ordinary value={answer.code} />"
              : '<ByReference value={answer.code} as="copy" /><Let value={copy} as="selected" />',
            "```bash exec",
            "printf '{selected}'",
            "```",
          ].join("\n\n"),
        });
        let failed = false;
        try {
          yield* collect(yield* execute({ path: "doc.md", stream: new InMemoryStream() }));
        } catch {
          failed = true;
        }
        expect(failed).toBe(ordinary);
        expect(bodies).toBe(0);
        expect(commands).toBe(ordinary ? 0 : 1);
        expect(exact).toBe(!ordinary);
      });
    }
  });

  it("rejects unsupported marker positions while treating const and enum as data", function* () {
    const invalid: Json[] = [
      { type: "object", properties: { code: { type: "number", writeOnly: true } } },
      {
        type: "object",
        properties: {
          nested: { type: "object", properties: { code: { type: "string", writeOnly: true } } },
        },
      },
      {
        type: "object",
        if: { properties: { code: { type: "string", writeOnly: true } } },
        then: {},
      },
      {
        type: "object",
        definitions: { code: { type: "string", writeOnly: true } },
        properties: { code: { $ref: "#/definitions/code" } },
      },
    ];
    for (const declaration of invalid) {
      let refused = false;
      try {
        yield* prepareElicitation(declaration);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    }
    const literal = yield* prepareElicitation({
      type: "object",
      properties: {
        data: { const: { writeOnly: true } },
        literal: { enum: [{ writeOnly: true }] },
        code: { type: "string", writeOnly: false },
      },
    });
    expect(literal.secretFields).toEqual([]);
  });

  it("refuses each named conversion and a custom chain before a dependent process", function* () {
    for (const expression of [
      "answer.code.trim()",
      "`value ${answer.code}`",
      "String(answer.code)",
      "encodeURIComponent(answer.code)",
      "JSON.stringify(answer.code)",
      "custom-chain",
    ]) {
      yield* scoped(function* () {
        yield* useTempFileCompiler();
        let secret = "";
        let commands = 0;
        let modified = 0;
        yield* Elicitation.around(
          {
            *elicit() {
              secret = String(Math.floor(100000 + Math.random() * 900000));
              return { code: secret, public: "useful" };
            },
          },
          { at: "min" },
        );
        yield* API.Process.around({
          *exec() {
            commands++;
            return { exitCode: 0, stdout: undefined, stderr: undefined };
          },
        });
        const blocks =
          expression === "custom-chain"
            ? ["```bash custom exec", "printf '{answer.code}'", "```"]
            : [
                "```ts eval",
                `const unsupported = ${expression};`,
                "```",
                "```bash exec",
                "printf dependent",
                "```",
              ];
        yield* useStubFs({
          "doc.md": [
            "```ts eval",
            `const schema = ${JSON.stringify(schema)};`,
            "```",
            '<Elicit schema={schema} as="answer">Code.</Elicit>',
            ...blocks,
          ].join("\n\n"),
        });
        let failure = "";
        try {
          yield* collect(
            yield* execute({
              path: "doc.md",
              stream: new InMemoryStream(),
              modifiers: {
                custom: () => (_args, next) =>
                  (function* () {
                    modified++;
                    return yield* next();
                  })(),
              },
            }),
          );
        } catch (error) {
          failure = error instanceof Error ? error.message : "failed";
        }
        expect(failure.length > 0).toBe(true);
        expect(failure.includes(secret)).toBe(false);
        expect(commands).toBe(0);
        expect(modified).toBe(0);
      });
    }
  });

  it("projects both channels and DocumentOutput before retention in every built-in exec form", function* () {
    for (const form of [
      "exec",
      'exec as="result"',
      "silent exec",
      "timeout=3s exec",
      "provider-error",
    ]) {
      yield* scoped(function* () {
        yield* useTempFileCompiler();
        yield* useNormalizedOutput();
        let secret = "";
        let exact = false;
        let forwarded = "";
        const encoder = new TextEncoder();
        yield* Stdio.around(
          {
            *stdout([bytes]) {
              forwarded += new TextDecoder().decode(bytes);
            },
            *stderr([bytes]) {
              forwarded += new TextDecoder().decode(bytes);
            },
          },
          { at: "min" },
        );
        yield* Elicitation.around(
          {
            *elicit() {
              secret = String(Math.floor(100000 + Math.random() * 900000));
              return { code: secret, public: "useful" };
            },
          },
          { at: "min" },
        );
        yield* API.Process.around({
          *exec([options], next) {
            exact = options.command.join(" ").includes(secret);
            if (form === "provider-error") {
              throw new Error("provider " + options.command.join(" "), {
                cause: new Error(secret),
              });
            }
            yield* Stdio.operations.stdout(encoder.encode("out " + secret.slice(0, 3)));
            expect(forwarded.includes(secret)).toBe(false);
            yield* Stdio.operations.stdout(encoder.encode(secret.slice(3) + " useful\n"));
            yield* Stdio.operations.stderr(encoder.encode("err " + secret + " useful\n"));
            yield* DocumentOutput.operations.output("document " + secret.slice(0, 3));
            yield* DocumentOutput.operations.output(secret.slice(3) + " useful\n");
            const outcome = yield* next(options);
            return { ...outcome, stdout: secret, stderr: secret };
          },
        });
        const stream = new InMemoryStream();
        const modifier = form === "provider-error" ? "exec" : form;
        const prefix = "printf useful; # " + "x".repeat(20) + " ";
        yield* useStubFs({
          "doc.md": [
            "```ts eval",
            `const schema = ${JSON.stringify(schema)};`,
            "```",
            '<Elicit schema={schema} as="answer">Code.</Elicit>',
            "```bash " + modifier,
            prefix + "{answer.code}",
            "```",
            form.includes("as=") ? "<Json value={result} />" : "",
          ].join("\n\n"),
        });
        let observed = "";
        try {
          observed = String(yield* collect(yield* execute({ path: "doc.md", stream })));
        } catch (error) {
          observed = error instanceof Error ? error.message : "failed";
        }
        expect(exact).toBe(true);
        expect((observed + forwarded + JSON.stringify(stream.snapshot())).includes(secret)).toBe(
          false,
        );
        expect(JSON.stringify(stream.snapshot()).includes("useful")).toBe(true);
        const command = stream
          .snapshot()
          .find((event) => event.type === "yield" && event.description.type === "exec");
        const safeCommand = command?.type === "yield" ? command.description.command : undefined;
        const safeProgram = Array.isArray(safeCommand) ? safeCommand[2] : undefined;
        expect(
          command?.type === "yield" &&
            typeof safeProgram === "string" &&
            command.description.name === "exec:" + safeProgram.slice(0, 40).replace(/\n/g, " "),
        ).toBe(true);
        expect(
          command?.type === "yield" &&
            JSON.stringify(command.description.command).includes(prefix + "[redacted]"),
        ).toBe(true);
      });
    }
  });

  it("prepares declared fields and conservatively projects invalid input", function* () {
    const prepared = yield* prepareElicitation(schema);
    expect(prepared.secretFields).toEqual(["code", "optional"]);
    const safe = projectElicitationAnswer(schema, {
      code: { invalid: "withheld" },
      public: "useful",
    });
    expect(safe).toEqual({ ok: true, value: { code: "[redacted]", public: "useful" } });
  });

  it("owns references, refuses conversions and filters split output", function* () {
    const values = yield* attachInputOwner(yield* createInputOwner());
    const secret = String(Math.floor(100000 + Math.random() * 900000));
    const leaf = values.protect({ coroutine: "root", index: 1, field: "code" }, secret);
    expect(() => String(leaf)).toThrow("protected");
    expect(() => JSON.stringify(leaf)).toThrow("protected");
    expect(() => Reflect.get(leaf, "trim")).toThrow("protected");
    const recorded = values.record({ nested: [leaf], public: "useful" });
    expect(recorded.ok).toBe(true);
    expect(JSON.stringify(recorded).includes(secret)).toBe(false);
    if (!recorded.ok) {
      throw recorded.error;
    }
    const restored = values.restore(recorded.value);
    expect(restored.ok).toBe(true);
    expect(values.display(restored.ok ? restored.value : null)).toEqual({
      ok: true,
      value: { nested: ["[redacted]"], public: "useful" },
    });
    const filter = values.text();
    expect(filter.write(`before ${secret.slice(0, 3)}`) === "before ").toBe(true);
    expect(filter.write(`${secret.slice(3)} after`) === "[redacted] after").toBe(true);
    expect(filter.finish() === "").toBe(true);
    expect(filter.finish() === "").toBe(true);
    expect(() => filter.write("late")).toThrow("finished");
  });

  it("runs a marked field through eval and real built-in exec without publication", function* () {
    yield* useTempFileCompiler();
    yield* useNormalizedOutput();
    let secret = "";
    let received = false;
    yield* Elicitation.around(
      {
        *elicit() {
          secret = String(Math.floor(100000 + Math.random() * 900000));
          return { code: secret, public: "useful" };
        },
      },
      { at: "min" },
    );
    yield* API.Process.around({
      *exec([options], next) {
        received = options.command.join(" ").includes(secret);
        return yield* next(options);
      },
    });
    const source = [
      "```ts eval",
      `const secretSchema = ${JSON.stringify(schema)};`,
      "```",
      '<Elicit schema={secretSchema} as="answer">Enter a code.</Elicit>',
      "```ts eval",
      'import { createContext } from "effection"; yield* createContext("executablemd.secrets.policy").set({ enabled: false }); const alias = answer.code;',
      "```",
      "```bash exec",
      "printf 'useful %s' '{alias}'",
      "```",
      "Protected prose: {answer.code}; public: {answer.public}.",
      "<Json value={answer} />",
    ].join("\n\n");
    yield* useStubFs({ "doc.md": source });
    const stream = new InMemoryStream();
    const result = yield* scoped(function* () {
      return yield* collect(yield* execute({ path: "doc.md", stream }));
    });
    expect(received).toBe(true);
    expect(String(result).includes(secret)).toBe(false);
    expect(JSON.stringify(stream.snapshot()).includes(secret)).toBe(false);
    expect(String(result).includes("useful")).toBe(true);
    expect(String(result).includes("Protected prose: [redacted]; public: useful.")).toBe(true);
  });
});

import { exec } from "@effectionx/process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { until } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { executeInstalled } from "../host.ts";
import type { SecretInputOwner } from "../host.ts";

function ownerInstallation(value: unknown): value is { secretInputs: SecretInputOwner } {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const owner: unknown = Reflect.get(value, "secretInputs");
  return (
    owner !== null &&
    typeof owner === "object" &&
    typeof Reflect.get(owner, "executablemd.secret-input.attach") === "function"
  );
}

function inputInstallationOperation(value: unknown): value is Operation<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, Symbol.iterator) === "function"
  );
}

describe("protected input ownership across loaded copies", () => {
  it("uses a separately bundled host installation with canonical execution and refuses its reuse", function* () {
    const directory = yield* useTempDirectory("protected-copy-");
    const module = fileURLToPath(new URL("../src/secrets/input-host.ts", import.meta.url));
    const bundle = join(directory, "input-host.mjs");
    const built = yield* exec("deno", {
      arguments: [
        "bundle",
        "--external=*.node",
        "--frozen",
        "--node-modules-dir=none",
        module,
        "--output",
        bundle,
      ],
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    }).join();
    expect(built.code).toBe(0);
    const copy: unknown = yield* until(import(`file://${bundle}`));
    if (copy === null || typeof copy !== "object") {
      throw new Error("No loaded host module.");
    }
    const factory: unknown = Reflect.get(copy, "useSecretInputs");
    if (typeof factory !== "function") {
      throw new Error("No host factory.");
    }
    const operation: unknown = Reflect.apply(factory, undefined, []);
    if (!inputInstallationOperation(operation)) {
      throw new Error("No host installation operation.");
    }
    const installation = yield* operation;
    if (!ownerInstallation(installation)) {
      throw new Error("No owned installation.");
    }
    let secret = "";
    let received = false;
    yield* useTempFileCompiler();
    yield* Elicitation.around({
      *elicit() {
        secret = String(Math.floor(100000 + Math.random() * 900000));
        return { code: secret, public: "useful" };
      },
    });
    yield* API.Process.around({
      *exec([options]) {
        received = options.command.join(" ").includes(secret);
        return { exitCode: 0, stdout: undefined, stderr: undefined };
      },
    });
    yield* useStubFs({
      "doc.md": [
        "```ts eval",
        `const schema = ${JSON.stringify(schema)};`,
        "```",
        '<Elicit schema={schema} as="answer">Code.</Elicit>',
        "```bash exec",
        "printf '{answer.code}'",
        "```",
      ].join("\n\n"),
    });
    const stream = new InMemoryStream();
    yield* collect(yield* executeInstalled({ path: "doc.md", stream }, [installation]));
    expect(received).toBe(true);
    expect(JSON.stringify(stream.snapshot()).includes(secret)).toBe(false);
    let refused = false;
    try {
      yield* executeInstalled({ path: "missing.md", stream: new InMemoryStream() }, [installation]);
    } catch (error) {
      refused = error instanceof Error && error.message.includes("already attached");
    }
    expect(refused).toBe(true);
  });
});

import { parseInputRecord } from "../src/secrets/input-record.ts";
import type { InputText } from "../src/secrets/inputs.ts";

describe("protected codecs and disposal", () => {
  it("treats user tag-shaped objects as data and refuses missing or malformed references", function* () {
    const owner = yield* attachInputOwner(yield* createInputOwner());
    const ordinary = { kind: "input", field: { coroutine: "root", index: 1, field: "ordinary" } };
    const recorded = owner.record(ordinary);
    if (!recorded.ok) {
      throw recorded.error;
    }
    expect(owner.restore(recorded.value)).toEqual({ ok: true, value: ordinary });
    expect(
      owner.restore({ kind: "input", field: { coroutine: "foreign", index: 1, field: "missing" } })
        .ok,
    ).toBe(false);
    expect(() => parseInputRecord({ kind: "input", field: {} })).toThrow("history");
    expect(() => parseInputRecord({ kind: "json", value: null, extra: true })).toThrow("history");
  });

  it("refuses output after the producer scope disposes its owner", function* () {
    const filter: InputText = yield* scoped(function* () {
      const owner = yield* attachInputOwner(yield* createInputOwner());
      const entered = String(Math.floor(100000 + Math.random() * 900000));
      owner.protect({ coroutine: "root", index: 0, field: "code" }, entered);
      const text = owner.text();
      text.write(entered.slice(0, 3));
      return text;
    });
    expect(() => filter.write("late")).toThrow("disposed");
    expect(() => filter.finish()).toThrow("disposed");
  });

  it("does not transfer live protection state into a subsequent independent execution", function* () {
    yield* useTempFileCompiler();
    let entered = "";
    yield* Elicitation.around({
      *elicit() {
        if (entered === "") {
          entered = String(Math.floor(100000 + Math.random() * 900000));
        }
        return { code: entered, public: "useful" };
      },
    });
    const streams: InMemoryStream[] = [];
    for (const marked of [true, false]) {
      yield* scoped(function* () {
        const declaration = {
          ...schema,
          properties: { ...schema.properties, code: { type: "string", writeOnly: marked } },
        };
        yield* useStubFs({
          "doc.md": [
            "```ts eval",
            `const schema = ${JSON.stringify(declaration)};`,
            "```",
            '<Elicit schema={schema} as="answer">Code.</Elicit>',
            "<Json value={answer} />",
          ].join("\n\n"),
        });
        const stream = new InMemoryStream();
        streams.push(stream);
        yield* collect(yield* execute({ path: "doc.md", stream }));
      });
    }
    expect(JSON.stringify(streams[0].snapshot()).includes(entered)).toBe(false);
    expect(JSON.stringify(streams[1].snapshot()).includes(entered)).toBe(true);
  });
});

import { useSecretInputs } from "../host.ts";

describe("protected question boundaries", () => {
  it("refuses a marked question immediately without a responder or dependent process", function* () {
    yield* useTempFileCompiler();
    let processes = 0;
    yield* API.Process.around({
      *exec() {
        processes++;
        return { exitCode: 0, stdout: undefined, stderr: undefined };
      },
    });
    yield* useStubFs({
      "doc.md": [
        "```ts eval",
        `const schema = ${JSON.stringify(schema)};`,
        "```",
        '<Elicit schema={schema} as="answer">Code.</Elicit>',
        "```bash exec",
        "printf dependent",
        "```",
      ].join("\n\n"),
    });
    let failure = "";
    try {
      yield* collect(yield* execute({ path: "doc.md", stream: new InMemoryStream() }));
    } catch (error) {
      failure = error instanceof Error ? error.message : "failed";
    }
    expect(failure.includes("live elicitation responder")).toBe(true);
    expect(processes).toBe(0);
  });

  it("refuses conflicting host attachments before a missing document is read", function* () {
    let failure = "";
    const first = yield* useSecretInputs();
    const second = yield* useSecretInputs();
    try {
      yield* executeInstalled({ path: "missing.md", stream: new InMemoryStream() }, [
        first,
        second,
      ]);
    } catch (error) {
      failure = error instanceof Error ? error.message : "failed";
    }
    expect(failure).toBe("Multiple protected-input owners");
  });
});

describe("protected value returns", () => {
  it("validates original strings through component and root return paths while preserving live leaves", function* () {
    const valueDocument = [
      "---",
      "returns:",
      '  code: {type: string, pattern: "^[0-9]{6}$"}',
      "  public: {type: string}",
      "---",
      '<Elicit schema={{type:"object",properties:{code:{type:"string",writeOnly:true},public:{type:"string"}},required:["code","public"],additionalProperties:false}} as="answer">Code</Elicit>',
      "<Return value={answer} />",
    ].join("\n\n");
    for (const rootReturn of [false, true]) {
      yield* scoped(function* () {
        yield* useTempFileCompiler();
        let entered = "";
        let exact = false;
        yield* Elicitation.around({
          *elicit() {
            entered = String(Math.floor(100000 + Math.random() * 900000));
            return { code: entered, public: "useful" };
          },
        });
        yield* API.Process.around({
          *exec([options]) {
            exact = options.command.join(" ").includes(entered);
            return { exitCode: 0, stdout: undefined, stderr: undefined };
          },
        });
        yield* useStubFs({
          "Value.md": valueDocument,
          "doc.md": rootReturn
            ? valueDocument
            : "<Value as=\"result\" />\n\n```bash exec\nprintf '{result.code}'\n```\n<Json value={result} />",
        });
        const stream = new InMemoryStream();
        const result = yield* collect(yield* execute({ path: "doc.md", stream }));
        expect(JSON.stringify(result).includes(entered)).toBe(false);
        expect(JSON.stringify(stream.snapshot()).includes(entered)).toBe(false);
        if (rootReturn) {
          expect(result).toEqual({ code: "[redacted]", public: "useful" });
        } else {
          expect(exact).toBe(true);
        }
      });
    }
  });
});

import { runPreparedElicitation } from "../src/elicit.ts";
import { parseJsonObject } from "../src/json.ts";

describe("protected validation keeps the original constraints", () => {
  it("keeps optional omission absent and rejects an explicitly empty constrained field", function* () {
    for (const supplied of [false, true]) {
      yield* scoped(function* () {
        yield* useTempFileCompiler();
        let value = "";
        yield* Elicitation.around({
          *elicit() {
            value = String(Math.floor(100000 + Math.random() * 900000));
            return { code: value, public: "useful", ...(supplied ? { optional: "" } : {}) };
          },
        });
        const declaration = {
          ...schema,
          properties: {
            ...schema.properties,
            optional: { type: "string", writeOnly: true, minLength: 1 },
          },
        };
        yield* useStubFs({
          "doc.md": [
            "```ts eval",
            `const schema = ${JSON.stringify(declaration)};`,
            "```",
            '<Elicit schema={schema} as="answer">Code</Elicit>',
          ].join("\n\n"),
        });
        const stream = new InMemoryStream();
        let failed = false;
        try {
          yield* collect(yield* execute({ path: "doc.md", stream }));
        } catch {
          failed = true;
        }
        expect(failed).toBe(supplied);
        expect(JSON.stringify(stream.snapshot()).includes(value)).toBe(false);
        const elicited = stream
          .snapshot()
          .find((event) => event.type === "yield" && event.description.type === "elicit");
        if (!supplied) {
          if (elicited?.type !== "yield" || elicited.result.status !== "ok") {
            throw new Error("Missing marked receipt.");
          }
          const members = parseJsonObject(
            parseJsonObject(parseJsonObject(elicited.result.value)["executablemd.input"]).members,
          );
          expect(Object.hasOwn(members, "optional")).toBe(false);
        }
      });
    }
  });

  it("does not publish a rejected operand embedded in a non-JSON marked answer", function* () {
    let value = "";
    yield* Elicitation.around({
      *elicit() {
        value = String(Math.floor(100000 + Math.random() * 900000));
        return { code: { [value]: undefined }, public: "useful" };
      },
    });
    let failure = "";
    try {
      yield* runPreparedElicitation(yield* prepareElicitation(schema), "Code");
    } catch (error) {
      failure = error instanceof Error ? error.message : "failed";
    }
    expect(failure.includes(value)).toBe(false);
    expect(failure.includes("protected operands are withheld")).toBe(true);
  });
});

describe("the private process result boundary", () => {
  it("projects returned channels and provider error causes while preserving cwd, timeout and framing", function* () {
    const owner = yield* attachInputOwner(yield* createInputOwner());
    const entered = String(Math.floor(100000 + Math.random() * 900000));
    const leaf = owner.protect({ coroutine: "root", index: 0, field: "code" }, entered);
    let requestExact = false;
    let fail = false;
    yield* API.Process.around({
      *exec([options]) {
        requestExact =
          options.command[0] === "node" &&
          options.command[1] === "-e" &&
          options.command[2] === entered &&
          options.cwd === "/test-input" &&
          options.timeout === 3456 &&
          options.retain === false;
        if (fail) {
          throw new Error("provider " + options.command[2], { cause: new Error(entered) });
        }
        return { exitCode: 0, stdout: entered, stderr: entered };
      },
    });
    const result = yield* owner.exec(
      { language: "javascript", parts: [leaf] },
      { cwd: "/test-input", timeout: 3456 },
    );
    expect(requestExact).toBe(true);
    expect(result.stdout === "[redacted]" && result.stderr === "[redacted]").toBe(true);
    fail = true;
    let safe = false;
    try {
      yield* owner.exec(
        { language: "javascript", parts: [leaf] },
        { cwd: "/test-input", timeout: 3456 },
      );
    } catch (error) {
      safe =
        error instanceof Error &&
        !error.message.includes(entered) &&
        error.cause instanceof Error &&
        !error.cause.message.includes(entered);
    }
    expect(safe).toBe(true);
  });
});

import { useSecretDetection } from "../src/secrets/policy.ts";

describe("serialized failure projection", () => {
  it("projects the actual journal representation when optional error fields are undefined", function* () {
    const inputs = yield* attachInputOwner(yield* createInputOwner());
    const entered = String(Math.floor(100000 + Math.random() * 900000));
    inputs.protect({ coroutine: "root", index: 0, field: "code" }, entered);
    const stream = new InMemoryStream();
    const detection = yield* useSecretDetection(undefined, stream, inputs);
    yield* detection.journal.append({
      type: "yield",
      coroutineId: "root",
      description: { type: "failure-probe", name: "failure-probe" },
      result: { status: "err", error: { message: entered, name: undefined, stack: undefined } },
    });
    const event = stream.snapshot()[0];
    expect(
      event.type === "yield" &&
        event.result.status === "err" &&
        event.result.error.message === "[redacted]",
    ).toBe(true);
    expect(
      event.result.status === "err" &&
        !Object.hasOwn(event.result.error, "stack") &&
        !Object.hasOwn(event.result.error, "name"),
    ).toBe(true);
    expect(JSON.stringify(stream.snapshot()).includes(entered)).toBe(false);
  });
});

const DISCLOSURE_REFUSAL = "This execution cannot disclose the supplied data.";
function expectDisclosureRefusal(result: Result<JsonObject>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.message).toBe(DISCLOSURE_REFUSAL);
    expect(result.error.cause).toBeUndefined();
  }
}

describe("owned execution disclosure", () => {
  it("refuses before policy readiness without invoking contextual work", function* () {
    const owner = yield* useComputedBindings();
    let calls = 0;
    expectDisclosureRefusal(
      yield* owner.disclose({ message: "not ready" }, function* (data) {
        calls += 1;
        return Ok(data);
      }),
    );
    expect(calls).toBe(0);
    expectDisclosureRefusal(yield* Execution.operations.disclose({ message: "no selected owner" }));
  });

  it("projects protected inputs with scanning disabled and returns detached copies only while live", function* () {
    yield* Elicitation.around({
      *elicit() {
        return { code: "249731", public: "useful" };
      },
    });
    yield* Execution.around({
      *execute([request], next) {
        yield* next(request.withOptions({ ...request.options, secretDetection: false }));
      },
    });
    yield* useSecretScannerFactory(() => {
      throw new Error("Disabled scanning constructs no scanner.");
    });
    const ended = yield* scoped(function* () {
      const held = yield* useHeldHost({
        root: {
          path: "host/protected-disclosure.md",
          source: `<Elicit as="answer" schema={${JSON.stringify(schema)}}>Code.</Elicit><Held />`,
        },
      });
      const data = { message: "Support 249731", nested: { label: "public" } };
      const safe = yield* held.execution.disclose(data);
      expect(safe).toEqual(Ok({ message: "Support [redacted]", nested: { label: "public" } }));
      if (safe.ok) {
        safe.value.message = "edited by reader";
      }
      expect(data.message).toBe("Support 249731");
      expect(yield* held.execution.disclose(data)).toEqual(
        Ok({ message: "Support [redacted]", nested: { label: "public" } }),
      );
      yield* scoped(function* () {
        yield* Execution.around({
          *disclose() {
            return Err(new Error("249731"));
          },
        });
        expectDisclosureRefusal(yield* held.execution.disclose(data));
      });
      held.release();
      expect((yield* held.watched).ok).toBe(true);
      expectDisclosureRefusal(yield* held.execution.disclose(data));
      return held.execution;
    });
    expectDisclosureRefusal(yield* ended.disclose({ message: "after disposal" }));
  });

  it("refuses a scan spanning revocation and joins cancellation without changing the execution", function* () {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    yield* useSecretScannerFactory(() => ({
      *scan(content) {
        if (content.includes("held-disclosure")) {
          entered.resolve();
          yield* release.operation;
        }
        return [];
      },
    }));
    const held = yield* useHeldHost();
    const disclosure = yield* spawn(() => held.execution.disclose({ message: "held-disclosure" }));
    yield* entered.operation;
    held.release();
    expect((yield* held.watched).ok).toBe(true);
    release.resolve();
    expectDisclosureRefusal(yield* disclosure);

    const live = yield* useHeldHost();
    const waiting = withResolvers<void>();
    let unwound = false;
    yield* scoped(function* () {
      yield* Execution.around({
        *disclose(): Operation<Result<JsonObject>> {
          try {
            waiting.resolve();
            yield* suspend();
            return Ok({});
          } finally {
            unwound = true;
          }
        },
      });
      const call = yield* spawn(() => live.execution.disclose({ message: "cancel this read" }));
      yield* waiting.operation;
      yield* call.halt();
      expect(unwound).toBe(true);
    });
    live.release();
    expect((yield* live.watched).ok).toBe(true);
  });
});

describe("host protected-input observation", () => {
  it("projects owned input and known text without replacing live values or requiring JSON", function* () {
    const owner = yield* createInputOwner();
    const values = yield* attachInputOwner(owner);
    const secret = String(Math.floor(100000 + Math.random() * 900000));
    const leaf = values.protect({ coroutine: "root", index: 0, field: "code" }, secret);
    const live = { code: leaf, public: "useful" };
    expect(projectInputValue(owner, live)).toEqual(Ok({ code: "[redacted]", public: "useful" }));
    expect(projectInputValue(owner, `entered ${secret}`)).toEqual(Ok("entered [redacted]"));
    expect(projectInputValue(owner, { public: [1, true, null] })).toEqual(
      Ok({ public: [1, true, null] }),
    );
    expect(projectInputValue(owner, undefined)).toEqual(Ok(undefined));
    expect(projectInputValue(owner, new Date(0))).toEqual(Ok(undefined));
    expect(live.code).toBe(leaf);
    expect(live.public).toBe("useful");
    expect(values.contains(live)).toBe(true);
  });

  it("withholds unsafe owned values, foreign input and disposed owners", function* () {
    const owner = yield* createInputOwner();
    const values = yield* attachInputOwner(owner);
    const secret = String(Math.floor(100000 + Math.random() * 900000));
    const leaf = values.protect({ coroutine: "root", index: 0, field: "code" }, secret);
    const unsafe = { code: leaf, unsupported: undefined };
    const foreign = yield* scoped(function* () {
      const other = yield* createInputOwner();
      const inputs = yield* attachInputOwner(other);
      return inputs.protect({ coroutine: "root", index: 0, field: "other" }, secret);
    });
    let disposed: SecretInputOwner | undefined;
    yield* scoped(function* () {
      disposed = yield* createInputOwner();
    });
    if (disposed === undefined) {
      throw new Error("Owner was not acquired.");
    }
    for (const result of [
      projectInputValue(owner, unsafe),
      projectInputValue(owner, { foreign }),
      projectInputValue(disposed, undefined),
      projectInputValue(disposed, { public: "useful" }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("withheld");
        expect(result.error.message.includes(secret)).toBe(false);
        expect(result.error.cause).toBeUndefined();
      }
    }
    expect(projectInputValue(owner, undefined)).toEqual(Ok(undefined));
  });
});
