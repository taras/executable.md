import { parseDurableEvent } from "@executablemd/durable-streams";
import { parseJsonObject } from "../../core/src/json.ts";
import { chmod } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { until } from "effection";
import { Stdio } from "@effectionx/process";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { scoped } from "effection";
import { join } from "node:path";
import { useProtectedInputObserver } from "../../core/tests/support/protected-input.ts";
import { protectedInputPlugin, protectedInputChild } from "./support/protected-input.ts";

function document(marked: boolean): string {
  const field = { type: "string", ...(marked ? { writeOnly: true } : {}) };
  const schema = {
    type: "object",
    properties: { code: field, public: { type: "string" } },
    required: ["code", "public"],
    additionalProperties: false,
  };
  return [
    "```ts eval",
    `const schema = ${JSON.stringify(schema)};`,
    "```",
    '<Elicit schema={schema} as="otp">Enter a code.</Elicit>',
    "```ts eval",
    "const alias = otp.code; const copy = { values: [alias] };",
    "```",
    "```bash exec",
    "npm_config_otp={otp.code} node child.cjs",
    "```",
    "<Json value={otp} />",
  ].join("\n\n");
}

describe("protected input in the actual CLI", () => {
  it("keeps all three publication modes safe and preserves the unmarked control", function* () {
    for (const mode of ["ordinary", "journal", "verbose", "scanner-off", "unmarked"]) {
      yield* scoped(function* () {
        yield* Stdio.around({ *stdout() {}, *stderr() {} }, { at: "min" });
        const observer = yield* useProtectedInputObserver();
        const root = yield* useTempDirectory("protected-cli-");
        yield* writeTextFile(join(root, "provider.ts"), protectedInputPlugin(observer.url));
        yield* writeTextFile(join(root, "child.cjs"), protectedInputChild(observer.url));
        yield* writeTextFile(join(root, "doc.md"), document(mode !== "unmarked"));
        const args = ["run", "doc.md", "--raw", "--plugin", "./provider.ts"];
        if (mode !== "ordinary") {
          args.push("--journal", "journal.jsonl");
        }
        if (mode === "verbose") {
          args.push("--verbose");
        }
        if (mode === "scanner-off") {
          args.push("--no-secret-detection");
        }
        const result = yield* runCli(args, { cwd: root }).join();
        expect(result.code).toBe(0);
        expect(observer.answers).toBe(1);
        expect(observer.commands).toBe(1);
        expect(observer.exact).toBe(true);
        const journal = mode === "ordinary" ? "" : yield* readTextFile(join(root, "journal.jsonl"));
        const safe = !observer.contains(result.stdout + result.stderr + journal);
        expect(safe).toBe(mode !== "unmarked");
        expect(result.stdout.includes("useful")).toBe(true);
        if (mode !== "ordinary") {
          const events = journal
            .trim()
            .split("\n")
            .map((line) => {
              const parsed = parseDurableEvent(line);
              if (!parsed.ok) {
                throw parsed.error;
              }
              return parsed.value;
            });
          const elicited = events.find(
            (event) => event.type === "yield" && event.description.type === "elicit",
          );
          if (elicited?.type !== "yield" || elicited.result.status !== "ok") {
            throw new Error("Missing Elicit receipt.");
          }
          const receipt = parseJsonObject(elicited.result.value);
          if (mode === "unmarked") {
            expect(receipt.public).toBe("useful");
            expect(observer.contains(JSON.stringify(receipt.code))).toBe(true);
          } else {
            expect(receipt["executablemd.input"]).toMatchObject({
              kind: "object",
              members: { code: { kind: "input" }, public: { kind: "json", value: "useful" } },
            });
            const close = events.find(
              (event) => event.type === "close" && event.coroutineId === "root",
            );
            if (close?.type !== "close" || close.result.status !== "ok") {
              throw new Error("Missing root result.");
            }
            const bindings = parseJsonObject(parseJsonObject(close.result.value).bindings);
            expect(bindings.otp).toEqual({ code: "[redacted]", public: "useful" });
            expect(bindings.alias).toBe("[redacted]");
            expect(bindings.copy).toEqual({ values: ["[redacted]"] });
            const command = events.find(
              (event) => event.type === "yield" && event.description.type === "exec",
            );
            expect(
              command?.type === "yield" && command.description.name.includes("[redacted]"),
            ).toBe(true);
            expect(
              events.some(
                (event) =>
                  event.type === "yield" &&
                  event.description.type === "eval" &&
                  JSON.stringify(event.result).includes("executablemd.input-exports"),
              ),
            ).toBe(true);
          }
        }
      });
    }
  });
});

describe("BootstrapNpmPackage protected command spellings", () => {
  it("passes the marked OTP to controlled npm-shaped commands without publication or configuration reads", function* () {
    yield* Stdio.around({ *stdout() {}, *stderr() {} }, { at: "min" });
    const observer = yield* useProtectedInputObserver();
    const root = yield* useTempDirectory("protected-bootstrap-");
    const bootstrap = yield* readTextFile(
      fileURLToPath(new URL("../../../components/BootstrapNpmPackage.md", import.meta.url)),
    );
    const declaration = bootstrap
      .slice(bootstrap.indexOf('<Let as="otpSchema"'))
      .match(/```json\n([\s\S]*?)```/);
    if (declaration === null) {
      throw new Error("No Bootstrap OTP schema.");
    }
    const commands = bootstrap
      .split("\n")
      .filter((line) => line.startsWith("npm_config_otp={otp.code}"));
    expect(commands.length).toBe(4);
    const props: Record<string, string> = {
      packageName: "@executablemd/test",
      registry: "https://registry.invalid",
      workflowFile: "release.yml",
      repository: "example/test",
      environment: "npm",
    };
    const filled = commands.map((line) =>
      line.replace(/\{([a-zA-Z]+)\}/g, (matched, name: string) => props[name] ?? matched),
    );
    yield* writeTextFile(
      join(root, "npm"),
      "#!/usr/bin/env node\n" +
        protectedInputChild(observer.url).replace("process accepted input", "{}"),
    );
    yield* until(chmod(join(root, "npm"), 0o700));
    yield* writeTextFile(join(root, "provider.ts"), protectedInputPlugin(observer.url));
    yield* writeTextFile(
      join(root, "doc.md"),
      [
        "```ts eval",
        `const schema = ${declaration[1]};`,
        "```",
        '<Elicit schema={schema} as="otp">Code.</Elicit>',
        ...filled.flatMap((command) => ["```bash exec", command, "```"]),
      ].join("\n\n"),
    );
    const result = yield* runCli(
      [
        "run",
        "doc.md",
        "--raw",
        "--journal",
        "journal.jsonl",
        "--verbose",
        "--plugin",
        "./provider.ts",
      ],
      { cwd: root, env: { PATH: root + ":" + (process.env.PATH ?? "") } },
    ).join();
    expect(result.code).toBe(0);
    expect(observer.answers).toBe(1);
    expect(observer.commands).toBe(4);
    expect(observer.exact).toBe(true);
    const journal = yield* readTextFile(join(root, "journal.jsonl"));
    expect(observer.contains(result.stdout + result.stderr + journal)).toBe(false);
    expect(journal.includes('"kind":"input"')).toBe(true);
  });
});
