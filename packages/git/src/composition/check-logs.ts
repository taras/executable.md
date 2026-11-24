import { createContext } from "effection";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import type { CheckEvidence } from "./pull-request-read-records.ts";
import { PullRequestReadError } from "./errors.ts";

export interface CheckLogRequest {
  url: string;
  provider?: string;
  checkId: string;
  headSha: string;
  directory: string;
}

export const CheckLogs = createContext<(request: CheckLogRequest) => Operation<Json>>(
  "executablemd.git.check-logs",
);

export function logsDirectory(value: Json | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    /[\\:\p{Cc}]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PullRequestReadError(
      "protocol",
      "<PullRequest.Checks>",
      "`logs` must be a project-relative directory.",
    );
  }
  return value;
}

export function* downloadFailedChecks(
  url: string,
  provider: string | undefined,
  directory: string,
  checks: readonly CheckEvidence[],
): Operation<Json[]> {
  const logs: Json[] = [];
  const download = yield* CheckLogs.get();
  const seen = new Set<string>();
  for (const check of checks) {
    if (
      check.kind !== "check-run" ||
      check.status !== "completed" ||
      check.conclusion !== "failure" ||
      seen.has(check.id)
    ) {
      continue;
    }
    seen.add(check.id);
    const log =
      download === undefined
        ? { checkId: check.id, status: "error", message: "This host has no check log provider." }
        : yield* download({ url, provider, checkId: check.id, headSha: check.headSha, directory });
    if (log !== null) {
      logs.push(log);
    }
  }
  return logs;
}
