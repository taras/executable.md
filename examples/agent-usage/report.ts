import type { UsageCoverage, UsageReading } from "@executablemd/core";
import type { Check } from "./evidence.ts";

/** One acknowledged Prompt, as the shareable report states it. */
export interface PromptReport {
  readonly status: "completed" | "failed" | "cancelled";
  readonly usage?: {
    readonly readings: readonly UsageReading[];
    readonly coverage: UsageCoverage;
  };
  readonly checks: {
    readonly usage: Check;
    readonly association: Check;
    readonly persistedAgreement: Check;
    readonly independentNative: Check;
  };
  readonly native?: {
    readonly calls: number;
    readonly toolCalls: number;
    readonly fixtureReads: number;
    readonly subagentCalls: number;
  };
}

/**
 * The feature-local calibration result.
 *
 * Selected counts, strict version tokens and digests, reviewed model
 * identifiers, fixed source semantics and categorical checks. No identity,
 * path, marker, prompt or reply text, and no native log, reaches it.
 */
export interface Report {
  readonly agent: "claude" | "codex";
  readonly host: "source" | "compiled";
  readonly scenario: string;
  readonly allowance: number;
  /** Outer Prompts reserved against the allowance by the invocations admitted. */
  readonly reservedPrompts: number;
  /** Submissions the evidence shows, or unknown when it cannot account for every reservation. */
  readonly observedSubmissions: number | "unknown";
  readonly observedAtLeast: number;
  readonly acknowledgedPrompts: number;
  readonly provenance: {
    readonly xmd: {
      readonly version?: string;
      readonly digest?: string;
      readonly sourceRevision?: string;
      readonly sourceClean?: boolean;
    };
    readonly runtime: { readonly version?: string; readonly digest?: string };
    readonly adapter: { readonly version?: string; readonly digest?: string };
    readonly native: { readonly version?: string; readonly digest?: string; readonly observedVersion?: string };
    readonly models: readonly string[];
  };
  readonly prompts: readonly PromptReport[];
  readonly scenarioChecks: Readonly<Record<string, Check>>;
  readonly readback: Check;
  readonly teardown: Check;
}

function line(name: string, item: Check): string {
  return `| ${name} | ${item.outcome} | ${item.reason} |`;
}

function value(text: string | undefined): string {
  return text ?? "unknown";
}

function tokens(reading: UsageReading): string {
  if (reading.kind === "tokens") {
    if (reading.tokens === null) {
      return "null";
    }
    const entries = Object.entries(reading.tokens);
    return entries.length === 0 ? "none reported" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
  }
  if (reading.kind === "context") {
    return `used=${reading.used ?? "unknown"}, size=${reading.size ?? "unknown"}`;
  }
  return `amount=${reading.amount ?? "unknown"}, currency=${reading.currency ?? "unknown"}`;
}

export function renderMarkdown(report: Report, result: string): string {
  const out: string[] = [
    `# Usage calibration: ${report.agent} on ${report.host}, ${report.scenario}`,
    "",
    `Result: **${result}**. Allowance ${report.allowance} outer Prompts; reserved ${report.reservedPrompts}; observed submissions ${report.observedSubmissions === "unknown" ? `unknown (at least ${report.observedAtLeast})` : report.observedSubmissions}; acknowledged ${report.acknowledgedPrompts}.`,
    "",
    "## Builds",
    "",
    `- XMD: version ${value(report.provenance.xmd.version)}, digest ${value(report.provenance.xmd.digest)}, source revision ${value(report.provenance.xmd.sourceRevision)}${report.provenance.xmd.sourceClean === false ? " (uncommitted changes present)" : ""}`,
    `- Runtime: version ${value(report.provenance.runtime.version)}`,
    `- Adapter: version ${value(report.provenance.adapter.version)}, digest ${value(report.provenance.adapter.digest)}`,
    `- Native: version ${value(report.provenance.native.version)}, digest ${value(report.provenance.native.digest)}, observed ${value(report.provenance.native.observedVersion)}`,
    `- Reported models: ${report.provenance.models.length === 0 ? "unknown" : report.provenance.models.join(", ")}`,
    "",
    "## Scenario",
    "",
    "| Check | Outcome | Reason |",
    "| --- | --- | --- |",
    ...Object.entries(report.scenarioChecks).map(([name, item]) => line(name, item)),
    line("history readback", report.readback),
    line("joined teardown", report.teardown),
    "",
  ];
  for (const [index, prompt] of report.prompts.entries()) {
    out.push(`## Prompt ${index + 1} (${prompt.status})`, "");
    out.push("| Check | Outcome | Reason |", "| --- | --- | --- |");
    out.push(line("usage retained", prompt.checks.usage));
    out.push(line("request to provider message", prompt.checks.association));
    out.push(line("persisted ACPX agreement", prompt.checks.persistedAgreement));
    out.push(line("independent native comparison", prompt.checks.independentNative));
    out.push("");
    if (prompt.native !== undefined) {
      out.push(
        `Native account: ${prompt.native.calls} model calls, ${prompt.native.toolCalls} tool calls, ${prompt.native.fixtureReads} fixture reads, ${prompt.native.subagentCalls} subagent calls.`,
        "",
      );
    }
    if (prompt.usage === undefined) {
      out.push("No usage was retained for this Prompt; its consumption is unknown.", "");
      continue;
    }
    out.push(
      `Coverage: final report ${prompt.usage.coverage.finalReport}; outer Prompt ${prompt.usage.coverage.outerPrompt}; limitations ${prompt.usage.coverage.limitations.join(", ") || "none"}.`,
      "",
      "| Source | Scope | Counter | Model | Values |",
      "| --- | --- | --- | --- | --- |",
      ...prompt.usage.readings.map(
        (reading) =>
          `| ${reading.source} | ${reading.scope} | ${reading.kind === "tokens" ? reading.counter : reading.kind} | ${reading.model ?? ""} | ${tokens(reading)} |`,
      ),
      "",
    );
  }
  out.push(
    "Source views of the same work are not additional spend, and no total here is an estimate or a price.",
    "",
  );
  return out.join("\n");
}
