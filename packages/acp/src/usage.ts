/**
 * What one ACP turn reports about its own usage
 * (specs/acp-client-spec.md §Prompt usage).
 *
 * The provider is the only reader of a turn's events and the only holder of its
 * terminal result, so this is where a turn's readings are observed. It is also
 * where they are interpreted: what a counter covers is a property of the
 * adapter build that produced it, and that knowledge lives in the table below,
 * one checked-in entry per adapter release whose sources were traced. A build
 * the table does not name reports its readings with unknown scope and counter
 * semantics rather than borrowing a neighbour's.
 *
 * Collection is observation. A reading that fails to normalize, a receiver that
 * throws and a coordinator that offers no receiver all leave the turn exactly as
 * it would have run, and never reach the provider-failure handling that cancels
 * or closes a turn.
 */

import type { Operation } from "effection";
import type {
  AgentLaunchCoordinator,
  PromptUsage,
  PromptUsageReporter,
  ReportedTokens,
  UsageBuild,
  UsageProvenance,
  UsageReading,
} from "@executablemd/core";
import type {
  AcpRuntimeEvent,
  AcpRuntimeQuotaTokens,
  AcpRuntimeTurnResult,
  AcpRuntimeUsageBreakdown,
} from "./acpx-runtime.ts";

/** What a host states about the XMD build a turn runs under. */
export interface PromptUsageHost {
  readonly host: UsageProvenance["host"];
  readonly xmd: UsageProvenance["xmd"];
}

/** The ACP runtime this package executes; see `../vendor/acpx/PROVENANCE.md`. */
const RUNTIME_BUILD: UsageBuild = Object.freeze({ version: "0.22.0" });

/** Fixed categorical limitations a record may carry. */
export const UsageLimitation = Object.freeze({
  finalReportUnavailable: "final-report-unavailable",
  sourceSemanticsUnknown: "source-semantics-unknown",
  nativeBuildUnobserved: "native-build-unobserved",
  adapterBuildUnknown: "adapter-build-unknown",
  normalizationFailed: "normalization-failed",
  updateBreakdownScopeUnknown: "update-breakdown-scope-unknown",
  costScopeUnverified: "cost-scope-unverified",
  claudeImputedZero: "claude-imputed-zero",
  claudeQuotaOverlapsResponse: "claude-quota-model-overlaps-response",
  claudeSubagentInclusionUnverified: "claude-subagent-inclusion-unverified",
  codexLastRequestOnly: "codex-last-request-only",
  codexReasoningInclusionUnverified: "codex-reasoning-inclusion-unverified",
});

interface ViewSemantics {
  readonly scope: UsageReading["scope"];
  readonly counter: "turn-total" | "snapshot" | "increment" | "unknown";
}

/** What one traced adapter release's views mean. */
interface SourceSemantics {
  readonly response: ViewSemantics;
  readonly quotaTotal: ViewSemantics;
  readonly quotaModel: ViewSemantics;
  /** How much of the outer Prompt a received final report covers. */
  readonly outerPrompt: "verified" | "partial" | "unknown";
  readonly limitations: readonly string[];
}

/**
 * The adapter releases whose usage sources were traced, by provider and version.
 *
 * Claude 0.70.0 reports its main agent loop's accumulated usage in the response
 * and mirrors it in `quota.token_count`; `quota.model_usage` counts that loop
 * together with Task subagents, sidechains and internal calls, so the two
 * overlap. It fills absent native counters with zero and always reports
 * `reasoningOutputTokens: 0` because thinking is billed inside output.
 *
 * Codex 1.6.2 builds both its response usage and its quota from the last
 * internal request's reading, which is reset when a prompt begins, so neither
 * covers a prompt that made several model calls. Reasoning is reported beside
 * output without established inclusion.
 */
