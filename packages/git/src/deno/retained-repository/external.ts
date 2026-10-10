/**
 * The external effects a retained entry performs: a push, a pull request, an
 * issue, and the three evidence reads.
 *
 * These five differ from the local operations beside them in where their answer
 * lives. A commit is finished when the object is in the checkout; a push is
 * finished when a Git host says so, and no record this entry appends can make
 * that true or untrue. So each one is two things in order:
 *
 * 1. **The request, frozen.** The resolved ask — which repository, which
 *    branch, which commit, which pull request, which issue text — is written
 *    down through the ordinary retained protocol before anything is contacted.
 *    None of these operations changes the checkout it was written in, so the
 *    two ends of that record are one state and the pair is complete before the
 *    service exists in the story. A later open reads the request back instead
 *    of resolving it again, which is the whole point: re-reading HEAD after the
 *    entry has committed would ask a different question, consume no retained
 *    result, and publish twice.
 *
 * 2. **The effect, reconciled.** The existing Git-host and Issue envelopes do
 *    the rest, under this entry's own owner and the authored occurrence its
 *    claimant authenticated. A completed one replays its record without
 *    selecting a provider or reaching a service; an interrupted one observes
 *    under the same frozen identity and adopts a compatible completion,
 *    performs proven absence once, refuses conflict and permanent ambiguity,
 *    and fails on temporary unavailability. Those records stay the only
 *    authority on what the service did.
 *
 * ## Why these are declared components
 *
 * The occurrence is the load-bearing part of an external identity: it is what
 * separates two identical `<Issue>` elements, and two iterations of one loop,
 * into two effects. `getExpansion()` reads a context a descendant may bind, so
 * it names an authored site and is not a permission boundary — which is why
 * each of these authenticates its own invocation through the claimant this
 * execution minted for it, in its own frame, and keeps the occurrence in the
 * closure that routes the operation.
 *
 * ## Publication
 *
 * `<PullRequest>` is admitted against this entry's own publications before an
 * adapter is selected, a credential is read or a request is sent. What a
 * publication is, and how it is rebuilt from accepted records, is
 * `publication.ts`.
 */

import { Err, Ok, scoped, useScope } from "effection";
import type { Operation, Result } from "effection";
import { cwd } from "@executablemd/runtime";
import { content, hasContent } from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import { PUSH, props as pushProps } from "../../composition/components/GitPush.ts";
import {
  PULL_REQUEST_ELEMENT,
  props as pullRequestProps,
  returns as pullRequestReturns,
} from "../../composition/components/PullRequest.ts";
import {
  ISSUE_ELEMENT,
  props as issueProps,
  returns as issueReturns,
} from "../../composition/components/Issue.ts";
import {
  CHECKS_ELEMENT,
  COMMENTS_ELEMENT,
  checksReturns,
  commentsReturns,
  props as readProps,
  REVIEWS_ELEMENT,
  reviewsReturns,
} from "../../composition/components/PullRequestReads.ts";
import {
  GitOperationAdmissionError,
  GitOperationError,
  GitOperationInfrastructureError,
  GitOperationProtocolError,
  PullRequestAdmissionError,
  PullRequestReadError,
} from "../../composition/errors.ts";
import {
  destinationRefFor,
  GIT_PUSH,
  gitPushInputsJson,
  gitPushNaturalKeyJson,
  parseGitPushRecord,
  PUSH_REMOTE,
  pushExpectation,
} from "../../composition/git-push-records.ts";
import {
  parsePullRequestRecord,
  PULL_REQUEST,
  pullRequestInputsJson,
  pullRequestNaturalKey,
  pullRequestNaturalKeyJson,
  pullRequestResultJson,
} from "../../composition/pull-request-records.ts";
import type { PullRequestInputs } from "../../composition/pull-request-records.ts";
import { pullRequestReadResultJson } from "../../composition/pull-request-read-records.ts";
import type { PullRequestReadKind } from "../../composition/pull-request-read-records.ts";
import {
  canonicalPullRequestUrl,
  pullRequestProviderName,
} from "../../composition/pull-request-target.ts";
import { PullRequestOperations } from "../../composition/pull-request-operations.ts";
import { reconcileOwnedGitHostEffect, withGitHostProvider } from "../../git-host/effect.ts";
import { currentIssueTracker } from "../../issue/context.ts";
import { readOwnedIssue, upsertOwnedIssue } from "../../issue/effect.ts";
import { IssueContentError, IssueProtocolError, IssueTrackerError } from "../../issue/errors.ts";
import { normalizedTags } from "../../issue/records.ts";
import {
  canonicalIssueTarget,
  issueProviderName,
  resolveIssueDestination,
} from "../../issue/tracker.ts";
import type { IssueInput } from "../../issue/api.ts";
import {
  parseRetainedPullRequestRequest,
  parseRetainedPushRequest,
  retainedIssueRequestJson,
  retainedPullRequestRequestJson,
  retainedPushRequestJson,
} from "../../retained-repository/requests.ts";
import type { RetainedPushRequest } from "../../retained-repository/requests.ts";
import { sameRetainedFrontier } from "../../retained-repository/records.ts";
import { currentBranch, resolveCommit } from "../composition/git.ts";
import type { GitHubAccess } from "../composition/github.ts";
import { pullRequestProvider } from "../composition/github-pull-request.ts";
import { objectSource } from "../composition/object-source.ts";
import { pushProvider } from "../composition/push.ts";
import { lazily } from "../run-composition/provider.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import type { GitHostCompletion, GitHostObservation } from "../../git-host/records.ts";
import { useGitAuthentication } from "../composition/host.ts";
import type { RepositoryHost } from "../composition/host.ts";
import type { GitCheckout } from "../composition/operations.ts";
import { gitRefusal } from "../composition/refusals.ts";
import { FrontierError, inventoryFrontier } from "./frontier.ts";
import { retain } from "./local.ts";
import type { RetainedFileHost, SelectedCheckout } from "./files.ts";
import { admitRetainedPublication } from "./publication.ts";
import type { RetainedPublication } from "./publication.ts";

