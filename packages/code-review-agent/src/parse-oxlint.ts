import type { OxlintDiagnostic } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function firstSpan(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const labels = record.labels;
  if (!Array.isArray(labels)) {
    return undefined;
  }
  const label = labels[0];
  if (!isRecord(label) || !isRecord(label.span)) {
    return undefined;
  }
  return label.span;
}

function ruleIdFromCode(code: string): string {
  const match = /\(([^)]+)\)/.exec(code);
  return match?.[1] ?? code;
}

/** Convert one Oxlint object to the bounded representation used by reviews. */
export function normalizeDiagnostic(value: unknown): OxlintDiagnostic | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = stringValue(value, "code");
  const span = firstSpan(value);
  return {
    message: stringValue(value, "message") ?? "",
    ruleId: stringValue(value, "ruleId") ?? (code ? ruleIdFromCode(code) : "unknown"),
    severity: stringValue(value, "severity") === "error" ? "error" : "warning",
    file: stringValue(value, "file") ?? stringValue(value, "filename") ?? "",
    line: numberValue(value, "line") ?? numberValue(span ?? {}, "line") ?? 0,
    column: numberValue(value, "column") ?? numberValue(span ?? {}, "column") ?? 0,
  };
}

function diagnosticEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const diagnostics = value.diagnostics;
  if (Array.isArray(diagnostics)) {
    return diagnostics;
  }
  if (isRecord(diagnostics) && Array.isArray(diagnostics.diagnostics)) {
    return diagnostics.diagnostics;
  }
  return undefined;
}

/**
 * Parse and bound Oxlint JSON before it enters an executable document value.
 * Unknown fields never cross this boundary.
 */
export function normalizeOxlintOutput(
  stdout: string,
  files?: readonly string[],
): OxlintDiagnostic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Oxlint returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = diagnosticEntries(parsed);
  if (!entries) {
    throw new Error("Oxlint JSON did not contain a diagnostics array");
  }

  const changed = files ? new Set(files) : undefined;
  return entries.flatMap((entry) => {
    const diagnostic = normalizeDiagnostic(entry);
    if (!diagnostic || (changed && !changed.has(diagnostic.file))) {
      return [];
    }
    return [diagnostic];
  });
}
