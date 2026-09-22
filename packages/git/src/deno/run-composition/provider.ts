/**
 * The ordinary run's repository provider: what `xmd run` installs under Deno
 * and inside the compiled binary.
 *
 * It answers the same four Apis the workflow provider answers, so a document
 * writes the same thirteen components either way. What differs is everything
 * about lifetime and ownership.
 *
 * A workflow run's checkouts are rows in its own database, restored from
 * retained history under a WorkflowRun the document must never be able to name.
 * An ordinary run's checkouts are directories: the one the person is standing
 * in, and the ones under the managed root, each held for the execution by an
 * advisory lock and each surviving it. Nothing is journaled, nothing replays,
 * and a second `xmd run` is a second question rather than a resumption.
 *
 * ## What this instance holds, and what a document can reach
 *
 * Four private things, all in this closure: a fresh opaque invocation identity,
 * the selection registry, the checkouts this execution registered, and the
 * evidence of every publication it verified. None of them is a prop, a Context
 * value, a middleware answer, a component result or a journal event, and none
 * survives the execution. That is what makes "this run pushed that branch" mean
 * this run — a `--journal` file, a copied binding and a previous execution's
 * output all grant exactly nothing.
 *
 * The engine's own `Expansion.id` names the authored site inside that one
 * invocation, which is what the live Issue and pull-request idempotency keys
 * are built from.
 *
 * ## Discovery costs nothing until something asks
 *
 * Installing this provider acquires nothing. The ambient repository is
 * discovered when the first element asks for one, from the directory the
 * command was run in, and the answer is kept for the rest of the execution.
 * Being outside a repository is not a startup failure: it is remembered as
 * "there is none", and only an element that needs one refuses. A document that
 * asks for no repository never looks — and a managed root, a lease, a Git
 * session and a commit identity are acquired on the same terms, each by the
 * first operation that needs it.
 */

import { race, suspend, useScope, withResolvers } from "effection";
import type { Operation, Scope } from "effection";

import { randomUUID } from "node:crypto";
import { getExpansion } from "@executablemd/core";
import { Repository } from "../../composition/api.ts";
import type { RepositoryRequest, WorktreeRequest } from "../../composition/api.ts";
import { Git } from "../../composition/git-api.ts";
import type {
  GitAddInvocation,
  GitCommitInvocation,
  GitPushInvocation,
  GitSwitchInvocation,
} from "../../composition/git-api.ts";
import { GitOperationAdmissionError, RepositorySelectionError } from "../../composition/errors.ts";
import type {
  GitAddResult,
  GitCommitResult,
  GitSwitchResult,
} from "../../composition/git-records.ts";
import { destinationRefFor, type GitPushOutcome } from "../../composition/git-push-records.ts";
import { admitPathspecs } from "../../composition/components/GitAdd.ts";
import { admitCommitMessage } from "../../composition/components/GitCommit.ts";
import { PULL_REQUEST_ELEMENT } from "../../composition/components/PullRequest.ts";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import {
  PullRequestOperations,
  type PullRequestReadInvocation,
  type PullRequestUpsertInvocation,
} from "../../composition/pull-request-operations.ts";
import type { PullRequestReadResult } from "../../composition/pull-request-read-records.ts";
import type {
  PullRequestInputs,
  PullRequestResult,
} from "../../composition/pull-request-records.ts";
import { PullRequestAdmissionError } from "../../composition/errors.ts";
import type { RepositoryIdentity, RepositorySelection } from "../../composition/selection.ts";
import { IssueApi } from "../../issue/api.ts";
import type { IssueDetails, IssueReference } from "../../issue/api.ts";
import {
  IssueOperations,
  type IssueReadInvocation,
  type IssueUpsertInvocation,
} from "../../issue/operations.ts";
import { issueIdempotencyKey, parseIssueDetails, parseIssueRecord } from "../../issue/records.ts";
import { IssueProtocolError } from "../../issue/errors.ts";
import { locatorFingerprint } from "../composition/locator.ts";
import { currentBranch, gitSession, resolveCommit, type GitSession } from "../composition/git.ts";
import { denoRepositoryHost, type RepositoryHost } from "../composition/host.ts";
import type { GitAuthentication } from "../composition/authentication.ts";
import type { HelperAssembly } from "../composition/credential-helper.ts";
import type { GitHubSource } from "../composition/github.ts";
import { denoGitHubSource } from "../composition/github-host.ts";
import {
  gitHubPullRequestAccess,
  useGitHubPullRequestReads,
  type GitHubPullRequestsOptions,
} from "../composition/pull-request-reads.ts";
import { useGitHubIssues, type GitHubIssuesOptions } from "../issue/github.ts";
import { selectionRegistry } from "../selections.ts";
import { discoverAmbientRepository, type AmbientRepository } from "./ambient.ts";
import type { Leases } from "./leases.ts";
import { captureCommitIdentity, denoIdentityReader, type IdentityReader } from "./identity.ts";
import type { GitCommitIdentity } from "./identity.ts";
import { selectManagedRepository, selectManagedWorktree } from "./checkouts.ts";
import { NoAmbientRepositoryError } from "./errors.ts";
import { useLeases } from "./leases.ts";
import { liveUpsertPullRequest } from "./pull-request.ts";
import {
  admitLivePushEvidence,
  liveAdd,
  liveCheckout,
  liveCommit,
  livePush,
  liveSwitch,
  selectCheckout,
  type PushEvidence,
  type RegisteredCheckout,
} from "./operations.ts";
import { repositorySlot, worktreeSlot } from "./placement.ts";
import { realpath } from "node:fs/promises";
import { ensureDir } from "@effectionx/fs";
import { until } from "effection";

