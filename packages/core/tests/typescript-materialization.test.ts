import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { cliBase } from "@executablemd/test-support/launch";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { realpath, symlink } from "node:fs/promises";
import { until } from "effection";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryStream, serializeDurableEvent } from "@executablemd/durable-streams";
import { collect, Component, execute, registerComponents, useNormalizedOutput } from "../mod.ts";
import type { Json } from "../mod.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function* project(): Operation<string> {
  yield* useComponentModuleLoader();
  const directory = yield* until(realpath(yield* useTempDirectory("typescript-materialization-")));
  yield* writeTextFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  yield* until(symlink(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir"));
  yield* ensureDir(join(directory, "components"));
  yield* writeTextFile(join(directory, "components/sibling.txt"), "sibling");
  yield* writeTextFile(
    join(directory, "components/late.ts"),
    'export const late: string = "late-native";',
  );
  yield* writeTextFile(join(directory, "effects.txt"), "");
  yield* writeTextFile(join(directory, "releases.txt"), "");
  yield* writeTextFile(
    join(directory, "components/helper.ts"),
    [
      'import { ensure } from "effection";',
      'import { readTextFile, writeTextFile } from "@effectionx/fs";',
      'export const helper = "relative-helper";',
      "export function* append(url: URL, text: string) {",
      '  yield* writeTextFile(url, (yield* readTextFile(url)) + text + "\\n");',
      "}",
      "export function* acquire(origin: string) {",
      '  yield* ensure(() => append(new URL("../releases.txt", origin), "released"));',
      "}",
    ].join("\n"),
  );
  return directory;
}

function source(version: string): string {
  return [
    'import { content, type ComponentExecution, type Json } from "@executablemd/core";',
    'import { createDurableOperation } from "@executablemd/durable-streams";',
    'import { readTextFile } from "@effectionx/fs";',
    'import { until } from "effection";',
    'import { acquire, append, helper } from "./helper.ts";',
    'export const props = { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false };',
    'export const returns = { type: "object", properties: { value: { type: "string" }, origin: { type: "string" }, sibling: { type: "string" }, projected: { type: "string" }, late: { type: "string" }, resolved: { type: "string" } }, required: ["value", "origin", "sibling", "projected", "late", "resolved"], additionalProperties: false };',
    "export default function*(props: Record<string, Json>): ComponentExecution<Json> {",
    "  yield* acquire(import.meta.url);",
    '  yield createDurableOperation({ type: "materialization-effect", name: "once" }, function* () {',
    '    yield* append(new URL("../effects.txt", import.meta.url), "completed");',
    '    return "acknowledged";',
    "  });",
    "  const projected = yield* content();",
    "  const order: string[] = [];",
    '  const specifier = { toString() { order.push("specifier"); return new URL("./late.ts", import.meta.url).href; } };',
    '  const dependency = yield* until(import(specifier, (order.push("options"), {})));',
    '  if (order.join(",") !== "options,specifier") { throw new Error("dynamic import changed evaluation order"); }',
    `  return { value: ${JSON.stringify(version)} + ":" + props.count + ":" + helper,`,
    '    origin: import.meta.url, sibling: yield* readTextFile(new URL("./sibling.txt", import.meta.url)),',
    '    projected, late: dependency.late, resolved: import.meta.resolve("./late.ts") };',
    "}",
  ].join("\n");
}

const DOCUMENT = [
  "---",
  "returns: { type: object }",
  "---",
  '<Direct count={7} as="actual"><Gate /></Direct>',
  "<Return value={actual} />",
].join("\n");

function* gate(fn: () => Operation<string>): Operation<void> {
  yield* registerComponents([
    {
      name: "Gate",
      props: { type: "object", properties: {}, additionalProperties: false },
      fn,
      origin: "materialization-fixture",
    },
  ]);
}

function run(directory: string, stream: InMemoryStream): Operation<Json> {
  return scoped(function* () {
    yield* useNormalizedOutput();
    yield* gate(function* () {
      return "continued";
    });
    return yield* collect(
      yield* execute({
        path: join(directory, "doc.md"),
        includes: [join(directory, "components")],
        stream,
      }),
    );
  });
}

function imports(stream: InMemoryStream) {
  return stream
    .snapshot()
    .filter(
      (event) =>
        event.type === "yield" &&
        event.description.type === "import_component" &&
        event.description.name === "Direct",
    );
}

describe("direct TypeScript materialization", () => {
  it("F1: the selected bytes replace same-path behavior while preserving the module contract", function* () {
    const directory = yield* project();
    const direct = join(directory, "components/Direct.ts");
    yield* writeTextFile(join(directory, "doc.md"), DOCUMENT);
    const firstSource = source("first");
    yield* writeTextFile(direct, firstSource);
    const firstStream = new InMemoryStream();
    const first = yield* run(directory, firstStream);
    expect(first).toEqual({
      value: "first:7:relative-helper",
      origin: pathToFileURL(direct).href,
      sibling: "sibling",
      projected: "continued",
      late: "late-native",
      resolved: pathToFileURL(join(directory, "components/late.ts")).href,
    });
    expect(yield* readTextFile(join(directory, "releases.txt"))).toBe("released\n");
    const secondSource = source("second");
    yield* writeTextFile(direct, secondSource);
    const secondStream = new InMemoryStream();
    expect(yield* run(directory, secondStream)).toEqual({
      value: "second:7:relative-helper",
      origin: pathToFileURL(direct).href,
      sibling: "sibling",
      projected: "continued",
      late: "late-native",
      resolved: pathToFileURL(join(directory, "components/late.ts")).href,
    });
    expect(imports(firstStream)).toMatchObject([
      {
        result: { status: "ok", value: { kind: "repository", path: direct, content: firstSource } },
      },
    ]);
    expect(imports(secondStream)).toMatchObject([
      {
        result: {
          status: "ok",
          value: { kind: "repository", path: direct, content: secondSource },
        },
      },
    ]);
    expect(yield* readTextFile(join(directory, "releases.txt"))).toBe("released\nreleased\n");

    yield* writeTextFile(
      join(directory, "components/choice-exports.ts"),
      [
        'import { content } from "@executablemd/core";',
        'export const props = { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false };',
        'export const returns = { type: "string" };',
        'export const generated = { "self-closing": { identity: "https://executable.md/tests/materialization/choice", effect: "read" } };',
        'export const form = { forms: "both",',
        '  "self-closing": function*(props) { return "selected:" + props.word; },',
        '  paired: function*() { return "paired:" + (yield* content()); }',
        "};",
        'export default function*() { throw new Error("default must not dispatch"); }',
      ].join("\n"),
    );
    yield* writeTextFile(
      join(directory, "components/Choice.ts"),
      'export { props, returns, generated, form } from "./choice-exports.ts";\nexport default function*() { throw new Error("default must not dispatch"); }',
    );
    yield* scoped(function* () {
      yield* useNormalizedOutput();
      yield* Component.around({ generated: () => ({ Choice: ["self-closing"] }) });
      yield* writeTextFile(
        join(directory, "form.md"),
        '<Evaluate text={\'<Choice word="offered" as="answer" /><Json value={answer} />\'} />\n\n<Choice word="paired" as="paired">body</Choice>\n<Json value={paired} />',
      );
      const result = yield* collect(
        yield* execute({
          path: join(directory, "form.md"),
          includes: [dirname(direct)],
          stream: new InMemoryStream(),
        }),
      );
      expect(result).toContain("selected:offered");
      expect(result).toContain("paired:body");
    });
  });

  it("F2: a fresh process continues retained direct source after its file is removed", function* () {
    const directory = yield* project();
    const direct = join(directory, "components/Direct.ts");
    const original = source("retained");
    yield* writeTextFile(direct, original);
    yield* writeTextFile(join(directory, "doc.md"), DOCUMENT);
    const stream = new InMemoryStream();
    const entered = withResolvers<void>();
    const parent = yield* spawn(function* () {
      yield* gate(function* () {
        entered.resolve();
        yield* suspend();
        return "unreachable";
      });
      yield* collect(
        yield* execute({ path: join(directory, "doc.md"), includes: [dirname(direct)], stream }),
      );
    });
    yield* entered.operation;
    expect(yield* readTextFile(join(directory, "effects.txt"))).toBe("completed\n");
    expect(imports(stream)).toMatchObject([
      { result: { status: "ok", value: { content: original } } },
    ]);
    const prefix = stream.snapshot();
    expect(prefix.some((event) => event.type === "close")).toBe(false);
    yield* parent.halt();
    expect(yield* readTextFile(join(directory, "releases.txt"))).toBe("released\n");
    yield* writeTextFile(
      join(directory, "journal.jsonl"),
      prefix.map(serializeDurableEvent).join(""),
    );
    yield* rm(direct);
    const [command, ...arguments_] = cliBase();
    arguments_.pop();
    const fixture = fileURLToPath(
      new URL("./fixtures/typescript-materialization.ts", import.meta.url),
    );
    const status = yield* exec(command, { arguments: [...arguments_, fixture, directory] }).join();
    expect({ code: status.code, stdout: status.stdout, stderr: status.stderr }).toMatchObject({
      code: 0,
      stdout: "",
    });
    expect(JSON.parse(yield* readTextFile(join(directory, "result.json")))).toEqual({
      value: "retained:7:relative-helper",
      origin: pathToFileURL(direct).href,
      sibling: "sibling",
      projected: "continued",
      late: "late-native",
      resolved: pathToFileURL(join(directory, "components/late.ts")).href,
    });
    expect(yield* readTextFile(join(directory, "effects.txt"))).toBe("completed\n");
    expect(yield* readTextFile(join(directory, "releases.txt"))).toBe("released\nreleased\n");
    expect(yield* readTextFile(join(directory, "continued.jsonl"))).toContain('"type":"close"');
  });
});
