import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { copyFile, ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { until } from "effection";
import { symlink } from "node:fs/promises";
import type { Operation } from "effection";
import path from "node:path";
import { useTempDirectory } from "@executablemd/test-support/temp";

import { ROOT, runOxlint } from "./oxlint.ts";
import { BANNED_WORDS } from "../banned-words.js";
import {
  categorizeRule,
  SENSOR_RULES,
  TYPE_AWARE_RULES,
} from "../../packages/code-review-agent/src/categories.ts";
import { summarizeDoctorProbe } from "../../packages/code-review-agent/src/doctor.ts";

const SHARED = "oxlint.shared.json";
const GATE = ".oxlintrc.json";
const SENSOR = ".reviews/.oxlintrc.json";

/** A production module, a test module, and a review component. */
const SUBJECTS = [
  "packages/code-review-agent/src/doctor.ts",
  "packages/code-review-agent/tests/doctor.test.ts",
  "packages/code-review-agent/src/components/Doctor.ts",
];

const PLUGINS = ["typescript", "unicorn", "import"];

const TEST_FILES = ["**/*.test.ts", "**/*.spec.ts", "**/test/**", "**/tests/**"];

/** Rules the component and generator protocols conflict with, plus the candidates #395 leaves undecided. */
const DENIED = [
  "eslint/func-style",
  "eslint/no-magic-numbers",
  "eslint/require-yield",
  "eslint/sort-keys",
  "eslint/sort-imports",
  "typescript/prefer-readonly-parameter-types",
  "import/exports-last",
  "import/group-exports",
  "import/no-named-export",
  "import/prefer-default-export",
  "import/consistent-type-specifier-style",
  "unicorn/filename-case",
  "typescript/no-unsafe-assignment",
  "typescript/no-unsafe-return",
  "typescript/no-unsafe-member-access",
  "eslint/preserve-caught-error",
  "eslint/no-duplicate-imports",
];

const GATE_RULES = [
  "eslint/curly",
  "local/no-banned-jsdoc-words",
  "local/no-module-scoped-registry",
  "local/no-section-divider-comments",
  "local/no-sync-filesystem",
  "local/no-yield-in-finally",
  "local/prefer-effection-operation",
  "local/prefer-effection-result",
  "local/require-scope-bound-event-registration",
];

interface Override {
  files: string[];
  rules: Record<string, unknown>;
}

interface Config {
  extends: string[];
  plugins: string[];
  jsPlugins: unknown[];
  categories: Record<string, string>;
  rules: Record<string, unknown>;
  overrides: Override[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function ruleMap(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function overrides(value: unknown): Override[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    files: stringArray(entry.files),
    rules: ruleMap(entry.rules),
  }));
}

function categories(value: unknown): Record<string, string> {
  const source = ruleMap(value);
  const result: Record<string, string> = {};
  for (const [key, level] of Object.entries(source)) {
    if (typeof level === "string") {
      result[key] = level;
    }
  }
  return result;
}

function parseConfig(source: string, origin: string): Config {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) {
    throw new Error(`${origin} is not a JSON object`);
  }
  return {
    extends: stringArray(value.extends),
    plugins: stringArray(value.plugins),
    jsPlugins: Array.isArray(value.jsPlugins) ? value.jsPlugins : [],
    categories: categories(value.categories),
    rules: ruleMap(value.rules),
    overrides: overrides(value.overrides),
  };
}

function* config(file: string): Operation<Config> {
  return parseConfig(yield* readTextFile(path.join(ROOT, file)), file);
}

function* profile(file: string, subject: string): Operation<Config> {
  const run = yield* runOxlint(file, ["--print-config", subject]);
  if (run.code !== 0) {
    throw new Error(
      `oxlint -c ${file} --print-config ${subject} exited ${run.code}: ${run.stderr.trim()}`,
    );
  }
  return parseConfig(run.stdout, `${file} applied to ${subject}`);
}

/** `off`, `error` and Oxlint's printed `allow`/`deny` name the same three severities. */
function severity(value: unknown): string {
  const level = Array.isArray(value) ? value[0] : value;
  if (typeof level !== "string") {
    return "unknown";
  }
  if (level === "off" || level === "allow") {
    return "off";
  }
  if (level === "error" || level === "deny") {
    return "error";
  }
  return level;
}

