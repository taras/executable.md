import type {
  Diagnostics,
  DoctorResult,
  PolicyCluster,
  PolicyInput,
  PolicyMode,
  PolicyReport,
  PolicyScore,
  PR,
} from "./types.ts";

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
