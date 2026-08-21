/**
 * What `<Git.Push>` owns: one branch published to one remote, exactly once.
 *
 * Switch, Add and Commit move state this run's own SQLite transaction encloses,
 * so each of them commits its mutation, its Workspace root and its journal
 * result together. The branch a Push publishes to belongs to a Git host, and no
 * transaction here reaches it. So this operation is built the other way round:
 * it reads everything it needs out of the Workspace, closes that transaction,
 * and then reconciles one external effect through the shared Git-host state
 * machine — observe, then adopt, perform once, or refuse.
 *
 * ## What happens before the remote exists in the story
 *
 * Authority first, and all of it locally. The enclosing `<Repository>` and the
 * contextual working directory select a retained checkout the way they do for
 * every other Git operation; the observed record is compared with the retained
 * row member for member, every row is held to the identity naming it, and the
 * exported family is proven to be the checkout the record claims. Only then are
 * the branch and the commit read — from the checkout, never from a document.
 *
 * A checkout whose HEAD names no branch stops here. That is the one condition a
 * document can act on, and it is decided before a durable effect exists and
 * before anything is contacted: a detached HEAD names a commit rather than
 * somewhere to publish it, and this operation never invents a destination.
 *
 * ## The transaction and the remote do not overlap
 *
 * The Workspace transaction is opened for the export and closed before any
 * remote is observed, so a network round trip never holds the run's database.
 * It is also read-only: nothing is imported, no root is published, and no row
 * moves. A Push changes the Git host; it changes nothing here but the journal.
 *
 * Concurrent later Workspace movement therefore cannot alter what is published.
 * The provider acts on an object source frozen out of the export this operation
 * owns, not on whatever the Workspace holds when the transport gets around to
 * reading it.
 *
 * ## What the provider is given, and what it is not
 *
 * The transport needs the objects and the destination, and nothing else may
 * travel with them. The retained locator, the disposable control repository and
 * the object database live in this module's own closure: public Git-host
 * middleware sees the frozen JSON request #297 defines and no part of any of
 * them. The durable request carries the Repository's filtered identity without
 * its checkout path, the remote, the branch, the full destination ref and the
 * source commit — no host path, no locator, no credential and nothing Git said.
 */

import { Err, Ok, scoped, type Operation, type Result } from "effection";
import {
  GitOperationInfrastructureError,
  GitOperationProtocolError,
} from "../../composition/errors.ts";
import { PUSH } from "../../composition/components/GitPush.ts";
import {
  destinationRefFor,
  filteredRepositoryIdentity,
  GIT_PUSH,
  gitPushInputsJson,
  gitPushNaturalKeyJson,
  gitPushObservationsJson,
  gitPushPreStateJson,
  gitPushResultJson,
  parseGitPushInputs,
  parseGitPushRecord,
  pushExpectation,
  PUSH_REMOTE,
  refspecFor,
  sameRepositoryIdentity,
  type GitPushInputs,
  type GitPushOutcome,
  type GitPushRequest,
  type GitPushResult,
} from "../../composition/git-push-records.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import { reconcileGitHostEffect, withGitHostProvider } from "../../git-host/effect.ts";
import { GitHostUnavailableError } from "../../git-host/errors.ts";
import type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostObservation,
} from "../../git-host/records.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { transactWorkspaceRoots } from "../workspace/private.ts";
import { currentBranch, gitSession, observeRemoteRef, pushRefspec, resolveCommit } from "./git.ts";
import { objectSource, type PushObjectSource } from "./object-source.ts";
import { useGitAuthentication } from "./host.ts";
import type { RepositoryHost } from "./host.ts";
import type { GitAuthenticationSession } from "./authentication.ts";
import {
  exportCheckoutFamily,
  prepareCheckout,
  selectGitCheckout,
  type GitCheckout,
} from "./operations.ts";
import { gitRefusal } from "./refusals.ts";

function unusable(reason: string): never {
  throw new GitOperationInfrastructureError(PUSH, reason);
}

