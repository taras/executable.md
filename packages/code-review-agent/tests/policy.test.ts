import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import {
  buildPolicyInput,
  buildPolicyReport,
  clusterDiagnostics,
  scoreClusters,
} from "../src/policy.ts";
import type { Diagnostics } from "../src/types.ts";

function diagnosticsFixture(): Diagnostics {
  return {
    groups: [
      {
        ruleId: "no-unused-vars",
        count: 3,
        files: ["src/a.ts"],
        instances: [],
      },
      {
        ruleId: "no-console",
        count: 2,
        files: ["src/b.ts"],
        instances: [],
      },
    ],
    total: 5,
    fileCount: 2,
    ruleCount: 2,
    byCategory: {
      structural: [
        {
          ruleId: "no-unused-vars",
          count: 3,
          files: ["src/a.ts"],
          instances: [],
        },
      ],
      verbosity: [
        {
          ruleId: "no-console",
          count: 2,
          files: ["src/b.ts"],
          instances: [],
        },
      ],
      typeAware: [],
      other: [],
    },
    summary: "fixture",
    density: 0.5,
  };
}

describe("policy helpers", () => {
  it("builds policy input", function* () {
    const diagnostics = diagnosticsFixture();
    const input = buildPolicyInput("repo", diagnostics, {
      source: "tests",
    });

    expect(input.mode).toBe("repo");
    expect(input.diagnostics.total).toBe(5);
    expect(input.metadata?.source).toBe("tests");
    expect(typeof input.metadata?.generatedAt).toBe("string");
  });

  it("clusters diagnostics by category", function* () {
    const diagnostics = diagnosticsFixture();
    const clusters = clusterDiagnostics(buildPolicyInput("pr", diagnostics));

    expect(clusters).toHaveLength(2);
    expect(clusters[0].category).toBe("bloat");
    expect(clusters[1].category).toBe("slop");
  });

  it("scores clusters and produces report", function* () {
    const diagnostics = diagnosticsFixture();
    const input = buildPolicyInput("pr", diagnostics);
    const clusters = clusterDiagnostics(input);
    const scores = scoreClusters(clusters);
    const report = buildPolicyReport(input);

    expect(scores).toHaveLength(2);
    expect(report.clusters).toHaveLength(2);
    expect(report.scores).toHaveLength(2);
    expect(report.summary).toContain("2 clusters");
  });
});
