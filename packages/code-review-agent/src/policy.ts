import type {
  CleanupAnalysis,
  CleanupEvidence,
  Diagnostics,
  DoctorResult,
  FileCluster,
  FileKind,
  OxlintDiagnostic,
  PolicyCluster,
  PolicyInput,
  PolicyMode,
  PolicyReport,
  PolicyScore,
  PR,
} from "./types.ts";
import { categorizeRule } from "./categories.ts";

export function buildPolicyInput(
  mode: PolicyMode,
  diagnostics: Diagnostics,
  options: {
    pr?: PR;
    doctor?: DoctorResult;
    source?: string;
  } = {},
): PolicyInput {
  return {
    mode,
    diagnostics,
    pr: options.pr,
    doctor: options.doctor,
    metadata: {
      source: options.source,
      generatedAt: new Date().toISOString(),
    },
  };
}

export function clusterDiagnostics(input: PolicyInput): PolicyCluster[] {
  const diagnostics = input.diagnostics;
  const clusters: PolicyCluster[] = [];

  const push = (
    category: PolicyCluster["category"],
    groups: Diagnostics["byCategory"][keyof Diagnostics["byCategory"]],
  ) => {
    for (const group of groups) {
      clusters.push({
        id: `${category}:${group.ruleId}`,
        category,
        ruleIds: [group.ruleId],
        files: group.files,
        count: group.count,
        summary: `${group.ruleId} appears ${group.count} time${group.count === 1 ? "" : "s"}`,
      });
    }
  };

  push("bloat", diagnostics.byCategory.structural);
  push("slop", diagnostics.byCategory.verbosity);
  push("correctness", diagnostics.byCategory.typeAware);
  push("correctness", diagnostics.byCategory.other);

  return clusters.sort((a, b) => b.count - a.count);
}

export function scoreClusters(clusters: PolicyCluster[]): PolicyScore[] {
  return clusters.map((cluster) => {
    const score = Math.min(100, cluster.count * 2);
    const confidence = score >= 30 ? "high" : score >= 12 ? "medium" : "low";
    return {
      clusterId: cluster.id,
      score,
      confidence,
    };
  });
}

export function buildPolicyReport(input: PolicyInput): PolicyReport {
  const clusters = clusterDiagnostics(input);
  const scores = scoreClusters(clusters);
  const summary = `Policy report: ${clusters.length} cluster${clusters.length === 1 ? "" : "s"} from ${input.diagnostics.total} diagnostics.`;

  return {
    summary,
    clusters,
    scores,
  };
}

function classifyFile(path: string): FileKind {
  if (/\.test\.|\.spec\.|(^|\/)tests\//.test(path)) {
    return "test";
  }
  if (/(^|\/)demo\//.test(path)) {
    return "demo";
  }
  if (/\.json$|\.ya?ml$|deno\.json|tsconfig/.test(path)) {
    return "config";
  }
  return "production";
}

export function clusterByFile(diagnostics: Diagnostics): FileCluster[] {
  const fileMap = new Map<string, OxlintDiagnostic[]>();

  for (const group of diagnostics.groups) {
    for (const instance of group.instances) {
      if (!instance.file) {
        continue;
      }

      const existing = fileMap.get(instance.file);
      if (existing) {
        existing.push(instance);
      } else {
        fileMap.set(instance.file, [instance]);
      }
    }
  }

  const clusters: FileCluster[] = [];

  for (const [file, instances] of fileMap.entries()) {
    const kind = classifyFile(file);
    const ruleIds = [...new Set(instances.map((d) => d.ruleId))];
    const categories = {
      structural: 0,
      verbosity: 0,
      typeAware: 0,
      other: 0,
    };

    for (const instance of instances) {
      const cats = categorizeRule(instance.ruleId);
      for (const cat of cats) {
        categories[cat]++;
      }
    }

    const coOccurrence = ruleIds.length;
    const kindWeight = kind === "production"
      ? 1
      : kind === "test"
      ? 0.3
      : kind === "demo"
      ? 0.2
      : 0.1;
    const score = Math.round(coOccurrence * instances.length * kindWeight);

    clusters.push({
      file,
      kind,
      totalViolations: instances.length,
      ruleIds,
      categories,
      coOccurrence,
      score,
    });
  }

  return clusters.sort((a, b) => b.score - a.score);
}

export function extractEvidence(
  diagnostics: Diagnostics,
  fileClusters: FileCluster[],
  topN = 10,
): CleanupEvidence[] {
  const topFiles = new Set(fileClusters.slice(0, topN).map((cluster) => cluster.file));
  const evidence: CleanupEvidence[] = [];

  for (const group of diagnostics.groups) {
    for (const instance of group.instances) {
      if (!topFiles.has(instance.file)) {
        continue;
      }

      if (evidence.length >= 40) {
        return evidence;
      }

      evidence.push({
        file: instance.file,
        ruleId: instance.ruleId,
        line: instance.line,
        message: instance.message,
      });
    }
  }

  return evidence;
}

export function buildCleanupAnalysis(
  diagnostics: Diagnostics,
  topN = 10,
): CleanupAnalysis {
  const fileClusters = clusterByFile(diagnostics);
  const evidence = extractEvidence(diagnostics, fileClusters, topN);
  const top = fileClusters.slice(0, topN);

  const lines: string[] = [];
  lines.push(`RANKED FILE CLUSTERS (top ${top.length} of ${fileClusters.length}):`);
  lines.push("");

  for (let i = 0; i < top.length; i++) {
    const cluster = top[i];
    lines.push(`${i + 1}. ${cluster.file} [${cluster.kind}]`);
    lines.push(
      `   Score: ${cluster.score} | Violations: ${cluster.totalViolations} | Co-occurring rules: ${cluster.coOccurrence}`,
    );
    lines.push(`   Rules: ${cluster.ruleIds.join(", ")}`);
    lines.push(
      `   Breakdown: structural=${cluster.categories.structural} slop=${cluster.categories.verbosity} type-aware=${cluster.categories.typeAware} other=${cluster.categories.other}`,
    );
  }

  if (evidence.length > 0) {
    lines.push("");
    lines.push("EVIDENCE (representative diagnostics from top files):");
    lines.push("");
    for (const item of evidence.slice(0, 20)) {
      lines.push(`  ${item.file}:${item.line} [${item.ruleId}] ${item.message}`);
    }
  }

  return {
    fileClusters,
    evidence,
    promptContext: lines.join("\n"),
  };
}
