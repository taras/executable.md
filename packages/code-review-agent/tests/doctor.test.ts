import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { buildDoctorResult, summarizeDoctorProbe } from "../src/doctor.ts";

describe("Doctor analysis", () => {
  it("classifies import noise and chooses filtered type-aware mode", function* () {
    const summary = summarizeDoctorProbe({
      exitCode: 1,
      stderr: "",
      diagnostics: [
        {
          message: "Cannot find module x",
          ruleId: "import/no-unresolved",
          severity: "error",
          file: "a.ts",
          line: 1,
          column: 1,
        },
        {
          message: "unused",
          ruleId: "no-unused-vars",
          severity: "warning",
          file: "b.ts",
          line: 2,
          column: 1,
        },
      ],
    });

    expect(summary.typeAwareAvailable).toBe(true);
    expect(summary.recommendation).toBe("type-aware-filtered");
    expect(summary.importErrors).toBe(1);
    expect(summary.filesAnalyzed).toBe(2);
    expect(summary.filesSkipped).toBe(1);
  });

  it("classifies a type-aware crash without exporting raw process output", function* () {
    const summary = summarizeDoctorProbe({
      exitCode: 1,
      stderr: "tsgolint panic: OOM",
      diagnostics: [],
    });
    const result = buildDoctorResult(
      {
        oxlintInstalled: true,
        oxlintVersion: "oxlint 1",
        tsgolintInstalled: true,
        tsgolintVersion: "tsgolint 1",
        tsconfigExists: true,
        nodeModulesExists: true,
        nativeSpecifiers: { count: 0, files: [], jsr: 0, npm: 0 },
      },
      summary,
    );

    expect(result.typeAwareAvailable).toBe(false);
    expect(result.recommendation).toBe("syntax-only");
    expect(JSON.stringify(result)).not.toContain("panic");
  });
});