/**
 * The provider that answers this exact reconciliation, and no other.
 *
 * Installed around one `reconcileGitHostEffect()` call and reachable only from
 * inside it. Its closure holds the retained locator and the object source; what
 * it receives from the engine is the frozen request, which it parses and holds
 * to the inputs this invocation admitted. A request naming another Repository,
 * branch or commit is not this invocation's, and answering one would publish a
 * completion for something this operation never authorized.
 */
function pushProvider(
  source: PushObjectSource,
  locator: string,
  admitted: GitPushInputs,
  session: GitAuthenticationSession,
): GitHostProvider {
  function admit(request: CompleteGitHostEffectRequest): GitPushInputs {
    const inputs = parseGitPushInputs(request.inputs);
    if (
      request.kind !== GIT_PUSH ||
      inputs === undefined ||
      !sameRepositoryIdentity(inputs.repository, admitted.repository) ||
      inputs.branch !== admitted.branch ||
      inputs.destinationRef !== admitted.destinationRef ||
      inputs.sourceCommit !== admitted.sourceCommit
    ) {
      unusable("the Git host asked this provider about a push this invocation did not describe");
    }
    return inputs;
  }

  function completion(observedRemoteCommit: string): GitHostCompletion {
    return {
      observations: gitPushObservationsJson({ remoteCommit: observedRemoteCommit }),
      result: gitPushResultJson(resultOf(admitted, observedRemoteCommit)),
    };
  }

  return {
    *observe(request): Operation<Result<GitHostObservation>> {
      const inputs = admit(request);
      // The source proves its own containment on this first call, before any
      // remote is contacted and before anything could have been published.
      const directory = yield* source.ready();
      const observed = yield* observeRemoteRef(
        source.git,
        directory,
        locator,
        inputs.destinationRef,
        inputs.repository.objectFormat,
        session,
      );

      if (observed.state === "unreachable") {
        // Not absence. A host that could not answer has proven nothing, and
        // offering silence as absence is what would authorize a duplicate push.
        return Err(new GitHostUnavailableError());
      }
      if (observed.state === "ambiguous") {
        return Ok({ state: "ambiguous", preState: gitPushPreStateJson({ remoteCommit: null }) });
      }
      if (observed.state === "absent") {
        return Ok({ state: "absent", preState: gitPushPreStateJson({ remoteCommit: null }) });
      }
      if (observed.commit !== inputs.sourceCommit) {
        return Ok({
          state: "conflict",
          preState: gitPushPreStateJson({ remoteCommit: observed.commit }),
        });
      }
      // The destination already names exactly this commit, which is what an
      // interrupted attempt that reached the remote leaves behind. Adopting it
      // is how a push happens once rather than twice.
      const adopted = completion(observed.commit);
      return Ok({
        state: "compatible",
        preState: gitPushPreStateJson({ remoteCommit: observed.commit }),
        observations: adopted.observations,
        result: adopted.result,
      });
    },

    *perform(request): Operation<Result<GitHostCompletion>> {
      const inputs = admit(request);
      const directory = yield* source.ready();
      const refspec = refspecFor(inputs.sourceCommit, inputs.destinationRef);

      if (yield* pushRefspec(source.git, directory, locator, refspec, session)) {
        return Ok(completion(inputs.sourceCommit));
      }

      // What Git printed is not evidence: a remote writes into that stream, and
      // reading a rejection out of a sentence would let it decide what this run
      // believes happened. One more exact observation is the whole of what a
      // refused push earns, and nothing here retries or forces.
      const observed = yield* observeRemoteRef(
        source.git,
        directory,
        locator,
        inputs.destinationRef,
        inputs.repository.objectFormat,
        session,
      );
      if (observed.state === "present" && observed.commit === inputs.sourceCommit) {
        return Ok(completion(observed.commit));
      }
      // Anything else fails at this boundary rather than becoming an outcome.
      // A completion nobody proved would retire the effect as published, and a
      // temporary unavailability would say the host merely could not answer.
      unusable("native Git did not publish the branch, and the remote does not hold it");
    },
  };
}

function resultOf(inputs: GitPushInputs, observedRemoteCommit: string): GitPushResult {
  return {
    repository: inputs.repository,
    remote: inputs.remote,
    branch: inputs.branch,
    destinationRef: inputs.destinationRef,
    refspec: refspecFor(inputs.sourceCommit, inputs.destinationRef),
    sourceCommit: inputs.sourceCommit,
    observedRemoteCommit,
  };
}

