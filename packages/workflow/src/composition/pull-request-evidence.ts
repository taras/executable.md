/**
 * Proving that the pull request an issue records is one this run opened.
 *
 * An `<Issue>` says "here is work I decided to defer, and here is the pull
 * request I decided it against". The pull request lives at a Git host, where
 * anything at all could have opened it, so the only thing that makes it *this
 * run's* pull request is this run's own record of reconciling it — a successful
 * `<PullRequest>` result for the same Repository identity whose every member is
 * the evidence the document supplied. Observing the pull request at the host
 * cannot stand in for that: a pull request that happens to be there proves who
 * has write access, not who opened it.
 *
 * The scan is closed and deterministic, and it fails closed. Three things can
 * go wrong and each has its own word:
 *
 * - **missing** — no such `<PullRequest>` is recorded. The document has to
 *   write one, and bind it.
 * - **conflicting** — this run reconciled that pull request, and what it
 *   retained is not what was handed over; or the evidence names a Repository
 *   other than the one the issue would be recorded in.
 * - **unreadable** — a successful Git-host record this scan cannot read as one
 *   whole thing. A shape that will not parse, and a record whose natural key,
 *   inputs and result do not name the same pull request, are both refused
 *   rather than skipped: neither can be shown to be about something else, and
 *   "I could not read it" must never come out as "there is nothing there".
 *
 * Nothing here quotes a journal value. What is refused is exactly what must not
 * be repeated.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { GIT_HOST_EFFECT } from "../git-host/effect-type.ts";
import { parseGitHostReconciliationRecord } from "../git-host/records.ts";
import { sameRepositoryIdentity } from "./git-push-records.ts";
import {
  parsePullRequestInputs,
  parsePullRequestRecord,
  PULL_REQUEST,
  samePullRequestEvidence,
  type PullRequestResult,
} from "./pull-request-records.ts";
import { IssueAuthorityError } from "./errors.ts";

function refuse(reason: "missing" | "conflicting" | "unreadable"): never {
  if (reason === "missing") {
    throw new IssueAuthorityError(
      "missing-pull-request-evidence",
      "this run holds no successful <PullRequest> result matching the evidence it was given. " +
        'Write <PullRequest ... as="pullRequest"> before <Issue> and pass that binding: an ' +
        "issue records a decision about a pull request this run reconciled.",
    );
  }
  if (reason === "conflicting") {
    throw new IssueAuthorityError(
      "conflicting-pull-request-evidence",
      "the pull-request evidence it was given is not what this run retained for that pull " +
        "request, or it names a Repository other than the one the issue would be recorded in.",
    );
  }
  throw new IssueAuthorityError(
    "unreadable-pull-request-evidence",
    "this run holds a successful Git-host result whose record cannot be read, so whether the " +
      "pull request was reconciled cannot be decided. Nothing is assumed about a record this " +
      "version cannot account for.",
  );
}

/**
 * That this evidence is a pull request this run already reconciled, here.
 *
 * Every successful Git-host result in the run is inspected. A record of another
 * kind, and a pull request of another Repository or another identity, are
 * ignored — a workflow may open several pull requests, and one of them being
 * irrelevant is ordinary. Everything else is decided:
 *
 * A record for the same provider identity whose retained result differs in any
 * member is conflicting rather than missing, because the run did reconcile that
 * pull request and saying "open one first" would be advice to do something it
 * already did. One or more exact records authorize, and they cannot disagree
 * with each other: each of them was held to this same evidence before it was
 * counted.
 *
 * Failed Git-host outcomes are not evidence of anything. A refused pull request
 * reconciled nothing, and a record of it never authorizes.
 */
export function admitPullRequestEvidence(
  events: readonly DurableEvent[],
  evidence: PullRequestResult,
  repository: PullRequestResult["repository"],
): void {
  if (!sameRepositoryIdentity(evidence.repository, repository)) {
    refuse("conflicting");
  }
  let proofs = 0;

  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== GIT_HOST_EFFECT) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const record = parseGitHostReconciliationRecord(event.result.value);
    if (record === undefined) {
      // A successful Git-host record this scan cannot parse. Its kind is inside
      // the part that would not read, so it cannot be excluded as unrelated.
      refuse("unreadable");
    }
    if (record.request.kind !== PULL_REQUEST) {
      continue;
    }
    const asked = parsePullRequestInputs(record.request.inputs);
    if (asked === undefined) {
      refuse("unreadable");
    }
    if (!sameRepositoryIdentity(asked.repository, repository)) {
      continue;
    }
    // Read whole before anything is compared: the natural key, the three JSON
    // members and the public result have to describe one pull request, and a
    // record whose halves name different ones cannot be read at all.
    const outcome = parsePullRequestRecord(record, asked);
    if (outcome === undefined) {
      refuse("unreadable");
    }
    if (outcome.result.providerId !== evidence.providerId) {
      continue;
    }
    if (!samePullRequestEvidence(outcome.result, evidence)) {
      refuse("conflicting");
    }
    proofs += 1;
  }

  if (proofs === 0) {
    refuse("missing");
  }
}
