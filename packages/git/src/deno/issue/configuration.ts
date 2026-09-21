/**
 * Where this adapter learns which issue trackers it may reach.
 *
 * A tracker URL a document writes is composition data: it says where an issue
 * is wanted, not that this deployment allows it. What allows it is here, beside
 * the credential, and it is the operator's to state — so it is read from the
 * environment rather than from anything a run can influence.
 *
 * Absence authorizes nothing, and that is fail-closed by construction: with no
 * ceiling, this adapter handles no destination and `<Issue>` reaches
 * `IssueApi`'s own base error, which says that nothing handles it. A deployment
 * that wants issues says so.
 *
 * Read when an invoked GitHub-backed operation needs it, never at startup.
 * Installing the Plugin, describing its syntax, validating a Plan and running
 * unrelated work read this variable not at all.
 *
 * Malformed configuration is refused rather than narrowed to what parsed. An
 * operator who wrote a ceiling this host could not read has not authorized the
 * empty set — they have made a mistake, and running with fewer targets than
 * they wrote would hide it until the day it mattered.
 */

import { env as readEnv } from "@executablemd/runtime";
import type { Operation } from "effection";
import { canonicalIssueTarget } from "../../issue/tracker.ts";
import type { GitHubIssuesConfiguration } from "./github.ts";

/** The variable that configures GitHub issue handling. */
export const GITHUB_ISSUES_ENV = "XMD_WORKFLOW_GITHUB_ISSUES";

/** What an operator wrote there, once it is something this host can use. */
export class GitHubIssuesConfigError extends Error {
  override name = "GitHubIssuesConfigError";

  constructor(sentence: string) {
    super(
      `${GITHUB_ISSUES_ENV} is not usable: ${sentence} Expected JSON such as ` +
        `{"ceiling":["https://github.com/owner/repo"],"endpoint":"https://api.github.com"} — ` +
        "ceiling is required, endpoint is optional. Unset it to authorize no tracker at all.",
    );
  }
}

/**
 * The GitHub issue options this host is configured with, or none.
 *
 * Strict about shape and about the URLs it holds. A ceiling entry that is not
 * the canonical name of a container is refused here rather than at the first
 * request, because a ceiling this host cannot read authorizes nothing and
 * saying so is the only honest answer to the operation that asked.
 */
export function* gitHubIssuesConfiguration(): Operation<GitHubIssuesConfiguration | undefined> {
  const written = yield* readEnv(GITHUB_ISSUES_ENV);
  if (written === undefined || written === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(written);
  } catch {
    throw new GitHubIssuesConfigError("it is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GitHubIssuesConfigError("it is not a JSON object.");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "ceiling" && key !== "endpoint") {
      throw new GitHubIssuesConfigError(
        `it carries ${JSON.stringify(key)}, which is not a member.`,
      );
    }
  }
  const declared = Reflect.get(parsed, "ceiling");
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new GitHubIssuesConfigError("its ceiling is not a non-empty array of container URLs.");
  }
  const ceiling: string[] = [];
  for (const entry of declared) {
    const canonical = canonicalIssueTarget(entry);
    if (canonical === undefined) {
      throw new GitHubIssuesConfigError(
        "one of its ceiling entries is not an http or https URL naming one container, free of " +
          "credentials, query and fragment.",
      );
    }
    ceiling.push(canonical);
  }
  const endpoint = Reflect.get(parsed, "endpoint");
  if (endpoint !== undefined && (typeof endpoint !== "string" || endpoint === "")) {
    throw new GitHubIssuesConfigError("its endpoint is not a URL.");
  }
  return Object.freeze({
    ceiling: Object.freeze(ceiling),
    ...(typeof endpoint === "string" ? { endpoint } : {}),
  });
}
