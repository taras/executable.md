/**
 * Where the production host learns which pull requests it may read.
 *
 * A URL a document writes is composition data: it says which pull request is
 * wanted, not that this deployment allows reading it. What allows it is here,
 * beside the credential, and it is the operator's to state — so it is read from
 * the environment rather than from anything a run can influence.
 *
 * Absence authorizes no URL read, and that is fail-closed by construction: with
 * nothing allowed, `<PullRequest.Reviews>` and its two siblings reach
 * `PullRequestAPI`'s own base error and say that nothing handles the
 * destination. A deployment that wants to read pull requests says so.
 *
 * **It does not disable `<PullRequest>`.** An upsert names a branch this run
 * published rather than a URL a document wrote, and its authority is this run's
 * own matching Push evidence and the Git-host reconciliation behind it. Nothing
 * here is what admits it, so nothing here can withdraw it.
 *
 * Malformed configuration is refused rather than narrowed to what parsed. An
 * operator who wrote a list this host could not read has not authorized the
 * empty set — they have made a mistake, and running with fewer targets than
 * they wrote would hide it until the day it mattered.
 *
 * The member is `allowed`, not `ceiling`. "Authority ceiling" is what the
 * architecture calls the bound; what an operator writes is the list of places
 * this host is allowed to read, and naming it after the thing they are stating
 * is the difference between configuration and jargon. `XMD_WORKFLOW_GITHUB_ISSUES`
 * keeps `ceiling`: it is shipped, and renaming a live contract to match a new
 * one is a break with nothing behind it.
 */

import { env as readEnv } from "@executablemd/runtime";
import type { Operation } from "effection";
import { canonicalPullRequestUrl } from "@executablemd/workflow";
import type { GitHubPullRequestsOptions } from "@executablemd/workflow/deno";

/** The variable that configures GitHub pull-request reading. */
export const GITHUB_PULL_REQUESTS_ENV = "XMD_WORKFLOW_GITHUB_PULL_REQUESTS";

/** What an operator wrote there, once it is something this host cannot use. */
export class GitHubPullRequestsConfigError extends Error {
  override name = "GitHubPullRequestsConfigError";

  constructor(sentence: string) {
    super(
      `${GITHUB_PULL_REQUESTS_ENV} is not usable: ${sentence} Expected JSON such as ` +
        `{"allowed":["https://github.com/owner/repository"],"endpoint":"https://api.github.com"} — ` +
        "allowed is required, endpoint is optional. Unset it to authorize no URL read.",
    );
  }
}

/**
 * The canonical form of an API base, or `undefined` when it is not one.
 *
 * Looser than a container URL in exactly one way: a port is admitted, because a
 * loopback endpoint is how a deployment points this at something other than
 * GitHub's own. Credentials, a query and a fragment are refused for the same
 * reason they are refused everywhere else — none of them is part of naming a
 * place, and none is guessed at or stripped.
 */
function canonicalEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.hostname === "") {
    return undefined;
  }
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * The GitHub pull-request options this host is configured with, or none.
 *
 * Strict about shape and about the URLs it holds. An entry that is not the
 * canonical name of a container is refused here rather than at the first
 * request, because an operator reading a startup failure can fix it and a
 * document author reading a refusal mid-run cannot.
 */
export function* gitHubPullRequestsConfiguration(): Operation<
  GitHubPullRequestsOptions | undefined
> {
  const written = yield* readEnv(GITHUB_PULL_REQUESTS_ENV);
  if (written === undefined || written === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(written);
  } catch {
    throw new GitHubPullRequestsConfigError("it is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GitHubPullRequestsConfigError("it is not a JSON object.");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "allowed" && key !== "endpoint") {
      throw new GitHubPullRequestsConfigError(
        `it carries ${JSON.stringify(key)}, which is not a member.`,
      );
    }
  }
  const declared = Reflect.get(parsed, "allowed");
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new GitHubPullRequestsConfigError(
      "its allowed is not a non-empty array of container URLs.",
    );
  }
  const allowed: string[] = [];
  for (const entry of declared) {
    const canonical = canonicalPullRequestUrl(entry);
    if (canonical === undefined) {
      throw new GitHubPullRequestsConfigError(
        "one of its allowed entries is not an http or https URL naming one container, free of " +
          "credentials, query and fragment.",
      );
    }
    allowed.push(canonical);
  }
  const written_endpoint = Reflect.get(parsed, "endpoint");
  if (written_endpoint === undefined) {
    return Object.freeze({ allowed: Object.freeze(allowed) });
  }
  const endpoint = canonicalEndpoint(written_endpoint);
  if (endpoint === undefined) {
    throw new GitHubPullRequestsConfigError(
      "its endpoint is not an http or https API base, free of credentials, query and fragment.",
    );
  }
  return Object.freeze({ allowed: Object.freeze(allowed), endpoint });
}
