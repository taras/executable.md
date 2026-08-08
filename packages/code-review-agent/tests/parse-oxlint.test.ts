import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { normalizeOxlintOutput } from "../src/parse-oxlint.ts";

describe("Oxlint normalization", () => {
  it("keeps only the bounded diagnostic fields and filters files", function* () {
    const result = normalizeOxlintOutput(
      JSON.stringify({
        diagnostics: [
          {
            message: "unused",
            code: "eslint(no-unused-vars)",
            severity: "warning",
            filename: "src/a.ts",
            labels: [{ span: { line: 4, column: 7 } }],
            source: "SECRET_SOURCE_EXCERPT",
            cause: "ARBITRARY_CAUSE",
            url: "https://example.invalid/diagnostic",
          },
          { message: "other", file: "src/b.ts" },
        ],
        stderr: "UNBOUNDED_STDERR",
      }),
      ["src/a.ts"],
    );

    expect(result).toEqual([
      {
        message: "unused",
        ruleId: "no-unused-vars",
        severity: "warning",
        file: "src/a.ts",
        line: 4,
        column: 7,
      },
    ]);
  });

  it("rejects malformed or unsupported output", function* () {
    expect(() => normalizeOxlintOutput("not json")).toThrow("malformed JSON");
    expect(() => normalizeOxlintOutput(JSON.stringify({ output: [] }))).toThrow(
      "diagnostics array",
    );
  });
});