/** Where these components report themselves as coming from. */
const RETAINED_ORIGIN = "@executablemd/git/retained";

/** What the external components need beyond the file host. */
export interface RetainedExternalHost {
  readonly files: RetainedFileHost;
  readonly repository: RepositoryHost;
  /** The pull-request transport this deployment authorized, opened on first ask. */
  pullRequests(): Operation<GitHubAccess>;
  /** Remember a publication this entry has verified. */
  published(publication: RetainedPublication): void;
  /** Every publication this entry holds: its accepted history and its own work. */
  publications(): readonly RetainedPublication[];
  /**
   * Run one evidence read under the occurrence that asked for it.
   *
   * The durability of a read belongs beneath the adapter that admits it — a
   * target this host never authorized must not leave a retained record of a
   * question it was not permitted to ask — and the adapter knows nothing about
   * occurrences. So the claimed occurrence is handed down through the entry's
   * own closure for the length of the one call, and the retaining middleware
   * reads it from there.
   */
  reading<T>(occurrence: string, read: () => Operation<T>): Operation<T>;
  /** The selected checkout covering this path, without discovering one. */
  enclosing(path: string): SelectedCheckout | undefined;
}

/** Every external effect this entry retains the request of. */
export function retainedExternalComponents(
  host: RetainedExternalHost,
): readonly IdentityComponent[] {
  return Object.freeze([
    retainedPush(host),
    retainedPullRequest(host),
    retainedIssue(host),
    retainedRead(host, "reviews", REVIEWS_ELEMENT, "PullRequest.Reviews", reviewsReturns),
    retainedRead(host, "comments", COMMENTS_ELEMENT, "PullRequest.Comments", commentsReturns),
    retainedRead(host, "checks", CHECKS_ELEMENT, "PullRequest.Checks", checksReturns),
  ]);
}

/**
 * `<Git.Push>`, with the request it publishes frozen before the remote hears of
 * it.
 *
 * The branch and the commit are read from the checkout, once, and written down.
 * Publishing itself goes out of a disposable control repository with a
 * read-only alternate on the checkout's object database, so the checkout is not
 * touched — and that is checked afterwards rather than assumed: a remote that
 * accepted the branch does not excuse a local state this entry's history can no
 * longer account for.
 */
