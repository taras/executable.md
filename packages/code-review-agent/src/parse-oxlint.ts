import type { OxlintDiagnostic } from "./types.ts";

const RULE_CODE_PATTERN = /\((?<ruleId>[^)]+)\)/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function firstSpan(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const { labels } = record;
  if (!Array.isArray(labels)) {
    return undefined;
  }
  const [label] = Array.from(labels, (entry: unknown) => entry);
  if (!isRecord(label) || !isRecord(label.span)) {
    return undefined;
  }
  return label.span;
}

function spanNumber(span: Record<string, unknown> | undefined, key: string): number | undefined {
  if (span === undefined) {
    return undefined;
  }
  return numberValue(span, key);
}

function ruleIdFromCode(code: string): string {
  const match = RULE_CODE_PATTERN.exec(code);
  return match?.groups?.ruleId ?? code;
}

function ruleIdFor(value: Record<string, unknown>, code: string | undefined): string {
  const explicitRuleId = stringValue(value, "ruleId");
  if (explicitRuleId !== undefined) {
    return explicitRuleId;
  }
  if (code !== undefined) {
    return ruleIdFromCode(code);
  }
  return "unknown";
}

function severityFor(value: string | undefined): "error" | "warning" {
  if (value === "error") {
    return "error";
  }
  return "warning";
}

function positionFor(
  value: Record<string, unknown>,
  span: Record<string, unknown> | undefined,
  key: string,
): number {
  return numberValue(value, key) ?? spanNumber(span, key) ?? 0;
}

/** Convert one Oxlint object to the bounded representation used by reviews. */
export function normalizeDiagnostic(value: unknown): OxlintDiagnostic | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = stringValue(value, "code");
  const span = firstSpan(value);
  const severity = stringValue(value, "severity");
  const file = stringValue(value, "file") ?? stringValue(value, "filename") ?? "";
  return {
    message: stringValue(value, "message") ?? "",
    ruleId: ruleIdFor(value, code),
    severity: severityFor(severity),
    file,
    line: positionFor(value, span, "line"),
    column: positionFor(value, span, "column"),
  };
}

function diagnosticEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return Array.from(value, (entry: unknown) => entry);
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const { diagnostics } = value;
  if (Array.isArray(diagnostics)) {
    return Array.from(diagnostics, (entry: unknown) => entry);
  }
  if (isRecord(diagnostics) && Array.isArray(diagnostics.diagnostics)) {
    return Array.from(diagnostics.diagnostics, (entry: unknown) => entry);
  }
  return undefined;
}

function parseOxlintJson(stdout: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed;
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      const { message: errorMessage } = error;
      message = errorMessage;
    }
    throw new Error(`Oxlint returned malformed JSON: ${message}`, { cause: error });
  }
}

function changedFiles(files: readonly string[] | undefined): Set<string> | undefined {
  if (files === undefined) {
    return undefined;
  }
  return new Set(files);
}

/**
 * Parse and bound Oxlint JSON before it enters an executable document value.
 * Unknown fields never cross this boundary.
 */
export function normalizeOxlintOutput(
  stdout: string,
  files?: readonly string[],
): OxlintDiagnostic[] {
  const entries = diagnosticEntries(parseOxlintJson(stdout));
  if (entries === undefined) {
    throw new Error("Oxlint JSON did not contain a diagnostics array");
  }

  const changed = changedFiles(files);
  return entries.flatMap((entry) => {
    const diagnostic = normalizeDiagnostic(entry);
    if (diagnostic === undefined || (changed !== undefined && !changed.has(diagnostic.file))) {
      return [];
    }
    return [diagnostic];
  });
}
