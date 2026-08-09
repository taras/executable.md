import { type PR, parseDiff } from "@executablemd/code-review-agent";
import { exec, env as runtimeEnv } from "@executablemd/runtime";
import { fetch } from "@effectionx/fetch";
import type { Operation } from "effection";

export const props = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const returns = {
  type: "object",
  properties: {
    pr: { type: "object" },
    changedFilePaths: { type: "array", items: { type: "string" } },
  },
  required: ["pr", "changedFilePaths"],
  additionalProperties: false,
};

interface PullRequestResponse {
  body?: unknown;
}

interface ReviewContextValue {
  pr: Omit<PR, "directories"> & { directories: string[] };
  changedFilePaths: string[];
}

interface ReviewInputs {
  base: string;
  head: string;
  title: string;
  number: string;
  repository: string;
  localBody: string;
}

function isPullRequestResponse(value: unknown): value is PullRequestResponse {
  return typeof value === "object" && value !== null;
}

function* reviewInputs(): Operation<ReviewInputs> {
  return {
    base: (yield* runtimeEnv("BASE_SHA")) ?? "HEAD~1",
    head: (yield* runtimeEnv("HEAD_SHA")) ?? "HEAD",
    title: (yield* runtimeEnv("PR_TITLE")) ?? "",
    number: (yield* runtimeEnv("PR_NUMBER")) ?? "",
    repository: (yield* runtimeEnv("GITHUB_REPOSITORY")) ?? "",
    localBody: (yield* runtimeEnv("PR_BODY")) ?? "",
  };
}

function* gitOutput(command: string[], description: string): Operation<string> {
  const result = yield* exec({ command });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `${description} failed with exit code ${result.exitCode}`);
  }
  return result.stdout;
}

function* pullBody(repository: string, number: string, fallback: string): Operation<string> {
  if (fallback || !repository || !number) {
    return fallback;
  }

  const payload: unknown = yield* fetch(
    `https://api.github.com/repos/${repository}/pulls/${number}`,
  )
    .expect()
    .json();
  if (!isPullRequestResponse(payload)) {
    return fallback;
  }
  if (typeof payload.body === "string") {
    return payload.body;
  }
  return fallback;
}

export default function* ReviewContext(
  _props: Record<string, unknown>,
): Operation<ReviewContextValue> {
  const inputs = yield* reviewInputs();
  const range = `${inputs.base}...${inputs.head}`;
  const diff = yield* gitOutput(["git", "diff", range], "git diff");
  const names = yield* gitOutput(["git", "diff", "--name-status", range], "git diff --name-status");
  const body = yield* pullBody(inputs.repository, inputs.number, inputs.localBody);
  const parsed = parseDiff(diff, names, {
    title: inputs.title,
    body,
    number: inputs.number,
  });
  const pr = { ...parsed, directories: [...parsed.directories] };
  return { pr, changedFilePaths: pr.files.map((file) => file.path) };
}
