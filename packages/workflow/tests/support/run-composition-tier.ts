/**
 * Fixtures shared by the ordinary-provider tier suites.
 *
 * The tier is split by capability — ambient and local Git, managed checkouts,
 * live remotes — because one file describing all of it was long enough that
 * finding the case a failure belongs to was its own step. What every part of it
 * shares lives here, so the split does not become three drifting copies.
 */

import { exists, readdir } from "@effectionx/fs";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";
import { GitOperationAuthorityError } from "../../src/composition/errors.ts";
import {
  ManagedCheckoutError,
  NoAmbientRepositoryError,
} from "../../src/deno/run-composition/errors.ts";

/** The github.com repository the modeled store answers for. */
export const GITHUB_LOCATOR = "https://github.com/octo/project";

/** The head every modeled pull request in this file is opened from. */
export const HEAD = "a".repeat(40);

/**
 * The routes one modeled pull request answers a reviews read on.
 *
 * The pull request itself is one of them: an answer is authenticated against
 * the subject it claims, so a collection with no pull request behind it is
 * refused rather than bound.
 */
export function reviewRoutes(endpoint: string): Record<string, string> {
  return {
    "/repos/octo/project/pulls/4": JSON.stringify({
      number: 4,
      head: { sha: HEAD },
      base: { repo: { full_name: "octo/project" } },
    }),
    "/repos/octo/project/pulls/4/reviews": JSON.stringify([
      {
        id: 10,
        user: { login: "reviewer" },
        state: "APPROVED",
        body: "looks right",
        submitted_at: "2026-01-01T00:00:00Z",
        commit_id: HEAD,
        html_url: "https://github.test/pr/4#r10",
        pull_request_url: `${endpoint}/repos/octo/project/pulls/4`,
      },
    ]),
  };
}

/** Every route the three collections are read from, each answering its own. */
export function evidenceRoutes(endpoint: string): Record<string, string> {
  const subject = `${endpoint}/repos/octo/project/pulls/4`;
  return {
    ...reviewRoutes(endpoint),
    "/repos/octo/project/issues/4/comments": JSON.stringify([
      {
        id: 20,
        user: { login: "watcher" },
        body: "a conversation comment",
        created_at: "2026-01-01T01:00:00Z",
        updated_at: "2026-01-01T01:00:00Z",
        html_url: "https://github.test/pr/4#c20",
        issue_url: `${endpoint}/repos/octo/project/issues/4`,
      },
    ]),
    "/repos/octo/project/pulls/4/comments": JSON.stringify([
      {
        id: 21,
        pull_request_review_id: 10,
        user: { login: "reviewer" },
        body: "an inline comment",
        created_at: "2026-01-01T02:00:00Z",
        updated_at: "2026-01-01T02:00:00Z",
        html_url: "https://github.test/pr/4#d21",
        path: "packages/core/mod.ts",
        diff_hunk: "@@ -1 +1 @@\n-old\n+new",
        commit_id: HEAD,
        original_commit_id: HEAD,
        line: 12,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        in_reply_to_id: null,
        pull_request_url: subject,
      },
    ]),
    [`/repos/octo/project/commits/${HEAD}/check-runs`]: JSON.stringify({
      total_count: 1,
      check_runs: [
        {
          id: 30,
          head_sha: HEAD,
          name: "test-deno",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.test/run/30",
          started_at: "2026-01-01T03:00:00Z",
          completed_at: "2026-01-01T03:10:00Z",
          output: { title: "1 failed", summary: "a summary", text: null },
        },
      ],
    }),
    [`/repos/octo/project/commits/${HEAD}/status`]: JSON.stringify({
      sha: HEAD,
      statuses: [
        {
          id: 31,
          context: "deploy",
          state: "error",
          description: "a description",
          target_url: null,
          created_at: "2026-01-01T04:00:00Z",
          updated_at: "2026-01-01T04:00:00Z",
        },
      ],
    }),
  };
}

/** The second process every exclusive-ownership case runs. */
export const CHILD = fileURLToPath(new URL("./run-composition-child.ts", import.meta.url));
export const TOKEN = "test-token";

export const REMOTE = {
  commits: [
    { message: "first", entries: [{ path: "which.txt", content: "main\n" }] },
    {
      message: "release",
      branch: "release",
      entries: [{ path: "which.txt", content: "release\n" }],
    },
  ],
} as const;

export function isManagedRefusal(value: unknown): value is ManagedCheckoutError {
  return value instanceof ManagedCheckoutError;
}

export function isAuthorityFailure(value: unknown): value is GitOperationAuthorityError {
  return value instanceof GitOperationAuthorityError;
}

export function isMissingAmbient(value: unknown): value is NoAmbientRepositoryError {
  return value instanceof NoAmbientRepositoryError;
}

/** Every entry a slot holds, sorted, so a byte-level comparison is stable. */
export function* entriesOf(path: string): Operation<string[]> {
  if (!(yield* exists(path))) {
    return [];
  }
  return [...(yield* readdir(path))].sort();
}
