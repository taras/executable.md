/**
 * Parses the JSON string produced by Doctor.md into a typed DoctorResult.
 * Applies defaults for every field so downstream code never sees undefined.
 */

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

export function parseDoctorResult(json: string): DoctorResult {
  try {
    const parsed = JSON.parse(json);
    return {
      ...DEFAULTS,
      ...parsed,
      nativeSpecifiers: {
        ...DEFAULTS.nativeSpecifiers,
        ...(parsed.nativeSpecifiers ?? {}),
      },
    };
  } catch {
    return { ...DEFAULTS };
  }
}
