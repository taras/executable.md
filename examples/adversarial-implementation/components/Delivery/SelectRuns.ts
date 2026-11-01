import { selectAuthoritative } from "../../../../scripts/lib/main-health.ts";
import { z } from "zod";
import type { Json } from "@executablemd/core";
import type { Operation } from "effection";

const run = z.object({
  id: z.number().int().positive(),
  run_number: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  head_branch: z.string(),
  event: z.string(),
  name: z.string(),
  html_url: z.string(),
  actor: z.object({ login: z.string() }),
});
const input = z.object({
  revision: z.string(),
  mainRevision: z.string(),
  prPages: z.array(z.object({ workflow_runs: z.array(run) })),
  mainPages: z.array(z.object({ workflow_runs: z.array(run) })),
});
export const props = {
  type: "object",
  properties: {
    revision: { type: "string" },
    mainRevision: { type: "string" },
    prPages: { type: "array" },
    mainPages: { type: "array" },
  },
  required: ["revision", "mainRevision", "prPages", "mainPages"],
  additionalProperties: false,
};
export const returns = { type: "object" };
function convert(value: z.infer<typeof run>) {
  return {
    id: value.id,
    runNumber: value.run_number,
    attempt: value.run_attempt,
    status: value.status,
    conclusion: value.conclusion ?? undefined,
    headSha: value.head_sha,
    headBranch: value.head_branch,
    event: value.event,
    workflow: value.name,
    url: value.html_url,
    actor: value.actor.login,
  };
}

export default function* SelectRuns(values: Record<string, Json>): Operation<Json> {
  const data = input.parse(values);
  let ci: ReturnType<typeof convert> | undefined;
  for (const value of data.prPages.flatMap((page) => page.workflow_runs).map(convert)) {
    if (
      value.headSha !== data.revision ||
      value.event !== "pull_request" ||
      value.workflow !== "CI"
    ) {
      continue;
    }
    if (
      !ci ||
      value.runNumber > ci.runNumber ||
      (value.runNumber === ci.runNumber && value.attempt > ci.attempt)
    ) {
      ci = value;
    }
  }
  const main = selectAuthoritative(
    data.mainRevision,
    data.mainPages.flatMap((page) => page.workflow_runs).map(convert),
  );
  return {
    ci: ci ? { ...ci, conclusion: ci.conclusion ?? null } : null,
    main: main ? { ...main, conclusion: main.conclusion ?? null } : null,
  };
}
