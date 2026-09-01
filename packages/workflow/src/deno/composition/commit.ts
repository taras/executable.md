/**
 * What `<Git.Commit>` owns: one commit of the index, and the proof it is that.
 *
 * Everything about *where* it happens belongs to the operation envelope. What is
 * here is the commit itself, which is one decision and then a great deal of
 * checking. The decision is whether there is anything to commit: an index that
 * already describes what HEAD describes is the one condition a document can act
 * on, and it is decided from the checkout's own state before native Git is asked
 * for anything.
 *
 * The checking is the rest. A commit is an object, and this provider retains
 * what that object is rather than the fact that a command exited zero — so the
 * commit is read back out of the repository that wrote it, and its parent, its
 * tree, its message bytes and its two timestamps all have to be the ones this
 * operation asked for. A commit that turned out to be a merge, that recorded a
 * different tree, or whose message is not byte-for-byte what was composed, is
 * not this invocation's commit, and nothing is imported or published for it.
 *
 * The message is never retained. What is kept is a digest of its exact bytes and
 * how many of them there were, which is what makes the read-back a proof and
 * keeps authored prose out of the run's own history.
 */
import { type Operation } from "effection";
import { getExpansion, sourceDescription } from "@executablemd/core";
import type { EffectDescription, Json } from "@executablemd/durable-streams";
import { createHash } from "node:crypto";
import {
  GitOperationInfrastructureError,
  GitOperationProtocolError,
} from "../../composition/errors.ts";
import {
  gitCommitResultJson,
  parseGitCommitResult,
  type GitCheckoutState,
  type GitCommitMessageSource,
  type GitCommitRequest,
  type GitCommitResult,
} from "../../composition/git-records.ts";
import {
  admitCommitMessage,
  admitMessageSource,
  COMMIT,
} from "../../composition/components/GitCommit.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { commitIndex, readCommit, readCommitMessage, resolveCommit } from "./git.ts";
import type { GitCommitIdentity, RepositoryHost } from "./host.ts";
import { settled, type CompositionOutcome, type MutationContext } from "./effects.ts";
import { gitRefused } from "./refusals.ts";
import {
  checkoutState,
  gitOperationFingerprint,
  performGitOperation,
  type GitCheckout,
} from "./operations.ts";
import { placedCheckout } from "./identity.ts";

/** The effect type one commit is recorded under. */
export const WORKSPACE_GIT_COMMIT = "workspace_git_commit";

/** What a run retains about a message instead of the message. */
export interface GitCommitMessageEvidence {
  readonly digest: string;
  readonly length: number;
}

/**
 * The evidence one message's bytes leave behind.
 *
 * UTF-8, because that is what Git receives and what a byte length has to be
 * counted in for the two to describe the same thing. Derived once, from the
 * admitted bytes, and then compared against everything: what Git read back, and
 * what a retained result claims.
 */
export function gitCommitMessageEvidence(message: string): GitCommitMessageEvidence {
  const bytes = new TextEncoder().encode(message);
  return Object.freeze({
    digest: createHash("sha256").update(bytes).digest("hex"),
    length: bytes.length,
  });
}

/**
 * How one commit is identified.
 *
 * Takes the admitted snapshot, like everything below it: `createGitCommit()` is
 * the only door, so nothing here can be handed a request whose values may still
 * change underneath it.
 *
 * The message itself takes part rather than its digest. The encoding is
 * injective over the values it covers, so a document edited to commit other
 * prose in the same place is a different effect and diverges rather than
 * replaying the previous one's SHA. What is deliberately absent is the time:
 * the second is captured while the effect runs, and an identity that included it
 * would make every replay a different effect from the one it is replaying.
 */
function* describeCommit(admitted: GitCommitRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  const configuration = gitOperationFingerprint([
    admitted.repository.name,
    admitted.repository.locatorFingerprint,
    admitted.repository.requestedBase,
    admitted.repository.creationCommit,
    admitted.repository.primaryBranch,
    admitted.repository.objectFormat,
    admitted.repository.checkoutPath,
    admitted.workingDirectory,
    admitted.messageSource,
    admitted.message,
  ]);
  return {
    type: WORKSPACE_GIT_COMMIT,
    name: `${expansion.id}:${admitted.repository.name}:${configuration}`,
    configuration,
    ...sourceDescription(expansion.position),
  };
}

/** What the commit turned out to be, once the repository has been asked. */
export interface Committed {
  readonly parent: string;
  readonly tree: string;
  readonly commit: string;
  readonly committedAt: number;
}

function unexpected(reason: string): never {
  throw new GitOperationInfrastructureError(COMMIT, reason);
}

/**
 * Commit the index, then prove the object that produced is the one asked for.
 *
 * Every reading here happens while the attempt can still be taken back. A
 * verification that ran after the transaction had committed would be reporting
 * damage rather than preventing it, so what native Git produced is read,
 * compared and — when it is not what this operation asked for — thrown on,
 * before anything is canonicalized, imported or published.
 */
