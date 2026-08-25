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
 * ## What one read retains
 *
 * One ordinary durable effect. Its input is the whole normalized request —
 * operation, canonical URL, provider discriminator, collection, run and
 * expansion — so a reader of the history knows what was asked, and a document
 * edited to read a different URL or collection at that position is a different
 * effect rather than one replaying the first answer.
 *
 * It is not a reconciled Git-host effect. There is no natural key, no
 * pre-state and nothing to adopt: repeating a read is safe in the way
 * repeating a write is not, and a completed one restores from the journal
 * without opening a session.
 */

import { getExpansion, sourceDescription } from "@executablemd/core";
import { createDurableOperation } from "@executablemd/durable-streams";
import type { EffectDescription, Json as DurableJson } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { scoped } from "effection";
import { gitOperationFingerprint } from "./operations.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { parseJsonValue } from "../../storage/members.ts";
import { PullRequestReadError } from "../../composition/errors.ts";
import {
  parsePullRequestReadResult,
  pullRequestReadEnvelopeJson,
  pullRequestReadRequestJson,
  readRequest,
} from "../../composition/pull-request-read-records.ts";
import type {
  PullRequestReadKind,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import type { PullRequestReadOptions } from "../../composition/pull-request-api.ts";
import { getWorkflowRun } from "../../run.ts";
import { denoGitHubSource } from "./github.ts";
import type { GitHubRepositoryName, GitHubSource } from "./github.ts";
import { readPullRequestEvidence as readEvidence } from "./pull-request-evidence.ts";
import { upsertPullRequest } from "./pull-request.ts";
import type { RepositoryHost } from "./host.ts";
import type { PullRequestResult } from "../../composition/pull-request-records.ts";

/** The durable effect type one evidence read is retained under. */
export const PULL_REQUEST_READ = "pull_request_read";

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

function* describeRead(request: PullRequestReadRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  // The run is in the retained request, and deliberately not in this
  // fingerprint. A fork is a different run reaching the same position with the
  // same question, and a name that carried the run would make every inherited
  // read a different effect — which is to say, unforkable. What the name has to
  // separate is different *questions*, and the four members below are what a
  // question is made of.
  const configuration = gitOperationFingerprint([
    request.operation,
    request.url,
    request.provider,
    request.kind,
  ]);
  return {
    type: PULL_REQUEST_READ,
    name: `${request.expansionId}:${configuration}`,
    input: pullRequestReadRequestJson(request),
    configuration,
    ...sourceDescription(expansion.position),
  };
}

/** Perform one read and retain it, or restore what is retained. */
function retainedRead(
  database: WorkflowRunDatabase,
  source: GitHubSource,
  request: PullRequestReadRequest,
  name: GitHubPullRequestName,
): Operation<PullRequestReadResult> {
  const element = ELEMENT[request.kind];

  return scoped(function* () {
    const description = yield* describeRead(request);

    const stored = yield createDurableOperation<DurableJson>(
      description,
      function* (): Operation<DurableJson> {
        // After the ceiling, never before: a session opened first would be an
        // identity established for a target this host had not authorized.
        const access = yield* source.open();
        const reading = yield* readEvidence(access, name, name.number, request.kind);
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
        return pullRequestReadEnvelopeJson(reading.result);
      },
    );

    const result = parsePullRequestReadResult(
      parseJsonValue(
        stored,
        "$",
        (reason, path) =>
          new PullRequestReadError(
            "protocol",
            element,
            `what this run retained for it is not a value it can carry: ${reason} at ${path}.`,
          ),
      ),
    );
    if (result === undefined || result.kind !== request.kind) {
      throw new PullRequestReadError(
        "protocol",
        element,
        "what this run retained for it is not the evidence that read produces.",
      );
    }
    return result;
  });
}

/**
 * Install GitHub pull-request reading for the current scope and below.
 *
 * Installing a second adapter beside it needs no coordination between them, and
 * installing none leaves `PullRequestAPI`'s own base error to report that
 * nothing handled the request.
 */
export function* useGitHubPullRequests(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  options: GitHubPullRequestsOptions,
): Operation<void> {
  // A source rather than an access: it is credential-free, so holding one for
  // the middleware's whole lifetime retains nothing. A session — which does
  // have an identity — is opened per request, after that request is allowed.
  //
  // Precedence: an injected transport, then a configured endpoint, then the
  // platform's own GitHub. A suite that supplies its own access is not asking
  // for a different endpoint as well.
  const source =
    options.access ??
    (options.endpoint === undefined ? denoGitHubSource() : denoGitHubSource(options.endpoint));

  yield* PullRequestAPI.around({
    /**
     * The upsert this host performs, unchanged in everything but where it is
     * reached from.
     *
     * It still proves this run published the branch, still reconciles through
     * the Git-host engine, and still refuses a pull request belonging to
     * another Repository. What moved is only the surface: `<PullRequest>` asks
     * this Api rather than the Git composition one, so both questions about a
     * pull request are asked in the same place.
     */
    *upsert([pullRequest, options], next): Operation<PullRequestResult> {
      const mine = options.provider === undefined || options.provider === GITHUB;
      if (!mine) {
        return yield* next(pullRequest, options);
      }
      const outcome = yield* upsertPullRequest(
        database,
        host,
        {
          repository: options.repository,
          workingDirectory: options.workingDirectory,
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

      const run = yield* getWorkflowRun();
      const expansion = yield* getExpansion();
      return yield* retainedRead(
        database,
        source,
        readRequest(url, read.kind, read.provider, run.runId, expansion.id),
        name,
      );
    },
  });
}

/** The options a read carries, re-exported for a host installing this. */
export type { PullRequestReadOptions };
