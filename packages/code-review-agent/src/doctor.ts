import type { DoctorResult, OxlintDiagnostic } from "./types.ts";
import { TYPE_AWARE_RULES } from "./categories.ts";

const BLOAT_RULES = [
  "no-unused-vars",
  "no-inferrable-types",
  "no-empty-function",
  "no-empty-object-type",
  "no-useless-empty-export",
  "no-unnecessary-type-constraint",
  "no-unnecessary-parameter-property-assignment",
  "no-static-only-class",
  "no-console",
  "no-debugger",
  ...TYPE_AWARE_RULES,
];
const TYPE_AWARE_RULE_SET = new Set<string>(TYPE_AWARE_RULES);
const IMPORT_NOISE_RATIO = 0.3;
const OXLINT_CRASH_PATTERN = /panic|oom|out of memory|fatal|segmentation fault/iu;

export interface DoctorProbeSummary {
  typeAwareAvailable: boolean;
  filesAnalyzed: number;
  filesSkipped: number;
  importErrors: number;
  bloatRulesAvailable: string[];
  bloatRulesMissing: string[];
  recommendation: DoctorResult["recommendation"];
}

export interface DoctorProbeInput {
  diagnostics: readonly OxlintDiagnostic[];
  stderr: string;
  exitCode: number;
}

function bloatRulesFor(typeAwareAvailable: boolean): {
  available: string[];
  missing: string[];
} {
  if (typeAwareAvailable) {
    return { available: [...BLOAT_RULES], missing: [] };
  }
  return {
    available: BLOAT_RULES.filter((rule) => !TYPE_AWARE_RULE_SET.has(rule)),
    missing: [...TYPE_AWARE_RULES],
  };
}

function recommendationFor(
  typeAwareAvailable: boolean,
  ratio: number,
): DoctorResult["recommendation"] {
  if (!typeAwareAvailable) {
    return "syntax-only";
  }
  if (ratio < IMPORT_NOISE_RATIO) {
    return "type-aware";
  }
  return "type-aware-filtered";
}

function noiseRatio(total: number, importNoise: number): number {
  if (total === 0) {
    return 0;
  }
  return importNoise / total;
}

function isImportNoise(diagnostic: OxlintDiagnostic): boolean {
  return (
    diagnostic.message.includes("Cannot find module") ||
    diagnostic.message.includes("cannot find") ||
    diagnostic.ruleId.includes("import")
  );
}

export function isOxlintCrash(stderr: string): boolean {
  return OXLINT_CRASH_PATTERN.test(stderr);
}

/** Summarize a bounded type-aware probe without retaining its raw output. */
export function summarizeDoctorProbe(input: DoctorProbeInput): DoctorProbeSummary {
  const importNoise = input.diagnostics.filter(isImportNoise);
  const files = new Set(input.diagnostics.map((diagnostic) => diagnostic.file).filter(Boolean));
  const skippedFiles = new Set(importNoise.map((diagnostic) => diagnostic.file).filter(Boolean));
  const available = input.exitCode <= 1 && !isOxlintCrash(input.stderr);
  const ratio = noiseRatio(input.diagnostics.length, importNoise.length);
  const rules = bloatRulesFor(available);

  return {
    typeAwareAvailable: available,
    filesAnalyzed: files.size,
    filesSkipped: skippedFiles.size,
    importErrors: importNoise.length,
    bloatRulesAvailable: rules.available,
    bloatRulesMissing: rules.missing,
    recommendation: recommendationFor(available, ratio),
  };
}

export interface DoctorEnvironment {
  oxlintInstalled: boolean;
  oxlintVersion: string;
  tsgolintInstalled: boolean;
  tsgolintVersion: string;
  tsconfigExists: boolean;
  nodeModulesExists: boolean;
  nativeSpecifiers: DoctorResult["nativeSpecifiers"];
}

/** Construct the durable Doctor value from bounded environment observations. */
export function buildDoctorResult(
  environment: DoctorEnvironment,
  probe: DoctorProbeSummary,
): DoctorResult {
  return {
    ...environment,
    ...probe,
    nativeSpecifiers: {
      count: environment.nativeSpecifiers.count,
      files: [...environment.nativeSpecifiers.files],
      jsr: environment.nativeSpecifiers.jsr,
      npm: environment.nativeSpecifiers.npm,
    },
  };
}