function retainedPush(host: RetainedExternalHost): IdentityComponent {
  return {
    name: "Git.Push",
    origin: RETAINED_ORIGIN,
    props: pushProps,
    forms: ["self-closing"],
    description:
      "Publish the current branch. `<Git.Push />` pushes its current commit to the same branch " +
      "on `origin` without forcing.",
    factory: (claim: IdentityClaimant) =>
      function* GitPush(_props, invocation): Operation<string> {
        if (yield* hasContent()) {
          throw new GitOperationError(
            PUSH,
            "invalid-invocation",
            `${PUSH} renders nothing, so it takes no content. Write it as <Git.Push />.`,
          );
        }
        const directory = yield* cwd();
        const occurrence = yield* claim(invocation);
        const selected = yield* host.files.covering(directory);
        if (selected === undefined) {
          throw new GitOperationAdmissionError(
            PUSH,
            "it is written outside a repository this entry has selected, so there is no " +
              "repository in scope whose origin a branch could be published to",
          );
        }

        const frozen = yield* retain(
          {
            owner: host.files.owner,
            site: host.files.site(occurrence),
            operation: "push",
            checkout: selected.checkout,
            common: selected.common,
            position: host.files.position(selected.common),
            candidates: () => host.files.candidates(selected.checkout),
            settled: (frontier) => host.files.settled(selected.checkout, frontier),
            selection: { checkout: selected.checkout },
            // What the document wrote is where it wrote it: `<Git.Push />` has
            // no props, and the branch and commit it publishes are resolved
            // rather than authored — so they belong in the frozen preparation
            // and not in the request this fingerprint names.
            request: { cwd: directory },
            inventory: () => inventoryOf(selected),
            *prepare(preState) {
              if (preState === null) {
                return Err(
                  new GitOperationError(
                    PUSH,
                    "invalid-invocation",
                    "<Git.Push> has no absent state: it publishes from a checkout that exists.",
                  ),
                );
              }
              const resolved = yield* pushRequest(selected, directory);
              if (!resolved.ok) {
                return resolved;
              }
              const request = retainedPushRequestJson(resolved.value);
              return Ok({
                // Publishing moves nothing here: the objects leave through a
                // control repository of their own, and the checkout ends where
                // it started.
                postState: preState,
                prepared: request,
                evidence: request,
              });
            },
            // deno-lint-ignore require-yield
            *perform(transition) {
              // Unreachable, and deliberately so: the two frozen ends are one
              // state, so the protocol adopts the transition and acknowledges
              // it before this operation contacts anything.
              return Ok(transition.evidence);
            },
          },
          host.files.resume,
          host.files.lanes,
        );
        if (!frozen.ok) {
          throw frozen.error;
        }
        const request = parseRetainedPushRequest(frozen.value);
        if (request === undefined) {
          throw new GitOperationProtocolError(PUSH);
        }

        yield* publish(host, selected, occurrence, request);
        // The remote is where it was asked to be. Whether the checkout still is
        // what this entry's history accounts for is a separate question, and
        // the answer decides whether anything after this is resumable.
        yield* unmoved(host, selected, PUSH);
        host.published(request);
        return "";
      },
  };
}

/** What this invocation publishes: the branch the checkout is on, at its commit. */
function* pushRequest(
  selected: SelectedCheckout,
  directory: string,
): Operation<Result<RetainedPushRequest>> {
  const publication = yield* selected.publication();
  if (!publication.ok) {
    return publication;
  }
  const origin = publication.value.origin;
  if (origin === null) {
    return Err(
      new GitOperationAdmissionError(
        PUSH,
        "the checkout it selected records no usable origin, so there is nowhere for this branch " +
          "to be published to. No credential was read and nothing was contacted",
      ),
    );
  }
  const branch = yield* currentBranch(selected.git, directory);
  if (branch === undefined) {
    // The one condition a document can act on, decided before an intent exists
    // and before anything is contacted: a detached HEAD names a commit rather
    // than somewhere to publish it.
    return Err(gitRefusal(PUSH, "unnamed-branch"));
  }
  const sourceCommit = yield* resolveCommit(selected.git, directory, "HEAD");
  if (sourceCommit === undefined) {
    return Err(
      new GitOperationInfrastructureError(
        PUSH,
        "the checkout it ran in did not report the commit its branch holds",
      ),
    );
  }
  return Ok(
    Object.freeze({
      checkout: selected.checkout,
      origin,
      inputs: Object.freeze({
        repository: publication.value.identity,
        remote: PUSH_REMOTE,
        branch,
        destinationRef: destinationRefFor(branch),
        sourceCommit,
      }),
    }),
  );
}

