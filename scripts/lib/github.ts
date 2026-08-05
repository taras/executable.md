/**
 * The GitHub half of Main Health, behind one seam.
 *
 * Every field is parsed rather than coerced. A successful response missing a
 * field this depends on is a malformed response, and reading `""` or `0` out of
 * it would put a wrong report on a real issue — so it raises, during the read
 * phase, before any mutation.
 */
import { createContext } from "effection";
import type { Context, Operation } from "effection";
import { Stdio } from "@effectionx/process";

import { REPORT_LABEL } from "./main-health.ts";
import type { Authored, GitHubReads, IssueOperations, ReportHandle, Run } from "./main-health.ts";

export interface GhCommand {
  run(args: string[]): Operation<string>;
}

export const Gh: Context<GhCommand> = createContext<GhCommand>("main-health.gh");

/**
 * Keep successful payloads out of the Actions log while still capturing them.
 *
 * One reconciliation reads a commit, a run listing, an issue and every page of
 * its comments — hundreds of kilobytes of JSON, which buries the summary and
 * the warnings that the log exists to show. `expect()` collects a child's
 * stdout through its own subscription rather than through this Api, so
 * dropping the forward keeps the text available to parse.
 *
 * `stderr` is deliberately not overridden: it is where a failing `gh` explains
 * itself, and that is a diagnostic rather than a payload.
 */
export function quietPayloads(): Operation<void> {
  return Stdio.around({
    *stdout() {},
  });
}

const PER_PAGE = 100;

/**
 * A ceiling on pagination, so a runaway loop stops. It raises rather than
 * returning what it has: a truncated comment list drops the newest marker and
 * silently reports a run that was already reported.
 */
const PAGE_LIMIT = 50;

function fields(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return raise(what, "an object", value);
  }
  return Object.fromEntries(Object.entries(value));
}

function items(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    return raise(what, "an array", value);
  }
  return value;
}

function raise(what: string, expected: string, saw: unknown): never {
  throw new Error(`GitHub answered ${what} with ${JSON.stringify(saw)}, expected ${expected}`);
}

function text(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  // A body GitHub never filled is `null`, which is an empty body rather than a
  // malformed one. A missing key is malformed.
  if (value === null && key in source) {
    return "";
  }
  if (typeof value !== "string") {
    return raise(`${what}.${key}`, "a string", value);
  }
  return value;
}

function count(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return raise(`${what}.${key}`, "a number", value);
  }
  return value;
}

function login(source: Record<string, unknown>, key: string, what: string): string {
  return text(fields(source[key], `${what}.${key}`), "login", `${what}.${key}`);
}

function toRun(record: unknown): Run {
  const run = fields(record, "a workflow run");
  const conclusion = run.conclusion;
  if (conclusion !== null && typeof conclusion !== "string") {
    return raise("a workflow run.conclusion", "a string or null", conclusion);
  }
  return {
    id: count(run, "id", "a workflow run"),
    runNumber: count(run, "run_number", "a workflow run"),
    attempt: count(run, "run_attempt", "a workflow run"),
    status: text(run, "status", "a workflow run"),
    conclusion: conclusion === null ? undefined : conclusion,
    headSha: text(run, "head_sha", "a workflow run"),
    headBranch: text(run, "head_branch", "a workflow run"),
    event: text(run, "event", "a workflow run"),
    workflow: text(run, "name", "a workflow run"),
    url: text(run, "html_url", "a workflow run"),
    actor: login(run, "actor", "a workflow run"),
  };
}

export function githubReads(repo: string): GitHubReads {
  function* one(path: string): Operation<unknown> {
    const gh = yield* Gh.expect();
    return JSON.parse(yield* gh.run(["api", `repos/${repo}/${path}`]));
  }

  /** Every page, because the newest marker is on the last one. */
  function* every(path: string, what: string): Operation<unknown[]> {
    const gh = yield* Gh.expect();
    const separator = path.includes("?") ? "&" : "?";
    const collected: unknown[] = [];

    for (let page = 1; page <= PAGE_LIMIT; page += 1) {
      const query = `${separator}per_page=${PER_PAGE}&page=${page}`;
      const batch = items(
        JSON.parse(yield* gh.run(["api", `repos/${repo}/${path}${query}`])),
        what,
      );
      collected.push(...batch);
      if (batch.length < PER_PAGE) {
        return collected;
      }
    }

    throw new Error(`${what} did not end within ${PAGE_LIMIT} pages`);
  }

  return {
    *head(): Operation<string> {
      return text(fields(yield* one("commits/main"), "the head commit"), "sha", "the head commit");
    },

    // The listing reports each run's latest attempt, which is the attempt the
    // selector wants; the comparison stays anyway, so a listing that ever
    // reported otherwise would still resolve correctly.
    *runs(): Operation<Run[]> {
      const payload = fields(yield* one("actions/runs?branch=main&event=push"), "the run listing");
      return items(payload.workflow_runs, "the run listing").map(toRun);
    },

    *findReport(): Operation<ReportHandle | undefined> {
      const open = (yield* every(`issues?labels=${REPORT_LABEL}&state=open`, "the report listing"))
        .map((record) => fields(record, "an issue"))
        // The issues endpoint answers with pull requests too, and a pull request
        // is never this report.
        .filter((record) => record.pull_request === undefined);

      const report = open[0];
      if (report === undefined) {
        return undefined;
      }

      return {
        number: count(report, "number", "an issue"),
        assignees: items(report.assignees, "an issue.assignees").map((assignee) =>
          text(fields(assignee, "an assignee"), "login", "an assignee"),
        ),
        body: {
          author: login(report, "user", "an issue"),
          text: text(report, "body", "an issue"),
        },
      };
    },

    *comments(issue: number): Operation<Authored[]> {
      const all = yield* every(`issues/${issue}/comments`, "the comment listing");
      return all.map((record) => {
        const comment = fields(record, "a comment");
        return {
          author: login(comment, "user", "a comment"),
          text: text(comment, "body", "a comment"),
        };
      });
    },
  };
}

export function githubIssues(repo: string): IssueOperations {
  function* run(args: string[]): Operation<string> {
    const gh = yield* Gh.expect();
    return yield* gh.run(args);
  }

  return {
    // `--force` updates an existing label instead of failing on it, so this is
    // safe to run before every report. Without it the first red run on a
    // repository that has never had one fails at `--label`, and reports nothing.
    *ensureLabel(label: string): Operation<void> {
      yield* run([
        "label",
        "create",
        label,
        "--repo",
        repo,
        "--description",
        "CI concluded red on main; closes itself when main recovers",
        "--color",
        "B60205",
        "--force",
      ]);
    },

    *open(input): Operation<number> {
      const url = yield* run([
        "issue",
        "create",
        "--repo",
        repo,
        "--label",
        input.label,
        "--title",
        input.title,
        "--body",
        input.body,
      ]);
      const number = Number(url.trim().split("/").pop());
      if (!Number.isInteger(number)) {
        throw new Error(`gh issue create answered ${JSON.stringify(url)}, expected an issue URL`);
      }
      return number;
    },

    *comment(issue, body): Operation<void> {
      yield* run(["issue", "comment", String(issue), "--repo", repo, "--body", body]);
    },

    *close(issue): Operation<void> {
      yield* run(["issue", "close", String(issue), "--repo", repo, "--reason", "completed"]);
    },

    *assign(issue, assignee): Operation<void> {
      yield* run(["issue", "edit", String(issue), "--repo", repo, "--add-assignee", assignee]);
    },

    warn(message: string): void {
      console.log(`::warning::${message}`);
    },
  };
}
