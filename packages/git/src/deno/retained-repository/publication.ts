/**
 * What one entry may publish, and what it published.
 *
 * A pull request says "here is work I have pushed", and the only thing that
 * makes the branch it names *this entry's* work is this entry's own record of
 * publishing it. So publication admission is rebuilt here, in the entry's
 * private closure, out of two things that have to agree:
 *
 * - a retained push record, which says which checkout this entry froze a
 *   publication request for; and
 * - an accepted successful Git-host record, which says the publication
 *   happened.
 *
 * Neither is evidence on its own. The retained record is written before the
 * remote is contacted, so it proves an intention rather than a publication; the
 * Git-host record carries the repository, the destination and the commit but
 * not the checkout, so it cannot say which of two checkouts of one repository
 * this entry pushed from. Pairing them is what yields the whole identity a
 * pull request has to match.
 *
 * The scan fails closed, exactly as the workflow host's does: a successful
 * Git-host record this version cannot read as one whole thing refuses the
 * admission rather than being skipped, because "I could not read it" must never
 * come out as "there is nothing there".
 *
 * Nothing here is a capability. The records are data in a journal anybody may
 * read; what they authorize is decided by this closure, which another entry
 * does not have.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { exists, readTextFile } from "@effectionx/fs";
import { dirname } from "node:path";
import type { DurableEvent } from "@executablemd/durable-streams";
import { PullRequestAdmissionError } from "../../composition/errors.ts";
import {
  GIT_PUSH,
  parseGitPushInputs,
  parseGitPushNaturalKey,
  parseGitPushRecord,
  pushExpectation,
} from "../../composition/git-push-records.ts";
import { parseRepositoryMetadata } from "../../composition/managed-metadata.ts";
import { sameRepositoryIdentity } from "../../composition/selection.ts";
import type { RepositoryIdentity } from "../../composition/selection.ts";
import { GIT_HOST_EFFECT } from "../../git-host/effect.ts";
import { parseGitHostReconciliationRecord } from "../../git-host/records.ts";
import type { RetainedRepositoryHistory } from "../../retained-repository/admission.ts";
import { parseRetainedPushRequest } from "../../retained-repository/requests.ts";
import type {
  RetainedAmbientSelection,
  RetainedPushRequest,
} from "../../retained-repository/requests.ts";
import { locatorFingerprint } from "../composition/locator.ts";
import type { AmbientRepository } from "../run-composition/ambient.ts";
import { ManagedCheckoutError } from "../run-composition/errors.ts";
import { METADATA, metadataOf } from "../run-composition/placement.ts";
import type { CheckoutPublication } from "./files.ts";

/**
 * One publication this entry holds: whose request it was, the checkout it
 * pushed from, and what it pushed.
 *
 * The owner and the occurrence are part of it because they are what the
 * receipt has to agree with. A Git-host record carries the identity it was
 * performed under, and a retained request carries the identity it was frozen
 * under; pairing them on the Git inputs alone would let a receipt somebody else
 * performed — another entry, another site in this one — stand for this
 * request's publication, which is exactly the substitution R2 refuses.
 */
export interface RetainedPublication {
  /** The effect owner the request was frozen under. */
  readonly owner: string;
  /** The canonical occurrence that froze it. */
  readonly site: string;
  readonly checkout: string;
  readonly origin: string;
  readonly inputs: RetainedPushRequest["inputs"];
}

/** What a pull request has to find among them. */
export interface PublicationQuestion {
  readonly checkout: string;
  readonly origin: string;
  readonly repository: RepositoryIdentity;
  readonly branch: string;
  readonly destinationRef: string;
  readonly commit: string;
}

function refuse(reason: "missing" | "conflicting" | "unreadable"): never {
  if (reason === "missing") {
    throw new PullRequestAdmissionError(
      "missing-push-evidence",
      "this entry holds no successful <Git.Push> result for the branch and commit it would open " +
        "a pull request from. Write <Git.Push /> before <PullRequest>: a pull request names work " +
        "this entry published, and publishing it is an explicit act.",
    );
  }
  if (reason === "conflicting") {
    throw new PullRequestAdmissionError(
      "conflicting-push-evidence",
      "this entry published that branch at a different commit than the one the checkout is on " +
        "now, so a pull request opened from it would name a head this entry never published.",
    );
  }
  throw new PullRequestAdmissionError(
    "unreadable-push-evidence",
    "this entry holds a successful Git-host result whose record cannot be read, so whether the " +
      "branch was published cannot be decided. Nothing is assumed about a record this version " +
      "cannot account for.",
  );
}