/**
 * Reconcile the publication this request describes.
 *
 * The provider's closure holds the control repository, the object source and
 * the authentication session; the frozen request is what public middleware
 * sees. A completed one reaches none of it, because no provider is asked.
 */
function publish(
  host: RetainedExternalHost,
  selected: SelectedCheckout,
  occurrence: string,
  request: RetainedPushRequest,
): Operation<void> {
  return scoped(function* () {
    // Built by the first provider call that needs it, into this operation's own
    // scope rather than into the frame that asked: the observation and the
    // publication after it share one control repository and one credential
    // session — so a push and the observation that decided it go out under one
    // identity — and a resource acquired inside `observe` would be gone before
    // `perform` ran. A completed push reaches no provider at all, so it builds
    // none of it: no scratch directory, no control repository, no session.
    const owner = yield* useScope();
    const ready = lazily(owner, function* (): Operation<GitHostProvider> {
      const publication = yield* selected.publication();
      if (!publication.ok) {
        throw publication.error;
      }
      const checkout: GitCheckout = {
        git: selected.git,
        directory: selected.directory,
        // The checkout whose administration holds the object database both a
        // repository and its linked worktrees publish from.
        repositoryDirectory: publication.value.repositoryDirectory,
        workingDirectory: selected.directory,
        identity: Object.freeze({
          repositoryName: request.inputs.repository.name,
          worktreeName: null,
          checkoutPath: selected.directory,
        }),
      };
      const source = objectSource(
        host.repository,
        yield* host.repository.useDirectory(),
        checkout,
        request.inputs.repository.objectFormat,
        PUSH,
      );
      return pushProvider(
        source,
        request.origin,
        request.inputs,
        yield* useGitAuthentication(host.repository, request.origin),
      );
    });
    const record = yield* withGitHostProvider(
      deferred(ready),
      reconcileOwnedGitHostEffect({
        owner: host.files.owner,
        site: occurrence,
        request: {
          kind: GIT_PUSH,
          inputs: gitPushInputsJson(request.inputs),
          naturalKey: gitPushNaturalKeyJson({
            repository: request.inputs.repository,
            remote: request.inputs.remote,
            destinationRef: request.inputs.destinationRef,
          }),
        },
      }),
    );
    // Read for this invocation rather than merely read: the shared engine has
    // held the record's request to the request being made, and what is decided
    // here is that its three JSON members describe this exact push.
    if (parseGitPushRecord(record, pushExpectation(request.inputs)) === undefined) {
      throw new GitOperationProtocolError(PUSH);
    }
  });
}

/**
 * `<PullRequest>`, admitted against this entry's own publications.
 *
 * The body expands first, then the head is read from the checkout and frozen,
 * and only then is this entry's record of publishing that head looked for. A
 * document that forgot `<Git.Push />`, one whose checkout has moved on, and one
 * replaying a historical request are all decided here — with the Git host never
 * having been asked anything.
 */
