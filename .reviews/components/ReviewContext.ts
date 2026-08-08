import type { Operation } from "effection";
import { fetch } from "@effectionx/fetch";
import { parseDiff } from "@executablemd/code-review-agent";
import type { PR } from "@executablemd/code-review-agent";
import { env as runtimeEnv, exec } from "@executablemd/runtime";

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

function isPullRequestResponse(value: unknown): value is PullRequestResponse {
  return typeof value === "object" && value !== null;
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
  return typeof payload.body === "string" ? payload.body : fallback;
}

export default function* ReviewContext(
  _props: Record<string, unknown>,
): Operation<ReviewContextValue> {
  const base = (yield* runtimeEnv("BASE_SHA")) ?? "HEAD~1";
  const head = (yield* runtimeEnv("HEAD_SHA")) ?? "HEAD";
  const title = (yield* runtimeEnv("PR_TITLE")) ?? "";
  const number = (yield* runtimeEnv("PR_NUMBER")) ?? "";
  const repository = (yield* runtimeEnv("GITHUB_REPOSITORY")) ?? "";
  const localBody = (yield* runtimeEnv("PR_BODY")) ?? "";
  const range = `${base}...${head}`;

  const diff = yield* exec({ command: ["git", "diff", range] });
  if (diff.exitCode !== 0) {
    throw new Error(diff.stderr || `git diff failed with exit code ${diff.exitCode}`);
  }
  const names = yield* exec({ command: ["git", "diff", "--name-status", range] });
  if (names.exitCode !== 0) {
    throw new Error(
      names.stderr || `git diff --name-status failed with exit code ${names.exitCode}`,
    );
  }

  const body = yield* pullBody(repository, number, localBody);
  const parsed = parseDiff(diff.stdout, names.stdout, { title, body, number });
  const pr = { ...parsed, directories: [...parsed.directories] };
  return { pr, changedFilePaths: pr.files.map((file) => file.path) };
}
