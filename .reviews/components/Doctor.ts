import type { Operation } from "effection";
import {
  buildDoctorResult,
  isOxlintCrash,
  normalizeOxlintOutput,
  summarizeDoctorProbe,
} from "@executablemd/code-review-agent";
import type { DoctorResult, OxlintDiagnostic } from "@executablemd/code-review-agent";
import { exec, glob, readTextFile, stat } from "@executablemd/runtime";

export const props = {
  type: "object",
  properties: {
    pr: { type: "object" },
    tsconfigPath: {
      type: "string",
      default: ".reviews/tsconfig.oxlint.json",
    },
  },
  required: ["pr"],
  additionalProperties: false,
};

export const returns = {
  type: "object",
  properties: {
    oxlintInstalled: { type: "boolean" },
    oxlintVersion: { type: "string" },
    tsgolintInstalled: { type: "boolean" },
    tsgolintVersion: { type: "string" },
    tsconfigExists: { type: "boolean" },
    nodeModulesExists: { type: "boolean" },
    typeAwareAvailable: { type: "boolean" },
    filesAnalyzed: { type: "number" },
    filesSkipped: { type: "number" },
    importErrors: { type: "number" },
    bloatRulesAvailable: { type: "array", items: { type: "string" } },
    bloatRulesMissing: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
    nativeSpecifiers: {
      type: "object",
      properties: {
        count: { type: "number" },
        files: { type: "array", items: { type: "string" } },
        jsr: { type: "number" },
        npm: { type: "number" },
      },
      required: ["count", "files", "jsr", "npm"],
      additionalProperties: false,
    },
  },
  required: [
    "oxlintInstalled",
    "oxlintVersion",
    "tsgolintInstalled",
    "tsgolintVersion",
    "tsconfigExists",
    "nodeModulesExists",
    "typeAwareAvailable",
    "filesAnalyzed",
    "filesSkipped",
    "importErrors",
    "bloatRulesAvailable",
    "bloatRulesMissing",
    "recommendation",
    "nativeSpecifiers",
  ],
  additionalProperties: false,
};

interface DoctorProps {
  pr: object;
  tsconfigPath?: string;
}

function* version(command: string[]): Operation<string> {
  const result = yield* exec({ command });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

function* nativeSpecifierSummary(): Operation<DoctorResult["nativeSpecifiers"]> {
  const entries = yield* glob({
    root: ".",
    patterns: ["packages/**/*.ts", "durable-effects/**/*.ts"],
    exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
  });
  const files: string[] = [];
  let jsr = 0;
  let npm = 0;
  for (const entry of entries) {
    if (!entry.isFile) {
      continue;
    }
    const source = yield* readTextFile(entry.path);
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(?:import|export)\s.*?from\s+["'](jsr:|npm:)/.exec(line);
      if (!match) {
        continue;
      }
      files.push(entry.path);
      if (match[1] === "jsr:") {
        jsr++;
      } else {
        npm++;
      }
    }
  }
  return { count: jsr + npm, files: [...new Set(files)], jsr, npm };
}

function* probeTypeAware(canProbe: boolean, tsconfigPath: string) {
  if (!canProbe) {
    return summarizeDoctorProbe({ diagnostics: [], stderr: "", exitCode: 2 });
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
  if (result.exitCode > 1 && !isOxlintCrash(result.stderr)) {
    throw new Error(result.stderr || `Oxlint probe failed with exit code ${result.exitCode}`);
  }
  if (result.stdout.trim().length === 0 && result.exitCode !== 0 && !isOxlintCrash(result.stderr)) {
    throw new Error(result.stderr || "Oxlint probe returned no JSON output");
  }
  const diagnostics: OxlintDiagnostic[] =
    result.stdout.trim().length === 0 ? [] : normalizeOxlintOutput(result.stdout);
  return summarizeDoctorProbe({
    diagnostics,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}

export default function* Doctor({
  tsconfigPath = ".reviews/tsconfig.oxlint.json",
}: DoctorProps): Operation<DoctorResult> {
  const oxlint = yield* stat(".reviews/.oxlint/oxlint");
  const tsgolint = yield* stat(".reviews/.oxlint/tsgolint");
  const tsconfig = yield* stat(tsconfigPath);
  const nodeModules = yield* stat("node_modules");
  const oxlintVersion = oxlint.isFile
    ? yield* version([".reviews/.oxlint/oxlint", "--version"])
    : "";
  const tsgolintVersion = tsgolint.isFile
    ? yield* version([".reviews/.oxlint/tsgolint", "--version"])
    : "";
  const canProbe = oxlint.isFile && tsgolint.isFile && tsconfig.isFile && nodeModules.isDirectory;
  const probe = yield* probeTypeAware(canProbe, tsconfigPath);
  return buildDoctorResult(
    {
      oxlintInstalled: oxlint.isFile,
      oxlintVersion,
      tsgolintInstalled: tsgolint.isFile,
      tsgolintVersion,
      tsconfigExists: tsconfig.isFile,
      nodeModulesExists: nodeModules.isDirectory,
      nativeSpecifiers: yield* nativeSpecifierSummary(),
    },
    probe,
  );
}
