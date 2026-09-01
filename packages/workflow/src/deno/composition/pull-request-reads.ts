/**
 * GitHub's pull-request middleware: reads by URL, retained.
 *
 * Ordinary middleware around `PullRequestAPI`, the way `useGitHubIssues` is
 * ordinary middleware around `IssueApi`. It looks at the URL, handles the ones
 * that are its own, and delegates the rest untouched. Once it matches, it owns
 * the answer: its validation and its refusal are final, and no fallback catches
 * them to try somewhere else.
 *
 * ## The URL is the identity
 *
 * A read needs no Repository in scope and no working directory. The repository
 * and the number are parsed out of the URL this middleware was handed, the
 * what is allowed is asked before a credential is read, and every response is held to
 * the URL that was requested rather than to whatever it says about itself.
 *
 * ## Transport, and only transport
 *
 * What a read *costs* — whether it is performed once and retained, or performed
 * afresh every execution — belongs to the profile above this, which is why both
 * profiles install this same middleware and answer that question differently.
 * Here there is one job: recognize the URL, hold it to the ceiling, open a
 * session, and hand back the normalized evidence.
 */

import type { Operation } from "effection";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { GitOperationAuthorityError, PullRequestReadError } from "../../composition/errors.ts";
import type {
  PullRequestReadKind,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import type { PullRequestReadOptions } from "../../composition/pull-request-api.ts";
import type { RepositoryRecord } from "../../composition/records.ts";
import type { SelectionRegistry } from "../selections.ts";
import { denoGitHubSource } from "./github.ts";
import type { GitHubRepositoryName, GitHubSource } from "./github.ts";
import { readPullRequestEvidence as readEvidence } from "./pull-request-evidence.ts";
import { upsertPullRequest } from "./pull-request.ts";
import type { RepositoryHost } from "./host.ts";
import { PULL_REQUEST_ELEMENT } from "../../composition/components/PullRequest.ts";
import type { PullRequestResult } from "../../composition/pull-request-records.ts";

/** How this middleware names itself when a document names it explicitly. */
export const GITHUB = "github";

/** Which element a refusal names, by the collection it was reading. */
const ELEMENT: Readonly<Record<PullRequestReadKind, string>> = Object.freeze({
  reviews: "<PullRequest.Reviews>",
  comments: "<PullRequest.Comments>",
  checks: "<PullRequest.Checks>",
});

/** One pull request on `github.com`, as a canonical URL names it. */
export interface GitHubPullRequestName extends GitHubRepositoryName {
  readonly number: number;
}

/**
 * The pull request this URL names, in the shape this adapter speaks.
 *
 * `/{owner}/{repository}/pull/{number}`, on any host — the *shape* is what this
 * parses, and which hosts are reachable is the ceiling's question and the
 * selection's, not this function's. A credential in the URL, a query, a
 * fragment, a missing segment and a number that is not one are each refused
 * here, before a ceiling is consulted and long before anything is sent.
 */
export function parseGitHubPullRequestUrl(url: string): GitHubPullRequestName | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return undefined;
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length !== 4 || segments[2] !== "pull") {
    return undefined;
  }
  const [owner, repository, , written] = segments;
  if (owner === undefined || repository === undefined || written === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(written)) {
    return undefined;
  }
  const number = Number(written);
  return Number.isSafeInteger(number) ? { owner, repository, number } : undefined;
}

/**
 * Whether this middleware recognizes the URL without being named.
 *
 * Public GitHub only. A self-hosted deployment wearing the same path shape is
 * reachable by naming `provider="github"` explicitly — implicit selection must
 * not claim a host nobody said was GitHub, because a search is how a document
 * that named one service quietly reaches a different one.
 */
export function recognizesGitHubPullRequestUrl(url: string): boolean {
  const parsed = parseGitHubPullRequestUrl(url);
  if (parsed === undefined) {
    return false;
  }
  try {
    return new URL(url).host === "github.com";
  } catch {
    return false;
  }
}

/**
 * Whether this host allows the pull request this URL names.
 *
 * An entry is a prefix by whole path segments, so a host that allowed
 * `https://github.com/octo` admits every pull request in every repository it
 * owns, and one that allowed `https://github.com/octo/project` admits that
 * repository alone. `https://github.com/octo/project-two` is *not* beneath
 * `.../project`, which is what "whole path segments" buys. Nothing a document
 * writes widens it.
 */
export function pullRequestAllowed(allowed: readonly string[], url: string): boolean {
  return allowed.some((entry) => url === entry || url.startsWith(`${entry}/`));
}

export interface GitHubPullRequestsOptions {
  /**
   * The canonical containers whose pull requests this host may read.
   *
   * Absent authorizes no URL read at all — and disables only reads. An upsert
   * names a branch this run published rather than a URL a document wrote, and
   * carries its own Repository, Push evidence and reconciliation authority, so
   * it is unaffected by what is or is not allowed here.
   */
  readonly allowed?: readonly string[];
  /** The API base every request is built against, when not the default. */
  readonly endpoint?: string;
  /** An injected transport, which outranks any configured endpoint. */
  readonly access?: GitHubSource;
}