/** What this invocation publishes: the branch the checkout is on, at its commit. */
function* admitInputs(checkout: GitCheckout, admitted: GitPushRequest): Operation<GitPushInputs> {
  const branch = yield* currentBranch(checkout.git, checkout.directory);
  if (branch === undefined) {
    throw gitRefusal(PUSH, "unnamed-branch");
  }
  const sourceCommit = yield* resolveCommit(checkout.git, checkout.directory, "HEAD");
  if (sourceCommit === undefined) {
    unusable("the checkout it ran in did not report the commit its branch holds");
  }
  return Object.freeze({
    repository: filteredRepositoryIdentity(admitted.repository),
    remote: PUSH_REMOTE,
    branch,
    destinationRef: destinationRefFor(branch),
    sourceCommit,
  });
}

/**
 * The whole of what `<Git.Push>` asks for: one reconciled effect, exactly parsed.
 *
 * Ordered so that everything a later step trusts has already been proven: the
 * retained rows and the export inside one short transaction, the exported
 * checkout's identity outside it, the branch and commit from that checkout, and
 * only then a frozen request and a provider that can answer for it.
 */
export function* createGitPush(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  request: GitPushRequest,
): Operation<GitPushOutcome> {
  // Admission takes a snapshot, and the snapshot is what the operation runs on.
  // A caller's request and the record inside it are its own objects, and this
  // operation has suspension points — a transaction, several Git commands, a
  // network round trip — across which whoever handed them over can still change
  // them. Reading them again later would let one Repository be authenticated
  // and another published for.
  const admitted: GitPushRequest = Object.freeze({
    repository: Object.freeze({ ...request.repository }),
    workingDirectory: request.workingDirectory,
  });

  return yield* scoped(function* () {
    const root = yield* host.useDirectory();
    const git = gitSession(host, root);

    // Held open for the export alone. Everything after this reads files, and a
    // remote round trip must never keep the run's database locked.
    const prepared = yield* transactWorkspaceRoots(database, function* (workspace) {
      const selection = selectGitCheckout(workspace.metadata, PUSH, admitted);
      return {
        selection,
        exported: yield* exportCheckoutFamily(workspace.filesystem, root, selection),
      };
    });
    if (!prepared.ok) {
      throw prepared.error;
    }
    const { selection, exported } = prepared.value;

    const checkout = yield* prepareCheckout(root, git, selection, exported, PUSH);
    const inputs = yield* admitInputs(checkout, admitted);

    // The exact retained locator, authenticated against its own fingerprint
    // when the row was read, rather than `remote.origin.url` or a `pushurl` out
    // of a configuration file this run merely stores.
    const locator = selection.repository.locator;
    // Its directory is acquired here, so it is removed with this push whether
    // or not anything is built inside it. Everything else the source does waits
    // until a live provider asks: a completed replay reaches none.
    const source = objectSource(
      host,
      yield* host.useDirectory(),
      checkout,
      inputs.repository.objectFormat,
      PUSH,
    );

    // One session for this whole reconciliation, opened after the inputs were
    // admitted and shared by its observations and its mutation, so a push and
    // the observation that decided it go out under one identity. It is released
    // with the scope below; a later attempt on an interrupted request opens its
    // own.
    const session = yield* useGitAuthentication(host, locator);

    const record = yield* withGitHostProvider(
      pushProvider(source, locator, inputs, session),
      reconcileGitHostEffect({
        kind: GIT_PUSH,
        inputs: gitPushInputsJson(inputs),
        naturalKey: gitPushNaturalKeyJson({
          repository: inputs.repository,
          remote: inputs.remote,
          destinationRef: inputs.destinationRef,
        }),
      }),
    );

    // Read for this invocation rather than merely read. The shared engine has
    // already held the record's request to the request being made; what is
    // decided here is that its three JSON members describe this exact push and
    // that the decision the engine recorded is one its pre-state supports.
    const outcome = parseGitPushRecord(record, pushExpectation(inputs));
    if (outcome === undefined) {
      throw new GitOperationProtocolError(PUSH);
    }
    return outcome;
  });
}
