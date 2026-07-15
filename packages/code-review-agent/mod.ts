/**
 * @executablemd/code-review-agent
 *
 * Provides parsers for transforming raw git diff and Oxlint output
 * into typed structures for use by executable.md review components.
 */

export { parseDiff } from "./src/parse-diff.ts";
export { parseDiagnostics } from "./src/parse-diagnostics.ts";
export { parseDoctorResult } from "./src/parse-doctor.ts";
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
