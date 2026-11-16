import { z } from "zod";

export const props = {
  type: "object",
  properties: { agent: { type: "string" } },
  required: ["agent"],
  additionalProperties: false,
};

const input = z.strictObject({ agent: z.string() });

function providerPolicy(agent: string) {
  return agent === "claude"
    ? { registration: "claude-workflow-role", inspectionDisplayName: null }
    : { registration: "acpx", inspectionDisplayName: agent === "codex" ? "Codex" : null };
}

export const inspectionRecipeSchema = z.strictObject({
  registration: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
  displayName: z.string().min(1),
});

export function inspectionRecipe(agent: string, model: string, effort: string) {
  const { registration, inspectionDisplayName } = providerPolicy(agent);
  return inspectionDisplayName === null
    ? null
    : { registration, agent, model, effort, displayName: inspectionDisplayName };
}

// deno-lint-ignore require-yield
export default function* ProviderName(value: unknown) {
  return providerPolicy(input.parse(value).agent).registration;
}
