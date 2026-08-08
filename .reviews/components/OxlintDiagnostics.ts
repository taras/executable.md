import { type OxlintDiagnostic, normalizeOxlintOutput } from "@executablemd/code-review-agent";
import { exec } from "@executablemd/runtime";
import type { Operation } from "effection";

const OXLINT_PATH = ".reviews/.oxlint/oxlint";
const OXLINT_CONFIG = ".reviews/.oxlintrc.json";
const OXLINT_CRASH_PATTERN = /panic|oom|out of memory|fatal|segmentation fault/iu;

export const props = {
  type: "object",
  properties: {
    files: { type: "array", items: { type: "string" } },
    typeAware: { type: "boolean", default: false },
    tsconfigPath: { type: "string", default: ".reviews/tsconfig.oxlint.json" },
  },
  required: ["files"],
  additionalProperties: false,
};

export const returns = {
  type: "array",
  items: {
    type: "object",
    properties: {
      message: { type: "string" },
      ruleId: { type: "string" },
      severity: { type: "string" },
      file: { type: "string" },
      line: { type: "number" },
      column: { type: "number" },
    },
    required: ["message", "ruleId", "severity", "file", "line", "column"],
    additionalProperties: false,
  },
};

interface OxlintDiagnosticsProps {
  files: string[];
  typeAware?: boolean;
  tsconfigPath?: string;
}

interface OxlintCommand {
  command: string[];
  environment: Record<string, string>;
}

function oxlintCommand(files: string[], typeAware: boolean, tsconfigPath: string): OxlintCommand {
  const command = [OXLINT_PATH, "--config", OXLINT_CONFIG, "--format", "json"];
  const environment: Record<string, string> = {};
  if (typeAware) {
    command.push("--type-aware", "--tsconfig", tsconfigPath);
    environment.OXLINT_TSGOLINT_PATH = ".reviews/.oxlint/tsgolint";
  }
  command.push(...files);
  return { command, environment };
}

function oxlintFailure(exitCode: number, stdout: string, stderr: string): Error | undefined {
  if (exitCode > 1) {
    return new Error(stderr || `Oxlint failed with exit code ${exitCode}`);
  }
  if (OXLINT_CRASH_PATTERN.test(stderr)) {
    return new Error(stderr);
  }
  if (stdout.trim().length === 0) {
    return new Error(stderr || "Oxlint returned no JSON output");
  }
  return undefined;
}

function* runOxlint(
  files: string[],
  typeAware: boolean,
  tsconfigPath: string,
): Operation<OxlintDiagnostic[]> {
  if (files.length === 0) {
    return [];
  }

  const { command, environment } = oxlintCommand(files, typeAware, tsconfigPath);
  const result = yield* exec({ command, env: environment });
  const failure = oxlintFailure(result.exitCode, result.stdout, result.stderr);
  if (failure !== undefined) {
    throw failure;
  }
  return normalizeOxlintOutput(result.stdout, files);
}

export default function* OxlintDiagnostics({
  files,
  typeAware = false,
  tsconfigPath = ".reviews/tsconfig.oxlint.json",
}: OxlintDiagnosticsProps): Operation<OxlintDiagnostic[]> {
  return yield* runOxlint(files, typeAware, tsconfigPath);
}