/**
 * The source this adapter reaches GitHub through.
 *
 * Credential-free, so holding one for a middleware's whole lifetime retains
 * nothing. A session — which does have an identity — is opened per request,
 * after that request is allowed.
 *
 * Precedence: an injected transport, then a configured endpoint, then the
 * platform's own GitHub. A suite that supplies its own access is not asking for
 * a different endpoint as well.
 */
function sourceOf(options: GitHubPullRequestsOptions): GitHubSource {
  return (
    options.access ??
    (options.endpoint === undefined ? denoGitHubSource() : denoGitHubSource(options.endpoint))
  );
}

/**
 * Install GitHub pull-request reading for the current scope and below.
 *
 * Both profiles install exactly this. What a read *costs* — retained once, or
 * performed afresh every execution — is decided above it, at
 * `PullRequestOperations`; what is decided here is which URLs this host will
 * read at all and what a credential may see.
 *
 * Installing a second adapter beside it needs no coordination between them, and
 * installing none leaves `PullRequestAPI`'s own base error to report that
 * nothing handled the request.
 */
export function* useGitHubPullRequestReads(options: GitHubPullRequestsOptions): Operation<void> {
  const source = sourceOf(options);

  yield* PullRequestAPI.around({
    *read([url, read], next): Operation<PullRequestReadResult> {
      // Matched by discriminator, or — with no discriminator — by URL.
      // With nothing allowed there is no URL read this host performs, so the
      // request passes to whatever else is installed and, finding nothing,
      // reaches the surface's own base error. Upsert is untouched by this: it
      // is handled below whether or not any URL is allowed.
      const configured = options.allowed !== undefined && options.allowed.length > 0;
      const mine =
        configured &&
        (read.provider === undefined
          ? recognizesGitHubPullRequestUrl(url)
          : read.provider === GITHUB);
      if (!mine) {
        return yield* next(url, read);
      }

      const element = ELEMENT[read.kind];
      // From here this middleware owns the answer, and what is allowed is asked
      // before anything is built: a URL a document wrote is not a place this
      // host authorized until the configuration says so.
      if (!pullRequestAllowed(options.allowed ?? [], url)) {
        throw new PullRequestReadError(
          "unavailable",
          element,
          "this host has not authorized the pull request that URL names.",
        );
      }
      const name = parseGitHubPullRequestUrl(url);
      if (name === undefined) {
        throw new PullRequestReadError(
          "invalid-url",
          element,
          "that URL does not name a pull request this adapter can read.",
        );
      }

      // After the ceiling, never before: a session opened first would be an
      // identity established for a target this host had not authorized.
      const access = yield* source.open();
      const reading = yield* readEvidence(access, name, name.number, read.kind);
      if (reading.state === "unavailable") {
        throw new PullRequestReadError(
          "unavailable",
          element,
          "the Git host did not answer with the complete collection. None of what it did " +
            "answer is evidence that there is nothing there.",
        );
      }
      if (reading.state === "protocol-invalid") {
        throw new PullRequestReadError(
          "protocol",
          element,
          "the Git host answered about a different subject, or with an item outside the " +
            "evidence contract. A well-formed answer to another question is still the wrong " +
            "answer.",
        );
      }
      return reading.result;
    },
  });
}

/**
 * Install the workflow host's reconciled pull-request upsert, and its reads.
 *
 * The upsert is unchanged in everything but where it is reached from: it still
 * proves this run published the branch, still reconciles through the Git-host
 * engine, and still refuses a pull request belonging to another Repository. The
 * selection it is handed is resolved through the provider's own registry, never
 * believed, which is the same rule every Git operation follows.
 */
export function* useGitHubPullRequests(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  options: GitHubPullRequestsOptions,
  selections: SelectionRegistry<RepositoryRecord>,
): Operation<void> {
  const source = sourceOf(options);

  yield* PullRequestAPI.around({
    *upsert([pullRequest, upsert], next): Operation<PullRequestResult> {
      const mine = upsert.provider === undefined || upsert.provider === GITHUB;
      if (!mine) {
        return yield* next(pullRequest, upsert);
      }
      const outcome = yield* upsertPullRequest(
        database,
        host,
        {
          // The record this provider itself holds for the selection, never the
          // selection's own words: a Repository nobody selected is exactly what
          // a replaced context would name.
          repository: selections.authenticate(
            upsert.repository,
            () =>
              new GitOperationAuthorityError(
                PULL_REQUEST_ELEMENT,
                "the Repository in scope is not one this run selected, so it names no retained " +
                  "checkout",
              ),
          ),
          workingDirectory: upsert.workingDirectory,
          number: pullRequest.number,
          title: pullRequest.title,
          body: pullRequest.body,
          draft: pullRequest.draft,
          base: pullRequest.base,
        },
        source,
      );
      return outcome.result;
    },
  });
  yield* useGitHubPullRequestReads(options);
}

/** The options a read carries, re-exported for a host installing this. */
export type { PullRequestReadOptions };
