---
props:
  type: object
  properties:
    tsconfigPath:
      type: string
      default: ".reviews/tsconfig.oxlint.json"
  additionalProperties: false
returns:
  type: object
  properties:
    oxlintInstalled: { type: boolean }
    oxlintVersion: { type: string }
    tsgolintInstalled: { type: boolean }
    tsgolintVersion: { type: string }
    tsconfigExists: { type: boolean }
    nodeModulesExists: { type: boolean }
    typeAwareAvailable: { type: boolean }
    filesAnalyzed: { type: number }
    filesSkipped: { type: number }
    importErrors: { type: number }
    availableRuleIds:
      type: array
      items: { type: string }
    bloatRulesAvailable:
      type: array
      items: { type: string }
    bloatRulesMissing:
      type: array
      items: { type: string }
    recommendation: { type: string }
    nativeSpecifiers:
      type: object
      properties:
        count: { type: number }
        files:
          type: array
          items: { type: string }
        jsr: { type: number }
        npm: { type: number }
      required: [count, files, jsr, npm]
      additionalProperties: false
  required:
    - oxlintInstalled
    - oxlintVersion
    - tsgolintInstalled
    - tsgolintVersion
    - tsconfigExists
    - nodeModulesExists
    - typeAwareAvailable
    - filesAnalyzed
    - filesSkipped
    - importErrors
    - availableRuleIds
    - bloatRulesAvailable
    - bloatRulesMissing
    - recommendation
    - nativeSpecifiers
  additionalProperties: false
---

