/**
 * Parses raw Oxlint JSON output into structured Diagnostics.
 *
 * Groups by ruleId, categorizes into structural/verbosity/typeAware/other,
 * filters import noise when doctor recommends it, computes density, and
 * generates a human-readable summary string.
 */

import { categorizeRule } from "./categories.ts";
import type {
  Diagnostics,
  DiagnosticGroup,
  DoctorResult,
  OxlintDiagnostic,
  PR,
} from "./types.ts";

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

/**
 * Parse raw Oxlint JSON output into structured diagnostics.
 */
export function parseDiagnostics(
  rawJson: string,
  pr: PR,
  doctor: DoctorResult,
): Diagnostics {
  let raw: OxlintDiagnostic[];
  try {
    const parsed = JSON.parse(rawJson);
    raw = Array.isArray(parsed) ? parsed : [];
  } catch {
    return emptyDiagnostics();
  }

  const filtered = doctor.recommendation === "type-aware-filtered"
    ? raw.filter((d) => {
      const msg = d.message ?? "";
      return !msg.includes("Cannot find module") && !msg.includes("cannot find");
    })
    : raw;

  // Group by ruleId
  const groupMap = new Map<string, OxlintDiagnostic[]>();
  for (const d of filtered) {
    const key = d.ruleId ?? "unknown";
    const arr = groupMap.get(key);
    if (arr) {
      arr.push(d);
    } else {
      groupMap.set(key, [d]);
    }
  }

  // Build groups sorted by count descending
  const groups: DiagnosticGroup[] = [...groupMap.entries()]
    .map(([ruleId, instances]) => ({
      ruleId,
      count: instances.length,
      files: [...new Set(instances.map((d) => d.file).filter(Boolean))],
      instances,
    }))
    .sort((a, b) => b.count - a.count);

  // Categorize groups
  const byCategory: Diagnostics["byCategory"] = {
    structural: [],
    verbosity: [],
    typeAware: [],
    other: [],
  };

  for (const group of groups) {
    const cats = categorizeRule(group.ruleId);
    for (const cat of cats) {
      byCategory[cat].push(group);
    }
  }

  const total = filtered.length;
  const allFiles = new Set(filtered.map((d) => d.file).filter(Boolean));
  const fileCount = allFiles.size;
  const ruleCount = groups.length;
  const density = pr.stats.additions > 0
    ? Math.round((total / pr.stats.additions) * 100) / 100
    : 0;

  // Generate summary
  const lines: string[] = [];
  lines.push(
    `Oxlint: ${total} diagnostic${total !== 1 ? "s" : ""} across ${fileCount} file${fileCount !== 1 ? "s" : ""} (${ruleCount} rule${ruleCount !== 1 ? "s" : ""})`,
  );
  lines.push(`Density: ${density} violations/added-line`);
  lines.push("");

  for (const g of groups) {
    const fileList = g.files.slice(0, 3).join(", ");
    const more = g.files.length > 3 ? ` (+${g.files.length - 3})` : "";
    lines.push(`  ${g.ruleId} (${g.count}): ${fileList}${more}`);
  }

  // Coverage annotations
  if (doctor.bloatRulesMissing.length > 0) {
    lines.push("");
    lines.push(
      `Note: ${doctor.bloatRulesMissing.length} type-aware rules unavailable (${doctor.bloatRulesMissing.join(", ")}). Density may be understated.`,
    );
  }

  if (doctor.nativeSpecifiers.count > 0) {
    lines.push("");
    lines.push(
      `Note: ${doctor.nativeSpecifiers.count} source files use scheme specifiers (jsr:, npm:).`,
    );
    lines.push(
      "Run `deno lint --fix` with no-scheme-specifiers plugin to migrate.",
    );
  }

  return {
    groups,
    total,
    fileCount,
    ruleCount,
    byCategory,
    summary: lines.join("\n"),
    density,
  };
}
