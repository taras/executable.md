import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { copyFile, ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { until } from "effection";
import type { Operation } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { ROOT, runOxlint } from "./oxlint.ts";
import { BANNED_WORDS } from "../banned-words.js";

const RULE = "local(no-banned-jsdoc-words)";

interface Diagnostic {
  code: string;
  message: string;
  filename: string;
  labels: { span: { line: number; column: number; length: number; offset: number } }[];
}

function diagnostics(source: string): Diagnostic[] {
  const report: { diagnostics: Diagnostic[] } = JSON.parse(source);
  return report.diagnostics.filter((item) => item.code === RULE);
}

function* subject(source: string, name = "subject.ts"): Operation<string> {
  const directory = yield* useTempDirectory("banned-words-");
  const file = path.join(directory, name);
  yield* writeTextFile(file, source);
  return file;
}

function architecture(file: string, script = path.join(ROOT, "scripts/lint-architecture.js")) {
  return exec("node", { arguments: [script, file], cwd: ROOT }).join();
}

describe("banned prose words", () => {
  it("rejects every explicit variant through the repository Oxlint config", function* () {
    const source =
      BANNED_WORDS.map((word) => `/** ${word.toUpperCase()}. */`).join("\n") + "\nexport {};\n";
    const file = yield* subject(source);
    const run = yield* runOxlint(".oxlintrc.json", ["--format=json", file]);
    const found = diagnostics(run.stdout);
    expect(run.code).not.toBe(0);
    expect(found.map((item) => item.labels[0].span)).toEqual(
      BANNED_WORDS.map((word, index) => ({
        line: index + 1,
        column: 5,
        length: word.length,
        offset: source.indexOf(word.toUpperCase()),
      })),
    );
    expect(found.every((item) => item.filename === file)).toBe(true);
    for (let index = 0; index < BANNED_WORDS.length; index++) {
      expect(found[index].message).toContain(BANNED_WORDS[index].toUpperCase());
    }
  });

  it("maps multiline CRLF prose back to exact source columns", function* () {
    const file = yield* subject(
      "/**\r\n * Intro.\r\n * A CLAIM, then claimed.\r\n * @returns claims remain prose.\r\n */\r\nexport {};\r\n",
    );
    const run = yield* runOxlint(".oxlintrc.json", ["--format=json", file]);
    expect(diagnostics(run.stdout).map((item) => item.labels[0].span)).toEqual([
      { line: 3, column: 6, length: 5, offset: 21 },
      { line: 3, column: 18, length: 7, offset: 33 },
      { line: 4, column: 13, length: 6, offset: 55 },
    ]);
  });

  it("preserves code, annotations, other comments and containing words", function* () {
    const file = yield* subject(
      [
        "// claim claims",
        "/* claim */",
        'export const claim = "claimed";',
        "/** A disclaimer and claimsConfiguration remain ordinary names.",
        " * Literal `claim(invocation)` and ``claims `claim` `` are references.",
        " * {@link IdentityClaimant} and {@link claim|the operation} name code.",
        " *",
        " * ```ts",
        ' * const claimed = "claim";',
        " * ```",
        " *",
        ' *     claim("claims");',
        " *",
        " * @param {IdentityClaimant} claim the callback",
        " * @type {claim}",
        " * @type {{",
        ' *   claim: "}",',
        " *   claimed: string",
        " * }}",
        " * @template Claim, Claimant",
        " * @example",
        ' * claim("claimed");',
        " */",
        "export function use(claim: unknown) { return claim; }",
      ].join("\n"),
    );
    const run = yield* runOxlint(".oxlintrc.json", ["--format=json", file]);
    expect(diagnostics(run.stdout)).toEqual([]);
  });

  it("rejects architectural prose with locations while preserving Markdown code", function* () {
    const bad = yield* subject("# Design\r\n\r\nA Claim remains.\r\n", "architecture.md");
    const rejected = yield* architecture(bad);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain(`${bad}:3:3: forbidden prose word "Claim"`);

    const good = yield* subject(
      [
        "# Design",
        "A disclaimer beside `claim(carrier)`.",
        "",
        "```ts",
        'const claim = "claimed";',
        "```",
        "",
        "    reclaim();",
      ].join("\n"),
      "architecture.md",
    );
    expect((yield* architecture(good)).code).toBe(0);
  });

  it("takes an added list entry through both consumers without shared mutation", function* () {
    const directory = yield* useTempDirectory("banned-words-list-");
    const copies = [
      "scripts/banned-words.js",
      "scripts/lib/banned-words.js",
      "scripts/oxlint-rules/no-banned-jsdoc-words.js",
      "scripts/lint-architecture.js",
    ];
    for (const file of copies) {
      yield* ensureDir(path.dirname(path.join(directory, file)));
      yield* copyFile(path.join(ROOT, file), path.join(directory, file));
    }
    yield* writeTextFile(path.join(directory, "package.json"), '{"type":"module"}\n');
    yield* until(
      symlink(path.join(ROOT, "node_modules"), path.join(directory, "node_modules"), "junction"),
    );
    yield* writeTextFile(
      path.join(directory, "plugin.js"),
      [
        'import { noBannedJsdocWords } from "./scripts/oxlint-rules/no-banned-jsdoc-words.js";',
        'export default { rules: { "no-banned-jsdoc-words": noBannedJsdocWords } };',
      ].join("\n"),
    );
    const config = path.join(directory, "oxlint.json");
    yield* writeTextFile(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [{ name: "local", specifier: "./plugin.js" }],
        rules: { "local/no-banned-jsdoc-words": "error" },
      }),
    );
    const source = yield* subject("/** jargonprobe */\nexport {};\n");
    const document = yield* subject("jargonprobe\n", "architecture.md");
    const script = path.join(directory, "scripts/lint-architecture.js");
    expect((yield* runOxlint(config, ["--format=json", source])).code).toBe(0);
    expect((yield* architecture(document, script)).code).toBe(0);

    const list = path.join(directory, "scripts/banned-words.js");
    const original = yield* readTextFile(list);
    yield* writeTextFile(list, original.replace("];", '  "JARGONPROBE",\n];'));
    const linted = yield* runOxlint(config, ["--format=json", source]);
    expect(linted.code).not.toBe(0);
    expect(diagnostics(linted.stdout)[0].message).toContain("jargonprobe");
    expect((yield* architecture(document, script)).code).not.toBe(0);
  });
});