function retainedPullRequest(host: RetainedExternalHost): IdentityComponent {
  return {
    name: "PullRequest",
    origin: RETAINED_ORIGIN,
    props: pullRequestProps,
    returns: pullRequestReturns,
    description:
      'Open or update a pull request. `<PullRequest title="Prepare 1.4">…</PullRequest>` uses ' +
      "its content as the body after `<Git.Push />`.",
    as: "Optional. The pull request's repository, number, url, state and head and base commits.",
    context: "The pull request's body.",
    factory: (claim: IdentityClaimant) =>
      function* PullRequest(props, invocation): Operation<Json> {
        // Before anything of this element's own exists. The body is what the
        // pull request would say, and a body that never finished rendering must
        // not become one that was published.
        const body = (yield* hasContent()) ? yield* content() : "";
        const directory = yield* cwd();
        const occurrence = yield* claim(invocation);
        const selected = yield* host.files.covering(directory);
        if (selected === undefined) {
          throw new PullRequestAdmissionError(
            "no-repository-context",
            "it is written outside a repository this entry has selected, so there is no " +
              "repository in scope for a pull request to be opened in.",
          );
        }
        const number = typeof props.number === "number" ? props.number : null;
        const title = typeof props.title === "string" ? props.title : "";
        const draft = props.draft === true;
        const base = typeof props.base === "string" && props.base !== "" ? props.base : undefined;

        const frozen = yield* retain(
          {
            owner: host.files.owner,
            site: host.files.site(occurrence),
            operation: "pull-request",
            checkout: selected.checkout,
            common: selected.common,
            position: host.files.position(selected.common),
            candidates: () => host.files.candidates(selected.checkout),
            settled: (frontier) => host.files.settled(selected.checkout, frontier),
            selection: { checkout: selected.checkout },
            request: {
              cwd: directory,
              number,
              title,
              body,
              draft,
              base: base ?? null,
            },
            inventory: () => inventoryOf(selected),
            *prepare(preState) {
              if (preState === null) {
                return Err(
                  new PullRequestAdmissionError(
                    "no-repository-context",
                    "<PullRequest> has no absent state: it names a branch in a checkout that " +
                      "exists.",
                  ),
                );
              }
              const publication = yield* selected.publication();
              if (!publication.ok) {
                return publication;
              }
              const origin = publication.value.origin;
              if (origin === null) {
                return Err(
                  new PullRequestAdmissionError(
                    "no-repository-context",
                    "the checkout it selected records no usable origin, so there is no " +
                      "repository at a Git host for a pull request to be opened in.",
                  ),
                );
              }
              const headBranch = yield* currentBranch(selected.git, directory);
              if (headBranch === undefined) {
                return Err(
                  new PullRequestAdmissionError(
                    "unnamed-branch",
                    "the checkout it selected has no branch checked out, so there is no head " +
                      "branch to open a pull request from — and a detached HEAD is not " +
                      "something this entry could have published.",
                  ),
                );
              }
              const headSha = yield* resolveCommit(selected.git, directory, "HEAD");
              if (headSha === undefined) {
                return Err(
                  new GitOperationInfrastructureError(
                    PULL_REQUEST_ELEMENT,
                    "the checkout it selected did not report the commit its branch holds",
                  ),
                );
              }
              const inputs: PullRequestInputs = Object.freeze({
                repository: publication.value.identity,
                number,
                title,
                body,
                draft,
                headBranch,
                headSha,
                // The repository's own initial branch, pinned when it was
                // selected, rather than whatever its default branch is at the
                // host right now.
                baseBranch: base ?? publication.value.identity.primaryBranch,
              });
              const request = retainedPullRequestRequestJson({
                checkout: selected.checkout,
                origin,
                inputs,
              });
              return Ok({ postState: preState, prepared: request, evidence: request });
            },
            // deno-lint-ignore require-yield
            *perform(transition) {
              return Ok(transition.evidence);
            },
          },
          host.files.resume,
          host.files.lanes,
        );
        if (!frozen.ok) {
          throw frozen.error;
        }
        const request = parseRetainedPullRequestRequest(frozen.value);
        if (request === undefined) {
          throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
        }

        // Before an adapter exists, before a token is read and before anything
        // is sent. What admits a pull request is this entry's own record of
        // publishing the branch it names.
        admitRetainedPublication(host.publications(), {
          checkout: request.checkout,
          origin: request.origin,
          repository: request.inputs.repository,
          branch: request.inputs.headBranch,
          destinationRef: destinationRefFor(request.inputs.headBranch),
          commit: request.inputs.headSha,
        });

        return yield* scoped(function* () {
          const owner = yield* useScope();
          const record = yield* withGitHostProvider(
            deferred(
              lazily(owner, function* (): Operation<GitHostProvider> {
                return pullRequestProvider(
                  yield* host.pullRequests(),
                  request.origin,
                  request.inputs,
                );
              }),
            ),
            reconcileOwnedGitHostEffect({
              owner: host.files.owner,
              site: occurrence,
              request: {
                kind: PULL_REQUEST,
                inputs: pullRequestInputsJson(request.inputs),
                naturalKey: pullRequestNaturalKeyJson(pullRequestNaturalKey(request.inputs)),
              },
            }),
          );
          const outcome = parsePullRequestRecord(record, request.inputs);
          if (outcome === undefined) {
            throw new GitOperationProtocolError(PULL_REQUEST_ELEMENT);
          }
          return pullRequestResultJson(outcome.result);
        });
      },
  };
}