/** What `withResolvers()` hands back, named so a capability can hold a pair. */
type Resolvers<T> = ReturnType<typeof withResolvers<T>>;

/** The canonical directory this path resolves to, or the path as written. */
function* canonicalPath(path: string): Operation<string> {
  try {
    return yield* until(realpath(path));
  } catch {
    return path;
  }
}

export interface RunCompositionOptions {
  /** Where managed checkouts live. Production passes `~/.xmd/repositories`. */
  readonly root: string;
  /** The directory the command was run in, which ambient discovery starts from. */
  readonly cwd: string;
  readonly host?: RepositoryHost;
  readonly authentication?: GitAuthentication;
  readonly helper?: HelperAssembly;
  /**
   * How this host reads the invoking user's effective Git identity.
   *
   * Absent uses native Git with the caller's own environment and starting
   * directory, which is the whole question. A suite substitutes it to say what
   * this host knows — including that it knows nothing.
   */
  readonly identity?: IdentityReader;
  /** What GitHub issue handling this host installs, and what it may reach. */
  readonly gitHubIssues?: GitHubIssuesOptions;
  /** The pull-request destinations this host allows a document to read. */
  readonly gitHubPullRequests?: GitHubPullRequestsOptions;
}

/** What a Repository selection names: its checkout, and how to publish from it. */
interface SelectedRepository {
  readonly checkout: RegisteredCheckout;
  /** The repository checkout `worktree add` runs in. */
  readonly ownerCheckout: string;
  /** The canonical common Git directory this repository's worktrees key on. */
  readonly commonDirectory: string;
}

/**
 * One capability, acquired at most once, owned by the installation scope.
 *
 * Installing this provider must reach nothing: no directory, no lease, no
 * `git`, no identity read. What each capability costs is paid by the first
 * operation that actually needs it, and by nothing else — a document that
 * writes no repository component pays none of it.
 *
 * Four properties, and each one is why this is not a plain memoized function:
 *
 * - **Single-flight.** The first ask starts the acquisition; an ask that
 *   arrives while it is still running awaits the same task rather than starting
 *   a second. Two concurrent `<Repository>` elements share one managed root.
 * - **Owned by the installation scope.** The work runs in `owner`, not in
 *   whichever element happened to ask first, and then *suspends* — because a
 *   task that returns releases what it acquired. A temporary directory, a
 *   session and a lease therefore last as long as the execution does, rather
 *   than as long as the element that first needed them.
 * - **Settled answers are answers.** An absent ambient repository and a host
 *   that cannot state a commit identity are values, not failures, and are
 *   remembered as such: the second ask does not rediscover them.
 * - **Nothing half-made is observable.** A caller cancelled while waiting
 *   abandons its own wait and not the acquisition; a failed acquisition is
 *   remembered as failed, and every later ask is told the same thing rather
 *   than retrying into partially made state.
 */
