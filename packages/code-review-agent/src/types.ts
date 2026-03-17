/**
 * Types for the code review agent's parsed PR representation
 * and Oxlint diagnostic structures.
 */

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

export interface PR {
  files: DiffFile[];
  added: DiffLine[];
  removed: DiffLine[];
  created: DiffFile[];
  modified: DiffFile[];
  deleted: DiffFile[];
  directories: Set<string>;
  /** Concatenated content of all added lines. */
  addedSource: string;
  /** addedSource truncated to 80,000 characters. */
  diffPreview: string;
  stats: {
    totalFiles: number;
    additions: number;
    deletions: number;
    totalChanges: number;
  };
  meta: {
    title: string;
    body: string;
    number: string;
  };
}

export interface DiffFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "C";
  hunks: DiffHunk[];
  language: string;
  isTest: boolean;
  isConfig: boolean;
  isTypeDeclaration: boolean;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  file: string;
  lineNumber: number;
  isTest: boolean;
}

// ---------------------------------------------------------------------------
// Oxlint diagnostic types
// ---------------------------------------------------------------------------

export interface OxlintDiagnostic {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface DiagnosticGroup {
  ruleId: string;
  count: number;
  files: string[];
  instances: OxlintDiagnostic[];
}

export interface Diagnostics {
  groups: DiagnosticGroup[];
  total: number;
  fileCount: number;
  ruleCount: number;
  byCategory: {
    structural: DiagnosticGroup[];
    verbosity: DiagnosticGroup[];
    typeAware: DiagnosticGroup[];
    other: DiagnosticGroup[];
  };
  summary: string;
  density: number;
}

// ---------------------------------------------------------------------------
// Doctor result types
// ---------------------------------------------------------------------------

export interface DoctorResult {
  oxlintInstalled: boolean;
  oxlintVersion: string;
  tsgolintInstalled: boolean;
  tsgolintVersion: string;
  tsconfigExists: boolean;
  nodeModulesExists: boolean;
  typeAwareAvailable: boolean;
  filesAnalyzed: number;
  filesSkipped: number;
  importErrors: number;
  bloatRulesAvailable: string[];
  bloatRulesMissing: string[];
  recommendation: "type-aware" | "type-aware-filtered" | "syntax-only";
  nativeSpecifiers: {
    count: number;
    files: string[];
    jsr: number;
    npm: number;
  };
}

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type PolicyMode = "pr" | "repo";

export interface PolicyInput {
  mode: PolicyMode;
  diagnostics: Diagnostics;
  pr?: PR;
  doctor?: DoctorResult;
  metadata?: {
    source?: string;
    generatedAt?: string;
  };
}

export type PolicyCategory = "bloat" | "slop" | "correctness" | "scope";

export interface PolicyCluster {
  id: string;
  category: PolicyCategory;
  ruleIds: string[];
  files: string[];
  count: number;
  summary: string;
}

export interface PolicyScore {
  clusterId: string;
  score: number;
  confidence: "low" | "medium" | "high";
}

export interface PolicyReport {
  summary: string;
  clusters: PolicyCluster[];
  scores: PolicyScore[];
}
