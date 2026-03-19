import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import {
  buildCleanupAnalysis,
  buildPolicyInput,
  buildPolicyReport,
  clusterByFile,
  clusterDiagnostics,
  extractEvidence,
  scoreClusters,
} from "../src/policy.ts";
import type { Diagnostics } from "../src/types.ts";

function diagnosticsFixture(): Diagnostics {
  const unusedA = {
    ruleId: "no-unused-vars",
    severity: "warning" as const,
    message: "'x' is defined but never used.",
    file: "src/a.ts",
    line: 10,
    column: 1,
  };
  const unusedATwo = {
    ...unusedA,
    line: 14,
  };
  const emptyA = {
    ruleId: "no-empty-function",
    severity: "warning" as const,
    message: "Unexpected empty function.",
    file: "src/a.ts",
    line: 20,
    column: 1,
  };
  const consoleDemo = {
    ruleId: "no-console",
    severity: "warning" as const,
    message: "Unexpected console statement.",
    file: "demo/b.ts",
    line: 3,
    column: 1,
  };

  return {
    groups: [
      {
        ruleId: "no-unused-vars",
        count: 3,
        files: ["src/a.ts", "demo/b.ts"],
        instances: [unusedA, unusedATwo, {
          ...unusedA,
          file: "demo/b.ts",
          line: 9,
        }],
      },
      {
        ruleId: "no-console",
        count: 2,
        files: ["demo/b.ts"],
        instances: [consoleDemo, {
          ...consoleDemo,
          line: 7,
        }],
      },
      {
        ruleId: "no-empty-function",
        count: 1,
        files: ["src/a.ts"],
        instances: [emptyA],
      },
    ],
    total: 6,
    fileCount: 2,
    ruleCount: 3,
    byCategory: {
      structural: [
        {
          ruleId: "no-unused-vars",
          count: 3,
          files: ["src/a.ts", "demo/b.ts"],
          instances: [unusedA, unusedATwo, {
            ...unusedA,
            file: "demo/b.ts",
            line: 9,
          }],
        },
        {
          ruleId: "no-empty-function",
          count: 1,
          files: ["src/a.ts"],
          instances: [emptyA],
        },
      ],
      verbosity: [
        {
          ruleId: "no-console",
          count: 2,
          files: ["demo/b.ts"],
          instances: [consoleDemo, {
            ...consoleDemo,
            line: 7,
          }],
        },
      ],
      typeAware: [],
      other: [],
    },
    summary: "fixture",
    density: 0.6,
  };
}

describe("policy helpers", () => {
  it("builds policy input", function* () {
    const diagnostics = diagnosticsFixture();
    const input = buildPolicyInput("repo", diagnostics, {
      source: "tests",
    });

    expect(input.mode).toBe("repo");
    expect(input.diagnostics.total).toBe(6);
    expect(input.metadata?.source).toBe("tests");
    expect(typeof input.metadata?.generatedAt).toBe("string");
  });

  it("clusters diagnostics by category", function* () {
    const diagnostics = diagnosticsFixture();
    const clusters = clusterDiagnostics(buildPolicyInput("pr", diagnostics));

    expect(clusters).toHaveLength(3);
    expect(clusters[0].category).toBe("bloat");
    expect(clusters[1].category).toBe("slop");
    expect(clusters[2].category).toBe("bloat");
  });

  it("scores clusters and produces report", function* () {
    const diagnostics = diagnosticsFixture();
    const input = buildPolicyInput("pr", diagnostics);
    const clusters = clusterDiagnostics(input);
    const scores = scoreClusters(clusters);
    const report = buildPolicyReport(input);

    expect(scores).toHaveLength(3);
    expect(report.clusters).toHaveLength(3);
    expect(report.scores).toHaveLength(3);
    expect(report.summary).toContain("3 clusters");
  });

  it("builds ranked file clusters", function* () {
    const diagnostics = diagnosticsFixture();
    const fileClusters = clusterByFile(diagnostics);

    expect(fileClusters).toHaveLength(2);
    expect(fileClusters[0].file).toBe("src/a.ts");
    expect(fileClusters[0].kind).toBe("production");
    expect(fileClusters[0].coOccurrence).toBe(2);
    expect(fileClusters[0].score).toBeGreaterThan(fileClusters[1].score);
  });

  it("extracts evidence from top ranked files", function* () {
    const diagnostics = diagnosticsFixture();
    const fileClusters = clusterByFile(diagnostics);
    const evidence = extractEvidence(diagnostics, fileClusters, 1);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((entry) => entry.file === "src/a.ts")).toBe(true);
  });

  it("builds cleanup analysis prompt context", function* () {
    const diagnostics = diagnosticsFixture();
    const cleanup = buildCleanupAnalysis(diagnostics, 2);

    expect(cleanup.fileClusters).toHaveLength(2);
    expect(cleanup.evidence.length).toBeGreaterThan(0);
    expect(cleanup.promptContext).toContain("RANKED FILE CLUSTERS");
    expect(cleanup.promptContext).toContain("EVIDENCE");
  });
});