function lazily<T>(owner: Scope, acquire: () => Operation<T>): () => Operation<T> {
  let settled: { readonly ready: Resolvers<T>; readonly failed: Resolvers<never> } | undefined;
  return function* (): Operation<T> {
    if (settled === undefined) {
      const ready = withResolvers<T>();
      const failed = withResolvers<never>();
      settled = { ready, failed };
      owner.run(function* () {
        let value: T;
        try {
          value = yield* acquire();
        } catch (error) {
          failed.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        ready.resolve(value);
        // Held for the scope's life. Returning here would end the task, and
        // ending a task releases everything it acquired.
        yield* suspend();
      });
    }
    return yield* race([settled.ready.operation, settled.failed.operation]);
  };
}

/**
 * Install the ordinary repository vocabulary for the current scope and below.
 *
 * One call rather than four, because the four Apis share this instance's
 * private state and installing some without the rest would leave a document
 * committing in a checkout no `<PullRequest>` could be authorized against.
 */
export function* useRunComposition(options: RunCompositionOptions): Operation<void> {
  const host =
    options.host ??
    denoRepositoryHost({
      ...(options.authentication === undefined ? {} : { authentication: options.authentication }),
      ...(options.helper === undefined ? {} : { helper: options.helper }),
    });
  // The scope this provider is installed in. Every capability below is
  // acquired into it, so a temporary directory, a session and a lease last as
  // long as the execution does rather than as long as whichever element first
  // needed them.
  const owner: Scope = yield* useScope();
  const selections = selectionRegistry<SelectedRepository>();
  const registered: RegisteredCheckout[] = [];
  const evidence: PushEvidence[] = [];

  // The Git session's root is also `HOME`, so Git reads no configuration
  // belonging to whoever is running the command — the same isolation a workflow
  // run gets, applied to a repository the caller owns.
  const useGit = lazily(owner, function* (): Operation<GitSession> {
    return gitSession(host, yield* host.useDirectory());
  });

  // Created before it is canonicalized, and canonicalized once. A path that
  // does not exist yet resolves to itself, so a root canonicalized before it
  // was made would be one spelling on the execution that created it and another
  // on every execution afterwards — two spellings, two digests, two slots for
  // one Repository, and no lock between them.
  const useRoot = lazily(owner, function* (): Operation<string> {
    yield* ensureDir(options.root);
    return yield* canonicalPath(options.root);
  });
  const useSlots = lazily(owner, function* (): Operation<Leases> {
    return yield* useLeases(yield* useRoot());
  });

  // Fresh, opaque and never derived from anything a document wrote. It names
  // this execution to a service; it is not addressable, reusable or observable.
  // Minted once, on the first operation that needs to name this execution.
  const useInvocation = lazily(owner, function* (): Operation<string> {
    return randomUUID();
  });

  // From the trusted host: the four strings a commit records about who made it.
  // A host that cannot say is remembered as not saying, and only `<Git.Commit>`
  // refuses — so the read happens when a commit needs it, not before.
  const useIdentity = lazily(owner, function* (): Operation<GitCommitIdentity | undefined> {
    return yield* captureCommitIdentity(options.identity ?? denoIdentityReader(options.cwd));
  });

  // A repository this command was not run inside is remembered as absent
  // rather than refused, so a document that never asks for one runs exactly as
  // it would anywhere else — and never looks.
  const useAmbient = lazily(owner, function* (): Operation<{
    readonly ambient: AmbientRepository | undefined;
    readonly selection: RepositorySelection | undefined;
  }> {
    const ambient = yield* discoverAmbientRepository(yield* useGit(), options.cwd);
    return {
      ambient,
      selection:
        ambient === undefined ? undefined : registerAmbient(ambient, selections, registered),
    };
  });

  yield* Repository.around(
    {
      *select([request]: [RepositoryRequest]): Operation<RepositorySelection> {
        const slot = repositorySlot(yield* useRoot(), request.locator, request.name);
        yield* (yield* useSlots()).hold(
          "repository",
          slot,
          `repository ${JSON.stringify(request.name)}`,
        );
        const managed = yield* selectManagedRepository(yield* useGit(), host, slot, request);
        const identity: RepositoryIdentity = Object.freeze({
          name: request.name,
          locatorFingerprint: managed.metadata.locatorFingerprint,
          requestedBase: managed.metadata.requestedBase,
          creationCommit: managed.creationCommit,
          primaryBranch: managed.metadata.primaryBranch,
          objectFormat: managed.objectFormat,
        });
        const checkout: RegisteredCheckout = Object.freeze({
          root: managed.checkout,
          identity,
          repositoryName: request.name,
          worktreeName: null,
          origin: managed.metadata.locator,
        });
        register(registered, checkout);
        return selections.mint(slot, request.name, identity, managed.checkout, {
          checkout,
          ownerCheckout: managed.checkout,
          commonDirectory: managed.commonDirectory,
        });
      },

      *worktree([repository, request]: [
        RepositorySelection,
        WorktreeRequest,
      ]): Operation<RepositorySelection> {
        const owner = selections.authenticate(
          repository,
          () => new RepositorySelectionError("<Worktree>"),
        );
        const slot = worktreeSlot(yield* useRoot(), owner.commonDirectory, request.name);
        yield* (yield* useSlots()).hold(
          "worktree",
          slot,
          `worktree ${JSON.stringify(request.name)}`,
        );
        const managed = yield* selectManagedWorktree(yield* useGit(), slot, {
          name: request.name,
          branch: request.branch,
          base: request.base,
          owner: owner.commonDirectory,
          ownerCheckout: owner.ownerCheckout,
        });
        // The owner's identity, because that is the repository this checkout
        // belongs to; the worktree's own name and path, because that is which
        // checkout of it this selection points at.
        const checkout: RegisteredCheckout = Object.freeze({
          root: managed.checkout,
          identity: owner.checkout.identity,
          repositoryName: owner.checkout.repositoryName,
          worktreeName: request.name,
          origin: owner.checkout.origin,
        });
        register(registered, checkout);
        return selections.mint(slot, request.name, owner.checkout.identity, managed.checkout, {
          checkout,
          ownerCheckout: owner.ownerCheckout,
          commonDirectory: owner.commonDirectory,
        });
      },

      // deno-lint-ignore require-yield
      *ambient(): Operation<RepositorySelection | undefined> {
        const { selection: ambientSelection } = yield* useAmbient();
        if (ambientSelection === undefined) {
          // This profile *has* ambient repositories; this invocation is not in
          // one. The refusal says how to run inside one rather than reporting
          // an absent provider, which is what Node and Bun report instead.
          throw new NoAmbientRepositoryError("this element");
        }
        return ambientSelection;
      },
    },
    { at: "min" },
  );

  function* place(
    invocationRepository: RepositorySelection,
    workingDirectory: string,
    operation: string,
  ): Operation<RegisteredCheckout> {
    const selected = selections.authenticate(
      invocationRepository,
      () =>
        new GitOperationAdmissionError(
          operation,
          "the Repository in scope is not one this execution selected, so it names no checkout",
        ),
    );
    // Canonicalized before it is matched. A checkout root is the path Git
    // resolved, and a working directory reached through a symbolic link — a
    // temporary directory under macOS `/var`, a home directory somebody linked
    // — is the same place under another name. Comparing the two as written
    // would report a document standing in its own checkout as standing in none.
    return selectCheckout(
      registered,
      selected.checkout.identity,
      yield* canonicalPath(workingDirectory),
      operation,
    );
  }

  yield* Git.around(
    {
      *switch([invocation_]: [GitSwitchInvocation]): Operation<GitSwitchResult> {
        const checkout = yield* place(
          invocation_.repository,
          invocation_.workingDirectory,
          "<Git.Switch>",
        );
        return yield* liveSwitch(
          liveCheckout(yield* useGit(), checkout, invocation_.workingDirectory),
          invocation_.branch,
          invocation_.base,
        );
      },

      *add([invocation_]: [GitAddInvocation]): Operation<GitAddResult> {
        const checkout = yield* place(
          invocation_.repository,
          invocation_.workingDirectory,
          "<Git.Add>",
        );
        // Admitted where a request enters, exactly as the retained provider
        // admits it: the Api is public, and a caller reaching it directly is
        // subject to the same boundary.
        return yield* liveAdd(
          liveCheckout(yield* useGit(), checkout, invocation_.workingDirectory),
          admitPathspecs(invocation_.paths),
        );
      },

      *commit([invocation_]: [GitCommitInvocation]): Operation<GitCommitResult> {
        const checkout = yield* place(
          invocation_.repository,
          invocation_.workingDirectory,
          "<Git.Commit>",
        );
        return yield* liveCommit(
          liveCheckout(yield* useGit(), checkout, invocation_.workingDirectory),
          admitCommitMessage(invocation_.message),
          invocation_.messageSource,
          // Read here, because this is the operation that needs it: a run that
          // commits nothing asks the host nothing about who it is.
          yield* useIdentity(),
        );
      },

      *push([invocation_]: [GitPushInvocation]): Operation<GitPushOutcome> {
        const checkout = yield* place(
          invocation_.repository,
          invocation_.workingDirectory,
          "<Git.Push>",
        );
        const published = yield* livePush(host, yield* useGit(), checkout);
        // Only after the provider has verified a performed or adopted
        // publication. A refused or unreadable one leaves no entry, so nothing
        // it did authorizes a pull request.
        evidence.push(published.evidence);
        return published.outcome;
      },
    },
    { at: "min" },
  );

  // The transport middlewares both profiles share, installed beneath the
  // ordinary lifecycle below. Installing them reads no configuration and
  // obtains no credential: each one matches a request against its own target
  // first, and only a request that turns out to be its own reaches what this
  // deployment authorized. Absent configuration then authorizes nothing, and a
  // document naming one reaches the surface's own error exactly as it did when
  // absence installed no provider at all.
  // The platform's transport, handed to adapters that know the protocol and
  // not the platform. Naming it here is not building one: it is a factory the
  // adapter calls if and when a request turns out to be its own.
  yield* useGitHubIssues({ host: denoGitHubSource, ...options.gitHubIssues });
  yield* useGitHubPullRequestReads({ host: denoGitHubSource, ...options.gitHubPullRequests });

  yield* IssueOperations.around(
    {
      *read([request]: [IssueReadInvocation]): Operation<IssueDetails> {
        const answered = yield* IssueApi.operations.read(request.url, {
          ...(request.provider === undefined ? {} : { provider: request.provider }),
        });
        const details = parseIssueDetails(answered);
        if (details === undefined) {
          throw new IssueProtocolError(
            "the issue provider answered a read with something that is not an issue's shared " +
              "fields",
          );
        }
        return details;
      },

      *upsert([request]: [IssueUpsertInvocation]): Operation<IssueReference> {
        const expansion = yield* getExpansion();
        const answered = yield* IssueApi.operations.upsert(request.issue, {
          url: request.target,
          ...(request.provider === undefined ? {} : { provider: request.provider }),
          // This execution and this authored site. A provider carries it
          // wherever its service can hold a mark, which is how "already
          // created" is answered inside one run without a local record.
          idempotencyKey: issueIdempotencyKey(
            { runId: yield* useInvocation(), expansionId: expansion.id },
            "upsert",
            request.target,
          ),
        });
        const record = parseIssueRecord(answered);
        if (record === undefined) {
          throw new IssueProtocolError(
            "the issue provider answered an upsert with something that is not a URL",
          );
        }
        return record;
      },
    },
    { at: "min" },
  );

  /**
   * The transport the live upsert reaches GitHub through.
   *
   * The adapter's own resolver rather than a second reading beside it: where
   * the API lives is configuration, configuration belongs to the GitHub half,
   * and two places parsing the same variable is two places to get it wrong.
   * A run that opens no pull request reads the variable not at all.
   */
  const pullRequestSource = gitHubPullRequestAccess({
    host: denoGitHubSource,
    ...options.gitHubPullRequests,
  });

  yield* PullRequestOperations.around(
    {
      // Afresh, every execution. There is nothing to retain a read in and
      // nothing that would replay one, so what a document binds is what the
      // pull request holds now.
      *read([request]: [PullRequestReadInvocation]): Operation<PullRequestReadResult> {
        return yield* PullRequestAPI.operations.read(request.url, {
          kind: request.kind,
          ...(request.provider === undefined ? {} : { provider: request.provider }),
        });
      },

      *upsert([request]: [PullRequestUpsertInvocation]): Operation<PullRequestResult> {
        const checkout = yield* place(
          request.repository,
          request.workingDirectory,
          PULL_REQUEST_ELEMENT,
        );
        if (checkout.origin === undefined) {
          throw new PullRequestAdmissionError(
            "no-repository-context",
            "the checkout it selected records no usable origin, so there is no repository at a " +
              "Git host for a pull request to be opened in.",
          );
        }
        const headBranch = yield* currentBranch(yield* useGit(), checkout.root);
        if (headBranch === undefined) {
          throw new PullRequestAdmissionError(
            "unnamed-branch",
            "the checkout it selected has no branch checked out, so there is no head branch to " +
              "open a pull request from — and a detached HEAD is not something this run could " +
              "have published.",
          );
        }
        const headSha = yield* resolveCommit(yield* useGit(), checkout.root, "HEAD");
        if (headSha === undefined) {
          throw new PullRequestAdmissionError(
            "unnamed-branch",
            "the checkout it selected did not report the commit its branch holds.",
          );
        }
        // Before a credential is read and before anything is sent. What
        // authorizes a pull request is this execution's own record of
        // publishing the branch.
        admitLivePushEvidence(evidence, {
          identity: checkout.identity,
          checkoutRoot: checkout.root,
          origin: checkout.origin,
          branch: headBranch,
          destinationRef: destinationRefFor(headBranch),
          commit: headSha,
        });

        const inputs: PullRequestInputs = Object.freeze({
          repository: checkout.identity,
          number: request.pullRequest.number,
          title: request.pullRequest.title,
          body: request.pullRequest.body,
          draft: request.pullRequest.draft,
          headBranch,
          headSha,
          baseBranch: request.pullRequest.base,
        });
        const access = yield* (yield* pullRequestSource()).open();
        return yield* liveUpsertPullRequest(access, checkout.origin, inputs);
      },
    },
    { at: "min" },
  );
}

/** Register a checkout, replacing an earlier registration of the same root. */
function register(registered: RegisteredCheckout[], checkout: RegisteredCheckout): void {
  const existing = registered.findIndex((entry) => entry.root === checkout.root);
  if (existing < 0) {
    registered.push(checkout);
    return;
  }
  registered[existing] = checkout;
}

/**
 * The ambient repository, as a selection every element outside a `<Repository>`
 * receives.
 *
 * Its identity is the origin when it records one and its own Git directory
 * otherwise, because that is what identifies a repository with no remote. The
 * creation commit is the commit HEAD named when this execution started: it is
 * the instant this identity was pinned at, and — like every other member — it
 * says nothing about where HEAD is now.
 */
function registerAmbient(
  ambient: AmbientRepository,
  selections: ReturnType<typeof selectionRegistry<SelectedRepository>>,
  registered: RegisteredCheckout[],
): RepositorySelection {
  const identity: RepositoryIdentity = Object.freeze({
    name: ambient.name,
    locatorFingerprint: ambient.originFingerprint ?? locatorFingerprint(ambient.commonDirectory),
    requestedBase: null,
    creationCommit: ambient.head,
    primaryBranch: ambient.defaultBranch,
    objectFormat: ambient.objectFormat,
  });
  const checkout: RegisteredCheckout = Object.freeze({
    root: ambient.checkoutRoot,
    identity,
    repositoryName: ambient.name,
    // The checkout the command was run in, whether that is the repository's
    // primary one or a linked worktree somebody made by hand. Either way it is
    // the repository's own checkout as far as this execution is concerned.
    worktreeName: null,
    origin: ambient.origin,
  });
  register(registered, checkout);
  return selections.mint(
    `ambient ${ambient.commonDirectory} ${ambient.checkoutRoot}`,
    ambient.name,
    identity,
    ambient.checkoutRoot,
    { checkout, ownerCheckout: ambient.checkoutRoot, commonDirectory: ambient.commonDirectory },
  );
}
