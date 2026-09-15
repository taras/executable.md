/**
 * @executablemd/code-review-agent
 *
 * The review component graph, as the Plugin a distribution bundles, and the
 * parsers behind the components in it.
 *
 * The default export is the Plugin. The named exports are the library they
 * always were, and `./review-components` still publishes the graph's own
 * assembly helpers.
 */

/**
 * The review graph as a Plugin — the package's default export, so a host that
 * selected this module has one unambiguous value to install.
 */
export { default } from "./src/plugin.ts";

export { parseDiff } from "./src/parse-diff.ts";
export { buildDiagnostics, parseDiagnostics } from "./src/parse-diagnostics.ts";
export { parseDoctorResult } from "./src/parse-doctor.ts";
export { buildDoctorResult, isOxlintCrash, summarizeDoctorProbe } from "./src/doctor.ts";
export { normalizeDiagnostic, normalizeOxlintOutput } from "./src/parse-oxlint.ts";
export type { DoctorEnvironment, DoctorProbeInput, DoctorProbeSummary } from "./src/doctor.ts";
export {
  buildCleanupAnalysis,
  clusterByFile,
  buildPolicyInput,
  buildPolicyReport,
  clusterDiagnostics,
  extractEvidence,
  scoreClusters,
} from "./src/policy.ts";
export {
  categorizeRule,
  STRUCTURAL_RULES,
  TYPE_AWARE_RULES,
  VERBOSITY_RULES,
} from "./src/categories.ts";
export type {
  CleanupAnalysis,
  CleanupEvidence,
  Diagnostics,
  DiagnosticGroup,
  DiffFile,
  DiffHunk,
  DiffLine,
  DoctorResult,
  FileCluster,
  FileKind,
  OxlintDiagnostic,
  PolicyCategory,
  PolicyCluster,
  PolicyInput,
  PolicyMode,
  PolicyReport,
  PolicyScore,
  PR,
} from "./src/types.ts";
