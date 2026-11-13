import { fableUsageLimitNotice } from "../Delivery/usage-limit.ts";

export const props = { type: "object", properties: {}, additionalProperties: false };

export default function* DiagnosticSolvers() {
  return {
    primary: {
      key: "fable",
      provider: "claude",
      models: ["fable", "claude-fable-5-1[1m]"],
      effort: "high",
      quotaNotice: fableUsageLimitNotice,
    },
    fallback: {
      key: "astra",
      provider: "codex",
      models: ["gpt-6-astra"],
      effort: "high",
    },
  };
}
