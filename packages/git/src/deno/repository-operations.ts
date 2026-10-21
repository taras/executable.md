/**
 * The native repository work a retaining host asks for, and nothing it owns.
 *
 * A host that retains what an entry did needs real Git: it has to discover the
 * checkout somebody started in, select a managed one, switch, stage and commit
 * in it, read a branch and a commit back, answer the four local reads, and hand
 * the shared Git-host engine a provider for one publication. None of that is
 * retention, and none of it is this module's to retain.
 *
 * ## Why this is a handle and not the host
 *
 * The shipped `RepositoryHost` runs arbitrary Git with a built environment, and
 * a `GitSession` and an authentication session carry an identity. Handing any of
 * those to a caller would put a credential, a command runner and a configuration
 * override in a public return graph, where the only thing protecting them would
 * be nobody looking. So what crosses this boundary is twelve operations that
 * take and answer domain data — paths, identities, object ids, normalized
 * results — and one provider whose own surface is `observe` and `perform`.
 *
 * ## What it acquires, and when
 *
 * Nothing, until something asks. Building the handle constructs the shipped host
 * and remembers how to open a session; it opens no directory, takes no lock,
 * runs no Git, reads no identity, no configuration and no credential. The
 * session is acquired on first use into the scope that built the handle, which
 * is the execution that owns it — the same lifetime the initializer gives it
 * today.
 *
 * One operation is deliberately different. `pushProvider` acquires in its
 * *caller's* scope rather than this one, because the scratch repository and the
 * credential session it needs belong to one owned attempt: they have to stay
 * alive across that attempt's observe and perform, and be joined when it
 * unwinds. Capturing the entry's scope for them would keep a credential open
 * for the rest of the entry.
 */

import { useScope } from "effection";
import type { Operation } from "effection";
import { denoRepositoryHost, useGitAuthentication } from "./composition/host.ts";
import type { RepositoryHost } from "./composition/host.ts";
import { commitPresent, currentBranch, gitSession, resolveCommit } from "./composition/git.ts";
import type { GitSession } from "./composition/git.ts";
import type { HelperAssembly } from "./composition/credential-helper.ts";
import { objectSourceAt } from "./composition/object-source.ts";
import { pushProvider } from "./composition/push.ts";
import { performGitObservation } from "./composition/observations.ts";
import type { ObservationPlace } from "./composition/observations.ts";
import { discoverAmbientCheckout, discoverAmbientRepository } from "./run-composition/ambient.ts";
import type { AmbientCheckout, AmbientRepository } from "./run-composition/ambient.ts";
import { selectManagedRepository, selectManagedWorktree } from "./run-composition/checkouts.ts";
import type {
  ManagedRepository,
  ManagedWorktree,
  WorktreeCreation,
} from "./run-composition/checkouts.ts";
import { lazily } from "./run-composition/lazy.ts";
import { liveAdd, liveCheckout, liveCommit, liveSwitch } from "./run-composition/operations.ts";
import type { RegisteredCheckout } from "./run-composition/operations.ts";
import type { GitCommitIdentity } from "./run-composition/identity.ts";
import { PUSH } from "../composition/components/GitPush.ts";
import type { GitPushInputs } from "../composition/git-push-records.ts";
import type {
  GitAddResult,
  GitCommitMessageSource,
  GitCommitResult,
  GitSwitchResult,
} from "../composition/git-records.ts";
import type { GitObservationRequest, GitObservationValue } from "../composition/observation-api.ts";
import type { GitHostProvider } from "../git-host/api.ts";

/**
 * Twelve native operations over domain data.
 *
 * No options bag, no host or session getter, no arbitrary command runner, no
 * environment, no observer, no authentication override and no raw attachment.
 */
export interface DenoRepositoryOperations {
  ambientCheckout(from: string): Operation<AmbientCheckout | undefined>;
  ambientRepository(from: string): Operation<AmbientRepository | undefined>;

  selectRepository(
    slot: string,
    request: {
      readonly name: string;
      readonly locator: string;
      readonly base: string | undefined;
    },
  ): Operation<ManagedRepository>;
  selectWorktree(slot: string, creation: WorktreeCreation): Operation<ManagedWorktree>;

  switch(
    checkout: RegisteredCheckout,
    workingDirectory: string,
    branch: string,
    base: string | undefined,
  ): Operation<GitSwitchResult>;
  add(
    checkout: RegisteredCheckout,
    workingDirectory: string,
    paths: readonly string[],
  ): Operation<GitAddResult>;
  commit(
    checkout: RegisteredCheckout,
    workingDirectory: string,
    message: string,
    messageSource: GitCommitMessageSource,
    identity: GitCommitIdentity | undefined,
  ): Operation<GitCommitResult>;

