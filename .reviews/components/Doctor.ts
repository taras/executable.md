import {
  type DoctorEnvironment,
  type DoctorResult,
  type OxlintDiagnostic,
  buildDoctorResult,
  isOxlintCrash,
  normalizeOxlintOutput,
  summarizeDoctorProbe,
} from "@executablemd/code-review-agent";
import { exec, glob, readTextFile, stat } from "@executablemd/runtime";
import type { Operation } from "effection";

const OXLINT_PATH = ".reviews/.oxlint/oxlint";
const TSGOLINT_PATH = ".reviews/.oxlint/tsgolint";
const OXLINT_CONFIG = ".reviews/.oxlintrc.json";
const NATIVE_SPECIFIER_PATTERN = /^\s*(?:import|export)\s.*?from\s+["'](?<scheme>jsr:|npm:)/u;

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
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  return "";
}

interface NativeSpecifierCounts {
  jsr: number;
  npm: number;
}

function nativeSpecifierCounts(source: string): NativeSpecifierCounts {
  const counts = { jsr: 0, npm: 0 };
  for (const line of source.split(/\r?\n/u)) {
    const scheme = NATIVE_SPECIFIER_PATTERN.exec(line)?.groups?.scheme;
    if (scheme === "jsr:") {
      counts.jsr++;
    }
    if (scheme === "npm:") {
      counts.npm++;
    }
  }
  return counts;
}

interface NativeSpecifierFile {
  path: string;
  counts: NativeSpecifierCounts;
}

function* nativeSpecifierFile(entry: {
  isFile: boolean;
  path: string;
}): Operation<NativeSpecifierFile | undefined> {
  if (!entry.isFile) {
    return undefined;
  }
  return { path: entry.path, counts: nativeSpecifierCounts(yield* readTextFile(entry.path)) };
}

function nativeSpecifierValue(files: NativeSpecifierFile[]): DoctorResult["nativeSpecifiers"] {
  let jsr = 0;
  let npm = 0;
  const paths: string[] = [];
  for (const file of files) {
    jsr += file.counts.jsr;
    npm += file.counts.npm;
    if (file.counts.jsr + file.counts.npm > 0) {
      paths.push(file.path);
    }
  }
  return { count: jsr + npm, files: [...new Set(paths)], jsr, npm };
}

function* nativeSpecifierFiles(
  entries: { isFile: boolean; path: string }[],
): Operation<NativeSpecifierFile[]> {
  const files: NativeSpecifierFile[] = [];
  for (const entry of entries) {
    const file = yield* nativeSpecifierFile(entry);
    if (file !== undefined) {
      files.push(file);
    }
  }
  return files;
}

function* nativeSpecifierSummary(): Operation<DoctorResult["nativeSpecifiers"]> {
  const entries = yield* glob({
    root: ".",
    patterns: ["packages/**/*.ts", "durable-effects/**/*.ts"],
    exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
  });
  return nativeSpecifierValue(yield* nativeSpecifierFiles(entries));
}

function probeCommand(tsconfigPath: string): string[] {
  return [
    OXLINT_PATH,
    "--config",
    OXLINT_CONFIG,
    "--type-aware",
    "--tsconfig",
    tsconfigPath,
    "--format",
    "json",
  ];
}

function probeFailure(exitCode: number, stdout: string, stderr: string): Error | undefined {
  if (exitCode > 1 && !isOxlintCrash(stderr)) {
    return new Error(stderr || `Oxlint probe failed with exit code ${exitCode}`);
  }
  if (stdout.trim().length === 0 && exitCode !== 0 && !isOxlintCrash(stderr)) {
    return new Error(stderr || "Oxlint probe returned no JSON output");
  }
  return undefined;
}

function probeDiagnostics(stdout: string): OxlintDiagnostic[] {
  if (stdout.trim().length === 0) {
    return [];
  }
  return normalizeOxlintOutput(stdout);
}

function* probeTypeAware(canProbe: boolean, tsconfigPath: string) {
  if (!canProbe) {
    return summarizeDoctorProbe({ diagnostics: [], stderr: "", exitCode: 2 });
  }

  const result = yield* exec({
    command: probeCommand(tsconfigPath),
    env: { OXLINT_TSGOLINT_PATH: TSGOLINT_PATH },
  });
  const failure = probeFailure(result.exitCode, result.stdout, result.stderr);
  if (failure !== undefined) {
    throw failure;
  }
  const diagnostics = probeDiagnostics(result.stdout);
  return summarizeDoctorProbe({
    diagnostics,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}

function* toolVersion(path: string): Operation<string> {
  const result = yield* stat(path);
  if (!result.isFile) {
    return "";
  }
  return yield* version([path, "--version"]);
}

function* doctorEnvironment(tsconfigPath: string): Operation<DoctorEnvironment> {
  const oxlint = yield* stat(OXLINT_PATH);
  const tsgolint = yield* stat(TSGOLINT_PATH);
  const tsconfig = yield* stat(tsconfigPath);
  const nodeModules = yield* stat("node_modules");
  return {
    oxlintInstalled: oxlint.isFile,
    oxlintVersion: yield* toolVersion(OXLINT_PATH),
    tsgolintInstalled: tsgolint.isFile,
    tsgolintVersion: yield* toolVersion(TSGOLINT_PATH),
    tsconfigExists: tsconfig.isFile,
    nodeModulesExists: nodeModules.isDirectory,
    nativeSpecifiers: yield* nativeSpecifierSummary(),
  };
}

export default function* Doctor({
  tsconfigPath = ".reviews/tsconfig.oxlint.json",
}: DoctorProps): Operation<DoctorResult> {
  const environment = yield* doctorEnvironment(tsconfigPath);
  const canProbe =
    environment.oxlintInstalled &&
    environment.tsgolintInstalled &&
    environment.tsconfigExists &&
    environment.nodeModulesExists;
  const probe = yield* probeTypeAware(canProbe, tsconfigPath);
  return buildDoctorResult(environment, probe);
}
