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
  pull_requests: z
    .array(
      z.object({
        number: z.number().int().positive(),
        head: z.object({ sha: z.string(), ref: z.string() }),
      }),
    )
    .default([]),
});
const input = z.object({
  number: z.number().int().positive(),
  branch: z.string().min(1),
  revision: z.string(),
  mainRevision: z.string(),
  prPages: z.array(z.object({ workflow_runs: z.array(run) })),
  mainPages: z.array(z.object({ workflow_runs: z.array(run) })),
});
export const props = {
  type: "object",
  properties: {
    number: { type: "integer", minimum: 1 },
    branch: { type: "string", minLength: 1 },
    revision: { type: "string" },
    mainRevision: { type: "string" },
    prPages: { type: "array" },
    mainPages: { type: "array" },
  },
  required: ["number", "branch", "revision", "mainRevision", "prPages", "mainPages"],
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
  for (const value of data.prPages.flatMap((page) => page.workflow_runs)) {
    if (
      value.head_sha !== data.revision ||
      value.head_branch !== data.branch ||
      value.event !== "pull_request" ||
      value.name !== "CI" ||
      !value.pull_requests.some(
        (pr) =>
          pr.number === data.number && pr.head.sha === data.revision && pr.head.ref === data.branch,
      )
    ) {
      continue;
    }
    if (
      !ci ||
      value.run_number > ci.runNumber ||
      (value.run_number === ci.runNumber && value.run_attempt > ci.attempt)
    ) {
      ci = convert(value);
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