  currentBranch(directory: string): Operation<string | undefined>;
  resolveCommit(directory: string, revision: string): Operation<string | undefined>;
  commitPresent(directory: string, commit: string): Operation<boolean>;
  observe(
    element: string,
    request: GitObservationRequest,
    place: ObservationPlace,
  ): Operation<GitObservationValue>;

  pushProvider(
    commonDirectory: string,
    origin: string,
    inputs: GitPushInputs,
  ): Operation<GitHostProvider>;
}

/**
 * One handle for the execution that asked for it.
 *
 * The helper is the deployment's own credential-helper assembly, which is what
 * a clone of an authenticated locator needs; it is not a credential and not a
 * callback over one.
 */
export function useDenoRepositoryOperations(
  helper?: HelperAssembly,
): Operation<DenoRepositoryOperations> {
  // The one shipped host this package builds, and the only place it is built
  // for this handle. Everything below is the builder, so what the public path
  // does and what a package-local caller can observe are the same code.
  return repositoryOperationsOver(denoRepositoryHost(helper === undefined ? {} : { helper }));
}

/**
 * The same handle, over a host the caller already has.
 *
 * Package-private, and deliberately absent from every entrypoint: handing a
 * `RepositoryHost` across the package boundary is the surface the amendment
 * withheld. What it exists for is this package's own tests — the acquisition
 * windows inside `pushProvider`, and the inertness of construction itself, are
 * only observable at the leaves a host owns, and a control that substituted a
 * *different* host would be watching something the public factory never calls.
 */
export function* repositoryOperationsOver(
  host: RepositoryHost,
): Operation<DenoRepositoryOperations> {
  // The scope that asked for the handle, which is the execution that owns it.
  const owner = yield* useScope();
  const useGit = lazily(owner, function* (): Operation<GitSession> {
    return gitSession(host, yield* host.useDirectory());
  });

  return {
    *ambientCheckout(from: string): Operation<AmbientCheckout | undefined> {
      return yield* discoverAmbientCheckout(yield* useGit(), from);
    },
    *ambientRepository(from: string): Operation<AmbientRepository | undefined> {
      return yield* discoverAmbientRepository(yield* useGit(), from);
    },

    *selectRepository(slot, request): Operation<ManagedRepository> {
      return yield* selectManagedRepository(yield* useGit(), host, slot, request);
    },
    *selectWorktree(slot, creation): Operation<ManagedWorktree> {
      return yield* selectManagedWorktree(yield* useGit(), slot, creation);
    },

    *switch(checkout, workingDirectory, branch, base): Operation<GitSwitchResult> {
      const git = yield* useGit();
      return yield* liveSwitch(liveCheckout(git, checkout, workingDirectory), branch, base);
    },
    *add(checkout, workingDirectory, paths): Operation<GitAddResult> {
      const git = yield* useGit();
      return yield* liveAdd(liveCheckout(git, checkout, workingDirectory), paths);
    },
    *commit(
      checkout,
      workingDirectory,
      message,
      messageSource,
      identity,
    ): Operation<GitCommitResult> {
      const git = yield* useGit();
      return yield* liveCommit(
        liveCheckout(git, checkout, workingDirectory),
        message,
        messageSource,
        identity,
      );
    },

    *currentBranch(directory: string): Operation<string | undefined> {
      return yield* currentBranch(yield* useGit(), directory);
    },
    *resolveCommit(directory: string, revision: string): Operation<string | undefined> {
      return yield* resolveCommit(yield* useGit(), directory, revision);
    },
    *commitPresent(directory: string, commit: string): Operation<boolean> {
      return yield* commitPresent(yield* useGit(), directory, commit);
    },
    observe(
      element: string,
      request: GitObservationRequest,
      place: ObservationPlace,
    ): Operation<GitObservationValue> {
      // The existing joined child scope is this operation's own, so it is
      // handed through rather than wrapped in a second one.
      return performGitObservation(host, element, request, place);
    },

    *pushProvider(commonDirectory, origin, inputs): Operation<GitHostProvider> {
      // The caller's attempt, not the entry: the scratch repository and the
      // credential session below belong to one owned attempt and are joined
      // when it unwinds.
      const attempt = yield* useScope();
      const source = objectSourceAt(
        host,
        yield* host.useDirectory(),
        commonDirectory,
        inputs.repository.objectFormat,
        PUSH,
      );
      const provider = pushProvider(
        source,
        origin,
        inputs,
        lazily(attempt, () => useGitAuthentication(host, origin)),
      );
      // Only the two phases. A source, a session or a scratch path on this
      // object would be the credential graph this boundary exists to close.
      return { observe: provider.observe, perform: provider.perform };
    },
  };
}
