/**
 * Tests for parseDiagnostics — Oxlint JSON output parser.
 * Covers PD1-PD8 from the oxlint-sensor-spec.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { parseDiagnostics } from "../src/parse-diagnostics.ts";
import type { DoctorResult, OxlintDiagnostic, PR } from "../src/types.ts";

function makePR(additions = 100): PR {
  return {
    files: [],
    added: [],
    removed: [],
    created: [],
    modified: [],
    deleted: [],
    directories: new Set(),
    addedSource: "",
    diffPreview: "",
    stats: { totalFiles: 1, additions, deletions: 0, totalChanges: additions },
    meta: { title: "Test", body: "", number: "1" },
  };
}

function makeDoctor(
  overrides: Partial<DoctorResult> = {},
): DoctorResult {
  return {
    oxlintInstalled: true,
    oxlintVersion: "0.16.0",
    tsgolintInstalled: true,
    tsgolintVersion: "0.16.0",
    tsconfigExists: true,
    nodeModulesExists: true,
    typeAwareAvailable: true,
    filesAnalyzed: 10,
    filesSkipped: 0,
    importErrors: 0,
    bloatRulesAvailable: [],
    bloatRulesMissing: [],
    recommendation: "type-aware",
    nativeSpecifiers: { count: 0, files: [], jsr: 0, npm: 0 },
    ...overrides,
  };
}

function makeDiag(
  ruleId: string,
  file: string,
  line = 1,
  message = "",
): OxlintDiagnostic {
  return {
    ruleId,
    severity: "warning",
    message: message || `${ruleId} violation`,
    file,
    line,
    column: 1,
  };
}

describe("parseDiagnostics", () => {
  it("PD1: groups diagnostics by ruleId", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
      makeDiag("no-unused-vars", "src/b.ts"),
      makeDiag("no-console", "src/a.ts"),
    ]);

    const result = parseDiagnostics(raw, makePR(), makeDoctor());

    expect(result.groups).toHaveLength(2);
    const unused = result.groups.find((g) => g.ruleId === "no-unused-vars");
    expect(unused).toBeDefined();
    expect(unused!.count).toBe(2);
    expect(unused!.files).toEqual(["src/a.ts", "src/b.ts"]);

    const console = result.groups.find((g) => g.ruleId === "no-console");
    expect(console).toBeDefined();
    expect(console!.count).toBe(1);
  });

  it("PD2: computes density as total / additions", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
      makeDiag("no-unused-vars", "src/b.ts"),
      makeDiag("no-console", "src/a.ts"),
      makeDiag("no-console", "src/b.ts"),
      makeDiag("no-console", "src/c.ts"),
    ]);

    const result = parseDiagnostics(raw, makePR(50), makeDoctor());

    expect(result.total).toBe(5);
    expect(result.density).toBe(0.1);
  });

  it("PD2b: density is 0 when additions is 0", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
    ]);

    const result = parseDiagnostics(raw, makePR(0), makeDoctor());

    expect(result.density).toBe(0);
  });

  it("PD3: categorizes rules into structural, verbosity, typeAware", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
      makeDiag("no-console", "src/a.ts"),
      makeDiag("no-unnecessary-type-assertion", "src/a.ts"),
      makeDiag("no-inferrable-types", "src/b.ts"),
    ]);

    const result = parseDiagnostics(raw, makePR(), makeDoctor());

    expect(result.byCategory.structural.map((g) => g.ruleId))
      .toContain("no-unused-vars");
    expect(result.byCategory.structural.map((g) => g.ruleId))
      .toContain("no-unnecessary-type-assertion");

    expect(result.byCategory.verbosity.map((g) => g.ruleId))
      .toContain("no-console");
    expect(result.byCategory.verbosity.map((g) => g.ruleId))
      .toContain("no-inferrable-types");

    expect(result.byCategory.typeAware.map((g) => g.ruleId))
      .toContain("no-unnecessary-type-assertion");
  });

  it("PD4: filters import noise in type-aware-filtered mode", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
      makeDiag(
        "import/no-unresolved",
        "src/b.ts",
        1,
        'Cannot find module "jsr:@std/assert"',
      ),
      makeDiag(
        "import/no-unresolved",
        "src/c.ts",
        1,
        "cannot find module foo",
      ),
    ]);

    const filtered = parseDiagnostics(
      raw,
      makePR(),
      makeDoctor({ recommendation: "type-aware-filtered" }),
    );

    expect(filtered.total).toBe(1);
    expect(filtered.groups).toHaveLength(1);
    expect(filtered.groups[0].ruleId).toBe("no-unused-vars");
  });

  it("PD4b: does NOT filter noise in type-aware mode", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
      makeDiag(
        "import/no-unresolved",
        "src/b.ts",
        1,
        'Cannot find module "jsr:@std/assert"',
      ),
    ]);

    const unfiltered = parseDiagnostics(
      raw,
      makePR(),
      makeDoctor({ recommendation: "type-aware" }),
    );

    expect(unfiltered.total).toBe(2);
  });

  it("PD5: annotates missing rules in summary", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
    ]);

    const result = parseDiagnostics(
      raw,
      makePR(),
      makeDoctor({
        bloatRulesMissing: [
          "no-unnecessary-type-assertion",
          "no-redundant-type-constituents",
        ],
      }),
    );

    expect(result.summary).toContain("2 type-aware rules unavailable");
    expect(result.summary).toContain("Density may be understated");
  });

  it("PD6: annotates scheme specifiers in summary", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
    ]);

    const result = parseDiagnostics(
      raw,
      makePR(),
      makeDoctor({
        nativeSpecifiers: {
          count: 5,
          files: ["src/a.ts", "src/b.ts"],
          jsr: 3,
          npm: 2,
        },
      }),
    );

    expect(result.summary).toContain("5 source files use scheme specifiers");
    expect(result.summary).toContain("no-scheme-specifiers plugin");
  });

  it("PD7: empty input returns zero diagnostics", function* () {
    const result = parseDiagnostics("[]", makePR(), makeDoctor());

    expect(result.total).toBe(0);
    expect(result.density).toBe(0);
    expect(result.groups).toHaveLength(0);
    expect(result.fileCount).toBe(0);
    expect(result.ruleCount).toBe(0);
  });

  it("accepts oxlint object shape with diagnostics array", function* () {
    const raw = JSON.stringify({
      diagnostics: [
        makeDiag("no-unused-vars", "src/a.ts"),
        makeDiag("no-console", "src/b.ts"),
      ],
    });

    const result = parseDiagnostics(raw, makePR(), makeDoctor());

    expect(result.total).toBe(2);
    expect(result.groups.map((g) => g.ruleId)).toEqual([
      "no-unused-vars",
      "no-console",
    ]);
  });

  it("accepts nested diagnostics wrapper shape", function* () {
    const raw = JSON.stringify({
      diagnostics: {
        diagnostics: [
          makeDiag("no-unused-vars", "src/a.ts"),
        ],
      },
    });

    const result = parseDiagnostics(raw, makePR(), makeDoctor());

    expect(result.total).toBe(1);
    expect(result.groups[0].ruleId).toBe("no-unused-vars");
  });

  it("normalizes native oxlint fields", function* () {
    const raw = JSON.stringify({
      diagnostics: [
        {
          message: "Type 'X' is imported but never used.",
          code: "eslint(no-unused-vars)",
          severity: "warning",
          filename: "src/example.ts",
          labels: [{ span: { line: 12, column: 7 } }],
        },
      ],
    });

    const result = parseDiagnostics(raw, makePR(), makeDoctor());

    expect(result.total).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].ruleId).toBe("no-unused-vars");
    expect(result.groups[0].files).toEqual(["src/example.ts"]);
    expect(result.byCategory.structural.map((g) => g.ruleId)).toContain(
      "no-unused-vars",
    );
  });

  it("PD8: malformed JSON returns empty diagnostics", function* () {
    const result = parseDiagnostics(
      "not valid json {{{",
      makePR(),
      makeDoctor(),
    );

    expect(result.total).toBe(0);
    expect(result.density).toBe(0);
    expect(result.groups).toHaveLength(0);
  });

  it("sorts groups by count descending", function* () {
    const raw = JSON.stringify([
      makeDiag("no-console", "src/a.ts"),
      makeDiag("no-unused-vars", "src/a.ts"),
      makeDiag("no-unused-vars", "src/b.ts"),
      makeDiag("no-unused-vars", "src/c.ts"),
    ]);

    const result = parseDiagnostics(raw, makePR(), makeDoctor());

    expect(result.groups[0].ruleId).toBe("no-unused-vars");
    expect(result.groups[0].count).toBe(3);
    expect(result.groups[1].ruleId).toBe("no-console");
    expect(result.groups[1].count).toBe(1);
  });

  it("summary includes density and rule breakdown", function* () {
    const raw = JSON.stringify([
      makeDiag("no-unused-vars", "src/a.ts"),
      makeDiag("no-unused-vars", "src/b.ts"),
      makeDiag("no-console", "src/a.ts"),
    ]);

    const result = parseDiagnostics(raw, makePR(100), makeDoctor());

    expect(result.summary).toContain("3 diagnostics across 2 files (2 rules)");
    expect(result.summary).toContain("Density: 0.030 violations/added-line");
    expect(result.summary).toContain("no-unused-vars (2)");
    expect(result.summary).toContain("no-console (1)");
  });

  it("handles plugin-prefixed rule IDs for categorization", function* () {
    const raw = JSON.stringify([
      makeDiag("eslint/no-unused-vars", "src/a.ts"),
      makeDiag("typescript/no-inferrable-types", "src/b.ts"),
    ]);

    const result = parseDiagnostics(raw, makePR(), makeDoctor());

    expect(result.byCategory.structural.map((g) => g.ruleId))
      .toContain("eslint/no-unused-vars");
    expect(result.byCategory.verbosity.map((g) => g.ruleId))
      .toContain("typescript/no-inferrable-types");
  });
});
