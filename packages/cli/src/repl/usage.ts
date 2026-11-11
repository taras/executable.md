import type { PromptRecord } from "@executablemd/core/host";
import { inertCommandText } from "./command-output.ts";

type Usage = NonNullable<PromptRecord["usage"]>;
type Reading = Usage["readings"][number];
type Tokens = NonNullable<Extract<Reading, { kind: "tokens" }>["tokens"]>;

export type ReplUsage = Readonly<Pick<Usage, "readings" | "coverage">>;

export function projectUsage(usage: PromptRecord["usage"]): ReplUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return Object.freeze({
    coverage: Object.freeze({
      ...usage.coverage,
      limitations: Object.freeze([...usage.coverage.limitations]),
    }),
    readings: Object.freeze(
      usage.readings.map((reading) =>
        Object.freeze(
          reading.kind === "tokens" && reading.tokens !== null
            ? { ...reading, tokens: Object.freeze({ ...reading.tokens }) }
            : { ...reading },
        ),
      ),
    ),
  });
}

function reported(usage: ReplUsage, source: Reading["source"]) {
  for (let index = usage.readings.length - 1; index >= 0; index -= 1) {
    const reading = usage.readings[index];
    if (reading?.kind === "tokens" && reading.source === source) {
      // An empty latest reading still supersedes older readings from this source.
      return reading.tokens !== null &&
        Object.values(reading.tokens).some((value) => value !== undefined)
        ? { reading, tokens: reading.tokens }
        : undefined;
    }
  }
  return undefined;
}

function countable(reading: Reading): boolean {
  return (
    reading.kind === "tokens" &&
    ((reading.scope === "main-loop" && reading.counter === "turn-total") ||
      (reading.scope === "last-request" && reading.counter === "snapshot"))
  );
}

function select(usage: ReplUsage) {
  const response = reported(usage, "response");
  const quota = reported(usage, "quota-total");
  const counted = [response, quota].find((one) => one !== undefined && countable(one.reading));
  return { counted, shown: counted ?? response ?? quota ?? reported(usage, "update") };
}

const number = new Intl.NumberFormat("en-US");
const scopeLabels = {
  "main-loop": "main loop",
  "last-request": "last request",
  "broader-model-work": "broader model work",
  session: "session",
  unknown: "unknown scope",
};
const limitations: ReadonlyMap<string, string> = new Map([
  ["claude-imputed-zero", "absent counters may be reported as zero"],
  ["claude-subagent-inclusion-unverified", "subagent inclusion unverified"],
  ["claude-quota-model-overlaps-response", "model and response views overlap"],
  ["codex-last-request-only", "last request only"],
  ["codex-reasoning-inclusion-unverified", "reasoning inclusion unverified"],
]);

function counter(value: number | undefined, label: string, subtotal = false): string {
  return value === undefined
    ? `${label} unknown`
    : `${number.format(value)} ${label}${subtotal ? " subtotal" : ""}`;
}

function counts(
  tokens: Tokens,
  inputSubtotal = false,
  outputSubtotal = false,
  totalSubtotal = false,
) {
  if (
    tokens.inputTokens === undefined &&
    tokens.outputTokens === undefined &&
    tokens.totalTokens !== undefined
  ) {
    return [counter(tokens.totalTokens, "reported total", totalSubtotal)];
  }
  return [
    counter(tokens.inputTokens, "in", inputSubtotal),
    counter(tokens.outputTokens, "out", outputSubtotal),
  ];
}

export function turnUsage(usage: ReplUsage | undefined): string {
  if (usage === undefined) {
    return "Usage unavailable";
  }
  const { counted, shown } = select(usage);
  const coverage = usage.coverage;
  if (shown === undefined) {
    return [
      "Usage unavailable",
      ...(usage.readings.some(
        (one) => one.kind === "tokens" && one.tokens !== null && Object.keys(one.tokens).length > 0,
      )
        ? ["unknown coverage"]
        : []),
      ...(coverage.finalReport === "unavailable" ? ["final report unavailable"] : []),
    ].join(" · ");
  }
  const scope = scopeLabels[shown.reading.scope];
  const quality =
    counted === undefined || coverage.outerPrompt === "unknown"
      ? `unknown coverage (${scope})`
      : coverage.outerPrompt === "partial"
        ? `partial (${scope})`
        : scope;
  return [
    "Usage",
    ...counts(shown.tokens),
    quality,
    ...(coverage.finalReport === "unavailable" ? ["final report unavailable"] : []),
  ].join(" · ");
}