/**
 * `<Issue>`, reading one or filing one.
 *
 * The form decides which, exactly as the ordinary component decides it, and a
 * form that is neither is refused before a tracker is read. What this adds is
 * the owner and the occurrence: an issue filed at one site is a different
 * effect from the same text filed at another, and a loop iteration is a site of
 * its own.
 *
 * An upsert inside a checkout this entry has selected also writes its request
 * down before the tracker is contacted. Outside every selection there is no
 * state lane for such a record to advance — the protocol's records describe
 * checkouts — and every field of an issue is authored rather than resolved, so
 * there is nothing a frozen copy would protect: the existing `issue_effect`
 * record and the stable owner/site idempotency key are the whole of its
 * recovery.
 */
function retainedIssue(host: RetainedExternalHost): IdentityComponent {
  return {
    name: "Issue",
    origin: RETAINED_ORIGIN,
    props: issueProps,
    returns: issueReturns,
    description:
      'Read or file an issue. `<Issue url={finding.issueUrl} as="found" />` reads one. ' +
      '`<Issue title="Retry the publish step">…</Issue>` files its content in the issue tracker ' +
      "in scope.",
    as:
      "Required for a read, which binds url, title, description, tags and assignee. A file " +
      "binds the url alone.",
    context: "The issue's description, for the form that files one.",
    factory: (claim: IdentityClaimant) =>
      function* Issue(props, invocation): Operation<Json> {
        // The shape first, and locally: everything after this depends on which
        // of the two questions is being asked.
        const paired = yield* hasContent();
        const asked = issueMode(props, paired);
        const occurrence = yield* claim(invocation);
        return asked === "read"
          ? yield* readIssueAt(host, occurrence, props)
          : yield* fileIssueAt(host, occurrence, props);
      },
  };
}

/** Which of the two forms this invocation is, or the refusal that says why neither. */
function issueMode(props: Record<string, Json>, paired: boolean): "read" | "upsert" {
  const url = typeof props.url === "string" && props.url !== "";
  const title = typeof props.title === "string" && props.title !== "";
  if (url && title) {
    throw new IssueContentError(
      `${ISSUE_ELEMENT} reads an issue with url, or files one with title, and cannot do both at ` +
        "once. Write two elements.",
    );
  }
  if (url) {
    if (paired) {
      throw new IssueContentError(
        `${ISSUE_ELEMENT} with a url reads an existing issue and renders nothing, so it takes ` +
          "no content. Write it as <Issue url=… as=… />.",
      );
    }
    for (const inapplicable of ["tags", "assignee"]) {
      if (props[inapplicable] !== undefined) {
        throw new IssueContentError(
          `${ISSUE_ELEMENT} with a url reads an issue and changes nothing about it, so ` +
            `${inapplicable} does not apply. Write an upsert to set it.`,
        );
      }
    }
    return "read";
  }
  if (title) {
    if (props.provider !== undefined) {
      throw new IssueContentError(
        `${ISSUE_ELEMENT} takes its provider from the enclosing <IssueTracker> when it files an ` +
          "issue, so provider does not apply here.",
      );
    }
    if (!paired) {
      throw new IssueContentError(
        `${ISSUE_ELEMENT} files the issue its content describes, so it needs content. Write it ` +
          "as <Issue title=…>…</Issue>.",
      );
    }
    return "upsert";
  }
  throw new IssueContentError(
    `${ISSUE_ELEMENT} either reads an issue — <Issue url=… as=… /> — or files one — ` +
      "<Issue title=…>…</Issue>. This is neither.",
  );
}

/**
 * Read one issue, as this entry's own durable observation.
 *
 * A completed read answers from its record without resolving a provider or
 * reaching one; a later authored read is a different site and therefore a
 * different observation, which may see something else. No tracker is consulted
 * either way: the URL is the identity.
 */