const SEMANTICS: Readonly<Record<string, SourceSemantics>> = Object.freeze({
  "claude@0.70.0": {
    response: { scope: "main-loop", counter: "turn-total" },
    quotaTotal: { scope: "main-loop", counter: "turn-total" },
    quotaModel: { scope: "broader-model-work", counter: "turn-total" },
    outerPrompt: "partial",
    limitations: [
      UsageLimitation.claudeImputedZero,
      UsageLimitation.claudeQuotaOverlapsResponse,
      UsageLimitation.claudeSubagentInclusionUnverified,
    ],
  },
  "codex@1.6.2": {
    response: { scope: "last-request", counter: "snapshot" },
    quotaTotal: { scope: "last-request", counter: "snapshot" },
    quotaModel: { scope: "last-request", counter: "snapshot" },
    outerPrompt: "partial",
    limitations: [
      UsageLimitation.codexLastRequestOnly,
      UsageLimitation.codexReasoningInclusionUnverified,
    ],
  },
});

const UNKNOWN_SEMANTICS: SourceSemantics = Object.freeze<SourceSemantics>({
  response: { scope: "unknown", counter: "unknown" },
  quotaTotal: { scope: "unknown", counter: "unknown" },
  quotaModel: { scope: "unknown", counter: "unknown" },
  outerPrompt: "unknown",
  limitations: [UsageLimitation.sourceSemanticsUnknown],
});

function semanticsFor(agent: string, adapter: UsageBuild | undefined): SourceSemantics {
  if (adapter?.version === undefined) {
    return UNKNOWN_SEMANTICS;
  }
  return SEMANTICS[`${agent}@${adapter.version}`] ?? UNKNOWN_SEMANTICS;
}

/**
 * The receiver for this subscription, captured once and before native work.
 *
 * An acquisition that fails is a turn with no receiver, never a turn refused:
 * observation is optional, and an installation that offers none still runs.
 */
export function* capturePromptUsage(
  coordinator: AgentLaunchCoordinator | undefined,
  host: PromptUsageHost | undefined,
): Operation<PromptUsageReporter | undefined> {
  if (coordinator?.promptUsage === undefined || host === undefined) {
    return undefined;
  }
  try {
    return yield* coordinator.promptUsage();
  } catch {
    return undefined;
  }
}

function tokensFrom(
  value: AcpRuntimeUsageBreakdown | AcpRuntimeQuotaTokens | null | undefined,
  fields: readonly (keyof ReportedTokens)[],
): ReportedTokens | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const tokens: Record<string, number> = {};
  for (const field of fields) {
    const count = Reflect.get(value, field);
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      tokens[field] = count;
    }
  }
  return tokens;
}

const RESPONSE_FIELDS: readonly (keyof ReportedTokens)[] = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
  "thoughtTokens",
  "totalTokens",
];
const QUOTA_FIELDS: readonly (keyof ReportedTokens)[] = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cachedWriteTokens",
  "outputTokens",
  "reasoningOutputTokens",
];

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * One subscribed turn's usage, from its live events to its terminal result.
 *
 * Live updates replace rather than add: an adapter's update is the current
 * snapshot, so the latest context, cost and breakdown are what the turn last
 * said, and an occupancy-only update leaves an earlier cost or breakdown in
 * place. Nothing from a previous turn is carried, because each subscription
 * gets its own collector.
 */
export interface TurnUsage {
  /** A live event, as the turn's one reader saw it. Never throws. */
  observe(event: AcpRuntimeEvent): void;
  /** Report what the turn retained, once. Never throws. */
  settle(result: AcpRuntimeTurnResult | undefined): void;
}

export interface TurnUsageFacts {
  readonly agent: string;
  readonly requestId: string;
  readonly host: PromptUsageHost;
  readonly adapter?: UsageBuild;
  readonly native?: UsageBuild;
}