function bare(ruleId: string): string {
  return ruleId.includes("/") ? ruleId.slice(ruleId.lastIndexOf("/") + 1) : ruleId;
}

function severities(rules: Record<string, unknown>): Map<string, string> {
  return new Map(Object.entries(rules).map(([id, value]) => [bare(id), severity(value)]));
}

function enabled(rules: Record<string, unknown>): string[] {
  return Object.entries(rules)
    .filter(([, value]) => severity(value) !== "off")
    .map(([id]) => id)
    .sort();
}

/** A directory of this test's own. */
function scratch(prefix: string): Operation<string> {
  return useTempDirectory(`${prefix}-`);
}

interface Report {
  diagnostics: { code: string; filename: string }[];
}

function parseReport(source: string, origin: string): Report {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) {
    throw new Error(`${origin} did not report diagnostics`);
  }
  return {
    diagnostics: value.diagnostics.filter(isRecord).map((entry) => ({
      code: typeof entry.code === "string" ? entry.code : "",
      filename: typeof entry.filename === "string" ? entry.filename : "",
    })),
  };
}

describe("Oxlint policy", () => {
  it("checks prose beyond packages/scripts without widening other rules or formatting", function* () {
    const manifest = JSON.parse(yield* readTextFile(path.join(ROOT, "package.json")));
    expect(manifest.scripts.lint).toContain("oxlint -c .oxlint-prose.json site smoke-test");
    expect(manifest.scripts.lint).toContain("node scripts/lint-architecture.js");
    expect(manifest.scripts.lint).toContain("oxfmt --check packages scripts");
    const prose = yield* config(".oxlint-prose.json");
    expect(prose.rules).toEqual({ "local/no-banned-jsdoc-words": "error" });
    expect(prose.categories).toEqual({ correctness: "off" });
    const directory = yield* scratch("oxlint-prose-policy");
    const file = path.join(directory, "surface.ts");
    yield* writeTextFile(file, "export function probe() { if (true) return 1; }\n");
    expect((yield* runOxlint(".oxlint-prose.json", [file])).code).toBe(0);
    yield* writeTextFile(file, "/** Claim */\nexport {};\n");
    expect((yield* runOxlint(".oxlint-prose.json", [file])).code).not.toBe(0);
  });

  it("extends one canonical shared policy from both profiles", function* () {
    const gate = yield* config(GATE);
    const sensor = yield* config(SENSOR);

    expect(gate.extends).toEqual(["./oxlint.shared.json"]);
    expect(sensor.extends).toEqual(["../oxlint.shared.json"]);

    const fromGate = path.resolve(ROOT, gate.extends[0]);
    const fromSensor = path.resolve(ROOT, ".reviews", sensor.extends[0]);
    expect(fromGate).toBe(path.join(ROOT, SHARED));
    expect(fromSensor).toBe(fromGate);
  });

  it("keeps the built-in catalog in the shared source and out of both profiles", function* () {
    const shared = yield* config(SHARED);
    const gate = yield* config(GATE);
    const sensor = yield* config(SENSOR);

    expect(shared.plugins).toEqual(PLUGINS);
    expect(shared.categories).toEqual({
      correctness: "warn",
      suspicious: "warn",
      pedantic: "off",
      style: "off",
    });

    const signals = Object.entries(shared.rules).filter(([, value]) => severity(value) === "warn");
    expect(signals.map(([id]) => bare(id)).sort()).toEqual([...SENSOR_RULES].sort());

    const denials = Object.entries(shared.rules).filter(([, value]) => severity(value) === "off");
    expect(denials.map(([id]) => id).sort()).toEqual([...DENIED].sort());

    expect(shared.overrides).toEqual([
      {
        files: TEST_FILES,
        rules: { "eslint/no-console": "off", "eslint/no-empty-function": "off" },
      },
    ]);

    expect(gate.categories).toEqual({});
    expect(sensor.categories).toEqual({});
    expect(
      Object.keys(gate.rules)
        .map(bare)
        .filter((id) => SENSOR_RULES.includes(id)),
    ).toEqual([]);
    expect(Object.keys(sensor.rules)).toEqual([]);
  });

  it("keeps the curated signal options the sensor's density model reads", function* () {
    const shared = yield* config(SHARED);

    expect(shared.rules["eslint/no-unused-vars"]).toEqual([
      "warn",
      {
        args: "all",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ]);
    expect(shared.rules["eslint/no-console"]).toEqual(["warn", { allow: ["warn", "error"] }]);
  });

  it("resolves both inheritance chains for production, test and review-component paths", function* () {
    for (const subject of SUBJECTS) {
      const gate = yield* profile(GATE, subject);
      const sensor = yield* profile(SENSOR, subject);

      expect(gate.plugins.sort()).toEqual([...PLUGINS].sort());
      expect(sensor.plugins.sort()).toEqual([...PLUGINS].sort());
      expect(Object.keys(gate.rules).length).toBeGreaterThan(0);
      expect(Object.keys(sensor.rules).length).toBeGreaterThan(0);
    }
  });

  it("keeps the sensor's built-in rules a subset of the gate's", function* () {
    for (const subject of SUBJECTS) {
      const gate = new Set(enabled((yield* profile(GATE, subject)).rules));
      const sensor = enabled((yield* profile(SENSOR, subject)).rules);

      expect(sensor.filter((rule) => !gate.has(rule))).toEqual([]);
    }
  });

  it("keeps every curated signal warning-enabled for the sensor", function* () {
    for (const subject of SUBJECTS) {
      const applied = severities((yield* profile(SENSOR, subject)).rules);

      for (const rule of SENSOR_RULES) {
        expect([rule, applied.get(rule)]).toEqual([rule, "warn"]);
        expect([rule, categorizeRule(rule)]).not.toEqual([rule, ["other"]]);
      }
    }
  });

  it("keeps the named conflicts and undecided candidates off in both profiles", function* () {
    for (const file of [GATE, SENSOR]) {
      const applied = severities((yield* profile(file, SUBJECTS[0])).rules);

      for (const rule of DENIED) {
        expect([file, rule, applied.get(bare(rule))]).toEqual([file, rule, "off"]);
      }
    }
  });

  it("keeps the sensor advisory, with no local plugin, local rule or error severity", function* () {
    const sensor = yield* config(SENSOR);
    expect(sensor.jsPlugins).toEqual([]);
    expect(Object.keys(sensor.rules)).toEqual([]);
    expect(sensor.overrides).toEqual([]);

    for (const subject of SUBJECTS) {
      const applied = yield* profile(SENSOR, subject);
      const rules = [
        ...Object.entries(applied.rules),
        ...applied.overrides.flatMap((entry) => Object.entries(entry.rules)),
      ];

      expect(rules.filter(([, value]) => severity(value) === "error")).toEqual([]);
      expect(rules.map(([id]) => id).filter((id) => id.startsWith("local/"))).toEqual([]);
      expect(applied.jsPlugins).toEqual([]);
    }
  });

  it("keeps the gate's blocking rules at error severity", function* () {
    const gate = yield* config(GATE);

    expect(Object.keys(gate.rules).sort()).toEqual([...GATE_RULES].sort());
    for (const rule of GATE_RULES) {
      expect([rule, severity(gate.rules[rule])]).toEqual([rule, "error"]);
    }
    expect(gate.jsPlugins).toEqual([{ name: "local", specifier: "./scripts/oxlint-plugin.js" }]);
    expect(gate.overrides).toEqual([
      { files: TEST_FILES, rules: { "local/no-redundant-test-scope": "error" } },
    ]);

    const applied = yield* profile(GATE, SUBJECTS[1]);
    expect(severity(applied.rules.curly)).toBe("error");
  });

  it("carries both the shared and the gate's test override through inheritance", function* () {
    for (const subject of SUBJECTS) {
      const gate = yield* profile(GATE, subject);
      const sensor = yield* profile(SENSOR, subject);

      expect(gate.overrides.map((entry) => entry.files)).toEqual([TEST_FILES, TEST_FILES]);
      expect(gate.overrides.map((entry) => severities(entry.rules).get("no-console"))).toEqual([
        "off",
        undefined,
      ]);
      expect(
        gate.overrides.map((entry) => severities(entry.rules).get("no-redundant-test-scope")),
      ).toEqual([undefined, "error"]);

      expect(sensor.overrides.map((entry) => entry.files)).toEqual([TEST_FILES]);
      expect(severities(sensor.overrides[0].rules).get("no-console")).toBe("off");
      expect(severities(sensor.overrides[0].rules).get("no-empty-function")).toBe("off");
    }
  });

  it("applies the shared test override to the files the sensor lints", function* () {
    const directory = yield* scratch("oxlint-policy");
    const body = 'export function probe() {\n  console.log("probe");\n}\n';
    yield* ensureDir(path.join(directory, "tests"));
    yield* writeTextFile(path.join(directory, "tests", "probe.ts"), body);
    yield* writeTextFile(path.join(directory, "probe.ts"), body);

    for (const file of [GATE, SENSOR]) {
      const run = yield* runOxlint(file, [
        "--format=json",
        path.join(directory, "tests", "probe.ts"),
        path.join(directory, "probe.ts"),
      ]);
      const report = parseReport(run.stdout, `oxlint -c ${file}`);
      const consoles = report.diagnostics.filter((entry) => entry.code === "eslint(no-console)");

      expect(consoles.map((entry) => path.relative(directory, entry.filename))).toEqual([
        "probe.ts",
      ]);
    }
  });

  it("reports Doctor's catalog as the curated signals", function* () {
    const available = summarizeDoctorProbe({ exitCode: 0, stderr: "", diagnostics: [] });
    expect(available.bloatRulesAvailable).toEqual([...SENSOR_RULES]);
    expect(available.bloatRulesMissing).toEqual([]);

    const syntaxOnly = summarizeDoctorProbe({
      exitCode: 2,
      stderr: "tsgolint panic",
      diagnostics: [],
    });
    const typeAware = new Set<string>(TYPE_AWARE_RULES);
    expect(syntaxOnly.bloatRulesMissing).toEqual([...TYPE_AWARE_RULES]);
    expect(syntaxOnly.bloatRulesAvailable.sort()).toEqual(
      SENSOR_RULES.filter((rule) => !typeAware.has(rule)).sort(),
    );
  });

  it("pins one Oxlint and one tsgolint version across the toolchain", function* () {
    const provisioning = yield* readTextFile(
      path.join(ROOT, "packages/code-review-agent/src/documents/components/EnsureOxlint.md"),
    );
    const oxlint = /const OXLINT_TAG = "apps_v([\d.]+)";/u.exec(provisioning);
    const tsgolint = /const TSGOLINT_VERSION = "([\d.]+)";/u.exec(provisioning);
    if (!oxlint || !tsgolint) {
      throw new Error("EnsureOxlint.md no longer declares its Oxlint and tsgolint versions");
    }

    const denoConfig = yield* readTextFile(path.join(ROOT, "deno.json"));
    const nodeManifest = yield* readTextFile(path.join(ROOT, "package.json"));
    expect(denoConfig).toContain(`"oxlint": "npm:oxlint@${oxlint[1]}"`);
    expect(denoConfig).toContain(`"oxlint-tsgolint": "npm:oxlint-tsgolint@${tsgolint[1]}"`);
    expect(nodeManifest).toContain(`"oxlint": "${oxlint[1]}"`);

    const run = yield* runOxlint(GATE, ["--version"]);
    expect(run.stdout.trim()).toContain(oxlint[1]);
  });

  it("fails rather than reporting an empty policy when inheritance is broken", function* () {
    const directory = yield* scratch("oxlint-policy-broken");
    const broken = path.join(directory, "broken.json");
    yield* writeTextFile(broken, JSON.stringify({ extends: ["./absent.json"] }));

    const run = yield* runOxlint(broken, ["--print-config", SUBJECTS[0]]);
    const output = `${run.stdout}${run.stderr}`;
    expect(run.code).not.toBe(0);
    expect(output).toContain("absent.json");
    expect(output).not.toContain('"rules"');
  });
});

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