function* readIssueAt(
  host: RetainedExternalHost,
  occurrence: string,
  props: Record<string, Json>,
): Operation<Json> {
  const url = canonicalIssueTarget(props.url);
  if (url === undefined) {
    throw new IssueTrackerError(
      "invalid-tracker-url",
      "the url it was given is not an http or https URL naming one issue, free of credentials, " +
        "query and fragment.",
    );
  }
  const details = yield* readOwnedIssue({
    owner: host.files.owner,
    site: occurrence,
    request: { url, provider: issueProvider(props.provider) },
  });
  return {
    url: details.url,
    title: details.title,
    description: details.description,
    tags: [...details.tags],
    assignee: details.assignee,
  };
}

/** File one issue, with its request written down first where there is a lane for it. */
function* fileIssueAt(
  host: RetainedExternalHost,
  occurrence: string,
  props: Record<string, Json>,
): Operation<Json> {
  // The description before the destination, so a body that failed to render
  // stops this element before a tracker is read.
  const description = yield* content();
  if (description === "") {
    throw new IssueContentError(
      `${ISSUE_ELEMENT} files the issue its content describes, and this content rendered ` +
        "nothing. An issue with no description is not one this element files.",
    );
  }
  const destination = resolveIssueDestination(yield* currentIssueTracker());
  const tags = normalizedTags(props.tags);
  if (tags === undefined) {
    throw new IssueProtocolError(
      "the tags this invocation was given are not a list of non-empty strings",
    );
  }
  const issue: IssueInput = Object.freeze({
    title: typeof props.title === "string" ? props.title : "",
    description,
    tags,
    assignee: typeof props.assignee === "string" && props.assignee !== "" ? props.assignee : null,
  });

  const frozen = yield* freezeIssueRequest(host, occurrence, {
    target: destination.target,
    provider: destination.provider ?? null,
    issue,
  });
  if (!frozen.ok) {
    throw frozen.error;
  }
  const reference = yield* upsertOwnedIssue({
    owner: host.files.owner,
    site: occurrence,
    request: { target: destination.target, provider: destination.provider, issue },
  });
  return { url: reference.url };
}

/**
 * Write this issue's request down, where this entry has a lane to write it in.
 *
 * `Ok` with nothing frozen is the honest answer outside every selection: the
 * record pair this protocol writes describes a checkout's state, and an issue
 * filed beside the document changes no checkout and names none.
 */
function freezeIssueRequest(
  host: RetainedExternalHost,
  occurrence: string,
  request: {
    readonly target: string;
    readonly provider: string | null;
    readonly issue: IssueInput;
  },
): Operation<Result<void>> {
  return scoped(function* () {
    const selected = host.enclosing(yield* cwd());
    if (selected === undefined) {
      return Ok(undefined);
    }
    const frozen = retainedIssueRequestJson(request);
    const written = yield* retain(
      {
        owner: host.files.owner,
        site: host.files.site(occurrence),
        operation: "issue",
        checkout: selected.checkout,
        common: selected.common,
        position: host.files.position(selected.common),
        candidates: () => host.files.candidates(selected.checkout),
        settled: (frontier) => host.files.settled(selected.checkout, frontier),
        selection: { checkout: selected.checkout },
        request: frozen,
        inventory: () => inventoryOf(selected),
        // deno-lint-ignore require-yield
        *prepare(preState) {
          if (preState === null) {
            return Err(
              new IssueProtocolError(
                "an issue has no absent state: it is filed from a checkout that exists.",
              ),
            );
          }
          // Filing an issue changes nothing here. What the record is for is
          // saying this entry asked for it, before any tracker was contacted.
          return Ok({ postState: preState, prepared: frozen, evidence: frozen });
        },
        // deno-lint-ignore require-yield
        *perform(transition) {
          return Ok(transition.evidence);
        },
      },
      host.files.resume,
      host.files.lanes,
    );
    return written.ok ? Ok(undefined) : Err(written.error);
  });
}

/** The discriminator this prop names, or `undefined` when it names none. */
function issueProvider(value: Json | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = issueProviderName(value);
  if (name === undefined) {
    throw new IssueTrackerError(
      "invalid-provider",
      "a provider discriminator is a stable lower-case name, and that is not one.",
    );
  }
  return name;
}