export function usageDetails(usage: ReplUsage): readonly string[] {
  const details = usage.readings.flatMap((reading) => {
    if (reading.kind !== "tokens") {
      return [];
    }
    const fields =
      reading.tokens === null
        ? "reported null"
        : Object.entries(reading.tokens)
            .map(([key, value]) => `${key} ${number.format(value)}`)
            .join(" · ") || "counters unavailable";
    return [`${reading.source} · ${scopeLabels[reading.scope]} · ${reading.counter} · ${fields}`];
  });
  return [
    ...details,
    `Final report ${usage.coverage.finalReport}`,
    ...usage.coverage.limitations.map((one) => limitations.get(one) ?? inertCommandText(one)),
  ];
}

export function usageSummary(
  turns: readonly { readonly usage?: ReplUsage }[],
  label: "Sidekick total" | "Entry agents",
): string {
  if (turns.length === 0) {
    return `${label} · ${label === "Sidekick total" ? "No retained turns" : "No retained entry-agent turns"}`;
  }
  const input = { sum: 0, count: 0 };
  const output = { sum: 0, count: 0 };
  const total = { sum: 0, count: 0 };
  let contributions = 0;
  let unavailable = 0;
  let uncountable = 0;
  let partial = false;
  let unknown = false;
  let finalUnavailable = false;
  const scopes = new Set<Reading["scope"]>();
  const entryLimitations = new Set<string>();
  for (const { usage } of turns) {
    if (usage === undefined) {
      unavailable++;
      continue;
    }
    const { counted } = select(usage);
    finalUnavailable ||= usage.coverage.finalReport === "unavailable";
    unknown ||= usage.coverage.outerPrompt === "unknown";
    if (counted === undefined) {
      const reported = usage.readings.some(
        (one) => one.kind === "tokens" && one.tokens !== null && Object.keys(one.tokens).length > 0,
      );
      if (reported) {
        uncountable++;
        unknown = true;
      } else {
        unavailable++;
      }
      continue;
    }
    contributions++;
    scopes.add(counted.reading.scope);
    if (label === "Entry agents") {
      for (const limitation of usage.coverage.limitations) {
        if (
          limitation === "claude-imputed-zero" ||
          limitation === "claude-subagent-inclusion-unverified"
        ) {
          entryLimitations.add(limitations.get(limitation) ?? limitation);
        }
      }
    }
    partial ||= usage.coverage.outerPrompt !== "verified";
    for (const [field, value] of [
      [input, counted.tokens.inputTokens],
      [output, counted.tokens.outputTokens],
      [total, counted.tokens.totalTokens],
    ] as const) {
      if (value !== undefined) {
        field.sum += value;
        field.count++;
      }
    }
  }
  const tokens = {
    ...(input.count === 0 ? {} : { inputTokens: input.sum }),
    ...(output.count === 0 ? {} : { outputTokens: output.sum }),
    ...(total.count === 0 ? {} : { totalTokens: total.sum }),
  };
  const hasCounts = input.count > 0 || output.count > 0 || total.count > 0;
  const missing =
    input.count === 0 && output.count === 0
      ? total.count < contributions
      : input.count < contributions || output.count < contributions;
  return [
    label,
    ...(hasCounts
      ? counts(
          tokens,
          input.count < contributions,
          output.count < contributions,
          total.count < contributions,
        )
      : unknown
        ? []
        : ["Usage unavailable"]),
    ...(hasCounts && (partial || missing || finalUnavailable || contributions < turns.length)
      ? [
          label === "Entry agents" && scopes.size === 1
            ? `partial (${[...scopes].map((scope) => scopeLabels[scope]).join("")})`
            : "partial",
        ]
      : []),
    ...(unknown ? ["unknown coverage"] : []),
    ...entryLimitations,
    ...(finalUnavailable ? ["final report unavailable"] : []),
    ...(unavailable === 0
      ? []
      : [`${unavailable} ${unavailable === 1 ? "turn" : "turns"} unavailable`]),
    ...(uncountable === 0
      ? []
      : [`${uncountable} ${uncountable === 1 ? "turn" : "turns"} uncountable`]),
  ].join(" · ");
}
