import type { DoctorResult } from "./types.ts";

const DEFAULTS: DoctorResult = {
  oxlintInstalled: false,
  oxlintVersion: "",
  tsgolintInstalled: false,
  tsgolintVersion: "",
  tsconfigExists: false,
  nodeModulesExists: false,
  typeAwareAvailable: false,
  filesAnalyzed: 0,
  filesSkipped: 0,
  importErrors: 0,
  availableRuleIds: [],
  bloatRulesAvailable: [],
  bloatRulesMissing: [],
  recommendation: "syntax-only",
  nativeSpecifiers: {
    count: 0,
    files: [],
    jsr: 0,
    npm: 0,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function stringArrayValue(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (isStringArray(value)) {
    return value;
  }
  return undefined;
}

function recommendationValue(
  record: Record<string, unknown>,
): DoctorResult["recommendation"] | undefined {
  const value = record.recommendation;
  if (value === "type-aware" || value === "type-aware-filtered" || value === "syntax-only") {
    return value;
  }
  return undefined;
}

function nativeSpecifierValue(value: unknown): DoctorResult["nativeSpecifiers"] {
  if (!isRecord(value)) {
    return cloneNativeSpecifiers(DEFAULTS.nativeSpecifiers);
  }
  return {
    count: numberValue(value, "count") ?? DEFAULTS.nativeSpecifiers.count,
    files: stringArrayValue(value, "files") ?? [...DEFAULTS.nativeSpecifiers.files],
    jsr: numberValue(value, "jsr") ?? DEFAULTS.nativeSpecifiers.jsr,
    npm: numberValue(value, "npm") ?? DEFAULTS.nativeSpecifiers.npm,
  };
}

function cloneNativeSpecifiers(
  value: DoctorResult["nativeSpecifiers"],
): DoctorResult["nativeSpecifiers"] {
  return { ...value, files: [...value.files] };
}

function defaultDoctorResult(): DoctorResult {
  return {
    ...DEFAULTS,
    bloatRulesAvailable: [...DEFAULTS.bloatRulesAvailable],
    bloatRulesMissing: [...DEFAULTS.bloatRulesMissing],
    nativeSpecifiers: cloneNativeSpecifiers(DEFAULTS.nativeSpecifiers),
  };
}

function parseDoctorObject(record: Record<string, unknown>): DoctorResult {
  return {
    oxlintInstalled: booleanValue(record, "oxlintInstalled") ?? DEFAULTS.oxlintInstalled,
    oxlintVersion: stringValue(record, "oxlintVersion") ?? DEFAULTS.oxlintVersion,
    tsgolintInstalled: booleanValue(record, "tsgolintInstalled") ?? DEFAULTS.tsgolintInstalled,
    tsgolintVersion: stringValue(record, "tsgolintVersion") ?? DEFAULTS.tsgolintVersion,
    tsconfigExists: booleanValue(record, "tsconfigExists") ?? DEFAULTS.tsconfigExists,
    nodeModulesExists: booleanValue(record, "nodeModulesExists") ?? DEFAULTS.nodeModulesExists,
    typeAwareAvailable: booleanValue(record, "typeAwareAvailable") ?? DEFAULTS.typeAwareAvailable,
    filesAnalyzed: numberValue(record, "filesAnalyzed") ?? DEFAULTS.filesAnalyzed,
    filesSkipped: numberValue(record, "filesSkipped") ?? DEFAULTS.filesSkipped,
    importErrors: numberValue(record, "importErrors") ?? DEFAULTS.importErrors,
    availableRuleIds: stringArrayValue(record, "availableRuleIds") ?? [
      ...DEFAULTS.availableRuleIds,
    ],
    bloatRulesAvailable: stringArrayValue(record, "bloatRulesAvailable") ?? [
      ...DEFAULTS.bloatRulesAvailable,
    ],
    bloatRulesMissing: stringArrayValue(record, "bloatRulesMissing") ?? [
      ...DEFAULTS.bloatRulesMissing,
    ],
    recommendation: recommendationValue(record) ?? DEFAULTS.recommendation,
    nativeSpecifiers: nativeSpecifierValue(record.nativeSpecifiers),
  };
}

/** Parse the published Doctor JSON contract while applying safe defaults. */
export function parseDoctorResult(json: string): DoctorResult {
  try {
    const parsed: unknown = JSON.parse(json);
    if (isRecord(parsed)) {
      return parseDoctorObject(parsed);
    }
    return defaultDoctorResult();
  } catch {
    return defaultDoctorResult();
  }
}