/**
 * One evidence collection, read under the occurrence that asked for it.
 *
 * The read itself is the ordinary one: the same canonicalization, the same
 * provider discriminator, the same adapter, and the same refusal when a
 * provider answers with another collection. What the entry adds is the owner
 * and the site its record is named by, handed down so the retaining middleware
 * beneath the adapter can use them.
 */
function retainedRead(
  host: RetainedExternalHost,
  kind: PullRequestReadKind,
  element: string,
  name: string,
  returns: IdentityComponent["returns"],
): IdentityComponent {
  return {
    name,
    origin: RETAINED_ORIGIN,
    props: readProps,
    ...(returns === undefined ? {} : { returns }),
    forms: ["self-closing"],
    description: `Read pull request ${kind}. \`<${name} url={pullRequest.url} as="${kind}" />\` reads ${kind} from the specified pull request.`,
    as: `Required. The ${kind} the pull request holds.`,
    factory: (claim: IdentityClaimant) =>
      function* PullRequestRead(props, invocation): Operation<Json> {
        const url = canonicalPullRequestUrl(props.url);
        if (url === undefined) {
          throw new PullRequestReadError(
            "invalid-url",
            element,
            "its `url` is not the plain canonical address of a pull request. A credential, a " +
              "query or a fragment makes it something else, and none of them is stripped.",
          );
        }
        const provider =
          props.provider === undefined ? undefined : pullRequestProviderName(props.provider);
        if (props.provider !== undefined && provider === undefined) {
          throw new PullRequestReadError(
            "invalid-provider",
            element,
            "its `provider` is not a provider name: lower case, starting with a letter.",
          );
        }
        const occurrence = yield* claim(invocation);
        const result = yield* host.reading(occurrence, () =>
          PullRequestOperations.operations.read({ url, kind, provider }),
        );
        if (result.kind !== kind) {
          throw new PullRequestReadError(
            "protocol",
            element,
            "the selected provider answered with a different collection than the one this " +
              "element asked for.",
          );
        }
        return pullRequestReadResultJson(result);
      },
  };
}

/**
 * A provider that builds itself the first time it is asked anything.
 *
 * What the Git-host engine does with a completed record is answer from it
 * without reaching a provider, so everything behind this is work a replay must
 * not do: a temporary directory, a control repository, a credential session.
 * The two phases share one build, because they are one reconciliation.
 */
function deferred(ready: () => Operation<GitHostProvider>): GitHostProvider {
  return {
    *observe(request): Operation<Result<GitHostObservation>> {
      return yield* (yield* ready()).observe(request);
    },
    *perform(request, observation): Operation<Result<GitHostCompletion>> {
      return yield* (yield* ready()).perform(request, observation);
    },
  };
}

/** This checkout's state right now. */
function inventoryOf(selected: SelectedCheckout) {
  return inventoryFrontier({
    git: selected.git,
    checkout: selected.checkout,
    directory: selected.directory,
  });
}

/**
 * That the checkout is still in the state this entry holds it to.
 *
 * Read after an external effect rather than before: what is in question is
 * whether publishing moved anything local, and a remote that accepted the
 * branch says nothing about that. A `FrontierError`, because an entry whose
 * history no longer describes its own checkout cannot be continued — and must
 * not be printed past.
 */
function* unmoved(
  host: RetainedExternalHost,
  selected: SelectedCheckout,
  operation: string,
): Operation<void> {
  const held = host.files.expected(selected.checkout);
  if (held === undefined) {
    throw new FrontierError(
      `${operation} published from ${selected.checkout}, and this entry holds no state for that ` +
        "checkout to be held to, so what it is in now is not recorded here.",
    );
  }
  const live = yield* inventoryOf(selected);
  if (!live.ok) {
    throw live.error;
  }
  if (!sameRetainedFrontier(live.value, held)) {
    throw new FrontierError(
      `${operation} published from ${selected.checkout}, and left it in a state this entry's ` +
        "history does not account for. The remote accepted the branch; the checkout is not " +
        "where this entry's own records say it is.",
    );
  }
}
