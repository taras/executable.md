/**
 * What authorizes one REPL entry to open or update a pull request.
 *
 * A pull request is a statement about a branch that already exists at the Git
 * host, so an entry may only ask for one over a branch *this entry* published.
 * Proving that takes the saved Push request together with its acknowledged
 * outcome: the receipt alone says what the host holds and says nothing about
 * which checkout asked for it, and a pull request opened on somebody else's
 * branch would be publishing their work under this entry's name.
 *
 * The pairing is not performed here. `push-admission.ts` already walks this
 * entry's segment, validates every saved request against its outcome and
 * refuses a history it cannot account for; this reads what that walk validated.
 * A second walk would be a second pairing algorithm that could disagree with
 * the one admission already performed.
 *
 * ## What counts, and what does not
 *
 * The last successful acknowledged pair for this Repository, admitted origin,
 * branch and destination ref decides, in physical journal outcome order. That
 * pair must name the same resolved checkout root, the same common directory and
 * the same commit the pull request resolved. Another checkout's publication
 * cannot authorize it even at the same commit, another entry's cannot be
 * borrowed because the walk refuses a foreign owner before this reader sees it,
 * a failed outcome and a trailing pending request prove nothing, and an earlier
 * exact pair cannot override a later publication of the same destination.
 *
 * Sibling coroutines restoring in another order change none of it: this is a
 * reading of the acknowledged stream, not of a schedule, and no evidence list
 * is accumulated in memory as execution proceeds.
 *
 * A saved pull-request request is evidence this proof already succeeded for
 * that exact request. Recovering one validates its historical provenance rather
 * than today's checkout, which is why recovery does not come back through here.
 */

import type { Operation } from "effection";
import { DurableContext } from "@executablemd/durable-streams";
import { PullRequestAdmissionError } from "@executablemd/git";
import { sameRepositoryIdentity } from "@executablemd/git/api";
import { type RepositoryIdentity } from "@executablemd/git";
import { walkReplRetainedPublications, type ReplAcknowledgedPush } from "./push-admission.ts";

/** The branch, destination and commit a pull request needs a publication of. */
export interface ReplPullRequestPublicationQuestion {
  /** The authenticated Repository identity the upsert belongs to. */
  readonly repository: RepositoryIdentity;
  /** The admitted credential-free locator the branch was published to. */
  readonly origin: string;
  /** The named branch the head commit is on. */
  readonly branch: string;
  /** The full destination ref the publication named. */
  readonly destinationRef: string;
  /** The checkout the upsert resolved from. */
  readonly checkoutRoot: string;
  /** That checkout's canonical common Git directory. */
  readonly commonDirectory: string;
  /** The exact commit the pull request will name as its head. */
  readonly headSha: string;
}

/**
 * Prove this entry published the branch, or refuse before anything is opened.
 *
 * Reads this entry's own acknowledged history through the durable stream it is
 * already executing against. Nothing is contacted, no checkout is inspected and
 * no credential is read: this decides whether a request may be saved at all.
 */
export function* proveReplPullRequestPublication(
  owner: string,
  question: ReplPullRequestPublicationQuestion,
): Operation<void> {
  const context = yield* DurableContext.expect();

  let publications: readonly ReplAcknowledgedPush[];
  try {
    const retained = yield* context.stream.readAll();
    publications = (yield* walkReplRetainedPublications(owner, retained)).pushes;
  } catch {
    // The walk refuses a history it cannot account for, and a history that
    // cannot be read is not one a publication can be proven from. Nothing of
    // what it held travels into this sentence.
    throw new PullRequestAdmissionError(
      "unreadable-push-evidence",
      "this entry's retained publication history could not be read, so whether the branch this " +
        "pull request names was published by this entry is unknown.",
    );
  }

  // The last one wins. A supervised entry publishes one destination repeatedly,
  // so an earlier exact pair followed by a later publication of the same
  // destination describes a branch that has since moved on.
  const relevant = publications.filter((pair) => addresses(pair, question));
  const last = relevant.at(-1);
  if (last === undefined) {
    throw new PullRequestAdmissionError(
      "missing-push-evidence",
      "this entry has no acknowledged publication of that branch to this repository's origin, " +
        "so there is no branch at the Git host this entry may open a pull request over. Write " +
        "<Git.Push /> for it in this entry first.",
    );
  }
  if (!produced(last, question)) {
    throw new PullRequestAdmissionError(
      "conflicting-push-evidence",
      "this entry's most recent acknowledged publication of that branch names a different " +
        "checkout or a different commit than this pull request resolved, so the two describe " +
        "different work. Publish this checkout's current commit before asking for a pull " +
        "request over it.",
    );
  }
}

function addresses(
  pair: ReplAcknowledgedPush,
  question: ReplPullRequestPublicationQuestion,
): boolean {
  const inputs = pair.request.resolved.inputs;
  return (
    sameRepositoryIdentity(inputs.repository, question.repository) &&
    pair.request.resolved.origin === question.origin &&
    inputs.branch === question.branch &&
    inputs.destinationRef === question.destinationRef
  );
}

/**
 * Whether that publication is the one this pull request's head came from.
 *
 * The checkout provenance and the commit together. A publication of the same
 * destination from another checkout is somebody else's work in this entry, and
 * one of an earlier commit describes a branch this head has moved past.
 */
function produced(
  pair: ReplAcknowledgedPush,
  question: ReplPullRequestPublicationQuestion,
): boolean {
  return (
    pair.request.resolved.checkoutRoot === question.checkoutRoot &&
    pair.request.resolved.commonDirectory === question.commonDirectory &&
    pair.request.resolved.inputs.sourceCommit === question.headSha
  );
}