export function* performCommit(
  checkout: GitCheckout,
  before: GitCheckoutState,
  message: string,
  evidence: GitCommitMessageEvidence,
  /**
   * Who this commit is by, when it is not the fixed workflow identity.
   *
   * Absent for a workflow run, whose retained Git state must not depend on
   * whose machine it was made on. Present for an ordinary run, where the commit
   * lands in the caller's own checkout.
   */
  identity?: GitCommitIdentity,
): Operation<Committed> {
  // Nothing staged is not a failure of native Git; it is the state of the
  // checkout, and a document can act on it. Deciding it here means no command
  // runs and no object is written for a commit that was never going to exist.
  if (before.indexTree === before.headTree) {
    gitRefused(COMMIT, "empty-index");
  }

  const { git, workingDirectory, directory } = checkout;
  const committedAt = Math.floor(Date.now() / 1000);
  yield* commitIndex(git, {
    operation: COMMIT,
    workingDirectory,
    message,
    committedAt,
    ...(identity === undefined ? {} : { identity }),
  });

  const commit = yield* resolveCommit(git, directory, "HEAD");
  if (commit === undefined) {
    unexpected("the checkout it ran in did not report the commit it had just written");
  }
  const facts = yield* readCommit(git, directory, commit);
  if (facts === undefined) {
    unexpected("the commit it wrote could not be read back out of the checkout");
  }

  // Exactly one parent, and the commit the checkout was on. A merge or an
  // amend-like transition is a different operation with a different history,
  // and this one has no word for either.
  const [parent] = facts.parents;
  if (facts.parents.length !== 1 || parent !== before.commit || commit === before.commit) {
    unexpected("the commit it wrote does not continue the commit the checkout was on");
  }
  if (facts.tree !== before.indexTree) {
    unexpected("the commit it wrote does not hold the tree the index described");
  }
  if (facts.authoredAt !== committedAt || facts.committedAt !== committedAt) {
    unexpected("the commit it wrote is not stamped with the instant this operation captured");
  }
  // Read back rather than assumed. The identity is the one thing about a commit
  // this provider borrows from outside itself, so the object is held to it: a
  // host that ignored the variables would otherwise write somebody else's name
  // and this operation would report success.
  if (
    identity !== undefined &&
    (facts.authorName !== identity.authorName ||
      facts.authorEmail !== identity.authorEmail ||
      facts.committerName !== identity.committerName ||
      facts.committerEmail !== identity.committerEmail)
  ) {
    unexpected("the commit it wrote does not record the identity this operation was given");
  }

  const written = yield* readCommitMessage(git, directory, commit);
  if (written === undefined) {
    unexpected("the message of the commit it wrote could not be read back");
  }
  const round = gitCommitMessageEvidence(written);
  if (round.digest !== evidence.digest || round.length !== evidence.length) {
    unexpected("the commit it wrote does not hold the message bytes it was given");
  }

  // The checkout's own end state, read the same way the envelope reads it. A
  // commit moves the branch it is on and leaves the index describing what it
  // wrote; a checkout that ended anywhere else did something this operation
  // cannot describe.
  const after = yield* checkoutState(git, directory, COMMIT);
  if (
    after.branch !== before.branch ||
    after.commit !== commit ||
    after.headTree !== facts.tree ||
    after.indexTree !== facts.tree
  ) {
    unexpected("the checkout it ran in did not end on the commit it had just written");
  }

  return { parent, tree: facts.tree, commit, committedAt };
}

function performGitCommit(
  context: MutationContext,
  host: RepositoryHost,
  admitted: GitCommitRequest,
  evidence: GitCommitMessageEvidence,
): Operation<CompositionOutcome> {
  return performGitOperation(
    context,
    host,
    COMMIT,
    { repository: admitted.repository, workingDirectory: admitted.workingDirectory },
    (checkout: GitCheckout, before: GitCheckoutState) =>
      performCommit(checkout, before, admitted.message, evidence),
    (checkout, before: GitCheckoutState, after: GitCheckoutState, performed: Committed): Json =>
      gitCommitResultJson({
        checkout: checkout.identity,
        messageSource: admitted.messageSource,
        messageDigest: evidence.digest,
        messageLength: evidence.length,
        parent: performed.parent,
        tree: performed.tree,
        commit: performed.commit,
        committedAt: performed.committedAt,
        before,
        after,
      }),
  );
}

/** The whole of what `<Git.Commit>` asks for: one durable effect, exactly parsed. */
export function* createGitCommit(
  database: WorkflowRunDatabase,
  host: RepositoryHost,
  request: GitCommitRequest,
): Operation<GitCommitResult> {
  // Admission takes a snapshot, and the snapshot is what the operation runs on.
  // A caller's request and the record inside it are its own objects, and this
  // operation has suspension points — a transaction, several Git commands, an
  // import — across which whoever handed them over can still change them.
  // Reading them again later would let an effect identify one commit, hand Git
  // the bytes of another and retain a digest of a third.
  const source: GitCommitMessageSource = admitMessageSource(request.messageSource);
  const admitted: GitCommitRequest = Object.freeze({
    repository: Object.freeze({ ...request.repository }),
    workingDirectory: request.workingDirectory,
    message: admitCommitMessage(request.message),
    messageSource: source,
  });
  const evidence = gitCommitMessageEvidence(admitted.message);

  const outcome = yield* settled(
    "git",
    COMMIT,
    database,
    yield* describeCommit(admitted),
    (filesystem, metadata) => performGitCommit({ filesystem, metadata }, host, admitted, evidence),
  );
  // Read for this request rather than merely read: a result whose checkout,
  // message evidence or object graph does not describe this invocation is not
  // this invocation's result, whatever else it is. The identity it names is then
  // held to this provider's own placement, which is the half of it the shared
  // protocol has no way to decide.
  const result = parseGitCommitResult(outcome, {
    repository: admitted.repository,
    workingDirectory: admitted.workingDirectory,
    messageSource: admitted.messageSource,
    messageDigest: evidence.digest,
    messageLength: evidence.length,
  });
  if (result === undefined || !placedCheckout(result.checkout, admitted.repository)) {
    throw new GitOperationProtocolError(COMMIT);
  }
  return result;
}
