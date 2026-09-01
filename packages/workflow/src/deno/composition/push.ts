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
import { getExpansion } from "@executablemd/core";
import {
  GitOperationInfrastructureError,
  GitOperationProtocolError,
} from "../../composition/errors.ts";
import { PUSH } from "../../composition/components/GitPush.ts";
import {
  ANCESTOR,
  destinationRefFor,
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
  type GitPushInputs,
  type GitPushOutcome,
  type GitPushRequest,
  type GitPushResult,
} from "../../composition/git-push-records.ts";
import type { GitHostProvider } from "../../git-host/api.ts";
import { reconcileGitHostEffect, withGitHostProvider } from "../../git-host/effect.ts";
import { GIT_HOST_EFFECT } from "../../git-host/effect-type.ts";
import { GitHostUnavailableError } from "../../git-host/errors.ts";
import {
  parseGitHostReconciliationRecord,
  type CompleteGitHostEffectRequest,
  type GitHostCompletion,
  type GitHostObservation,
} from "../../git-host/records.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { transactWorkspaceRoots } from "../workspace/private.ts";
import type { PrivateWorkspaceTransaction } from "../workspace/private.ts";
import {
  commitPresent,
  currentBranch,
  gitSession,
  observeRemoteRef,
  pushRefspec,
  resolveCommit,
} from "./git.ts";
import { objectSource, type PushObjectSource } from "./object-source.ts";
import { useGitAuthentication } from "./host.ts";
import type { RepositoryHost } from "./host.ts";
import type { GitAuthenticationSession } from "./authentication.ts";
import {
  exportCheckoutFamily,
  prepareCheckout,
  selectGitCheckout,
  type ExportedCheckouts,
  type GitCheckout,
  type GitCheckoutSelection,
} from "./operations.ts";
import { gitRefusal } from "./refusals.ts";

import { filteredRepositoryIdentity, sameRepositoryIdentity } from "../../composition/selection.ts";
import type { RepositoryIdentity } from "../../composition/selection.ts";
function unusable(reason: string): never {
  throw new GitOperationInfrastructureError(PUSH, reason);
}

/**
 * Whether the commit the destination holds is provably behind the one being
 * published, decided entirely inside the authenticated object source.
 *
 * This is the whole of what turns an ordinary fast-forward into something this
 * operation may perform, so it is proved rather than inferred, and proved from
 * objects this run already authenticated. The control repository and its
 * read-only alternate are the only place it reads: the selected checkout is
 * configuration a document can write, and the remote has already said all it is
 * going to say.
 *
 * A commit the source does not hold is not an answer, and it is not a question
 * either. Fetching it would manufacture the very compatibility being asked
 * about — the objects would then be here because this proof went and got them,
 * not because the run had already published them — so an object that is absent
 * is an ordinary conflict.
 *
 * Git answers ancestry with an exit status and nothing else: 0 is ancestry, 1 is
 * divergence. Any other status means the proof did not run or did not decide —
 * including the case where a source commit this run cannot read makes the
 * traversal itself impossible — and a decision that was not reached is not a
 * finding about the remote.
 */
function* provenAncestor(
  source: PushObjectSource,
  directory: string,
  observed: string,
  desired: string,
): Operation<boolean> {
  if (!(yield* commitPresent(source.git, directory, observed))) {
    return false;
  }
  const outcome = yield* source.git.run(
    ["merge-base", "--is-ancestor", observed, desired],
    directory,
  );
  if (outcome.code === 0) {
    return true;
  }
  if (outcome.code === 1) {
    return false;
  }
  unusable("native Git could not decide whether the branch already holds an earlier commit");
}

/**
 * The Workspace root this invocation's own retained Push was written against,
 * or `undefined` when it has none and this is a live attempt.
 *
 * A Push names its request from the checkout: the branch it is on and the
 * commit that branch holds. That reading is a question about a moment, and a
 * replay asks it after the run has moved on — a document that publishes a
 * branch, commits again and publishes it again would otherwise reconstruct its
 * first Push out of the second commit and ask the journal about a request that
 * position never made.
 *
 * So a completed Push is reconstructed from the root its own journal row was
 * appended against. That association was made when the event was written and is
 * the only thing here that says where this position was; the current pointer,
 * the branch name and the retained payload all describe somewhere else, or
 * describe it circularly.
 *
 * Reading history is all this does. The root it names still has to produce the
 * exact request whose fingerprint the shared engine is looking for, so a wrong
 * one refuses the replay rather than answering it, and no root selected here
 * can authorize live Git-host work.
 */
function* retainedPushRoot(
  database: WorkflowRunDatabase,
  expansionId: string,
  repository: RepositoryIdentity,
): Operation<string | undefined> {
  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    throw entries.error;
  }
  let selected: string | undefined;
  for (const entry of entries.value) {
    const event = entry.event;
    if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    const inputs =
      record?.request.kind === GIT_PUSH && record.request.identity.expansionId === expansionId
        ? parseGitPushInputs(record.request.inputs)
        : undefined;
    // A record this position cannot read as a Push of the Repository it
    // admitted is not one to reconstruct from. It is not read around either:
    // the shared engine holds every retained record at this position to the
    // request being made, and refuses one that answers a different question.
    if (inputs === undefined || !sameRepositoryIdentity(inputs.repository, repository)) {
      continue;
    }
    if (selected !== undefined) {
      unusable("this run retains more than one published branch for the same invocation");
    }
    selected = entry.workspaceRootId;
  }
  return selected;
}

/** The checkout family this invocation names its request from, exported to `root`. */
function* exportRequestSource(
  workspace: PrivateWorkspaceTransaction,
  retained: string | undefined,
  root: string,
  selection: GitCheckoutSelection,
): Operation<ExportedCheckouts> {
  const family = () => exportCheckoutFamily(workspace.filesystem, root, selection);
  if (retained === undefined || retained === (yield* workspace.currentRoot())) {
    return yield* family();
  }
  return yield* workspace.readRetainedRoot(retained, family);
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
        // The branch already exists somewhere behind this commit, which is what
        // a second iteration on the same branch leaves. The completion is
        // absent — the destination does not hold this commit — and the
        // predecessor travels with the proof that publishing over it advances
        // the branch rather than replacing it, so the shared state machine
        // performs the same exact non-force push it performs against absence.
        if (yield* provenAncestor(source, directory, observed.commit, inputs.sourceCommit)) {
          return Ok({
            state: "absent",
            preState: gitPushPreStateJson({
              remoteCommit: observed.commit,
              relation: ANCESTOR,
            }),
          });
        }
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

    // Which moment this invocation is naming its request from. Read before the
    // transaction, because it is a question about retained history rather than
    // about the Workspace, and a transaction here cannot nest inside itself.
    const expansion = yield* getExpansion();
    const retained = yield* retainedPushRoot(
      database,
      expansion.id,
      filteredRepositoryIdentity(admitted.repository),
    );

    // Held open for the export alone. Everything after this reads files, and a
    // remote round trip must never keep the run's database locked.
    const prepared = yield* transactWorkspaceRoots(database, function* (workspace) {
      const selection = selectGitCheckout(workspace.metadata, PUSH, admitted);
      return {
        selection,
        exported: yield* exportRequestSource(workspace, retained, root, selection),
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