/**
 * The publications this entry's accepted history proves.
 *
 * In journal order, because a branch is published more than once: an entry that
 * commits, pushes, commits again and pushes again holds a sequence, and what a
 * pull request is decided against is where that sequence ended.
 *
 * Every accepted Git-host record is read completely rather than searched for a
 * match, so an unreadable one earlier in the sequence refuses here instead of
 * going unnoticed behind a later exact one. A readable one then has to be
 * *this* request's receipt: the identity it was performed under has to be the
 * owner and the occurrence the request was frozen under, and its Git inputs
 * have to be the ones that request froze. A receipt that agrees about the
 * branch and the commit while naming another owner or another site is a
 * publication somebody else performed, and it pairs with nothing here.
 */
export function admittedPublications(
  events: readonly DurableEvent[],
  history: RetainedRepositoryHistory,
): readonly RetainedPublication[] {
  const frozen = retainedPushRequests(history);
  const held: RetainedPublication[] = [];
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
      continue;
    }
    if (event.result.status !== "ok") {
      // A refused push published nothing, and a record of it admits nothing.
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    if (record === undefined) {
      // Its kind is inside the part that would not read, so it cannot be
      // excluded as unrelated.
      refuse("unreadable");
    }
    if (record.request.kind !== GIT_PUSH) {
      continue;
    }
    const key = parseGitPushNaturalKey(record.request.naturalKey);
    const inputs = parseGitPushInputs(record.request.inputs);
    if (key === undefined || inputs === undefined) {
      refuse("unreadable");
    }
    // The key says where this record is about; the inputs are what the result
    // is read against. A record whose two halves name different places cannot
    // be read at all, and reading it anyway would admit a push of somebody
    // else's branch on the strength of a key that merely mentioned ours.
    if (
      !sameRepositoryIdentity(inputs.repository, key.repository) ||
      inputs.remote !== key.remote ||
      inputs.destinationRef !== key.destinationRef ||
      parseGitPushRecord(record, pushExpectation(inputs)) === undefined
    ) {
      refuse("unreadable");
    }
    // Which checkout this entry pushed from is the retained record's to say,
    // and whose publication this is, is the pair's. A successful Git-host push
    // this entry never froze a request for — or froze at another site, or
    // under another owner — is not this request's publication, whatever its
    // inputs look like.
    const pushed = frozen.find(
      (candidate) =>
        candidate.owner === record.request.identity.runId &&
        candidate.site === record.request.identity.expansionId &&
        sameRepositoryIdentity(candidate.inputs.repository, inputs.repository) &&
        candidate.inputs.remote === inputs.remote &&
        candidate.inputs.branch === inputs.branch &&
        candidate.inputs.destinationRef === inputs.destinationRef &&
        candidate.inputs.sourceCommit === inputs.sourceCommit,
    );
    if (pushed === undefined) {
      continue;
    }
    held.push(pushed);
  }
  return Object.freeze(held);
}

/**
 * The push requests this entry's retained records froze, with their checkouts
 * and the identity each one was frozen under.
 *
 * Read from the admitted intents rather than from the events again: admission
 * has already held every one of them to its owner, its site, its request
 * fingerprint and its lane — so the owner here is this entry's by
 * construction, and carrying it is what lets a receipt be held to it.
 */
function retainedPushRequests(history: RetainedRepositoryHistory): readonly RetainedPublication[] {
  const frozen: RetainedPublication[] = [];
  for (const effect of [...history.completed, ...history.pending]) {
    if (effect.intent.operation !== "push") {
      continue;
    }
    const request = parseRetainedPushRequest(effect.intent.evidence);
    if (request === undefined) {
      // A retained push whose frozen request this version cannot read cannot
      // say what it published, and a pull request decided without it would be
      // decided against a shorter history than the one that exists.
      refuse("unreadable");
    }
    frozen.push(
      Object.freeze({
        owner: effect.intent.owner,
        site: effect.intent.site.occurrence,
        checkout: request.checkout,
        origin: request.origin,
        inputs: request.inputs,
      }),
    );
  }
  return Object.freeze(frozen);
}

