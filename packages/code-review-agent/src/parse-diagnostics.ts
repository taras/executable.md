import type { DiagnosticGroup, Diagnostics, DoctorResult, OxlintDiagnostic, PR } from "./types.ts";
import { categorizeRule } from "./categories.ts";
import { normalizeOxlintOutput } from "./parse-oxlint.ts";

const IMPORT_NOISE_MARKERS = ["Cannot find module", "cannot find"];
const SUMMARY_FILE_LIMIT = 3;
const DENSITY_PRECISION = 1000;

function emptyDiagnostics(): Diagnostics {
  return {
    groups: [],
    total: 0,
    fileCount: 0,
    ruleCount: 0,
    byCategory: {
      structural: [],
      verbosity: [],
      typeAware: [],
      other: [],
    },
    summary: "",
    density: 0,
  };
}

function isImportNoise(diagnostic: OxlintDiagnostic): boolean {
  return (
    IMPORT_NOISE_MARKERS.some((marker) => diagnostic.message.includes(marker)) ||
    diagnostic.ruleId.includes("import")
  );
}

function filteredDiagnostics(
  raw: readonly OxlintDiagnostic[],
  doctor: DoctorResult,
): OxlintDiagnostic[] {
  if (doctor.recommendation !== "type-aware-filtered") {
    return [...raw];
  }
  return raw.filter((diagnostic) => !isImportNoise(diagnostic));
}

function groupedDiagnostics(raw: readonly OxlintDiagnostic[]): Map<string, OxlintDiagnostic[]> {
  const groups = new Map<string, OxlintDiagnostic[]>();
  for (const diagnostic of raw) {
    const { ruleId } = diagnostic;
    const group = groups.get(ruleId);
    let next = [diagnostic];
    if (group !== undefined) {
      next = [...group, diagnostic];
    }
    groups.set(ruleId, next);
  }
  return groups;
}

function filesForGroup(instances: readonly OxlintDiagnostic[]): string[] {
  const files = new Set<string>();
  for (const diagnostic of instances) {
    if (diagnostic.file.length > 0) {
      files.add(diagnostic.file);
    }
  }
  return [...files];
}

function fileCountFor(raw: readonly OxlintDiagnostic[]): number {
  const files = new Set<string>();
  for (const diagnostic of raw) {
    if (diagnostic.file.length > 0) {
      files.add(diagnostic.file);
    }
  }
  return files.size;
}

function diagnosticGroups(raw: readonly OxlintDiagnostic[]): DiagnosticGroup[] {
  const groups = [...groupedDiagnostics(raw).entries()].map(([ruleId, instances]) => ({
    ruleId,
    count: instances.length,
    files: filesForGroup(instances),
    instances,
  }));
  const ordered: DiagnosticGroup[] = [];
  for (const group of groups) {
    const index = ordered.findIndex((candidate) => candidate.count < group.count);
    if (index === -1) {
      ordered.push(group);
    } else {
      ordered.splice(index, 0, group);
    }
  }
  return ordered;
}

function categorizedGroups(groups: readonly DiagnosticGroup[]): Diagnostics["byCategory"] {
  const byCategory: Diagnostics["byCategory"] = {
    structural: [],
    verbosity: [],
    typeAware: [],
    other: [],
  };
  for (const group of groups) {
    for (const category of categorizeRule(group.ruleId)) {
      byCategory[category].push(group);
    }
  }
  return byCategory;
}

function densityFor(pr: PR, total: number): number {
  if (pr.stats.additions === 0) {
    return 0;
  }
  return Math.round((total / pr.stats.additions) * DENSITY_PRECISION) / DENSITY_PRECISION;
}

function pluralized(count: number, singular: string, plural: string): string {
  if (count === 1) {
    return singular;
  }
  return plural;
}

interface SummaryInput {
  total: number;
  fileCount: number;
  ruleCount: number;
  density: number;
  groups: readonly DiagnosticGroup[];
  doctor: DoctorResult;
}

function summaryFor({
  total,
  fileCount,
  ruleCount,
  density,
  groups,
  doctor,
}: SummaryInput): string {
  const lines = [
    `Oxlint: ${total} ${pluralized(total, "diagnostic", "diagnostics")} across ${fileCount} ${pluralized(fileCount, "file", "files")} (${ruleCount} ${pluralized(ruleCount, "rule", "rules")})`,
    `Density: ${density.toFixed(3)} violations/added-line`,
    "",
  ];
  for (const group of groups) {
    const fileList = group.files.slice(0, SUMMARY_FILE_LIMIT).join(", ");
    const moreFiles = group.files.length - SUMMARY_FILE_LIMIT;
    let more = "";
    if (moreFiles > 0) {
      more = ` (+${moreFiles})`;
    }
    lines.push(`  ${group.ruleId} (${group.count}): ${fileList}${more}`);
  }
  appendDoctorNotes(lines, doctor);
  return lines.join("\n");
}

function appendDoctorNotes(lines: string[], doctor: DoctorResult): void {
  if (doctor.bloatRulesMissing.length > 0) {
    lines.push(
      "",
      `Note: ${doctor.bloatRulesMissing.length} type-aware rules unavailable (${doctor.bloatRulesMissing.join(", ")}). Density may be understated.`,
    );
  }
  if (doctor.nativeSpecifiers.count > 0) {
    lines.push(
      "",
      `Note: ${doctor.nativeSpecifiers.count} source files use scheme specifiers (jsr:, npm:).`,
      "Run `deno lint --fix` with no-scheme-specifiers plugin to migrate.",
    );
  }
}

/** Group bounded Oxlint diagnostics for review policies. */
export function buildDiagnostics(
  raw: readonly OxlintDiagnostic[],
  pr: PR,
  doctor: DoctorResult,
): Diagnostics {
  const filtered = filteredDiagnostics(raw, doctor);
  const groups = diagnosticGroups(filtered);
  const total = filtered.length;
  const fileCount = fileCountFor(filtered);
  const density = densityFor(pr, total);
  return {
    groups,
    total,
    fileCount,
    ruleCount: groups.length,
    byCategory: categorizedGroups(groups),
    summary: summaryFor({
      total,
      fileCount,
      ruleCount: groups.length,
      density,
      groups,
      doctor,
    }),
    density,
  };
}

/** Parse raw Oxlint JSON into structured diagnostics. */
export function parseDiagnostics(rawJson: string, pr: PR, doctor: DoctorResult): Diagnostics {
  try {
    return buildDiagnostics(normalizeOxlintOutput(rawJson), pr, doctor);
  } catch {
    return emptyDiagnostics();
  }
}