```ts eval
import { exec, glob, readTextFile, stat } from "@executablemd/runtime";

function diagnosticEntries(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && Array.isArray(value.diagnostics)) {
    return value.diagnostics;
  }
  return [];
}

function diagnosticFile(entry) {
  return typeof entry.file === "string"
    ? entry.file
    : typeof entry.filename === "string" ? entry.filename : "";
}

function diagnosticRule(entry) {
  return typeof entry.ruleId === "string"
    ? entry.ruleId
    : typeof entry.code === "string" ? entry.code : "unknown";
}

function diagnosticMessage(entry) {
  return typeof entry.message === "string" ? entry.message : "";
}

function isImportNoise(entry) {
  const message = diagnosticMessage(entry).toLowerCase();
  const rule = diagnosticRule(entry).toLowerCase();
  return message.includes("cannot find module") || rule.includes("import");
}

function* scanSpecifiers() {
  const files = yield* glob({
    root: ".",
    patterns: ["packages/**/*.ts", "packages/**/*.tsx", "src/**/*.ts", "src/**/*.tsx"],
    exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
  });
  const lines = [];
  const filesWithSpecifiers = new Set();
  let jsr = 0;
  let npm = 0;
  for (const entry of files) {
    if (!entry.isFile) {
      continue;
    }
    const source = yield* readTextFile(entry.path);
    for (const line of source.split(/\r?\n/)) {
      if (!/^\s*(import|export)\s.*from\s+["'](jsr:|npm:)/.test(line)) {
        continue;
      }
      if (lines.length < 50) {
        lines.push(`${entry.path}:${line.trim()}`);
      }
      filesWithSpecifiers.add(entry.path);
      if (line.includes("jsr:")) {
        jsr++;
      }
      if (line.includes("npm:")) {
        npm++;
      }
    }
  }
  return { lines, files: [...filesWithSpecifiers].slice(0, 50), jsr, npm };
}

function* probeTypeAware(canProbe) {
  if (!canProbe) {
    return {
      diagnosticCount: 0,
      importNoiseCount: 0,
      filesAnalyzed: 0,
      filesSkipped: 0,
      importErrors: 0,
      availableRuleIds: [],
      tsgolintCrashed: false,
    };
  }

  const result = yield* exec({
    command: [
      ".reviews/.oxlint/oxlint",
      "--config",
      ".reviews/.oxlintrc.json",
      "--type-aware",
      "--tsconfig",
      tsconfigPath,
      "--format",
      "json",
    ],
    env: { OXLINT_TSGOLINT_PATH: ".reviews/.oxlint/tsgolint" },
  });
  const stderr = result.stderr.toLowerCase();
  const crashed = stderr.includes("tsgolint") &&
    (stderr.includes("panic") || stderr.includes("fatal") || stderr.includes("oom"));
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = [];
  }

  const diagnostics = diagnosticEntries(parsed);
  const files = new Set();
  const skipped = new Set();
  const rules = new Set();
  let importNoiseCount = 0;
  for (const entry of diagnostics) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const file = diagnosticFile(entry);
    const rule = diagnosticRule(entry);
    if (file) {
      files.add(file);
    }
    if (rule) {
      rules.add(rule);
    }
    if (isImportNoise(entry)) {
      importNoiseCount++;
      if (file) {
        skipped.add(file);
      }
    }
  }
  return {
    diagnosticCount: diagnostics.length,
    importNoiseCount,
    filesAnalyzed: files.size,
    filesSkipped: skipped.size,
    importErrors: importNoiseCount,
    availableRuleIds: [...rules],
    tsgolintCrashed: crashed,
  };
}

function* inspect() {
  const oxlintStat = yield* stat(".reviews/.oxlint/oxlint");
  const tsgolintStat = yield* stat(".reviews/.oxlint/tsgolint");
  const tsconfigStat = yield* stat(tsconfigPath);
  const nodeModulesStat = yield* stat("node_modules");
  const oxlintInstalled = oxlintStat.exists && oxlintStat.isFile;
  const tsgolintInstalled = tsgolintStat.exists && tsgolintStat.isFile;
  const canProbe = oxlintInstalled && tsgolintInstalled && tsconfigStat.exists && nodeModulesStat.exists;

  const oxlintVersionResult = oxlintInstalled
    ? yield* exec({ command: [".reviews/.oxlint/oxlint", "--version"] })
    : { stdout: "", stderr: "", exitCode: 0 };
  const tsgolintVersionResult = tsgolintInstalled
    ? yield* exec({ command: [".reviews/.oxlint/tsgolint", "--version"] })
    : { stdout: "", stderr: "", exitCode: 0 };
  const specifiers = yield* scanSpecifiers();
  const probe = yield* probeTypeAware(canProbe);

  const BLOAT_RULES = [
    "no-unused-vars", "no-inferrable-types", "no-empty-function",
    "no-empty-object-type", "no-useless-empty-export",
    "no-unnecessary-type-constraint",
    "no-unnecessary-parameter-property-assignment",
    "no-static-only-class", "no-console", "no-debugger",
    "no-unnecessary-type-assertion", "no-redundant-type-constituents",
    "no-unnecessary-type-arguments", "no-unnecessary-boolean-literal-compare",
  ];
  const TYPE_AWARE_RULES = [
    "no-unnecessary-type-assertion", "no-redundant-type-constituents",
    "no-unnecessary-type-arguments", "no-unnecessary-boolean-literal-compare",
  ];
  const noiseRatio = probe.diagnosticCount > 0
    ? probe.importNoiseCount / probe.diagnosticCount : 0;
  const typeAwareAvailable = canProbe && !probe.tsgolintCrashed;
  const recommendation = !typeAwareAvailable
    ? "syntax-only"
    : noiseRatio >= 0.3 ? "type-aware-filtered" : "type-aware";

  return {
    oxlintInstalled,
    oxlintVersion: oxlintVersionResult.stdout.trim(),
    tsgolintInstalled,
    tsgolintVersion: tsgolintVersionResult.stdout.trim(),
    tsconfigExists: tsconfigStat.exists,
    nodeModulesExists: nodeModulesStat.exists,
    typeAwareAvailable,
    filesAnalyzed: probe.filesAnalyzed,
    filesSkipped: probe.filesSkipped,
    importErrors: probe.importErrors,
    availableRuleIds: probe.availableRuleIds,
    bloatRulesAvailable: typeAwareAvailable
      ? BLOAT_RULES : BLOAT_RULES.filter((rule) => !TYPE_AWARE_RULES.includes(rule)),
    bloatRulesMissing: typeAwareAvailable ? [] : TYPE_AWARE_RULES,
    recommendation,
    nativeSpecifiers: {
      count: specifiers.lines.length,
      files: specifiers.files,
      jsr: specifiers.jsr,
      npm: specifiers.npm,
    },
  };
}

const doctor = yield* inspect();
```

<Return value={doctor} />