/**
 * That this entry published the branch a pull request would name.
 *
 * Every member has to match, and the last publication of a destination is the
 * one that decides. A push of another checkout, repository, origin, destination
 * or branch is irrelevant rather than disagreement; the same destination at
 * another commit is this entry having published past the head the pull request
 * would name.
 *
 * Whose each publication is was settled when it was paired, so this compares
 * what a pull request is *about* rather than who asked for it: a push and the
 * pull request that names it are two sites of one entry, and requiring one
 * occurrence would refuse every document that writes them as two elements.
 */
export function admitRetainedPublication(
  held: readonly RetainedPublication[],
  question: PublicationQuestion,
): void {
  let published: "this head" | "another commit" | undefined;
  for (const entry of held) {
    if (
      entry.checkout !== question.checkout ||
      entry.origin !== question.origin ||
      !sameRepositoryIdentity(entry.inputs.repository, question.repository) ||
      entry.inputs.branch !== question.branch ||
      entry.inputs.destinationRef !== question.destinationRef
    ) {
      continue;
    }
    published = entry.inputs.sourceCommit === question.commit ? "this head" : "another commit";
  }
  if (published === "this head") {
    return;
  }
  refuse(published === undefined ? "missing" : "conflicting");
}

/**
 * What an ambient checkout publishes as, from what its discovery found.
 *
 * Its identity is the origin when it records one and its own Git directory
 * otherwise, because that is what identifies a repository with no remote. The
 * creation commit is the commit HEAD named when this entry selected it: the
 * instant the identity was pinned at, which — like every other member — says
 * nothing about where HEAD is now.
 */
export function ambientSelection(ambient: AmbientRepository): RetainedAmbientSelection {
  return Object.freeze({
    root: ambient.checkoutRoot,
    identity: Object.freeze({
      name: ambient.name,
      locatorFingerprint: ambient.originFingerprint ?? locatorFingerprint(ambient.commonDirectory),
      requestedBase: null,
      creationCommit: ambient.head,
      primaryBranch: ambient.defaultBranch,
      objectFormat: ambient.objectFormat,
    }),
    origin: ambient.origin ?? null,
  });
}

/** What a selected ambient checkout publishes as, from its own frozen selection. */
export function ambientPublication(
  selection: RetainedAmbientSelection,
  common: string,
): CheckoutPublication {
  return Object.freeze({
    identity: selection.identity,
    origin: selection.origin,
    // The checkout whose administration is the common directory: the ambient
    // checkout's own, or — when the entry was started inside a linked worktree
    // somebody made by hand — the repository that worktree belongs to.
    repositoryDirectory: dirname(common),
  });
}

/**
 * What a managed repository publishes as, from the metadata its creation wrote.
 *
 * Read from the sidecar rather than from Git, and deliberately: the sidecar is
 * written once, when the checkout is created, so what it says is the identity
 * this placement was selected under however far HEAD has moved since. Nothing
 * here creates, adopts or verifies a checkout — a slot with no readable
 * metadata is an answer the asking element refuses with.
 */
export function* managedPublication(
  slot: string,
  destination: string,
): Operation<Result<CheckoutPublication>> {
  const path = metadataOf(slot);
  if (!(yield* exists(path))) {
    return Err(
      new ManagedCheckoutError(
        "unusable-checkout",
        `the managed checkout at ${destination} carries no ${METADATA}, so what repository it ` +
          "is a checkout of is not recorded. Nothing was changed.",
      ),
    );
  }
  let read: unknown;
  try {
    read = JSON.parse(yield* readTextFile(path));
  } catch {
    read = undefined;
  }
  const metadata = parseRepositoryMetadata(read);
  if (metadata === undefined) {
    return Err(
      new ManagedCheckoutError(
        "incompatible-reuse",
        `the managed checkout at ${destination} carries a ${METADATA} this version cannot read, ` +
          "so what it holds cannot be decided. Nothing was changed.",
      ),
    );
  }
  return Ok(
    Object.freeze({
      identity: Object.freeze({
        name: metadata.name,
        locatorFingerprint: metadata.locatorFingerprint,
        requestedBase: metadata.requestedBase,
        creationCommit: metadata.creationCommit,
        primaryBranch: metadata.primaryBranch,
        objectFormat: metadata.objectFormat,
      }),
      origin: metadata.locator,
      repositoryDirectory: destination,
    }),
  );
}
