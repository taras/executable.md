import type { Operation } from "effection";
import { normalizeOxlintOutput } from "@executablemd/code-review-agent";
import type { OxlintDiagnostic } from "@executablemd/code-review-agent";
import { exec } from "@executablemd/runtime";

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

export default function* OxlintDiagnostics({
  files,
  typeAware = false,
  tsconfigPath = ".reviews/tsconfig.oxlint.json",
}: OxlintDiagnosticsProps): Operation<OxlintDiagnostic[]> {
  if (files.length === 0) {
    return [];
  }

  const command = [
    ".reviews/.oxlint/oxlint",
    "--config",
    ".reviews/.oxlintrc.json",
    "--format",
    "json",
  ];
  const environment: Record<string, string> = {};
  if (typeAware) {
    command.push("--type-aware", "--tsconfig", tsconfigPath);
    environment.OXLINT_TSGOLINT_PATH = ".reviews/.oxlint/tsgolint";
  }
  command.push(...files);

  const result = yield* exec({ command, env: environment });
  if (result.exitCode > 1) {
    throw new Error(result.stderr || `Oxlint failed with exit code ${result.exitCode}`);
  }
  if (/panic|oom|out of memory|fatal|segmentation fault/i.test(result.stderr)) {
    throw new Error(result.stderr);
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(result.stderr || "Oxlint returned no JSON output");
  }
  return normalizeOxlintOutput(result.stdout, files);
}
