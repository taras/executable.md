import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { ensure } from "effection";
import type { Operation } from "effection";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT, runOxlint } from "./oxlint.ts";
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
  ".reviews/components/Doctor.ts",
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
  "local/no-module-scoped-registry",
  "local/no-section-divider-comments",
  "local/no-yield-in-finally",
  "local/prefer-effection-result",
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

/** The profile Oxlint actually applies to `subject`, resolved through `extends`. */
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

/** A directory of this test's own; `@effectionx/fs` has no mkdtemp. */
function* scratch(prefix: string): Operation<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  yield* ensure(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
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
    fs.mkdirSync(path.join(directory, "tests"));
    fs.writeFileSync(path.join(directory, "tests", "probe.ts"), body);
    fs.writeFileSync(path.join(directory, "probe.ts"), body);

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
      path.join(ROOT, ".reviews", "components", "EnsureOxlint.md"),
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
    fs.writeFileSync(broken, JSON.stringify({ extends: ["./absent.json"] }));

    const run = yield* runOxlint(broken, ["--print-config", SUBJECTS[0]]);
    const output = `${run.stdout}${run.stderr}`;
    expect(run.code).not.toBe(0);
    expect(output).toContain("absent.json");
    expect(output).not.toContain('"rules"');
  });
});
