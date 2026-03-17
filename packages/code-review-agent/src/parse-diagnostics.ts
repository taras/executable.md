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

function extractDiagnosticsArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === "object") {
    const direct = (parsed as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(direct)) {
      return direct;
    }

    if (direct && typeof direct === "object") {
      const nested = (direct as { diagnostics?: unknown }).diagnostics;
      if (Array.isArray(nested)) {
        return nested;
      }
    }
  }

  return [];
}

function parseRuleId(code: string): string {
  const match = /\(([^)]+)\)/.exec(code);
  return match?.[1] ?? code;
}

function normalizeDiagnostic(entry: unknown): OxlintDiagnostic | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const diagnostic = entry as Record<string, unknown>;

  const ruleId = typeof diagnostic.ruleId === "string"
    ? diagnostic.ruleId
    : typeof diagnostic.code === "string"
    ? parseRuleId(diagnostic.code)
    : "unknown";

  const severity = diagnostic.severity === "error" ? "error" : "warning";
  const message = typeof diagnostic.message === "string" ? diagnostic.message : "";

  const file = typeof diagnostic.file === "string"
    ? diagnostic.file
    : typeof diagnostic.filename === "string"
    ? diagnostic.filename
    : "";

  const firstLabel = Array.isArray(diagnostic.labels)
    ? diagnostic.labels[0]
    : undefined;
  const firstSpan = firstLabel && typeof firstLabel === "object"
    ? (firstLabel as { span?: unknown }).span
    : undefined;

  const line = typeof diagnostic.line === "number"
    ? diagnostic.line
    : (firstSpan && typeof firstSpan === "object"
        && typeof (firstSpan as { line?: unknown }).line === "number")
    ? (firstSpan as { line: number }).line
    : 0;

  const column = typeof diagnostic.column === "number"
    ? diagnostic.column
    : (firstSpan && typeof firstSpan === "object"
        && typeof (firstSpan as { column?: unknown }).column === "number")
    ? (firstSpan as { column: number }).column
    : 0;

  return {
    ruleId,
    severity,
    message,
    file,
    line,
    column,
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
    raw = extractDiagnosticsArray(parsed)
      .map((entry) => normalizeDiagnostic(entry))
      .filter((entry): entry is OxlintDiagnostic => entry !== null);
  } catch {
    return emptyDiagnostics();
  }

  const filtered = doctor.recommendation === "type-aware-filtered"
    ? raw.filter((d) => {
      const msg = d.message ?? "";
      return !msg.includes("Cannot find module") && !msg.includes("cannot find");
    })
    : raw;

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
