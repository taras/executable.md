import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { parseDoctorResult } from "../mod.ts";

describe("parseDoctorResult", () => {
  it("parses a complete Doctor value", function* () {
    const result = parseDoctorResult(
      JSON.stringify({
        oxlintInstalled: true,
        recommendation: "type-aware",
        nativeSpecifiers: { count: 2, files: ["a.ts"], jsr: 1, npm: 1 },
      }),
    );

    expect(result.oxlintInstalled).toBe(true);
    expect(result.recommendation).toBe("type-aware");
    expect(result.nativeSpecifiers.count).toBe(2);
  });

  it("returns defaults for malformed input", function* () {
    const result = parseDoctorResult("not json");

    expect(result.oxlintInstalled).toBe(false);
    expect(result.recommendation).toBe("syntax-only");
    expect(result.nativeSpecifiers.files).toEqual([]);
  });
});