export function turnUsage(reporter: PromptUsageReporter, facts: TurnUsageFacts): TurnUsage {
  let context: { used?: number; size?: number } | undefined;
  let cost: { amount?: number; currency?: string } | undefined;
  let breakdown: ReportedTokens | undefined;
  let settled = false;

  function provenance(): UsageProvenance {
    return {
      host: facts.host.host,
      xmd: { ...facts.host.xmd },
      runtime: { ...RUNTIME_BUILD },
      adapter: { ...facts.adapter },
      ...(facts.native === undefined ? {} : { native: { ...facts.native } }),
    };
  }

  function build(result: AcpRuntimeTurnResult | undefined): PromptUsage {
    const semantics = semanticsFor(facts.agent, facts.adapter);
    const retained = result?.usage;
    const readings: UsageReading[] = [];
    const response = tokensFrom(retained?.response, RESPONSE_FIELDS);
    if (response !== undefined) {
      readings.push({
        source: "response",
        scope: semantics.response.scope,
        kind: "tokens",
        counter: semantics.response.counter,
        tokens: response,
      });
    }
    const quotaTotal = tokensFrom(retained?.quota?.tokenCount, QUOTA_FIELDS);
    if (quotaTotal !== undefined) {
      readings.push({
        source: "quota-total",
        scope: semantics.quotaTotal.scope,
        kind: "tokens",
        counter: semantics.quotaTotal.counter,
        tokens: quotaTotal,
      });
    }
    for (const row of retained?.quota?.modelUsage ?? []) {
      const tokens = tokensFrom(row.tokenCount, QUOTA_FIELDS);
      if (tokens !== undefined && typeof row.model === "string" && row.model.length > 0) {
        readings.push({
          source: "quota-model",
          scope: semantics.quotaModel.scope,
          model: row.model,
          kind: "tokens",
          counter: semantics.quotaModel.counter,
          tokens,
        });
      }
    }
    const limitations = [...semantics.limitations];
    if (breakdown !== undefined) {
      readings.push({
        source: "update",
        scope: "unknown",
        kind: "tokens",
        counter: "unknown",
        tokens: breakdown,
      });
      limitations.push(UsageLimitation.updateBreakdownScopeUnknown);
    }
    if (context !== undefined) {
      readings.push({ source: "update", scope: "session", kind: "context", ...context });
    }
    if (cost !== undefined) {
      readings.push({ source: "update", scope: "unknown", kind: "cost", ...cost });
      limitations.push(UsageLimitation.costScopeUnverified);
    }
    const finalReport = response !== undefined || quotaTotal !== undefined;
    if (!finalReport) {
      limitations.push(UsageLimitation.finalReportUnavailable);
    }
    if (facts.adapter?.version === undefined) {
      limitations.push(UsageLimitation.adapterBuildUnknown);
    }
    if (facts.native === undefined) {
      limitations.push(UsageLimitation.nativeBuildUnobserved);
    }
    return {
      requestId: facts.requestId,
      ...(retained?.acpxRecordId === undefined ? {} : { providerRecordId: retained.acpxRecordId }),
      ...(retained?.promptMessageId === undefined
        ? {}
        : { providerMessageId: retained.promptMessageId }),
      ...(retained?.sessionId === undefined ? {} : { providerSessionId: retained.sessionId }),
      provenance: provenance(),
      readings,
      coverage: {
        finalReport: finalReport ? "received" : "unavailable",
        outerPrompt: finalReport ? semantics.outerPrompt : "unknown",
        limitations,
      },
    };
  }

  return {
    observe(event) {
      if (settled || event.type !== "status" || event.tag !== "usage_update") {
        return;
      }
      try {
        const used = finite(event.used);
        const size = finite(event.size);
        if (used !== undefined || size !== undefined) {
          context = {
            ...(used === undefined ? {} : { used }),
            ...(size === undefined ? {} : { size }),
          };
        }
        if (event.cost !== undefined) {
          const amount = finite(event.cost.amount);
          const currency =
            typeof event.cost.currency === "string" && event.cost.currency.length > 0
              ? event.cost.currency
              : undefined;
          if (amount !== undefined || currency !== undefined) {
            cost = {
              ...(amount === undefined ? {} : { amount }),
              ...(currency === undefined ? {} : { currency }),
            };
          }
        }
        const tokens = tokensFrom(event.breakdown, RESPONSE_FIELDS);
        if (tokens) {
          breakdown = tokens;
        }
      } catch {
        // A reading that does not normalize is a reading this turn lacks.
      }
    },
    settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      let usage: PromptUsage;
      try {
        usage = build(result);
      } catch {
        usage = {
          requestId: facts.requestId,
          provenance: provenance(),
          readings: [],
          coverage: {
            finalReport: "unavailable",
            outerPrompt: "unknown",
            limitations: [UsageLimitation.normalizationFailed],
          },
        };
      }
      try {
        reporter(usage);
      } catch {
        // The receiver is observation. Its failure is not this turn's.
      }
    },
  };
}
